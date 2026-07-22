import { validatePeriod } from "@/lib/olsera-financial-core";
import { getFinancialLedgerMovementTotals, listFinancialAccounts, listFinancialLedgerEntriesPage } from "@/lib/olsera-financial-store";
import { guard, json, isDatabaseTimeoutError } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const REQUEST_TIMEOUT_MS = 15000;

const MAX_LIMIT = 200;

async function timed<T>(label: string, task: Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`ledger ${label} timeout`)), REQUEST_TIMEOUT_MS)),
    ]);
  } finally {
    console.info(`[financial-snapshot-ledger] ${label} ${Math.round(performance.now() - started)}ms`);
  }
}

/** Buku Besar per akun — dari snapshot MongoDB (bukan live Olsera). */
export async function GET(req: Request) {
  try {
    await timed("auth", guard());
    const url = new URL(req.url);
    const periodParam = url.searchParams.get("period") ?? "";
    const [yearText, monthText] = periodParam.split("-");
    const period = validatePeriod(yearText, monthText);

    const accountCode = (url.searchParams.get("accountCode") ?? "").trim();
    if (!/^\d{1,20}$/.test(accountCode)) return json({ status: "upstream-error", message: "Nomor akun tidak valid." });

    const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 50)));

    const [{ data, total }, movementTotals, accounts] = await Promise.all([
      timed("ledgerQuery", listFinancialLedgerEntriesPage(period, accountCode, page, limit)),
      timed("movementTotals", getFinancialLedgerMovementTotals(period, accountCode)),
      timed("accounts", listFinancialAccounts()),
    ]);

    const account = accounts.find((row: any) => row.accountCode === accountCode);
    const accountName = account?.accountName ?? data.find((row) => row.accountName)?.accountName ?? null;

    return json({
      status: "success",
      period,
      accountCode,
      accountName,
      data: data.map((row) => ({
        transactionDate: row.transactionDate,
        formattedTransactionDate: row.formattedTransactionDate,
        transactionNo: row.transactionNo,
        description: row.description,
        debit: row.debit,
        credit: row.credit,
        isOpeningBalance: row.isOpeningBalance,
      })),
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      totals: {
        debit: movementTotals.debit,
        credit: movementTotals.credit,
        movement: movementTotals.debit - movementTotals.credit,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (isDatabaseTimeoutError(error)) {
      return json({ status: "timeout", message: "Buku besar belum merespons dalam batas waktu aman." }, { status: 504 });
    }
    return json({ status: "upstream-error", message: "Gagal membaca snapshot laporan keuangan. Coba lagi." });
  }
}
