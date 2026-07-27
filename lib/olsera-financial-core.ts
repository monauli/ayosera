export type FinancialAmount = number | string | null | undefined;
export interface FinancialNode { name: string | null; accountCode: string | null; amount: number; formattedAmount: string | null; children: FinancialNode[]; }
export interface FinancialSection { amount: number; formattedAmount: string | null; children: FinancialNode[]; }

export function parseFinancialAmount(value: FinancialAmount): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value == null || !String(value).trim()) return 0;
  let text = String(value).trim().replace(/^[A-Za-z]{2,5}\s*/i, "").replace(/\s/g, "");
  const negative = /^\(.*\)$/.test(text); text = text.replace(/[()]/g, "");
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
  const parsed = Number(text.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? (negative ? -Math.abs(parsed) : parsed) : 0;
}

export function financialAmount(row: Record<string, unknown>): number {
  for (const key of ["famount", "fdebit", "fcredit"]) if (row[key] != null && String(row[key]).trim() !== "") return parseFinancialAmount(row[key] as FinancialAmount);
  return 0;
}

function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function first(row: Record<string, unknown>, keys: string[]): unknown { return keys.map((key) => row[key]).find((value) => value != null && String(value).trim() !== ""); }
function childrenOf(row: Record<string, unknown>): unknown[] { const value = first(row, ["children", "child", "accounts", "rows", "data"]); return Array.isArray(value) ? value : []; }
function nodeFrom(raw: unknown): FinancialNode {
  const row = asObject(raw); const children = childrenOf(row).map(nodeFrom);
  const rawAmount = first(row, ["famount", "fdebit", "fcredit"]);
  return { name: (first(row, ["name", "account_name", "label"]) as string | undefined) ?? null, accountCode: (first(row, ["accountCode", "account_code", "account_no", "code"]) as string | undefined) ?? null, amount: rawAmount == null ? parseFinancialAmount(first(row, ["amount", "value", "total"]) as FinancialAmount) : parseFinancialAmount(rawAmount as FinancialAmount), formattedAmount: rawAmount == null ? null : String(rawAmount), children };
}
function sectionFrom(raw: unknown): FinancialSection { const row = asObject(raw); const children = childrenOf(row).map(nodeFrom); const rawAmount = first(row, ["famount", "fdebit", "fcredit", "amount", "total", "value"]); return { amount: parseFinancialAmount(rawAmount as FinancialAmount) || children.reduce((sum, child) => sum + child.amount, 0), formattedAmount: rawAmount == null ? null : String(rawAmount), children }; }
function rootFrom(raw: unknown): Record<string, unknown> { const object = asObject(raw); return asObject(object.data ?? object.result ?? object.payload ?? raw); }
function findSection(root: Record<string, unknown>, keys: string[]): unknown { return first(root, keys); }
function normalizeKey(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function findDeepByKey(value: unknown, keys: string[]): unknown {
  const wanted = new Set(keys.map(normalizeKey));
  if (Array.isArray(value)) { for (const item of value) { const found = findDeepByKey(item, keys); if (found != null) return found; } return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(row)) if (wanted.has(normalizeKey(key))) return item;
  for (const item of Object.values(row)) { const found = findDeepByKey(item, keys); if (found != null) return found; }
  return undefined;
}
function findDeepByLabel(value: unknown, labels: string[]): unknown {
  if (Array.isArray(value)) { for (const item of value) { const found = findDeepByLabel(item, labels); if (found != null) return found; } return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const label = String(row.name ?? row.label ?? row.account_name ?? row.title ?? "").toLowerCase();
  if (labels.some((item) => label.includes(item))) return value;
  for (const item of Object.values(row)) { const found = findDeepByLabel(item, labels); if (found != null) return found; }
  return undefined;
}
function semanticSection(root: Record<string, unknown>, keys: string[], labels: string[]): FinancialSection {
  const raw = findDeepByKey(root, keys) ?? findDeepByLabel(root, labels);
  return raw == null ? { amount: 0, formattedAmount: null, children: [] } : sectionFrom(raw);
}
function childByLabel(raw: unknown, labels: string[]): unknown {
  const children = childrenOf(asObject(raw));
  return children.find((child) => { const row = asObject(child); const label = String(row.name ?? row.label ?? row.account_name ?? "").toLowerCase(); return labels.some((item) => label.includes(item)); });
}
export function normalizeBalanceSheetPayload(rawPayload: unknown) {
  const root = rootFrom(rawPayload); const assetsRaw = findSection(root, ["assets", "asset", "total_assets", "totalAssets"]); const liabilityRaw = findSection(root, ["liabilityCapital", "liability_capital", "liabilities_capital", "liability_and_capital", "total_liability_capital"]);
  if (assetsRaw == null || liabilityRaw == null) throw new Error("Struktur Neraca tidak lengkap.");
  const assets = sectionFrom(assetsRaw), liabilityCapital = sectionFrom(liabilityRaw); const difference = assets.amount - liabilityCapital.amount;
  return { assets, liabilityCapital, totals: { totalAssets: assets.amount, totalLiabilityCapital: liabilityCapital.amount, balanced: Math.abs(difference) <= 0.01, difference: Math.abs(difference) <= 0.01 ? 0 : difference } };
}
function sectionByKeys(root: Record<string, unknown>, keys: string[]): FinancialSection { const raw = findSection(root, keys); return raw == null ? { amount: 0, formattedAmount: null, children: [] } : sectionFrom(raw); }
export function normalizeProfitLossPayload(rawPayload: unknown) {
  const root = rootFrom(rawPayload); const operational = asObject(root.operasional ?? root.operating); const source = { ...root, ...operational }; const grossRaw = findDeepByKey(source, ["laba_kotor", "gross_profit"]) ?? findDeepByLabel(source, ["laba kotor", "gross profit"]); const nonOperatingRaw = findDeepByKey(source, ["non_operasional", "nonOperating", "non_operating"]); const revenue = sectionFrom(childByLabel(grossRaw, ["pendapatan"]) ?? operational.pendapatan ?? findDeepByKey(grossRaw, ["revenue", "pendapatan", "total_pendapatan"]) ?? findDeepByKey(source, ["revenue", "total_pendapatan"]) ?? { }); const costOfGoodsSold = sectionFrom(childByLabel(grossRaw, ["biaya pokok", "hpp", "harga pokok"]) ?? operational.hpp ?? findDeepByKey(grossRaw, ["costOfGoodsSold", "cost_of_goods_sold", "hpp"]) ?? findDeepByKey(source, ["costOfGoodsSold", "cost_of_goods_sold", "hpp"]) ?? { }); const grossProfit = sectionFrom(grossRaw ?? { }); const operatingExpenses = semanticSection(source, ["operatingExpenses", "operating_expenses", "biaya_operasional"], ["biaya operasional", "operating expense"]); const operatingIncome = source.operatingIncome == null ? null : sectionFrom(source.operatingIncome); const nonOperatingIncome = sectionFrom(childByLabel(nonOperatingRaw, ["pendapatan non operasional", "pendapatan non-operasional"]) ?? findDeepByKey(nonOperatingRaw, ["pendapatan_non_operasional", "nonOperatingIncome"]) ?? findDeepByKey(source, ["nonOperatingIncome", "non_operating_income", "pendapatan_non_operasional"]) ?? { }); const nonOperatingExpenses = sectionFrom(childByLabel(nonOperatingRaw, ["biaya non operasional", "biaya non-operasional"]) ?? findDeepByKey(nonOperatingRaw, ["biaya_non_operasional", "nonOperatingExpenses"]) ?? findDeepByKey(source, ["nonOperatingExpenses", "non_operating_expenses", "biaya_non_operasional"]) ?? { }); const netNonOperating = nonOperatingRaw == null ? null : sectionFrom(nonOperatingRaw); const netProfit = semanticSection(source, ["netProfit", "net_profit", "laba_bersih"], ["laba bersih", "net profit"]);
  const grossExpected = revenue.amount - costOfGoodsSold.amount; const netExpected = grossExpected - operatingExpenses.amount + nonOperatingIncome.amount - nonOperatingExpenses.amount;
  return { revenue, costOfGoodsSold, grossProfit, operatingExpenses, operatingIncome, nonOperatingIncome, nonOperatingExpenses, netNonOperating, netProfit, totals: { revenue: revenue.amount, costOfGoodsSold: costOfGoodsSold.amount, grossProfit: grossProfit.amount, operatingExpenses: operatingExpenses.amount, nonOperatingIncome: nonOperatingIncome.amount, nonOperatingExpenses: nonOperatingExpenses.amount, netProfit: netProfit.amount, grossProfitValid: Math.abs(grossExpected - grossProfit.amount) <= 0.01, netProfitValid: Math.abs(netExpected - netProfit.amount) <= 0.01 } };
}
export function normalizeCashFlowPayload(rawPayload: unknown) {
  const root = rootFrom(rawPayload);
  const operational = sectionByKeys(root, ["operational", "operasional"]);
  const investing = sectionByKeys(root, ["investing", "investasi"]);
  const funding = sectionByKeys(root, ["funding", "pendanaan"]);
  const cashIncrease = sectionByKeys(root, ["cashIncrease", "cash_increase"]);
  const openingCash = sectionByKeys(root, ["openingCash", "first_cash"]);
  const endingCash = sectionByKeys(root, ["endingCash", "end_cash"]);
  const activity = operational.amount + investing.amount + funding.amount;
  const ending = openingCash.amount + cashIncrease.amount;
  return { operational, investing, funding, cashIncrease, openingCash, endingCash, totals: { operational: operational.amount, investing: investing.amount, funding: funding.amount, cashIncrease: cashIncrease.amount, openingCash: openingCash.amount, endingCash: endingCash.amount, activityTotalValid: Math.abs(activity - cashIncrease.amount) <= 0.01, endingCashValid: Math.abs(ending - endingCash.amount) <= 0.01 } };
}
export function normalizeLedgerSummaryPayload(rawPayload: unknown) {
  const root = asObject(rawPayload);
  const rows = Object.keys(root).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b)).map((key) => {
    const row = asObject(root[key]);
    const debit = parseFinancialAmount(row.fdebit as FinancialAmount);
    const credit = Math.abs(parseFinancialAmount(row.fcredit as FinancialAmount));
    const balance = parseFinancialAmount(row.famount as FinancialAmount);
    return { accountId: (row.account_id ?? row.id ?? null) as string | number | null, accountCode: (row.account_code ?? row.account_no ?? row.code ?? null) as string | null, accountName: (row.account_name ?? row.name ?? null) as string | null, classification: (row.classification ?? row.class ?? null) as string | null, debit, formattedDebit: row.fdebit == null ? null : String(row.fdebit), credit, formattedCredit: row.fcredit == null ? null : String(row.fcredit), balance, formattedBalance: row.famount == null ? null : String(row.famount), rawPayload: row };
  });
  return rows;
}

