import "server-only";
import { collections, withMongo } from "@/lib/mongodb";
import { fetchOlseraSalesAuditSource } from "@/lib/olsera-sync";
import { fetchStockMovementRange } from "@/lib/olsera-inventory-stockmovement";
import { getBalanceSheet, getCashFlow, getLedgerSummary, getProfitLoss } from "@/lib/olsera-financial-client";
import { normalizeBalanceSheetPayload, normalizeCashFlowPayload, normalizeLedgerSummaryPayload, normalizeProfitLossPayload } from "@/lib/olsera-financial-core";

/**
 * Perbandingan AYOSERA-vs-Olsera-live per source (Kategori/Inventori/
 * Financial), diekstrak dari app/api/audit/olsera-validation/route.ts supaya
 * bisa dipakai ULANG persis (bukan diduplikasi/ditulis ulang) oleh gap
 * check/recovery (app/api/private/integration-monitor/route.ts) — satu
 * sumber kebenaran perbandingan untuk kedua endpoint.
 */

export type ValidationStatus = "Cocok" | "Selisih" | "Data Belum Lengkap" | "Gagal Dicek";

// Kategori menarik SEMUA order (closeorder+openorder) + detail per hari untuk
// satu bulan penuh dari Olsera live — arsitektur yang sama dengan cron sync
// bulanan (app/api/cron/olsera/sales/route.ts), yang diberi maxDuration 300s.
// 45 detik (budget lama) jauh di bawah waktu nyata yang dibutuhkan untuk
// sebulan penuh order, sehingga category SELALU gagal timeout untuk periode
// dengan volume order wajar — root cause exact Phase 1.
export const CATEGORY_TIMEOUT_MS = 240_000;

const stable = (value: unknown) => JSON.stringify(value, (_, v) => v instanceof Date ? v.toISOString() : v);

/** Tanggal akhir bulan (ISO yyyy-mm-dd) dari period "YYYY-MM" — dipakai bersama oleh validator dan gap check/recovery. */
export const periodEnd = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);

// `stage`/`code` adalah diagnostic AMAN (tidak pernah token/credential/raw
// response/stack) — code diambil dari error.code bila ada (mis.
// OlseraSalesAuditSourceError), atau ditebak dari pesan (TIMEOUT), fallback UNKNOWN.
export function failedSection(stage: "category" | "inventory" | "financial", error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : error instanceof Error && /batas waktu|timeout/i.test(error.message) ? "TIMEOUT" : "UNKNOWN";
  return { status: "Gagal Dicek" as ValidationStatus, stage, code, detail: error instanceof Error ? error.message : "Source Olsera tidak dapat dibaca." };
}

