import { isCurrentJakartaPeriod, validatePeriod } from "@/lib/olsera-financial-core";
import {
  getFinancialSyncLogForPeriod,
  getLatestSuccessfulFinancialSyncLog,
  getMonthlyReportsForPeriod,
  getFinancialSummaryDiagnostics,
  listFinancialAccounts,
} from "@/lib/olsera-financial-store";
import { guard, json, isDatabaseTimeoutError, withDatabaseRetry } from "../_shared";
import { withTimeout } from "@/lib/with-timeout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const REQUEST_TIMEOUT_MS = 15000;

async function timed<T>(label: string, task: Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await withTimeout(task, REQUEST_TIMEOUT_MS, `snapshot ${label} timeout`);
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
    await timed("auth", guard());
    const url = new URL(req.url);
    const periodParam = url.searchParams.get("period") ?? "";
    const [yearText, monthText] = periodParam.split("-");
    const period = validatePeriod(yearText, monthText);

    const [reports, accounts, syncLog, latestSuccessfulRun, summaryDiagnostics] = await withDatabaseRetry(() =>
      Promise.all([
        timed("monthlyReports", getMonthlyReportsForPeriod(period)),
        timed("accounts", listFinancialAccounts()),
        timed("syncLog", getFinancialSyncLogForPeriod(period)),
        timed("latestSyncLog", getLatestSuccessfulFinancialSyncLog()),
        timed("summaryDiagnostics", getFinancialSummaryDiagnostics(period)),
      ]),
    );

    const hasData = Object.keys(reports).length > 0;

    const allReportsValidated = ["balance-sheet", "profit-loss", "cash-flow", "ledger-summary"].every((type) => reports[type as keyof typeof reports]?.validated === true);
    const currentMonth = isCurrentJakartaPeriod(period);
    const periodStatus = currentMonth ? { code: "current", label: "Bulan Berjalan / Belum Final" } : syncLog?.status === "success" && allReportsValidated ? { code: "final", label: "Final" } : syncLog?.status === "success" ? { code: "waiting-validation", label: "Menunggu Validasi" } : { code: "sync", label: "Sync Belum Selesai" };
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
            failedAccountCodes: syncLog.failedAccountCodes ?? [],
            recoveredAccountCodes: syncLog.recoveredAccountCodes ?? [],
            accountAttempts: syncLog.accountAttempts ?? [],
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
      periodStatus,
      summaryDiagnostics,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (isDatabaseTimeoutError(error)) {
      return json({ status: "timeout", message: "Snapshot laporan keuangan belum merespons dalam batas waktu aman." }, { status: 504 });
    }
    return json({ status: "upstream-error", message: "Gagal membaca snapshot laporan keuangan. Coba lagi." });
  }
}