export type LedgerMovementInput = {
  accountCode?: string | number | null;
  debit?: number | null;
  credit?: number | null;
  isOpeningBalance?: boolean | null;
};

/**
 * Rekonsiliasi Debit/Kredit ringkasan dengan Buku Besar Detail tersimpan.
 * Endpoint ringkasan dapat mengirim angka yang sudah dibulatkan, sedangkan
 * detail periode menyimpan pecahan asli. Saldo tidak disentuh karena itu
 * posisi akun, bukan total pergerakan periode.
 */
export function reconcileLedgerSummaryWithDetails(
  summary: unknown,
  entries: LedgerMovementInput[] | null | undefined,
): Array<Record<string, unknown>> {
  if (!Array.isArray(summary)) return [];
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.isOpeningBalance === true) continue;
    const code = String(entry.accountCode ?? "").trim();
    if (!code) continue;
    const debit = typeof entry.debit === "number" && Number.isFinite(entry.debit) ? entry.debit : 0;
    const credit = typeof entry.credit === "number" && Number.isFinite(entry.credit) ? entry.credit : 0;
    const current = totals.get(code) ?? { debit: 0, credit: 0 };
    current.debit += debit;
    current.credit += credit;
    totals.set(code, current);
  }
  return summary.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object").map((row) => {
    const code = String(row.accountCode ?? "").trim();
    const movement = totals.get(code);
    if (!movement) return row;
    return {
      ...row,
      debit: movement.debit,
      credit: movement.credit,
      formattedDebit: String(movement.debit),
      formattedCredit: String(movement.credit),
    };
  });
}

