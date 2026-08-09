import "server-only";
import { getAccounts, getBalanceSheet, getCashFlow, getLedgerDetail, getLedgerSummary, getProfitLoss, FINANCIAL_REQUEST_TIMEOUT_MS } from "./olsera-financial-client";
import { collectSubtotalDiagnostics, deduplicateFinancialAccounts, normalizeAccounts, normalizeBalanceSheetPayload, normalizeCashFlowPayload, normalizeLedgerDetailPayload, normalizeLedgerSummaryPayload, normalizeProfitLossPayload, validatePeriod } from "./olsera-financial-core";
import { bulkUpsertLedgerEntries, createFinancialSyncRun, getFinancialSyncRun, markLedgerNonEmptyObservation, reconcileLedgerSummarySnapshot, recordLedgerEmptyObservation, updateFinancialSyncRun, upsertAccounts, upsertMonthlyReport, type FinancialCollections } from "./olsera-financial-store";
import { randomUUID } from "node:crypto";

const reportTypes = ["balance-sheet", "profit-loss", "cash-flow", "ledger-summary"] as const;
/** Jumlah akun "baru" yang diambil per step (cursor maju sebanyak ini). */
const LEDGER_BATCH_SIZE = 4;
/** Slot retry akun gagal per step — dijalankan MENDAHULUI batch berikutnya. */
const RETRY_SLOTS_PER_STEP = 2;
/** Batas keras percobaan per akun dalam satu run: mencegah retry tak berujung. */
const MAX_ATTEMPTS_PER_ACCOUNT = 3;

/**
 * Deadline internal SATU invocation cron financial — konsep TUNGGAL dibagi
 * antara runOlseraFinancialCron (lib/cron-olsera-financial.ts, cek di antara
 * step) dan stepFinancialSync di sini (cek di antara akun, di dalam loop
 * ledger-details). Jauh lebih kecil dari maxDuration route (300s) atau lock
 * lease (6 menit) — cron-job.org hanya menunggu response ~30 detik sebelum
 * menganggap invocation timeout (Phase 3C.4). 21 detik menyisakan margin ~9
 * detik untuk update MongoDB, release lock, serialisasi response, dan
 * overhead jaringan SETELAH deadline ini terlampaui — sengaja tidak dipepetkan
 * ke 29 detik.
 */
export const FINANCIAL_INVOCATION_TIME_BUDGET_MS = 21_000;

/**
 * Phase 3C.5.1 — HARDENING: `now() >= deadlineAt` saja TIDAK CUKUP. Sebuah
 * akun/step baru bisa MULAI tepat sebelum deadline, lalu request Olsera-nya
 * sendiri butuh waktu sampai FINANCIAL_REQUEST_TIMEOUT_MS (10 detik) —
 * ditambah checkpoint MongoDB + release lock + serialisasi response setelah
 * itu, total bisa jauh melewati 30 detik cron-job.org walau "deadline"
 * 21 detik itu sendiri belum pernah dilanggar SAAT keputusan mulai diambil.
 *
 * Margin konservatif yang WAJIB tersisa setelah request Olsera terburuk
 * selesai, sebelum kerja baru (akun ledger baru MAUPUN step baru di level
 * route) boleh dimulai — untuk checkpoint Mongo (bulkUpsert + update run),
 * release lock, dan pengiriman response. Operasi Mongo tunggal di Atlas
 * biasanya cuma ratusan ms; 3 detik sengaja jauh di atas itu (konservatif).
 */
export const FINANCIAL_ACCOUNT_START_SAFETY_MARGIN_MS = 3_000;

/**
 * Waktu tersisa MINIMUM (relatif terhadap deadline bersama di atas) yang
 * wajib ada SEBELUM boleh memulai satu request Olsera baru — worst-case
 * request (FINANCIAL_REQUEST_TIMEOUT_MS) + margin finalisasi
 * (FINANCIAL_ACCOUNT_START_SAFETY_MARGIN_MS). Dicek SEBELUM memulai kerja
 * baru (bukan sesudahnya): dipakai identik oleh stepFinancialSync (per akun,
 * di dalam loop ledger-details) dan runOlseraFinancialCron (per step, di
 * antara pemanggilan step) — SATU rumus, dua tempat, tidak ada dua timer
 * yang saling bertentangan.
 */
