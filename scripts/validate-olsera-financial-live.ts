import { readFileSync } from "node:fs";
import { getAccounts, getBalanceSheet, getCashFlow, getFinancialStatus, getLedgerDetail, getLedgerSummary, getProfitLoss } from "../lib/olsera-financial-client.ts";
import { deduplicateFinancialAccounts, normalizeAccounts, normalizeBalanceSheetPayload, normalizeCashFlowPayload, normalizeLedgerDetailPayload, normalizeLedgerSummaryPayload, normalizeProfitLossPayload, validatePeriod } from "../lib/olsera-financial-core.ts";

function loadLocalEnv(): void {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch { /* Environment may already be provided by the shell. */ }
}

const expected = {
  accounts: 85, assets: 2519025675.61, liabilityCapital: 2519025675.61,
  revenue: 351707500, cogs: 42162139.51, gross: 309545360.49, opex: 178852843,
  nonOperatingIncome: 77522.77, nonOperatingExpenses: 1322013.02, netProfit: 129448027.24,
  cashOperational: 252572176.75, cashInvesting: -5350000, cashFunding: 0,
  cashIncrease: 247222176.75, openingCash: 346987623.54, endingCash: 594209800.29,
  ledgerAccounts: 85, ledgerDebit: 370361514, ledgerCredit: 120030000, ledgerBalance: 250331513.75,
};
const tolerance = 0.01;
function numeric(value: unknown): number { const result = typeof value === "number" ? value : Number(value); if (!Number.isFinite(result)) throw new Error("invalid-financial-number"); return result; }
function close(actual: unknown, wanted: unknown): boolean { const actualNumber = numeric(actual), wantedNumber = numeric(wanted); return Math.abs(actualNumber - wantedNumber) <= tolerance; }
function fail(label: string, expectedValue: unknown, actual: unknown): never { const expectedText = String(expectedValue), actualText = String(actual); const expectedNumber = Number(expectedValue), actualNumber = Number(actual); const difference = Number.isFinite(expectedNumber) && Number.isFinite(actualNumber) ? `\n  difference ${actualNumber - expectedNumber}` : ""; console.error(`[FAIL] ${label}\n  expected ${expectedText}, received ${actualText}${difference}`); throw new Error("validation-failed"); }
function pass(label: string): void { console.log(`[PASS] ${label}`); }

async function main(): Promise<void> {
  loadLocalEnv();
  const argument = process.argv.find((value) => value.startsWith("--period="));
  const periodInput = argument?.slice("--period=".length) || process.env.OLSERA_FINANCIAL_BASELINE_PERIOD || "2026-02";
  const periodMatch = /^(\d{4})-(\d{1,2})$/.exec(periodInput);
  if (!periodMatch) { console.error("[FAIL] Configuration\n  invalid period"); process.exitCode = 2; return; }
  let period: string;
  try { period = validatePeriod(periodMatch[1], periodMatch[2]); } catch { console.error("[FAIL] Configuration\n  invalid period"); process.exitCode = 2; return; }
  try {
    const status = await getFinancialStatus();
    if (!status.connected) { console.error(`[FAIL] Connection\n  status ${status.status}`); process.exitCode = 2; return; }
    pass("Connection");
    const accountArgument = process.argv.find((value) => value.startsWith("--account=")); const accountCode = accountArgument?.slice("--account=".length) || "11105";
    const [accountPages, rawBalance, rawProfit, rawCash, rawLedger, rawDetail] = await Promise.all([
      getAccounts(Number(period.slice(0, 4)), Number(period.slice(5))), getBalanceSheet(period), getProfitLoss(period), getCashFlow(period), getLedgerSummary(period), getLedgerDetail(period, accountCode),
    ]);
    const accounts = deduplicateFinancialAccounts(normalizeAccounts(accountPages[0]), normalizeAccounts(accountPages[1]));
    if (period === "2026-05" && accounts.length !== expected.accounts) fail("Accounts", expected.accounts, accounts.length);
    pass(`Accounts: ${accounts.length}`);
    const balance = normalizeBalanceSheetPayload(rawBalance);
    if (period === "2026-05" && (!close(balance.totals.totalAssets, expected.assets) || !close(balance.totals.totalLiabilityCapital, expected.liabilityCapital) || !balance.totals.balanced)) fail("Balance Sheet", "balanced", `${balance.totals.totalAssets} / ${balance.totals.totalLiabilityCapital}`);
    pass("Balance Sheet");
    const profit = normalizeProfitLossPayload(rawProfit);
    if (period === "2026-05" && (!close(profit.totals.revenue, expected.revenue) || !close(profit.totals.costOfGoodsSold, expected.cogs) || !close(profit.totals.grossProfit, expected.gross) || !close(profit.totals.operatingExpenses, expected.opex) || !close(profit.totals.nonOperatingIncome, expected.nonOperatingIncome) || !close(profit.totals.nonOperatingExpenses, expected.nonOperatingExpenses) || !close(profit.totals.netProfit, expected.netProfit) || !profit.totals.grossProfitValid || !profit.totals.netProfitValid)) fail("Profit Loss", expected.revenue, profit.totals.revenue);
    pass("Profit Loss");
    const cash = normalizeCashFlowPayload(rawCash);
    if (period === "2026-05" && (!close(cash.totals.operational, expected.cashOperational) || !close(cash.totals.investing, expected.cashInvesting) || !close(cash.totals.funding, expected.cashFunding) || !close(cash.totals.cashIncrease, expected.cashIncrease) || !close(cash.totals.openingCash, expected.openingCash) || !close(cash.totals.endingCash, expected.endingCash) || !cash.totals.activityTotalValid || !cash.totals.endingCashValid)) fail("Cash Flow", expected.cashIncrease, cash.totals.cashIncrease);
    pass("Cash Flow");
    const ledger = normalizeLedgerSummaryPayload(rawLedger);
    if (period === "2026-05" && ledger.length !== expected.ledgerAccounts) fail("Ledger Summary", expected.ledgerAccounts, ledger.length);
    pass(`Ledger Summary: ${ledger.length}`);
    const account = ledger.find((row) => String(row.accountCode ?? "") === "11105" || String(row.accountId ?? "") === "11105");
    if (!account || (period === "2026-05" && (!close(account.debit, expected.ledgerDebit) || !close(account.credit, expected.ledgerCredit) || !close(account.balance, expected.ledgerBalance)))) fail("Ledger account 11105", expected.ledgerBalance, account?.balance ?? "missing");
    pass("Ledger account 11105");
    const detail = normalizeLedgerDetailPayload(rawDetail, accountCode);
    if (period === "2026-05" && (!accountCode || detail.totalRecords !== 91 || detail.entries.filter((entry) => entry.isOpeningBalance).length !== 1 || !close(detail.totalDebit, 370361513.75) || !close(detail.totalCredit, 120030000) || !close(detail.calculatedClosingBalance ?? NaN, 250331513.75) || !detail.balanceValid)) fail(`Ledger Detail account ${accountCode}`, 370361513.75, detail.totalDebit);
    pass(`Ledger Detail account ${accountCode}`);
    console.log("Financial live validation: PASSED");
  } catch (error) { if (error instanceof Error && error.message === "validation-failed") { process.exitCode = 1; return; } console.error("[FAIL] Connection\n  unable to validate configured upstream"); process.exitCode = 2; }
}
main().catch(() => { process.exitCode = 2; });
