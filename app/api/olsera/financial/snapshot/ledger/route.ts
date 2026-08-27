import { validatePeriod } from "@/lib/olsera-financial-core";
import { computeRunningLedgerBalances, ledgerMovementForDisplay } from "@/lib/olsera-financial-export-core";
import { getFinancialLedgerMovementTotals, listAllFinancialLedgerEntriesForAccount, listFinancialAccounts } from "@/lib/olsera-financial-store";
import { guard, json, isDatabaseTimeoutError, withDatabaseRetry } from "../../_shared";
import { withTimeout } from "@/lib/with-timeout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const REQUEST_TIMEOUT_MS = 15000;

const MAX_LIMIT = 200;

async function timed<T>(label: string, task: Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await withTimeout(task, REQUEST_TIMEOUT_MS, `ledger ${label} timeout`);
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

    const [allRows, movementTotals, accounts] = await withDatabaseRetry(() =>
      Promise.all([
        timed("ledgerQuery", listAllFinancialLedgerEntriesForAccount(period, accountCode)),
        timed("movementTotals", getFinancialLedgerMovementTotals(period, accountCode)),
        timed("accounts", listFinancialAccounts()),
      ]),
    );

    // Saldo berjalan = saldo awal + KUMULATIF famount (row.balance) seluruh
    // baris akun, bukan kumulatif debit-kredit: famount sudah mengikuti sisi
    // normal akun, jadi memakai debit-kredit membalik tanda akun kredit-normal
    // (lihat commit 4e0809b). computeRunningLedgerBalances SATU-SATUNYA titik
    // hitung, sama dipakai Excel & PDF (lib/olsera-financial-export-core.ts)
    // supaya UI/Excel/PDF tidak pernah berbeda formula. Diambil TANPA
    // pagination lalu dipotong di memori supaya saldo baris N tidak pernah
    // hilang konteks baris 1..N-1 dari halaman sebelumnya.
    const withBalances = computeRunningLedgerBalances(allRows);
    const total = withBalances.length;
    const start = (page - 1) * limit;
    const data = withBalances.slice(start, start + limit);

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
        balance: row.balance,
        isOpeningBalance: row.isOpeningBalance,
      })),
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      totals: {
        debit: movementTotals.debit,
        credit: movementTotals.credit,
        movement: ledgerMovementForDisplay(accountCode, movementTotals.debit, movementTotals.credit),
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