export const FINANCIAL_MIN_REMAINING_MS_TO_START_WORK = FINANCIAL_REQUEST_TIMEOUT_MS + FINANCIAL_ACCOUNT_START_SAFETY_MARGIN_MS;

function readCodes(value: unknown): string[] { return Array.isArray(value) ? value.map((code) => String(code)).filter(Boolean) : []; }
function readAttempts(value: unknown): Map<string, number> { const map = new Map<string, number>(); if (Array.isArray(value)) for (const item of value) { const row = item as { code?: unknown; attempts?: unknown }; const code = row && typeof row === "object" ? String(row.code ?? "") : ""; if (code) map.set(code, Number(row.attempts) || 0); } return map; }
function writeAttempts(map: Map<string, number>): Array<{ code: string; attempts: number }> { return [...map.entries()].map(([code, attempts]) => ({ code, attempts })); }
function failureMessage(codes: string[], permanent: boolean): string { const shown = codes.slice(0, 10).join(", "); const more = codes.length > 10 ? ` (+${codes.length - 10} akun lain)` : ""; return permanent ? `Buku Besar Detail gagal permanen setelah ${MAX_ATTEMPTS_PER_ACCOUNT} percobaan untuk akun: ${shown}${more}.` : `Buku Besar Detail gagal untuk akun: ${shown}${more} — akan dicoba ulang.`; }
function safeRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function periodParts(period: string) { return { year: Number(period.slice(0, 4)), month: Number(period.slice(5)) }; }
function validation(type: string, normalized: any): { validated: boolean; note: string | null } {
  const subtotalDiagnostics = collectSubtotalDiagnostics(normalized);
  const subtotalNote = subtotalDiagnostics.length ? `Subtotal sumber tidak cocok dengan detail: ${subtotalDiagnostics.slice(0, 3).join("; ")}` : null;
  let base: { validated: boolean; note: string | null };
  if (type === "balance-sheet") base = { validated: normalized.totals.balanced === true, note: normalized.totals.balanced ? null : "Neraca tidak balance." };
  else if (type === "profit-loss") base = { validated: normalized.totals.grossProfitValid && normalized.totals.netProfitValid, note: normalized.totals.grossProfitValid && normalized.totals.netProfitValid ? null : "Formula laba rugi tidak valid." };
  else if (type === "cash-flow") base = { validated: normalized.totals.activityTotalValid && normalized.totals.endingCashValid, note: normalized.totals.activityTotalValid && normalized.totals.endingCashValid ? null : "Formula arus kas tidak valid." };
  else base = { validated: normalized.length === 85, note: normalized.length === 85 ? null : `Jumlah akun ${normalized.length}, diharapkan 85.` };
  return { validated: base.validated && subtotalDiagnostics.length === 0, note: [base.note, subtotalNote].filter(Boolean).join(" ") || null };
}

/**
 * `context` opsional: bila diisi (mis. koleksi MongoDB TEST dari validator),
 * seluruh operasi store diarahkan ke sana dan TIDAK PERNAH menyentuh
 * withMongo()/singleton production. Bila kosong, perilaku production
 * (routes app/api/olsera/financial/sync/*) tidak berubah sama sekali.
 */
export async function startFinancialSync(year: unknown, month: unknown, context?: FinancialCollections) { const period = validatePeriod(String(year), String(month)); const { year: y, month: m } = periodParts(period); const pages = await getAccounts(y, m); const accounts = deduplicateFinancialAccounts(normalizeAccounts(pages[0]), normalizeAccounts(pages[1])); const codes = accounts.map((row: any) => String(row.account_code ?? row.account_no ?? row.code ?? "")).filter(Boolean); await upsertAccounts(accounts, context); return createFinancialSyncRun(period, codes, context); }
/**
 * `deadlineAt` (timestamp ms, opsional): dibagi dengan runOlseraFinancialCron
 * (SATU konsep deadline, lihat FINANCIAL_INVOCATION_TIME_BUDGET_MS di atas) —
 * bila diisi, fase ledger-details berhenti SEBELUM memulai akun berikutnya
 * (retry maupun baru) begitu `now() >= deadlineAt`, menyimpan checkpoint untuk
 * akun yang SUDAH selesai diproses saja (lihat blok ledger-details di bawah).
 * `now` hanya untuk testability (default `Date.now`) — tidak pernah dipakai
 * oleh pemanggil production.
 */
