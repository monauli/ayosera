// Cron "revenue re-check mingguan" — endpoint TERPISAH dari cron Financial
// utama (app/api/cron/olsera/financial/route.ts, lib/cron-olsera-financial.ts).
//
// Latar belakang: akun revenue (40001/40004/21003, dipakai
// computeOmzetOlseraLedger() di lib/reconciliation-omzet-ledger.ts) terbukti
// bisa kehilangan entry BACKDATED bila sync pertama kali periode itu jalan
// SEBELUM staf Olsera selesai input jurnal accrued/reklas akhir bulan
// (kasus nyata: periode 2026-08, ditemukan 2026-09-02 — 40000/40002/40003
// masing-masing kedapatan +24/+14/+2 baris setelah di-fetch ulang manual).
// Sync yang sudah "success" TIDAK PERNAH dicek ulang oleh cron utama —
// cabang lama yang dulu menutup celah ini (previous-refresh-due,
// lib/cron-olsera-financial.ts) DIMATIKAN PERMANEN karena efeknya me-restart
// PENUH 85 akun dari accountCursor 0 tiap 24 jam, terlalu mahal untuk
// kebutuhan yang sebenarnya sempit (9 akun revenue saja).
//
// Cron ini mengisi celah itu dengan MURAH: re-fetch getLedgerDetail() untuk
// akun revenue tetap (REVENUE_RECHECK_ACCOUNT_CODES) pada periode BULAN
// SEBELUMNYA (relatif tanggal cron jalan, previousFinancialPeriod), sekali
// per RONDE MINGGUAN — TANPA startFinancialSync/getAccounts/
// createFinancialSyncRun sama sekali (daftar akun konstan, jadi NOL request
// Olsera untuk daftar akun sebelum getLedgerDetail() pertama). State ronde
// disimpan di field `revenueRecheck` pada dokumen sync log periode itu
// sendiri (olsera_financial_sync_logs, lib/olsera-financial-store.ts) —
// TERPISAH SENGAJA dari failedAccountCodes/accountAttempts/finalized, yang
// khusus untuk akun GAGAL saat sync AWAL periode (bukan akun yang sudah
// berhasil tapi perlu dicek ulang).
//
// Jadwal invocation vs jadwal ronde — DUA KONSEP BERBEDA:
//   - Kadensi INVOCATION (jadwal cron-job.org): disarankan TIAP JAM (mis.
//     menit :15), menjauh dari financial (:45) dan inventory (:25).
//   - Kadensi RONDE (REVENUE_RECHECK_ROUND_INTERVAL_MS): 7 hari. Ronde hanya
//     boleh MULAI sekali per jendela ini; begitu mulai, invocation
//     berikutnya (jam demi jam) melanjutkan checkpoint (cursor) sampai
//     benar-benar selesai (9 akun / REVENUE_RECHECK_SLOTS_PER_INVOCATION
//     slot ≈ 2-3 invocation), lalu berhenti sampai jendela berikutnya lewat.
//   Invocation di luar jendela ronde itu no-op murah: satu findOne, TANPA
//   request Olsera apa pun.
import "server-only";
import { todayJakarta } from "@/lib/olsera-sync";
import {
  previousFinancialPeriod,
  normalizeLedgerDetailPayload,
  normalizeBalanceSheetPayload,
  normalizeProfitLossPayload,
  normalizeCashFlowPayload,
  normalizeLedgerSummaryPayload,
} from "@/lib/olsera-financial-core";
import { getLedgerDetail, getBalanceSheet, getProfitLoss, getCashFlow, getLedgerSummary } from "@/lib/olsera-financial-client";
import {
  getFinancialSyncLogForPeriod,
  updateFinancialSyncRun,
  bulkUpsertLedgerEntries,
  reconcileLedgerSummarySnapshot,
  countLedgerEntriesForAccount,
  upsertMonthlyReport,
  type FinancialSyncRun,
} from "@/lib/olsera-financial-store";
import { FINANCIAL_INVOCATION_TIME_BUDGET_MS, FINANCIAL_MIN_REMAINING_MS_TO_START_WORK, periodParts, validateMonthlyReportPayload, safeRecord } from "@/lib/olsera-financial-sync";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";
import { acquireOlseraSyncLock, releaseOlseraSyncLock } from "@/lib/olsera-cron-lock";
import { assertOmzetPeriodNotLocked, OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock";
import { currentStoreId } from "@/lib/olsera-store-id";
import { isDatabaseTimeoutError, withDatabaseRetry } from "@/lib/mongodb-errors";
import { collections, withMongo } from "@/lib/mongodb";

/**
 * Akun revenue yang di-re-check tiap ronde — konstanta, TIDAK PERNAH diambil
 * dari Olsera (getAccounts() tidak pernah dipanggil cron ini). Mencakup
 * seluruh grup 40000-40007 + 21003 (bukan cuma 40001/40004/21003 yang
 * dipakai computeOmzetOlseraLedger()) karena bukti empiris 2026-09-02:
 * 40000/40002/40003 juga menerima baris susulan dengan pola sama, walau
 * tidak menyentuh omzet AYO — mereka tetap menyentuh laba-rugi.
 */
export const REVENUE_RECHECK_ACCOUNT_CODES = ["40000", "40001", "40002", "40003", "40004", "40005", "40006", "40007", "21003"] as const;

/**
 * Slot (akun) maksimum diproses per invocation. Guard start-safety di bawah
 * (SAMA PERSIS dengan cron Financial utama) memangkasnya sendiri saat akun
 * berat — akun revenue terukur 2026-09-02 (deltaSyncedAt): 40000 ~1069
 * baris/1,0s, 40002 ~589 baris/5,9s. Angka ini pagar atas, bukan target.
 */
export const REVENUE_RECHECK_SLOTS_PER_INVOCATION = 4;

/** Jeda minimum antar MULAI ronde baru. TIDAK menunda ronde yang SUDAH berjalan (lihat isRoundInProgress) — itu selalu dilanjutkan invocation berikutnya, apa pun umurnya. */
export const REVENUE_RECHECK_ROUND_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// Lock module "financial" — SENGAJA berbagi lock global yang sama dengan
// cron Financial utama (lib/olsera-cron-lock.ts, singleton lintas modul
// sales/inventory/financial), supaya re-check ini TIDAK PERNAH berjalan
// bersamaan dengan sync/restart akun untuk periode yang sama.
const LEASE_MS = 6 * 60 * 1000;
const TIME_BUDGET_MS = FINANCIAL_INVOCATION_TIME_BUDGET_MS;
const MIN_REMAINING_MS_TO_START_WORK = FINANCIAL_MIN_REMAINING_MS_TO_START_WORK;

export type RevenueRecheckState = NonNullable<FinancialSyncRun["revenueRecheck"]>;

function freshState(now: Date): RevenueRecheckState {
  return { accountCodes: [...REVENUE_RECHECK_ACCOUNT_CODES], cursor: 0, roundStartedAt: now, roundFinishedAt: null, attempts: 0, changed: [] };
}

function toTime(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** true = ronde sedang berjalan (mid-fetch ATAU cursor selesai tapi laporan belum difinalisasi) -> HARUS dilanjutkan, jendela 7 hari tidak relevan lagi. */
export function isRevenueRecheckRoundInProgress(state: RevenueRecheckState | undefined | null): boolean {
  return Boolean(state?.roundStartedAt && !state.roundFinishedAt);
}

/** true = boleh MULAI ronde baru sekarang — tidak ada ronde berjalan, DAN jendela REVENUE_RECHECK_ROUND_INTERVAL_MS sejak ronde terakhir selesai sudah lewat (belum pernah selesai = due). */
export function isRevenueRecheckRoundDue(state: RevenueRecheckState | undefined | null, now: Date): boolean {
  if (isRevenueRecheckRoundInProgress(state)) return false;
  const lastFinishedMs = state?.roundFinishedAt ? toTime(state.roundFinishedAt) : 0;
  return now.getTime() - lastFinishedMs >= REVENUE_RECHECK_ROUND_INTERVAL_MS;
}

export type RevenueRecheckCronResponse = { status: number; body: Record<string, unknown> };

export async function runOlseraRevenueRecheckCron(authHeader: string | null, now: () => number = Date.now): Promise<RevenueRecheckCronResponse> {
  const auth = verifyCronSecret(authHeader);
  if (!auth.ok) {
    if (auth.status === 500) console.error("[cron:olsera:financial:revenue-recheck] CRON_SECRET is not configured");
    return { status: auth.status, body: { success: false, mode: "cron", module: "financial-revenue-recheck", status: "unauthorized", message: auth.message } };
  }

  let lock;
  try {
    lock = await withDatabaseRetry(() => acquireOlseraSyncLock("financial", "cron", LEASE_MS));
  } catch (error) {
    if (isDatabaseTimeoutError(error)) {
      return { status: 504, body: { status: "database-timeout", module: "financial-revenue-recheck", safeErrorCode: "mongodb-timeout" } };
    }
    throw error;
  }
  if (!lock.ok) {
    return { status: 409, body: { status: "sync-in-progress", activeModule: lock.activeModule, runId: lock.runId } };
  }

  const { runId } = lock;
  const startedAt = now();
  const deadlineAt = startedAt + TIME_BUDGET_MS;
  const telemetryStartedAt = new Date(startedAt);
  let telemetryPeriod: string | null = null;
  let telemetryStatus = "no-op";
  let telemetrySteps = 0;
  let telemetryCheckpoint: number | null = null;
  let telemetrySafeErrorCode: "TIMEOUT" | "DEADLINE" | "UNKNOWN" | null = null;

  function noop(status: string, period: string | null) {
    telemetryStatus = status;
    return { status: 200, body: { success: true, mode: "cron", module: "financial-revenue-recheck", runId, period, status, stepsExecuted: 0, completed: false } };
  }

  try {
    const currentPeriod = todayJakarta().slice(0, 7);
    const period = previousFinancialPeriod(currentPeriod);
    if (!period) return noop("no-previous-period", null);
    telemetryPeriod = period;

    const run = await getFinancialSyncLogForPeriod(period);
    if (!run || run.status !== "success") return noop("not-ready", period);

    try {
      await assertOmzetPeriodNotLocked(currentStoreId(), period);
    } catch (error) {
      if (error instanceof OmzetPeriodLockError) return noop("period-locked", period);
      throw error;
    }

    const existing = run.revenueRecheck;
    const startedAtDate = new Date(startedAt);
    let state: RevenueRecheckState;
    if (isRevenueRecheckRoundInProgress(existing)) {
      state = existing as RevenueRecheckState;
    } else if (isRevenueRecheckRoundDue(existing, startedAtDate)) {
      state = freshState(startedAtDate);
    } else {
      return noop("round-not-due", period);
    }

    // Fase 1 — fetch ulang akun tersisa, budget-guarded (pola SAMA dengan
    // stepFinancialSync/lib/olsera-financial-sync.ts: berhenti SEBELUM
    // memulai akun baru begitu sisa waktu tidak cukup lagi untuk request
    // Olsera terburuk + margin finalisasi — akun yang belum sempat dimulai
    // TIDAK disentuh sama sekali, jadi tidak pernah ada state setengah jalan
    // untuk SATU akun; hanya cursor yang berhenti di batas akun terakhir
    // yang benar-benar selesai diproses).
    let cursor = state.cursor;
    let attempts = state.attempts;
    const changed = [...state.changed];
    let processed = 0;
    while (cursor < state.accountCodes.length && processed < REVENUE_RECHECK_SLOTS_PER_INVOCATION) {
      if (deadlineAt - now() <= MIN_REMAINING_MS_TO_START_WORK) break;
      const code = state.accountCodes[cursor];
      try {
        const rowsBefore = await countLedgerEntriesForAccount(period, code);
        const raw = await getLedgerDetail(period, code);
        const normalized = normalizeLedgerDetailPayload(raw, code);
        // Respons KOSONG sengaja DILEWATI sepenuhnya — TIDAK ada upsert,
        // TIDAK ada delete, dan SECARA SENGAJA TIDAK memanggil
        // recordLedgerEmptyObservation() (lib/olsera-financial-store.ts):
        // fungsi itu menghapus SELURUH baris akun setelah 2 observasi kosong
        // berjarak >=60 detik dalam satu run — ambang yang dirancang untuk
        // DUA OBSERVASI DALAM SATU RUN SYNC AWAL, trivial terlampaui oleh
        // kadensi mingguan cron ini, dan akan MENGHAPUS DATA akun revenue
        // yang sebenarnya baik-baik saja (dikonfirmasi read-only pada
        // investigasi 2026-09-02: sejumlah akun revenue SUDAH pernah
        // "confirmed"/terhapus lewat jalur ini di periode lain).
        if (normalized.totalRecords > 0) {
          await bulkUpsertLedgerEntries(code, period, normalized.entries as unknown as Array<Record<string, unknown>>);
          if (normalized.totalRecords !== rowsBefore) changed.push({ code, rowsBefore, rowsAfter: normalized.totalRecords, at: new Date() });
        }
      } catch {
        // Kegagalan satu akun (timeout/error Olsera) TIDAK menghentikan
        // ronde — murni dicatat sebagai audit (attempts), cursor tetap maju.
        // Akun ini akan tetap kena giliran lagi di RONDE MINGGUAN berikutnya
        // (bukan retry dalam ronde yang sama seperti failedAccountCodes di
        // sync utama — kebutuhan re-check ini jauh lebih longgar).
        attempts++;
      }
      cursor++;
      processed++;
    }
    telemetrySteps = processed;
    telemetryCheckpoint = cursor;

    if (cursor < state.accountCodes.length) {
      await updateFinancialSyncRun(run._id, { revenueRecheck: { ...state, cursor, attempts, changed } });
      telemetryStatus = "in-progress";
      if (deadlineAt - now() <= MIN_REMAINING_MS_TO_START_WORK) telemetrySafeErrorCode = "DEADLINE";
      return { status: 200, body: { success: true, mode: "cron", module: "financial-revenue-recheck", runId, period, status: "in-progress", stepsExecuted: processed, cursor, accountsTotal: state.accountCodes.length, changedCount: changed.length, completed: false } };
    }

    // Fase 2 — seluruh akun sudah di-fetch ulang (baru saja ATAU sisa dari
    // invocation sebelumnya yang tidak sempat finalisasi): finalisasi punya
    // kebutuhan waktu SENDIRI (reconcile + mungkin 4 request laporan
    // bulanan) -> guard start-safety yang SAMA dicek lagi sebelum mulai. Bila
    // tidak cukup, cursor tetap tersimpan di akhir (roundFinishedAt tetap
    // null) dan invocation BERIKUTNYA mengulang persis dari sini — "1 step
    // lagi" untuk laporan bulanan terjadi secara alami lewat mekanisme ini,
    // tanpa perlu field phase terpisah.
    if (deadlineAt - now() <= MIN_REMAINING_MS_TO_START_WORK) {
      await updateFinancialSyncRun(run._id, { revenueRecheck: { ...state, cursor, attempts, changed } });
      telemetryStatus = "in-progress";
      telemetrySafeErrorCode = "DEADLINE";
      return { status: 200, body: { success: true, mode: "cron", module: "financial-revenue-recheck", runId, period, status: "in-progress", stepsExecuted: processed, cursor, accountsTotal: state.accountCodes.length, changedCount: changed.length, completed: false } };
    }

    // Snapshot ledger-summary dibaca ulang dari detail yang baru saja
    // ditulis — murni baca+tulis Mongo, TIDAK PERNAH memanggil Olsera.
    await reconcileLedgerSummarySnapshot(period);

    // Laporan bulanan (balance-sheet/profit-loss/cash-flow/ledger-summary)
    // HANYA disegarkan bila ada akun yang jumlah barisnya benar-benar
    // berubah ronde ini — kalau tidak ada satu pun akun berubah, laporan
    // yang sudah tersimpan sudah pasti masih akurat, tidak perlu 4 request
    // Olsera tambahan yang sia-sia.
    if (changed.length > 0) {
      const [balanceRaw, profitRaw, cashRaw, ledgerRaw] = await Promise.all([getBalanceSheet(period), getProfitLoss(period), getCashFlow(period), getLedgerSummary(period)]);
      const { year, month } = periodParts(period);
      const reports = [
        ["balance-sheet", normalizeBalanceSheetPayload(balanceRaw), balanceRaw, "account/balancenew"],
        ["profit-loss", normalizeProfitLossPayload(profitRaw), profitRaw, "account/gainloss"],
        ["cash-flow", normalizeCashFlowPayload(cashRaw), cashRaw, "account/cashflowstatement"],
        ["ledger-summary", normalizeLedgerSummaryPayload(ledgerRaw), ledgerRaw, "account/ledger2"],
      ] as const;
      for (const [reportType, normalizedPayload, rawPayload, sourceEndpoint] of reports) {
        const result = validateMonthlyReportPayload(reportType, normalizedPayload);
        await upsertMonthlyReport({ period, year, month, reportType, normalizedPayload: safeRecord(normalizedPayload), rawPayload: safeRecord(rawPayload), sourceEndpoint, currency: "IDR", validated: result.validated, validationNote: result.note });
      }
    }

    const finishedAt = new Date();
    await updateFinancialSyncRun(run._id, { revenueRecheck: { ...state, cursor, attempts, changed, roundFinishedAt: finishedAt } });
    telemetryStatus = "round-complete";
    return { status: 200, body: { success: true, mode: "cron", module: "financial-revenue-recheck", runId, period, status: "round-complete", stepsExecuted: processed, cursor, accountsTotal: state.accountCodes.length, changedCount: changed.length, completed: true } };
  } catch (error) {
    if (isDatabaseTimeoutError(error)) {
      telemetrySafeErrorCode = "TIMEOUT";
      return { status: 504, body: { status: "database-timeout", module: "financial-revenue-recheck", runId, period: telemetryPeriod, safeErrorCode: "mongodb-timeout" } };
    }
    console.error(`[cron:olsera:financial:revenue-recheck] runId=${runId} gagal`, error instanceof Error ? error.message : error);
    telemetrySafeErrorCode = "UNKNOWN";
    telemetryStatus = "step-failed";
    return { status: 200, body: { success: false, mode: "cron", module: "financial-revenue-recheck", runId, period: telemetryPeriod, status: "step-failed", completed: false } };
  } finally {
    try {
      await withDatabaseRetry(() => releaseOlseraSyncLock(runId));
    } catch (error) {
      console.error(`[cron:olsera:financial:revenue-recheck] runId=${runId} gagal release lock`, isDatabaseTimeoutError(error) ? "timeout" : "error");
    }
    try {
      const finishedAt = new Date();
      await withMongo(async () => {
        const { olseraFinancialCronInvocations } = await collections();
        await olseraFinancialCronInvocations.insertOne({
          _id: `${runId}:${finishedAt.getTime()}`,
          cronRunId: runId,
          period: telemetryPeriod,
          status: telemetryStatus,
          startedAt: telemetryStartedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt,
          stepsExecuted: telemetrySteps,
          checkpoint: telemetryCheckpoint,
          safeErrorCode: telemetrySafeErrorCode,
          stopReason: telemetryStatus === "round-complete" ? "completed" : telemetryStatus === "in-progress" ? "checkpointed" : "no-op",
        });
      });
    } catch (error) {
      console.error("[cron:olsera:financial:revenue-recheck] telemetry write failed", isDatabaseTimeoutError(error) ? "timeout" : "error");
    }
  }
}
