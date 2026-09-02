import "server-only";
import { createHash } from "node:crypto";
import { reconcileLedgerSummaryWithDetails } from "./olsera-financial-core";

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
  emptyLedgerConfirmations?: any;
  staleCleanupAudits?: any;
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

const nonEmptyText = (value: unknown): string | null => {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
};
const pickText = (keys: string[], ...sources: Array<Record<string, unknown>>): string | null => {
  for (const source of sources) for (const key of keys) { const text = nonEmptyText(source[key]); if (text) return text; }
  return null;
};
/** Id transaksi ASLI Olsera bila payload ledger/detail menyertakannya — identitas paling stabil. */
const LEDGER_NATIVE_ID_KEYS = ["id", "transaction_id", "trans_id", "journal_id", "journal_detail_id", "detail_id", "ledger_id"];
/** Identitas BARIS di dalam satu transaksi (jurnal multi-baris), bila disediakan Olsera. */
const LEDGER_LINE_ID_KEYS = ["line_id", "line_no", "detail_no", "seq", "sequence", "row_no", "urut"];

/**
 * Identitas dokumen buku besar (C2). WAJIB stabil terhadap KOREKSI NILAI:
 * nominal (debit/credit/balance), deskripsi, dan raw payload TIDAK BOLEH ikut
 * masuk ke `_id` — bila ikut, koreksi nominal dari Olsera menghasilkan `_id`
 * baru sehingga versi lama jadi yatim dan ikut terjumlah dua kali.
 *
 * Urutan prioritas:
 *  1. id transaksi asli Olsera (bila ada),
 *  2. penanda saldo awal (satu per akun+periode — tidak boleh tertabrak baris transaksi),
 *  3. business key stabil: transactionNo + tanggal + line identifier.
 *
 * `occurrence` > 0 dipakai HANYA untuk membedakan beberapa baris valid dengan
 * business key identik dalam satu payload akun (lihat bulkUpsertLedgerEntries);
 * urutannya berasal dari urutan baris Olsera, bukan dari nominal.
 */
export const ledgerEntryId = (id: number, period: string, code: string, row: Record<string, unknown>, occurrence = 0) => {
  const raw = row.rawPayload && typeof row.rawPayload === "object" ? (row.rawPayload as Record<string, unknown>) : row;
  const suffix = occurrence > 0 ? `#${occurrence}` : "";
  const native = pickText(LEDGER_NATIVE_ID_KEYS, row, raw);
  if (native) return `${id}:${period}:${code}:${native}${suffix}`;
  if (row.isOpeningBalance === true) return `${id}:${period}:${code}:opening${suffix}`;
  const transactionNo = pickText(["transactionNo"], row) ?? pickText(["transaction_no", "journal_no", "no"], raw);
  const date = pickText(["transactionDate"], row) ?? pickText(["transaction_date", "ftransaction_date"], raw);
  const line = pickText(LEDGER_LINE_ID_KEYS, row, raw);
  return `${id}:${period}:${code}:txn:${hash({ transactionNo, date, line })}${suffix}`;
};

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
      emptyLedgerConfirmations: c.olseraFinancialEmptyLedgerConfirmations,
      staleCleanupAudits: c.olseraFinancialStaleCleanupAudits,
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
    emptyLedgerConfirmations: c.olseraFinancialEmptyLedgerConfirmations,
    staleCleanupAudits: c.olseraFinancialStaleCleanupAudits,
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