function rowsFromPayload(rawPayload: unknown): Record<string, unknown>[] {
  if (Array.isArray(rawPayload)) return rawPayload.map(asObject);
  const root = asObject(rawPayload);
  for (const key of ["data", "rows", "items", "transactions", "results"]) {
    const value = root[key];
    if (Array.isArray(value)) return value.map(asObject);
    if (value && typeof value === "object") return Object.keys(value as object).filter((item) => /^\d+$/.test(item)).sort((a, b) => Number(a) - Number(b)).map((item) => asObject((value as Record<string, unknown>)[item]));
  }
  return Object.keys(root).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b)).map((key) => asObject(root[key]));
}
export function normalizeLedgerDetailPayload(rawPayload: unknown, accountCode: string) {
  const rows = rowsFromPayload(rawPayload);
  const entries = rows.map((row) => {
    const date = first(row, ["transaction_date", "ftransaction_date"]); const opening = String(first(row, ["transaction_description", "description", "name"]) ?? "").toLowerCase().includes("saldo awal");
    const debit = opening ? 0 : parseFinancialAmount(first(row, ["fdebit", "debit"]) as FinancialAmount); const credit = opening ? 0 : parseFinancialAmount(first(row, ["fcredit", "credit"]) as FinancialAmount); const balanceRaw = first(row, ["famount", "amount_decimal", "balance"]);
    return { transactionDate: date == null ? null : String(date), formattedTransactionDate: first(row, ["ftransaction_date", "transaction_date"]) == null ? null : String(first(row, ["ftransaction_date", "transaction_date"])), transactionNo: (first(row, ["transaction_no", "journal_no", "no"]) as string | undefined) ?? null, description: (first(row, ["transaction_description", "description", "name"]) as string | undefined) ?? null, debit, formattedDebit: first(row, ["fdebit", "debit"]) == null ? null : String(first(row, ["fdebit", "debit"])), credit, formattedCredit: first(row, ["fcredit", "credit"]) == null ? null : String(first(row, ["fcredit", "credit"])), balance: balanceRaw == null ? null : parseFinancialAmount(balanceRaw as FinancialAmount), formattedBalance: balanceRaw == null ? null : String(balanceRaw), isOpeningBalance: opening, rawPayload: row };
  });
  const openingEntry = entries.find((entry) => entry.isOpeningBalance); const transactions = entries.filter((entry) => !entry.isOpeningBalance); const totalDebit = transactions.reduce((sum, entry) => sum + entry.debit, 0); const totalCredit = transactions.reduce((sum, entry) => sum + entry.credit, 0); const openingBalance = openingEntry?.balance ?? null; const calculatedClosingBalance = totalDebit - totalCredit; const rawClosingBalance = [...entries].reverse().find((entry) => entry.balance != null)?.balance ?? null; const closingBalance = Math.abs((rawClosingBalance ?? 0) - calculatedClosingBalance) <= 0.01 ? rawClosingBalance : calculatedClosingBalance;
  return { accountCode, accountName: (first(rows[0] ?? {}, ["account_name", "name"]) as string | undefined) ?? null, totalRecords: entries.length, openingBalance, closingBalance, totalDebit, totalCredit, calculatedClosingBalance, balanceValid: closingBalance != null && Math.abs(closingBalance - calculatedClosingBalance) <= 0.01, entries };
}
export function normalizeAccounts(payload: unknown): unknown[] { const root = asObject(payload); const rows = Array.isArray(payload) ? payload : (root.data ?? root.rows ?? root.accounts ?? []); return Array.isArray(rows) ? rows : []; }
function nonEmpty(value: unknown): string | null { return value == null || String(value).trim() === "" ? null : String(value).trim(); }
function stableObject(value: unknown): unknown { if (Array.isArray(value)) return value.map(stableObject); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !["created_at", "updated_at"].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableObject(item)])); }
function accountKey(row: Record<string, unknown>): string { const id = nonEmpty(row.account_id ?? row.id); if (id) return `id:${id}`; const number = nonEmpty(row.account_no ?? row.account_code); if (number) return `number:${number}`; const combination = [nonEmpty(row.classification), nonEmpty(row.account_name ?? row.name), nonEmpty(row.parent_id)].join("|"); if (combination.replace(/\|/g, "")) return `combo:${combination}`; return `object:${JSON.stringify(stableObject(row))}`; }
export function deduplicateFinancialAccounts(page1: unknown[], page2: unknown[]): unknown[] { const result: unknown[] = []; const seen = new Set<string>(); for (const item of [...page1, ...page2]) { const row = asObject(item); const key = accountKey(row); if (!seen.has(key)) { seen.add(key); result.push(item); } } return result; }
/** Periode "YYYY-MM" bulan berjalan menurut zona waktu Asia/Jakarta — SATU sumber kebenaran, jangan hitung ulang di tempat lain. */
export function jakartaCurrentPeriod(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" }).format(now);
}