export async function stepFinancialSync(runId: string, context?: FinancialCollections, deadlineAt?: number, now: () => number = Date.now) { const run = await getFinancialSyncRun(runId, context); if (!run) throw new Error("Sync run tidak ditemukan."); if (run.status === "success" || run.finalized === true) return run; const invocationId = randomUUID(); if (run.phase === "monthly-reports") { const [balanceRaw, profitRaw, cashRaw, ledgerRaw] = await Promise.all([getBalanceSheet(run.period), getProfitLoss(run.period), getCashFlow(run.period), getLedgerSummary(run.period)]); const reports = [["balance-sheet", normalizeBalanceSheetPayload(balanceRaw), balanceRaw, "account/balancenew"], ["profit-loss", normalizeProfitLossPayload(profitRaw), profitRaw, "account/gainloss"], ["cash-flow", normalizeCashFlowPayload(cashRaw), cashRaw, "account/cashflowstatement"], ["ledger-summary", normalizeLedgerSummaryPayload(ledgerRaw), ledgerRaw, "account/ledger2"]] as const; for (const [reportType, normalizedPayload, rawPayload, sourceEndpoint] of reports) { const result = validation(reportType, normalizedPayload); await upsertMonthlyReport({ period: run.period, year: periodParts(run.period).year, month: periodParts(run.period).month, reportType, normalizedPayload: safeRecord(normalizedPayload), rawPayload: safeRecord(rawPayload), sourceEndpoint, currency: "IDR", validated: result.validated, validationNote: result.note }, context); } return updateFinancialSyncRun(runId, { phase: "ledger-details", reportsCompleted: [...reportTypes], status: "running" }, context); }
 if (run.phase === "ledger-details") {
  // C1 — akun yang gagal TIDAK PERNAH dianggap selesai: kode akunnya disimpan
  // eksplisit di run (failedAccountCodes) sehingga bertahan lintas invocation,
  // di-retry pada step berikutnya, dan baru hilang setelah benar-benar berhasil.
  const failed = new Set(readCodes(run.failedAccountCodes));
  const recovered = new Set(readCodes(run.recoveredAccountCodes));
  const attempts = readAttempts(run.accountAttempts);
  const retryBatch = [...failed].filter((code) => (attempts.get(code) ?? 0) < MAX_ATTEMPTS_PER_ACCOUNT).slice(0, RETRY_SLOTS_PER_STEP);
  const nextBatch = run.accountCodes.slice(run.accountCursor, run.accountCursor + LEDGER_BATCH_SIZE);
  let records = 0;
  // Akun baru yang BENAR-BENAR diproses (bukan cuma direncanakan) — cursor
  // hanya boleh maju sebesar ini, supaya akun yang belum sempat dicoba karena
  // deadline TIDAK PERNAH ditandai selesai (lihat Phase 3C.5).
  let processedNewCount = 0;
  const combined = [...retryBatch, ...nextBatch];
  for (let i = 0; i < combined.length; i++) {
   // Phase 3C.5.1 — start-safety guard: SEBELUM memulai akun berikutnya
   // (retry maupun baru), pastikan sisa waktu masih cukup untuk request
   // Olsera TERBURUK (FINANCIAL_REQUEST_TIMEOUT_MS) DITAMBAH margin
   // finalisasi (checkpoint Mongo + release lock + response). Sekadar
   // "belum lewat deadline" TIDAK CUKUP — akun bisa mulai tepat sebelum
   // deadline lalu request-nya sendiri baru selesai lama setelahnya. Akun
   // yang belum sempat mulai diproses tetap utuh (attempts/failed/recovered
   // tidak disentuh sama sekali untuknya), jadi tidak ada state setengah jalan.
   if (deadlineAt !== undefined && deadlineAt - now() <= FINANCIAL_MIN_REMAINING_MS_TO_START_WORK) break;
   const code = combined[i];
   const isRetry = i < retryBatch.length;
   attempts.set(code, (attempts.get(code) ?? 0) + 1);
   try {
    const raw = await getLedgerDetail(run.period, code);
    const normalized = normalizeLedgerDetailPayload(raw, code);
    if (normalized.totalRecords === 0) await recordLedgerEmptyObservation(run.period, code, runId, invocationId, context);
    else await markLedgerNonEmptyObservation(run.period, code, context);
    await bulkUpsertLedgerEntries(code, run.period, normalized.entries as unknown as Array<Record<string, unknown>>, context);
    records += normalized.totalRecords;
    if (failed.delete(code)) recovered.add(code);
   } catch {
    failed.add(code);
   }
   if (!isRetry) processedNewCount++;
  }
  const cursor = Math.min(run.accountCursor + processedNewCount, run.accountCodes.length);
  const cursorDone = cursor >= run.accountCodes.length;
  const remaining = [...failed];
  const retryable = remaining.some((code) => (attempts.get(code) ?? 0) < MAX_ATTEMPTS_PER_ACCOUNT);
  const patch = { accountCursor: cursor, accountsProcessed: Math.min(cursor, run.accountCodes.length), recordsProcessed: run.recordsProcessed + records, failedAccountCodes: remaining, recoveredAccountCodes: [...recovered], accountAttempts: writeAttempts(attempts), completedAt: null };
  // errorMessage kegagalan TIDAK PERNAH dihapus oleh batch berikutnya yang
  // kebetulan sukses — hanya dibersihkan saat run benar-benar selesai sukses.
  if (remaining.length) return updateFinancialSyncRun(runId, { ...patch, status: "partial", phase: "ledger-details", finalized: cursorDone && !retryable, errorMessage: failureMessage(remaining, cursorDone && !retryable) }, context);
  // Seluruh akun selesai tanpa sisa kegagalan -> rekonsiliasi dijalankan pada
  // step TERSENDIRI (fase "reconcile"), bukan menempel di batch fetch terakhir.
  return updateFinancialSyncRun(runId, { ...patch, status: "running", phase: cursorDone ? "reconcile" : "ledger-details", finalized: false, errorMessage: run.errorMessage ?? null }, context);
 }
 if (run.phase === "reconcile") {
  // Guard: rekonsiliasi HANYA boleh jalan bila seluruh akun benar-benar selesai.
  const remaining = readCodes(run.failedAccountCodes);
  if (remaining.length || run.accountCursor < run.accountCodes.length) {
   const retryable = remaining.some((code) => (readAttempts(run.accountAttempts).get(code) ?? 0) < MAX_ATTEMPTS_PER_ACCOUNT);
   return updateFinancialSyncRun(runId, { phase: "ledger-details", status: remaining.length ? "partial" : "running", finalized: remaining.length > 0 && !retryable, errorMessage: remaining.length ? failureMessage(remaining, !retryable) : run.errorMessage ?? null }, context);
  }
  await reconcileLedgerSummarySnapshot(run.period, context);
  return updateFinancialSyncRun(runId, { status: "success", phase: "completed", finalized: true, errorMessage: null, completedAt: new Date() }, context);
 }
 return run;
}
export async function getFinancialSyncStatus(runId: string, context?: FinancialCollections) { const run = await getFinancialSyncRun(runId, context); if (!run) return null; const total = run.accountCodes.length; return { status: run.status, period: run.period, phase: run.phase, failedAccountCodes: readCodes(run.failedAccountCodes), recoveredAccountCodes: readCodes(run.recoveredAccountCodes), accountAttempts: writeAttempts(readAttempts(run.accountAttempts)), progress: { accountsTotal: total, accountsProcessed: run.accountsProcessed, recordsProcessed: run.recordsProcessed, percentage: total ? Math.round((run.accountsProcessed / total) * 100) : 0 }, message: run.errorMessage ?? (run.status === "success" ? "Sinkronisasi selesai." : "Sinkronisasi berjalan."), completedAt: run.completedAt?.toISOString() ?? null }; }