export async function updateMonthlyReportNormalizedPayload(
  period: string,
  reportType: FinancialMonthlyReportInput["reportType"],
  normalizedPayload: Record<string, unknown>,
  context?: FinancialCollections,
): Promise<void> {
  return runWithCollections(context, async (fc) => {
    await fc.monthlyReports.updateOne(
      { _id: monthlyReportId(storeId(), period, reportType) },
      { $set: { normalizedPayload, updatedAt: new Date() } },
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

/**
 * Jumlah baris ledger tersimpan untuk SATU akun+periode SEKARANG (termasuk
 * saldo awal, sama seperti `totalRecords` dari normalizeLedgerDetailPayload —
 * dipakai cron "revenue re-check mingguan" untuk membandingkan sebelum/
 * sesudah fetch ulang, murni pembacaan, tidak pernah mengubah data.
 */
export async function countLedgerEntriesForAccount(period: string, accountCode: string, context?: FinancialCollections): Promise<number> {
  return runWithReadCollections(context, (fc) => fc.ledgerEntries.countDocuments({ storeId: storeId(), period, accountCode }));
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
    // Discriminator baris ganda: beberapa baris VALID boleh punya business key
    // identik (jurnal multi-baris tanpa line id). Dibedakan lewat urutan
    // kemunculan dalam payload akun ini — stabil dan tidak berbasis nominal,
    // sehingga dua baris berbeda tidak pernah digabung jadi satu dokumen.
    const seen = new Map<string, number>();
    await fc.ledgerEntries.bulkWrite(
      entries.map((row) => {
        const base = ledgerEntryId(id, period, accountCode, row);
        const occurrence = seen.get(base) ?? 0;
        seen.set(base, occurrence + 1);
        const _id = occurrence === 0 ? base : `${base}#${occurrence}`;
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
    // Replace-per-account+periode (Bagian C Task 6A.2): baris LAMA milik akun +
    // periode INI yang tidak ikut ditulis ulang barusan (mis. dokumen dengan
    // `_id` hash-konten dari implementasi lama, atau baris yang sudah dihapus di
    // Olsera) dibuang. Dipilih daripada migrasi `_id` karena tidak butuh membaca
    // /menulis ulang seluruh koleksi historis dan scope-nya sempit.
    //
    // AMAN karena fungsi ini HANYA dipanggil setelah satu akun berhasil di-fetch
    // PENUH dan seluruh barisnya sukses di-upsert (lihat lib/olsera-financial-sync.ts):
    //  - fetch gagal  -> bulkUpsertLedgerEntries tidak pernah dipanggil -> tidak ada delete,
    //  - payload kosong -> early return di atas -> tidak ada delete,
    //  - filter dibatasi storeId + period + accountCode (akun/periode/store lain tidak tersentuh),
    //  - `syncedAt: { $lt: now }` memakai timestamp batch ini sendiri, jadi baris
    //    yang BARU ditulis (syncedAt === now, termasuk saldo awal) mustahil ikut terhapus.
    if (typeof fc.ledgerEntries.deleteMany === "function") {
      await fc.ledgerEntries.deleteMany({ storeId: id, period, accountCode, syncedAt: { $lt: now } });
    }
  });
}

export type FinancialSyncRun = {
  _id: string;
  storeId: number;
  period: string;
  status: "running" | "success" | "partial" | "failed";
  phase: "monthly-reports" | "ledger-details" | "reconcile" | "completed";
  accountCursor: number;
  accountCodes: string[];
  reportsCompleted: string[];
  recordsProcessed: number;
  accountsProcessed: number;
  errorMessage: string | null;
  /** Akun yang gagal disinkronkan dan BELUM pernah berhasil — unik, bertahan lintas invocation. */
  failedAccountCodes: string[];
  /** Akun yang sempat gagal lalu berhasil setelah retry (jejak audit, tidak menghalangi success). */
  recoveredAccountCodes: string[];
  /** Jumlah percobaan per akun — batas keras agar retry tidak pernah tak berujung. */
  accountAttempts: Array<{ code: string; attempts: number }>;
  /** true = run sudah final (success, atau partial dengan akun gagal permanen): step berikutnya no-op. */
  finalized: boolean;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  /**
   * State cron "revenue re-check mingguan" (lib/cron-olsera-revenue-recheck.ts)
   * — TERPISAH SENGAJA dari failedAccountCodes/accountAttempts/finalized di
   * atas, yang khusus untuk akun GAGAL saat sync awal periode ini. Field ini
   * melacak ronde re-fetch periodik untuk akun REVENUE yang SUDAH berhasil
   * (menangkap jurnal susulan/backdated Olsera yang masuk setelah tutup
   * buku). `undefined` = belum pernah ada ronde untuk periode ini.
   */
  revenueRecheck?: {
    /** Snapshot daftar akun SAAT ronde ini dimulai — stabil sepanjang ronde walau konstanta di kode berubah. */
    accountCodes: string[];
    /** 0..accountCodes.length; >= accountCodes.length berarti seluruh akun sudah di-fetch ulang ronde ini. */
    cursor: number;
    roundStartedAt: Date | null;
    /** null = ronde ini masih berjalan (mid-fetch ATAU sudah selesai fetch tapi belum finalisasi laporan). */
    roundFinishedAt: Date | null;
    /** Penghitung kegagalan getLedgerDetail() sepanjang ronde — murni audit, TIDAK menghentikan ronde (akun gagal tetap dilewati, cursor tetap maju). */
    attempts: number;
    /** Akun yang jumlah barisnya berubah dibanding sebelum ronde ini — dipakai memutuskan perlu tidaknya refresh 4 laporan bulanan di akhir ronde. */
    changed: Array<{ code: string; rowsBefore: number; rowsAfter: number; at: Date }>;
  };
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
      failedAccountCodes: [],
      recoveredAccountCodes: [],
      accountAttempts: [],
      finalized: false,
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
    let cursor = fc.monthlyReports.find({ storeId: storeId(), period }, { projection: { rawPayload: 0 } });
    if (typeof cursor.maxTimeMS === "function") cursor = cursor.maxTimeMS(8000);
    const docs = await cursor.toArray();
    const byType: Partial<Record<FinancialMonthlyReportInput["reportType"], FinancialMonthlyReportDocument>> = {};
    for (const doc of docs) byType[doc.reportType as FinancialMonthlyReportInput["reportType"]] = doc;
    return byType;
  });
}

/**
 * Memperbaiki snapshot ledger summary dari detail periode yang sudah ada.
 * Fungsi ini baca detail snapshot lalu menulis hanya normalizedPayload
 * ledger-summary; tidak pernah memanggil Olsera live.
 */
export async function reconcileLedgerSummarySnapshot(
  period: string,
  context?: FinancialCollections,
): Promise<void> {
  const [reports, entries] = await Promise.all([
    getMonthlyReportsForPeriod(period, context),
    listAllFinancialLedgerEntriesForPeriod(period, context),
  ]);
  const report = reports["ledger-summary"];
  if (!report) return;
  const normalizedPayload = reconcileLedgerSummaryWithDetails(report.normalizedPayload, entries);
  // @ts-expect-error — normalizedPayload untuk reportType "ledger-summary" adalah array baris ledger
  // (bukan Record<string, unknown> tunggal seperti tipe parameter fungsi ini); perilaku existing, bukan bug baru.
  await updateMonthlyReportNormalizedPayload(period, "ledger-summary", normalizedPayload, context);
  await zeroConfirmedEmptyLedgerSummaryRows(period, context);
}

/** Safety barrier for an account whose successful empty response was confirmed twice. */
export const EMPTY_LEDGER_CONFIRMATION_COUNT = 2;
export const EMPTY_LEDGER_CONFIRMATION_MIN_GAP_MS = 60_000;

export async function recordLedgerEmptyObservation(
  period: string,
  accountCode: string,
  runId: string,
  invocationId: string,
  context?: FinancialCollections,
  now = new Date(),
): Promise<{ status: "unavailable" | "candidate" | "confirmed"; deletedCount: number }> {
  return runWithCollections(context, async (fc) => {
    const confirmations = fc.emptyLedgerConfirmations;
    if (!confirmations) return { status: "unavailable", deletedCount: 0 };
    const id = `${storeId()}:${period}:${accountCode}`;
    const current = await confirmations.findOne({ _id: id });
    const previous = Array.isArray(current?.observations) ? current.observations : [];
    const last = previous[previous.length - 1];
    if (last?.invocationId === invocationId) return { status: current?.status === "confirmed" ? "confirmed" : "candidate", deletedCount: 0 };
    if (last && now.getTime() - new Date(last.observedAt).getTime() < EMPTY_LEDGER_CONFIRMATION_MIN_GAP_MS) {
      return { status: "candidate", deletedCount: 0 };
    }
    const observation = { runId, invocationId, observedAt: now, rowCount: 0, sourceStatus: "success-empty" };
    const observations = [...previous, observation].slice(-EMPTY_LEDGER_CONFIRMATION_COUNT);
    const confirmed = observations.length >= EMPTY_LEDGER_CONFIRMATION_COUNT;
    await confirmations.updateOne(
      { _id: id },
      { $set: { _id: id, storeId: storeId(), period, accountCode, status: confirmed ? "confirmed" : "candidate", observations, confirmedAt: confirmed ? now : current?.confirmedAt ?? null, updatedAt: now }, $setOnInsert: { createdAt: now, lastNonEmptyAt: null } },
      { upsert: true },
    );
    if (!confirmed) return { status: "candidate", deletedCount: 0 };

    const result = typeof fc.ledgerEntries.deleteMany === "function"
      ? await fc.ledgerEntries.deleteMany({ storeId: storeId(), period, accountCode })
      : { deletedCount: 0 };
    const deletedCount = Number(result?.deletedCount ?? 0);
    const audit = {
      _id: `${id}:${now.getTime()}`,
      storeId: storeId(), period, accountCode, runId,
      reason: "dua pemeriksaan sukses terpisah mengembalikan akun kosong",
      firstCheck: observations[0], secondCheck: observations[1], deletedCount, succeeded: true, createdAt: now,
    };
    if (fc.staleCleanupAudits?.insertOne) await fc.staleCleanupAudits.insertOne(audit);
    return { status: "confirmed", deletedCount };
  });
}

export async function markLedgerNonEmptyObservation(period: string, accountCode: string, context?: FinancialCollections, now = new Date()): Promise<void> {
  return runWithCollections(context, async (fc) => {
    if (!fc.emptyLedgerConfirmations) return;
    const id = `${storeId()}:${period}:${accountCode}`;
    await fc.emptyLedgerConfirmations.updateOne({ _id: id }, { $set: { status: "cancelled", observations: [], lastNonEmptyAt: now, updatedAt: now }, $setOnInsert: { _id: id, storeId: storeId(), period, accountCode, confirmedAt: null, createdAt: now } }, { upsert: true });
  });
}

export async function cleanupConfirmedStaleLedgerAccount(period: string, accountCode: string, context?: FinancialCollections): Promise<{ deletedCount: number; confirmed: boolean }> {
  return runWithCollections(context, async (fc) => {
    if (!fc.staleCleanupAudits) return { deletedCount: 0, confirmed: false };
    const audits = await fc.staleCleanupAudits.find({ storeId: storeId(), period, accountCode, succeeded: true }).sort({ createdAt: -1 }).limit(1).toArray();
    if (!audits.length) return { deletedCount: 0, confirmed: false };
    const result = await fc.ledgerEntries.deleteMany({ storeId: storeId(), period, accountCode });
    await zeroConfirmedEmptyLedgerSummaryRows(period, context);
    return { deletedCount: Number(result?.deletedCount ?? 0), confirmed: true };
  });
}

export async function zeroConfirmedEmptyLedgerSummaryRows(period: string, context?: FinancialCollections): Promise<void> {
  return runWithCollections(context, async (fc) => {
    if (!fc.staleCleanupAudits) return;
    const audits = await fc.staleCleanupAudits.find({ storeId: storeId(), period, succeeded: true }).toArray();
    const codes = [...new Set(audits.map((row: any) => String(row.accountCode)).filter(Boolean))];
    if (!codes.length) return;
    const reports = await getMonthlyReportsForPeriod(period, context);
    const report = reports["ledger-summary"];
    if (!report || !Array.isArray(report.normalizedPayload)) return;
    const entries = await fc.ledgerEntries.find({ storeId: storeId(), period }).toArray();
    const hasDetail = new Set(entries.filter((row: any) => row.isOpeningBalance !== true).map((row: any) => String(row.accountCode)));
    const next = report.normalizedPayload.map((row: any) => codes.includes(String(row.accountCode)) && !hasDetail.has(String(row.accountCode)) ? { ...row, debit: 0, credit: 0, formattedDebit: "0", formattedCredit: "0" } : row);
    // @ts-expect-error — normalizedPayload untuk reportType "ledger-summary" adalah array baris ledger
    // (bukan Record<string, unknown> tunggal seperti tipe parameter fungsi ini); perilaku existing, bukan bug baru.
    await updateMonthlyReportNormalizedPayload(period, "ledger-summary", next, context);
  });
}

export type FinancialSummaryDiagnosticStatus = "Data Lengkap" | "Tidak Ada Transaksi" | "Gagal Disinkronkan" | "Perlu Dicek" | "Kandidat Data Lama";
export async function getFinancialSummaryDiagnostics(period: string, context?: FinancialCollections): Promise<Array<Record<string, unknown>>> {
  return runWithReadCollections(context, async (fc) => {
    const [reports, entries, syncLog, candidates] = await Promise.all([
      getMonthlyReportsForPeriod(period, context),
      listAllFinancialLedgerEntriesForPeriod(period, context),
      getFinancialSyncLogForPeriod(period, context),
      fc.emptyLedgerConfirmations?.find({ storeId: storeId(), period }).toArray() ?? Promise.resolve([]),
    ]);
    const detailTotals = new Map<string, { debit: number; credit: number }>();
    for (const row of entries) { if (row.isOpeningBalance) continue; const code = String(row.accountCode); const total = detailTotals.get(code) ?? { debit: 0, credit: 0 }; total.debit += Number(row.debit) || 0; total.credit += Number(row.credit) || 0; detailTotals.set(code, total); }
    const failed = new Set(readCodesForAudit(syncLog?.failedAccountCodes));
    const candidateMap = new Map((candidates as any[]).map((row: any) => [String(row.accountCode), row]));
    const summary = Array.isArray(reports["ledger-summary"]?.normalizedPayload) ? reports["ledger-summary"]!.normalizedPayload as any[] : [];
    return summary.map((row) => {
      const code = String(row.accountCode ?? ""); const detail = detailTotals.get(code); const candidate = candidateMap.get(code); const summaryDebit = Number(row.debit) || 0; const summaryCredit = Number(row.credit) || 0;
      let status: FinancialSummaryDiagnosticStatus = "Tidak Ada Transaksi";
      if (failed.has(code)) status = "Gagal Disinkronkan";
      else if (candidate?.status === "candidate") status = "Kandidat Data Lama";
      else if (!detail && (summaryDebit !== 0 || summaryCredit !== 0)) status = "Perlu Dicek";
      else if (detail && (Math.abs(summaryDebit - detail.debit) > 1 || Math.abs(summaryCredit - detail.credit) > 1)) status = "Perlu Dicek";
      else if (detail) status = "Data Lengkap";
      return { accountCode: code, accountName: row.accountName ?? null, status, summaryDebit, summaryCredit, detailDebit: detail?.debit ?? 0, detailCredit: detail?.credit ?? 0, failed: failed.has(code), candidateStatus: candidate?.status ?? null };
    });
  });
}

function readCodesForAudit(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : []; }

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
 * SELURUH baris buku besar SATU periode (semua akun, TANPA pagination) —
 * dipakai HANYA oleh export Buku Besar Detail server-side (lib/olsera-financial-export.ts)
 * supaya laporan tidak terpotong pada halaman pertama API pagination
 * (lihat instruksi Tahap 4C). Diurutkan per akun (accountCode) lalu saldo awal
 * dulu lalu tanggal — deterministik, sama seperti halaman UI per akun.
 * rawPayload diproyeksikan keluar (tidak pernah dikirim ke client).
 */
export async function listAllFinancialLedgerEntriesForPeriod(
  period: string,
  context?: FinancialCollections,
): Promise<FinancialLedgerEntryDocument[]> {
  return runWithReadCollections(context, async (fc) => {
    let cursor = fc.ledgerEntries.find({ storeId: storeId(), period }, { projection: { rawPayload: 0 } });
    if (typeof cursor.sort === "function") cursor = cursor.sort({ accountCode: 1, isOpeningBalance: -1, transactionDate: 1, _id: 1 });
    if (typeof cursor.maxTimeMS === "function") cursor = cursor.maxTimeMS(20000);
    return cursor.toArray();
  });
}

/**
 * SELURUH baris buku besar SATU akun SATU periode (tanpa pagination) — dipakai
 * HANYA oleh export "Download Akun Ini" (buildLedgerAccountDetail) supaya
 * laporan per akun tidak terpotong seperti listFinancialLedgerEntriesPage
 * (MAX_LIMIT=200). Urutan sama dengan listFinancialLedgerEntriesPage: saldo
 * awal dulu lalu tanggal. rawPayload diproyeksikan keluar.
 */
export async function listAllFinancialLedgerEntriesForAccount(
  period: string,
  accountCode: string,
  context?: FinancialCollections,
): Promise<FinancialLedgerEntryDocument[]> {
  return runWithReadCollections(context, async (fc) => {
    let cursor = fc.ledgerEntries.find({ storeId: storeId(), period, accountCode }, { projection: { rawPayload: 0 } });
    if (typeof cursor.sort === "function") cursor = cursor.sort({ isOpeningBalance: -1, transactionDate: 1, _id: 1 });
    if (typeof cursor.maxTimeMS === "function") cursor = cursor.maxTimeMS(15000);
    return cursor.toArray();
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