/** Apakah `period` ("YYYY-MM") adalah bulan berjalan menurut Asia/Jakarta (bukan UTC server). */
export function isCurrentJakartaPeriod(period: string, now: Date = new Date()): boolean {
  return period === jakartaCurrentPeriod(now);
}

export function validatePeriod(yearValue: unknown, monthValue: unknown, now = new Date()): string { if (typeof yearValue !== "string" || !/^\d{4}$/.test(yearValue) || typeof monthValue !== "string" || !/^\d{1,2}$/.test(monthValue)) throw new Error("Periode tidak valid."); const year = Number(yearValue), month = Number(monthValue); if (month < 1 || month > 12) throw new Error("Periode tidak valid."); const period = `${year}-${String(month).padStart(2, "0")}`; const jakarta = jakartaCurrentPeriod(now); if (period < "2026-02" || period > jakarta) throw new Error("Periode tidak valid."); return period; }
export type FinancialStatus = "connection-expired" | "no-data" | "upstream-error" | "unreachable" | "not-configured";
export function mapFinancialError(status: number): { status: FinancialStatus; message: string } { if (status === 401 || status === 403) return { status: "connection-expired", message: "Koneksi Olsera kedaluwarsa. Hubungi administrator untuk memperbarui." }; if (status === 404) return { status: "no-data", message: "Tidak ada data untuk periode ini." }; return { status: "upstream-error", message: "Server Olsera sedang bermasalah. Coba lagi." }; }
