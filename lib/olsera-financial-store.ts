// @ts-nocheck
import "server-only";
import { createHash } from "node:crypto";

/**
 * Adapter koleksi financial — bentuk minimal yang dibutuhkan store ini, TIDAK
 * bergantung pada tipe/singleton production. Production maupun MongoDB TEST
 * (validator) sama-sama membuat objek berbentuk ini; hanya sumber koneksinya
 * yang beda (lihat runWithCollections di bawah).
 */
export type FinancialCollections = {
  monthlyReports: any;
  accounts: any;
  ledgerEntries: any;
  syncLogs: any;
};
export type FinancialStoreContext = FinancialCollections;

export type FinancialMonthlyReportInput = {
  period: string;
  year: number;
  month: number;
  reportType: "balance-sheet" | "profit-loss" | "cash-flow" | "ledger-summary";
  normalizedPayload: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  sourceEndpoint: string;
  currency: "IDR";
  validated: boolean;
  validationNote: string | null;
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const storeId = () => {
  const value = Number(process.env.OLSERA_INTERNAL_STORE_ID);
  if (!Number.isInteger(value) || value <= 0) throw new Error("Konfigurasi store laporan keuangan tidak valid.");
  return value;
};

export const monthlyReportId = (id: number, period: string, type: string) => `${id}:${period}:${type}`;
export const accountDocumentId = (id: number, row: Record<string, unknown>) =>
  `${id}:account:${row.account_id ?? row.id ?? row.account_code ?? row.account_no ?? hash(row)}`;
export const ledgerEntryId = (id: number, period: string, code: string, row: Record<string, unknown>) =>
  `${id}:${period}:${code}:${row.id ?? hash({ transactionNo: row.transaction_no, date: row.transaction_date, debit: row.debit ?? row.fdebit, credit: row.credit ?? row.fcredit, raw: row })}`;

/**
 * Resolusi koleksi PRODUCTION di-dynamic-import supaya modul ini (dan siapa
 * pun yang memanggilnya, termasuk validator MongoDB TEST) TIDAK PERNAH memuat
 * atau menginisialisasi singleton production di lib/mongodb.ts kecuali jalur
 * production benar-benar dieksekusi (context tidak diberikan). Ini akar
 * perbaikan Tahap 4A: sebelumnya SETIAP fungsi di file ini memanggil
 * withMongo() tanpa syarat — bahkan saat context TEST sudah dipasok — sehingga
 * ensureIndexes() ikut menyentuh mongoClient production (fallback ke
 * 127.0.0.1:27017 karena env belum sempat dimuat saat modul di-import).
 */
async function runWithCollections<T>(
  context: FinancialCollections | undefined,
  handler: (fc: FinancialCollections) => Promise<T>,
): Promise<T> {
  if (context) return handler(context);
  const { collections, withMongo } = await import("./mongodb");
  return withMongo(async () => {
    const c = await collections();
    return handler({
      monthlyReports: c.olseraFinancialMonthlyReports,
      accounts: c.olseraFinancialAccounts,
      ledgerEntries: c.olseraFinancialLedgerEntries,
      syncLogs: c.olseraFinancialSyncLogs,
    });
  });
}

/** Jalur baca snapshot tidak memicu ensureIndexes global untuk seluruh aplikasi. */
async function runWithReadCollections<T>(
  context: FinancialCollections | undefined,
  handler: (fc: FinancialCollections) => Promise<T>,
): Promise<T> {
  if (context) return handler(context);
  const { collections } = await import("./mongodb");
  const c = await collections();
  return handler({
    monthlyReports: c.olseraFinancialMonthlyReports,
    accounts: c.olseraFinancialAccounts,
    ledgerEntries: c.olseraFinancialLedgerEntries,
    syncLogs: c.olseraFinancialSyncLogs,
  });
}

export async function upsertMonthlyReport(input: FinancialMonthlyReportInput, context?: FinancialCollections): Promise<void> {
  return runWithCollections(context, async (fc) => {
    const id = monthlyReportId(storeId(), input.period, input.reportType);
    const now = new Date();
    await fc.monthlyReports.updateOne(
      { _id: id },
      { $set: { ...input, storeId: storeId(), syncedAt: now, updatedAt: now }, $setOnInsert: { _id: id, createdAt: now } },
      { upsert: true },
    );
  });
}

export async function upsertAccounts(rows: unknown[], context?: FinancialCollections): Promise<void> {
  return runWithCollections(context, async (fc) => {
    const id = storeId();
    const now = new Date();
    for (const value of rows) {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const _id = accountDocumentId(id, row);
      await fc.accounts.updateOne(
        { _id },
        {
          $set: {
            _id,
            storeId: id,
            accountId: (row.account_id ?? row.id ?? null) as string | number | null,
            accountCode: String(row.account_code ?? row.account_no ?? row.code ?? "") || null,
            accountName: String(row.account_name ?? row.name ?? "") || null,
            classification: String(row.classification ?? row.class ?? "") || null,
            parentId: (row.parent_id ?? null) as string | number | null,
            isActive: row.is_active !== false,
            rawPayload: row,
            syncedAt: now,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    }
  });
}

export async function bulkUpsertLedgerEntries(
  accountCode: string,
  period: string,
  entries: Array<Record<string, unknown>>,
  context?: FinancialCollections,
): Promise<void> {
  return runWithCollections(context, async (fc) => {
    const id = storeId();
    const now = new Date();
    if (!entries.length) return;
    await fc.ledgerEntries.bulkWrite(
      entries.map((row) => {
        const _id = ledgerEntryId(id, period, accountCode, row);
        return {
          updateOne: {
            filter: { _id },
            update: {
              $set: {
                _id,
                storeId: id,
                period,
                accountCode,
                accountName: row.accountName ?? null,
                transactionDate: row.transactionDate ?? null,
                formattedTransactionDate: row.formattedTransactionDate ?? null,
                transactionNo: row.transactionNo ?? null,
                description: row.description ?? null,
                debit: Number(row.debit ?? 0),
                credit: Number(row.credit ?? 0),
                balance: row.balance == null ? null : Number(row.balance),
                isOpeningBalance: row.isOpeningBalance === true,
                rawPayload: row.rawPayload ?? row,
                syncedAt: now,
                updatedAt: now,
              },
              $setOnInsert: { createdAt: now },
            },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
  });
}

export type FinancialSyncRun = {
  _id: string;
  storeId: number;
  period: string;
  status: "running" | "success" | "partial" | "failed";
  phase: "monthly-reports" | "ledger-details" | "completed";
  accountCursor: number;
  accountCodes: string[];
  reportsCompleted: string[];
  recordsProcessed: number;
  accountsProcessed: number;
  errorMessage: string | null;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export async function createFinancialSyncRun(period: string, accountCodes: string[], context?: FinancialCollections): Promise<FinancialSyncRun> {
  return runWithCollections(context, async (fc) => {
    const id = `financial:${storeId()}:${period}`;
    const now = new Date();
    const run = {
      _id: id,
      storeId: storeId(),
      period,
      status: "running" as const,
      phase: "monthly-reports" as const,
      accountCursor: 0,
      accountCodes,
      reportsCompleted: [],
      recordsProcessed: 0,
      accountsProcessed: 0,
      errorMessage: null,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await fc.syncLogs.updateOne({ _id: id }, { $set: run }, { upsert: true });
    return run;
  });
}

export async function getFinancialSyncRun(runId: string, context?: FinancialCollections): Promise<FinancialSyncRun | null> {
  return runWithCollections(context, (fc) => fc.syncLogs.findOne({ _id: runId }));
}

export async function updateFinancialSyncRun(
  runId: string,
  patch: Record<string, unknown>,
  context?: FinancialCollections,
): Promise<FinancialSyncRun | null> {
  return runWithCollections(context, (fc) =>
    fc.syncLogs.findOneAndUpdate({ _id: runId }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" }),
  );
}

// ---- Read-only helpers untuk UI Laporan Keuangan (Tahap 4B) ----
// Semua fungsi di bawah HANYA membaca snapshot MongoDB yang sudah tersimpan
// (tidak pernah memanggil Olsera live) — dipakai oleh app/api/olsera/financial/snapshot/*.

/** ID sync run deterministik yang sama seperti dipakai createFinancialSyncRun. */
export const financialSyncRunId = (period: string) => `financial:${storeId()}:${period}`;

export type FinancialMonthlyReportDocument = FinancialMonthlyReportInput & {
  _id: string;
  storeId: number;
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/** Keempat laporan bulanan (bila ada) untuk satu periode, dikelompokkan per reportType. */
export async function getMonthlyReportsForPeriod(
  period: string,
  context?: FinancialCollections,
): Promise<Partial<Record<FinancialMonthlyReportInput["reportType"], FinancialMonthlyReportDocument>>> {
  return runWithReadCollections(context, async (fc) => {
    const docs = await fc.monthlyReports.find({ storeId: storeId(), period }, { projection: { rawPayload: 0 } }).maxTimeMS(8000).toArray();
    const byType: Partial<Record<FinancialMonthlyReportInput["reportType"], FinancialMonthlyReportDocument>> = {};
    for (const doc of docs) byType[doc.reportType as FinancialMonthlyReportInput["reportType"]] = doc;
    return byType;
  });
}

/** Katalog akun tersimpan (tidak per-periode — snapshot terbaru storeId). */
export async function listFinancialAccounts(context?: FinancialCollections): Promise<any[]> {
  return runWithReadCollections(context, (fc) =>
    fc.accounts
      .find({ storeId: storeId() }, { projection: { rawPayload: 0 } })
      .sort({ accountCode: 1 })
      .maxTimeMS(8000)
      .toArray(),
  );
}

/** Periode terakhir yang sync-nya berstatus success — dipakai default month-picker UI. */
export async function getLatestSuccessfulFinancialSyncLog(context?: FinancialCollections): Promise<FinancialSyncRun | null> {
  return runWithReadCollections(context, async (fc) => {
    const rows = await fc.syncLogs
      .find({ storeId: storeId(), status: "success" }, { projection: { accountCodes: 0 } })
      .sort({ period: -1 })
      .limit(1)
      .maxTimeMS(8000)
      .toArray();
    return rows[0] ?? null;
  });
}

/**
 * Sync log untuk satu periode spesifik (untuk mendeteksi run yang masih "running" saat halaman dibuka/direfresh).
 * accountCodes SENGAJA disertakan (tidak diproyeksikan keluar): route snapshot memakai
 * accountCodes.length sebagai accountsTotal — memproyeksikannya keluar pernah menyebabkan
 * TypeError runtime setelah semua read sukses (HTTP 200 dengan pesan error generik).
 */
export async function getFinancialSyncLogForPeriod(period: string, context?: FinancialCollections): Promise<FinancialSyncRun | null> {
  return runWithReadCollections(context, (fc) => fc.syncLogs.findOne({ _id: financialSyncRunId(period) }));
}

export type FinancialLedgerEntryDocument = {
  _id: string;
  storeId: number;
  period: string;
  accountCode: string;
  accountName: string | null;
  transactionDate: string | null;
  formattedTransactionDate: string | null;
  transactionNo: string | null;
  description: string | null;
  debit: number;
  credit: number;
  balance: number | null;
  isOpeningBalance: boolean;
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/** Satu halaman baris buku besar (akun+periode), diurutkan saldo awal dulu lalu tanggal. */
export async function listFinancialLedgerEntriesPage(
  period: string,
  accountCode: string,
  page: number,
  limit: number,
  context?: FinancialCollections,
): Promise<{ data: FinancialLedgerEntryDocument[]; total: number }> {
  return runWithReadCollections(context, async (fc) => {
    const filter = { storeId: storeId(), period, accountCode };
    const total = await fc.ledgerEntries.countDocuments(filter, { maxTimeMS: 8000 });
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, limit);
    const data = await fc.ledgerEntries
      .find(filter, { projection: { rawPayload: 0 } })
      .sort({ isOpeningBalance: -1, transactionDate: 1, _id: 1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .maxTimeMS(8000)
      .toArray();
    return { data, total };
  });
}

/**
 * Total debit/kredit buku besar SATU periode (bukan hanya halaman aktif),
 * mengecualikan baris saldo awal — dipakai untuk "Pergerakan Periode"
 * (debit dikurangi kredit), BUKAN saldo berjalan (famount).
 */
export async function getFinancialLedgerMovementTotals(
  period: string,
  accountCode: string,
  context?: FinancialCollections,
): Promise<{ debit: number; credit: number }> {
  return runWithReadCollections(context, async (fc) => {
    const rows = await fc.ledgerEntries
      .aggregate([
        { $match: { storeId: storeId(), period, accountCode, isOpeningBalance: { $ne: true } } },
        { $group: { _id: null, debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } },
      ], { maxTimeMS: 8000 })
      .toArray();
    return { debit: rows[0]?.debit ?? 0, credit: rows[0]?.credit ?? 0 };
  });
}