async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([task, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Validasi kategori melewati batas waktu.")), ms))]);
}

export async function computeCategoryValidation(start: string, end: string, current: boolean) {
  const [live, stored] = await withTimeout(
    Promise.all([fetchOlseraSalesAuditSource(start, end), withMongo(async () => { const { olseraSalesByCategory } = await collections(); return olseraSalesByCategory.find({ date: { $gte: start, $lte: end } }).toArray(); })]),
    CATEGORY_TIMEOUT_MS,
  );
  const liveTotal = live.items.reduce((x, row) => x + (Number.isFinite(row.amount) ? row.amount : 0), 0), liveQty = live.items.reduce((x, row) => x + (Number.isFinite(row.qty) ? row.qty : 0), 0);
  const storedTotal = stored.reduce((x, row) => x + row.totalAmount, 0), storedQty = stored.reduce((x, row) => x + row.qty, 0);
  const status: ValidationStatus = current ? "Data Belum Lengkap" : live.orders.length === 0 ? "Data Belum Lengkap" : liveTotal === storedTotal && liveQty === storedQty ? "Cocok" : "Selisih";
  return { status, label: "Cocok dengan API Olsera", reason: live.orders.length === 0 ? "API Olsera tidak mengembalikan order pada periode ini." : null, ayosera: { qty: storedQty, total: storedTotal }, olseraLive: { qty: liveQty, total: liveTotal }, delta: { qty: liveQty - storedQty, total: liveTotal - storedTotal }, orders: live.orders.length };
}

export async function computeInventoryValidation(year: number, month: number, start: string, end: string) {
  const [live, stored] = await Promise.all([fetchStockMovementRange(start, end), withMongo(async () => { const { olseraInventoryMonthlySnapshots } = await collections(); return olseraInventoryMonthlySnapshots.find({ year, month }).toArray(); })]);
  if (!live.ok) return failedSection("inventory", new Error(live.error));
  const byProduct = new Map(live.rows.map((row) => [String(row.productId), row]));
  const details: Array<{ product: string; ayosera: number | null; olseraLive: number | null; delta: number | null; fields: string[] }> = [];
  for (const row of stored) {
    const liveRow = byProduct.get(String(row.productId));
    if (!liveRow) { details.push({ product: row.productName, ayosera: row.closingQty, olseraLive: null, delta: null, fields: ["product tidak ditemukan"] }); continue; }
    const mapping = { openingQty: "beginningQty", incomingQty: "incomingQty", returnQty: "returnQty", salesQty: "salesQty", outgoingQty: "outgoingQty", closingQty: "sisa" } as const;
    const fields = (Object.keys(mapping) as Array<keyof typeof mapping>).filter((key) => row[key] !== liveRow[mapping[key]]);
    if (fields.length) details.push({ product: row.productName, ayosera: row.closingQty, olseraLive: liveRow.sisa, delta: liveRow.sisa - (row.closingQty ?? 0), fields });
  }
  return { status: (stored.length === 0 || live.rows.length === 0 ? "Data Belum Lengkap" : details.length ? "Selisih" : "Cocok") as ValidationStatus, checked: stored.length, liveItems: live.rows.length, matching: stored.length - details.length, incomplete: stored.length === 0 || live.rows.length === 0 ? stored.length : 0, reason: live.rows.length === 0 ? "Stockmovement API kosong untuk periode ini; tidak dianggap 0/0 Cocok." : null, differences: details, source: "/en/inventory/stockmovement" };
}

export async function computeFinancialValidation(period: string) {
  const periodReports = await withMongo(async () => { const { olseraFinancialMonthlyReports } = await collections(); return olseraFinancialMonthlyReports.find({ period }).toArray(); });
  const live = await Promise.all([getBalanceSheet(period), getProfitLoss(period), getCashFlow(period), getLedgerSummary(period)]);
  const normalized = [normalizeBalanceSheetPayload(live[0]), normalizeProfitLossPayload(live[1]), normalizeCashFlowPayload(live[2]), normalizeLedgerSummaryPayload(live[3])];
  const names = ["balanceSheet", "profitLoss", "cashFlow", "ledgerSummary"] as const;
  const reports = Object.fromEntries(names.map((name, i) => {
    const stored = periodReports.find((x) => x.reportType === ({ balanceSheet: "balance-sheet", profitLoss: "profit-loss", cashFlow: "cash-flow", ledgerSummary: "ledger-summary" } as const)[name]);
    const oldTotals = (stored?.normalizedPayload as { totals?: Record<string, unknown> } | undefined)?.totals ?? {};
    const newTotals = (normalized[i] as { totals?: Record<string, unknown> })?.totals ?? {};
    const totals = Object.fromEntries(Object.keys({ ...oldTotals, ...newTotals }).map((key) => [key, { ayosera: oldTotals[key] ?? null, olsera: newTotals[key] ?? null, delta: typeof oldTotals[key] === "number" && typeof newTotals[key] === "number" ? (newTotals[key] as number) - (oldTotals[key] as number) : null }]));
    return [name, { status: (stored && stable(stored.normalizedPayload) === stable(normalized[i]) ? "Cocok" : "Selisih") as ValidationStatus, detail: stored ? null : "Snapshot AYOSERA belum tersedia.", totals }];
  }));
  const storedLedger = periodReports.find((x) => x.reportType === "ledger-summary")?.normalizedPayload;
  const oldRows = Array.isArray(storedLedger) ? storedLedger as Array<Record<string, unknown>> : [];
  const newRows = Array.isArray(normalized[3]) ? normalized[3] as Array<Record<string, unknown>> : [];
  const oldByCode = new Map(oldRows.map((row) => [String(row.accountCode ?? row.account_code ?? row.code), row]));
  const differences = newRows.flatMap((row) => {
    const code = String(row.accountCode ?? row.account_code ?? row.code);
    const old = oldByCode.get(code);
    return old && stable(old) !== stable(row) ? [{ accountCode: code, name: row.accountName ?? row.name ?? null, ayosera: old, olsera: row }] : [];
  });
  return { ...reports, status: (Object.values(reports).every((x) => x.status === "Cocok") ? "Cocok" : "Selisih") as ValidationStatus, ledgerAccounts: { checked: newRows.length, matching: newRows.length - differences.length, differences } };
}
