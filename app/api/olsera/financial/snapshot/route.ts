import { validatePeriod } from "@/lib/olsera-financial-core";
import {
  getFinancialSyncLogForPeriod,
  getLatestSuccessfulFinancialSyncLog,
  getMonthlyReportsForPeriod,
  listFinancialAccounts,
} from "@/lib/olsera-financial-store";
import { readGuard, json, isDatabaseTimeoutError, withDatabaseRetry } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const REQUEST_TIMEOUT_MS = 15000;

async function timed<T>(label: string, task: Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`snapshot ${label} timeout`)), REQUEST_TIMEOUT_MS)),
    ]);
  } finally {
    console.info(`[financial-snapshot] ${label} ${Math.round(performance.now() - started)}ms`);
  }
}

/**
 * Snapshot MongoDB Laporan Keuangan — BERBEDA dari /api/olsera/financial/{balance-sheet,...}
 * yang selalu memanggil Olsera live. Route ini HANYA membaca data yang sudah
 * disinkronkan (lib/olsera-financial-store.ts), jadi UI tidak pernah
 * mengakses Olsera langsung dan tidak pernah menampilkan token/URI mentah.
 */
export async function GET(req: Request) {
  try {
    await timed("auth", readGuard());
    const url = new URL(req.url);
    const periodParam = url.searchParams.get("period") ?? "";
    const [yearText, monthText] = periodParam.split("-");
    const period = validatePeriod(yearText, monthText);

    const [reports, accounts, syncLog, latestSuccessfulRun] = await withDatabaseRetry(() =>
      Promise.all([
        timed("monthlyReports", getMonthlyReportsForPeriod(period)),
        timed("accounts", listFinancialAccounts()),
        timed("syncLog", getFinancialSyncLogForPeriod(period)),
        timed("latestSyncLog", getLatestSuccessfulFinancialSyncLog()),
      ]),
    );

    const hasData = Object.keys(reports).length > 0;

    return json({
      status: "success",
      period,
      latestSyncedPeriod: latestSuccessfulRun?.period ?? null,
      hasData,
      syncLog: syncLog
        ? {
            runId: syncLog._id,
            status: syncLog.status,
            phase: syncLog.phase,
            accountsProcessed: syncLog.accountsProcessed,
            accountsTotal: syncLog.accountCodes?.length ?? 0,
            recordsProcessed: syncLog.recordsProcessed,
            errorMessage: syncLog.errorMessage,
            completedAt: syncLog.completedAt ? new Date(syncLog.completedAt).toISOString() : null,
          }
        : null,
      reports: {
        balanceSheet: reports["balance-sheet"]?.normalizedPayload ?? null,
        profitLoss: reports["profit-loss"]?.normalizedPayload ?? null,
        cashFlow: reports["cash-flow"]?.normalizedPayload ?? null,
        ledgerSummary: reports["ledger-summary"]?.normalizedPayload ?? null,
      },
      accounts: accounts.map((row: any) => ({
        accountCode: row.accountCode ?? null,
        accountName: row.accountName ?? null,
        classification: row.classification ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (isDatabaseTimeoutError(error)) {
      return json({ status: "timeout", message: "Snapshot laporan keuangan belum merespons dalam batas waktu aman." }, { status: 504 });
    }
    return json({ status: "upstream-error", message: "Gagal membaca snapshot laporan keuangan. Coba lagi." });
  }
}
