// Task 6A.2 — regression test untuk PERBAIKAN C1 (akun ledger gagal tidak
// pernah hilang / run tidak pernah palsu-sukses) dan C2 (identitas dokumen
// ledger stabil terhadap koreksi nilai, tanpa dobel-hitung).
//
// Berbeda dari lib/financial-reconciliation-integrity.test.ts (bukti reproduksi
// bug), file ini menjaga perilaku SESUDAH perbaikan supaya tidak mundur lagi.
//
// Jalankan: npm run test:financial-integrity-fix
import test, { mock } from "node:test";
import assert from "node:assert/strict";

process.env.OLSERA_INTERNAL_STORE_ID = "324175";

const ACCOUNT_CODES = ["10001", "10002", "10003", "40004", "50005"];

/** Kendali perilaku klien Olsera palsu — diatur per skenario. */
const olsera = {
  calls: [] as string[],
  failForever: new Set<string>(),
  failFirstAttempt: new Set<string>(),
  reset(options: { failForever?: string[]; failFirstAttempt?: string[] } = {}) {
    this.calls = [];
    this.failForever = new Set(options.failForever ?? []);
    this.failFirstAttempt = new Set(options.failFirstAttempt ?? []);
  },
  attempts(code: string) {
    return this.calls.filter((item) => item === code).length;
  },
};

mock.module("./olsera-financial-client", {
  namedExports: {
    getAccounts: async () => [
      { data: ACCOUNT_CODES.map((code, index) => ({ account_id: index + 1, account_code: code, account_name: `Akun ${code}` })) },
      { data: [] },
    ],
    getBalanceSheet: async () => ({ data: { assets: { amount: 100 }, liabilityCapital: { amount: 100 } } }),
    getProfitLoss: async () => ({
      data: {
        revenue: { amount: 1000 },
        costOfGoodsSold: { amount: 200 },
        laba_kotor: { amount: 800 },
        operatingExpenses: { amount: 300 },
        nonOperatingIncome: { amount: 0 },
        nonOperatingExpenses: { amount: 0 },
        netProfit: { amount: 500 },
      },
    }),
    getCashFlow: async () => ({
      data: { operational: { amount: 100 }, investing: { amount: 50 }, funding: { amount: 50 }, cashIncrease: { amount: 200 }, openingCash: { amount: 1000 }, endingCash: { amount: 1200 } },
    }),
    getLedgerSummary: async () => ({ "0": { account_id: 1, account_code: "10001", fdebit: "100", fcredit: "0", famount: "100" } }),
    getLedgerDetail: async (_period: string, accountCode: string) => {
      const attempt = olsera.attempts(accountCode) + 1;
      olsera.calls.push(accountCode);
      if (olsera.failForever.has(accountCode) || (olsera.failFirstAttempt.has(accountCode) && attempt === 1)) {
        throw new Error(`Simulated Olsera outage untuk akun ${accountCode}`);
      }
      return { data: [{ transaction_date: "2026-05-05", transaction_no: `TRX-${accountCode}`, transaction_description: "Transaksi normal", fdebit: "10", fcredit: "0", famount: "10" }] };
    },
  },
});

class FakeCollection {
  docs = new Map<string, Record<string, unknown>>();
  /** Jumlah panggilan updateMonthlyReportNormalizedPayload — penanda rekonsiliasi berjalan. */
  reconcileWrites = 0;
  deleteCalls: Array<Record<string, unknown>> = [];

  private matches(doc: Record<string, unknown>, filter: Record<string, unknown>) {
    return Object.entries(filter).every(([key, value]) => {
      if (value && typeof value === "object" && "$ne" in (value as object)) return doc[key] !== (value as { $ne: unknown }).$ne;
      if (value && typeof value === "object" && "$lt" in (value as object)) return (doc[key] as Date) < (value as { $lt: Date }).$lt;
      return doc[key] === value;
    });
  }

  async createIndex() {
    return "ok";
  }

  async updateOne(filter: Record<string, unknown>, update: Record<string, any>, options: { upsert?: boolean } = {}) {
    const keys = Object.keys(update.$set ?? {});
    if (keys.length === 2 && keys.includes("normalizedPayload") && keys.includes("updatedAt")) this.reconcileWrites++;
    const id = filter._id as string;
    const existing = this.docs.get(id);
    if (!existing) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      this.docs.set(id, { ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) });
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 1 };
    }
    this.docs.set(id, { ...existing, ...(update.$set ?? {}) });
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 1 };
  }

  async bulkWrite(ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, any>; upsert?: boolean } }>) {
    for (const op of ops) await this.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert });
    return { ok: 1 };
  }

  async deleteMany(filter: Record<string, unknown>) {
    this.deleteCalls.push(filter);
    let deleted = 0;
    for (const [id, doc] of [...this.docs.entries()]) {
      if (this.matches(doc, filter)) {
        this.docs.delete(id);
        deleted++;
      }
    }
    return { deletedCount: deleted };
  }

  async findOne(filter: Record<string, unknown>) {
    const doc = [...this.docs.values()].find((item) => this.matches(item, filter));
    return doc ? { ...doc } : null;
  }

  async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, any>) {
    await this.updateOne(filter, update, {});
    return this.findOne(filter);
  }

  async countDocuments(filter: Record<string, unknown>) {
    return [...this.docs.values()].filter((doc) => this.matches(doc, filter)).length;
  }

  find(filter: Record<string, unknown> = {}) {
    const docs = [...this.docs.values()].filter((doc) => this.matches(doc, filter)).map((doc) => ({ ...doc }));
    return { toArray: async () => docs };
  }

  aggregate(pipeline: Array<Record<string, any>>) {
    const filter = pipeline.find((stage) => stage.$match)?.$match ?? {};
    const docs = [...this.docs.values()].filter((doc) => this.matches(doc, filter));
    return {
      toArray: async () => [
        {
          debit: docs.reduce((sum, doc) => sum + (Number(doc.debit) || 0), 0),
          credit: docs.reduce((sum, doc) => sum + (Number(doc.credit) || 0), 0),
        },
      ],
    };
  }
}

function fakeCollections() {
  return { monthlyReports: new FakeCollection(), accounts: new FakeCollection(), ledgerEntries: new FakeCollection(), syncLogs: new FakeCollection() };
}

/** Menjalankan step sampai run final (atau batas keras), meniru cron/manual yang memanggil step berulang. */
async function stepUntilFinal(runId: string, fc: ReturnType<typeof fakeCollections>, maxSteps = 40) {
  const { stepFinancialSync } = await import("./olsera-financial-sync.ts");
  let run = await stepFinancialSync(runId, fc);
  let steps = 1;
  while (steps < maxSteps && run && run.status !== "success" && run.finalized !== true) {
    run = await stepFinancialSync(runId, fc);
    steps++;
  }
  return { run, steps };
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

test("C1-1: akun yang gagal sesaat di-retry dan run baru sukses setelah akun itu benar-benar tersimpan", async () => {
  olsera.reset({ failFirstAttempt: ["40004"] });
  const { startFinancialSync } = await import("./olsera-financial-sync.ts");
  const fc = fakeCollections();
  const started = await startFinancialSync(2026, 5, fc);
  const { run } = await stepUntilFinal(started._id, fc);

  assert.equal(run?.status, "success");
  assert.equal(run?.phase, "completed");
  assert.deepEqual(run?.failedAccountCodes, []);
  assert.deepEqual(run?.recoveredAccountCodes, ["40004"]);
  assert.ok(olsera.attempts("40004") >= 2, "akun gagal harus dicoba ulang");
  const stored = [...fc.ledgerEntries.docs.values()].filter((doc) => doc.accountCode === "40004");
  assert.equal(stored.length, 1, "data akun yang pulih harus tersimpan");
});

test("C1-2: akun yang gagal permanen membuat run tetap partial — tidak pernah success/completed", async () => {
  olsera.reset({ failForever: ["40004"] });
  const { startFinancialSync } = await import("./olsera-financial-sync.ts");
  const fc = fakeCollections();
  const started = await startFinancialSync(2026, 5, fc);
  const { run } = await stepUntilFinal(started._id, fc);

  assert.equal(run?.status, "partial");
  assert.notEqual(run?.phase, "completed");
  assert.deepEqual(run?.failedAccountCodes, ["40004"]);
  assert.equal(run?.finalized, true);
  assert.equal(run?.completedAt, null);
});

test("C1-3: errorMessage tidak hilang walau batch berikutnya sukses", async () => {
  olsera.reset({ failForever: ["40004"] });
  const { startFinancialSync, stepFinancialSync } = await import("./olsera-financial-sync.ts");
  const fc = fakeCollections();
  const started = await startFinancialSync(2026, 5, fc);
  await stepFinancialSync(started._id, fc); // monthly-reports
  const afterFailingBatch = await stepFinancialSync(started._id, fc); // batch 1 (akun gagal ikut)
  assert.ok(afterFailingBatch?.errorMessage?.includes("40004"));
  const afterSuccessfulBatch = await stepFinancialSync(started._id, fc); // batch 2 sukses
  assert.ok(afterSuccessfulBatch?.errorMessage?.includes("40004"), "error akun gagal tidak boleh terhapus batch sukses");
});

test("C1-4: rekonsiliasi ledger summary TIDAK dijalankan selama masih ada akun gagal", async () => {
  olsera.reset({ failForever: ["40004"] });
  const { startFinancialSync } = await import("./olsera-financial-sync.ts");
  const fc = fakeCollections();
  const started = await startFinancialSync(2026, 5, fc);
  await stepUntilFinal(started._id, fc);
  assert.equal(fc.monthlyReports.reconcileWrites, 0, "reconcileLedgerSummarySnapshot tidak boleh jalan pada run partial");

  // Pembanding: run yang benar-benar bersih tetap menjalankan rekonsiliasi.
  olsera.reset();
  const clean = fakeCollections();
  const cleanRun = await startFinancialSync(2026, 5, clean);
  const { run } = await stepUntilFinal(cleanRun._id, clean);
  assert.equal(run?.status, "success");
  assert.equal(clean.monthlyReports.reconcileWrites, 1);
});

test("C1-5: retry dibatasi — tidak pernah infinite loop pada akun yang selalu gagal", async () => {
  olsera.reset({ failForever: ["40004"] });
  const { startFinancialSync } = await import("./olsera-financial-sync.ts");
  const fc = fakeCollections();
  const started = await startFinancialSync(2026, 5, fc);
  const { run, steps } = await stepUntilFinal(started._id, fc);

  assert.equal(run?.finalized, true, "run harus berhenti final, bukan berputar terus");
  assert.ok(steps < 40, `run harus final dalam jumlah step wajar, aktual ${steps}`);
  assert.ok(olsera.attempts("40004") <= 3, `percobaan per akun dibatasi, aktual ${olsera.attempts("40004")}`);

  const { stepFinancialSync } = await import("./olsera-financial-sync.ts");
  const before = olsera.attempts("40004");
  await stepFinancialSync(started._id, fc);
  assert.equal(olsera.attempts("40004"), before, "step pada run final harus no-op");
});

test("C1-6: checkpoint akun gagal bertahan lintas invocation (cron resume memakai run yang sama)", async () => {
  olsera.reset({ failForever: ["40004"] });
  const { startFinancialSync, stepFinancialSync } = await import("./olsera-financial-sync.ts");
  const fc = fakeCollections();
  const started = await startFinancialSync(2026, 5, fc);
  await stepFinancialSync(started._id, fc);
  await stepFinancialSync(started._id, fc);

  // Invocation "berikutnya" hanya memegang runId — membaca ulang dari store.
  const { getFinancialSyncRun } = await import("./olsera-financial-store.ts");
  const persisted = await getFinancialSyncRun(started._id, fc);
  assert.deepEqual(persisted?.failedAccountCodes, ["40004"]);
  assert.equal(persisted?.status, "partial");
  assert.equal(fc.syncLogs.docs.size, 1, "resume tidak boleh membuat run doc baru");
});

test("C1-7: manual sync (start ulang) aman — run direset bersih, satu dokumen run, dan bisa sukses", async () => {
  olsera.reset({ failForever: ["40004"] });
  const { startFinancialSync } = await import("./olsera-financial-sync.ts");
  const fc = fakeCollections();
  const first = await startFinancialSync(2026, 5, fc);
  const { run: partial } = await stepUntilFinal(first._id, fc);
  assert.equal(partial?.status, "partial");

  // Olsera pulih -> user klik Sync lagi.
  olsera.reset();
  const second = await startFinancialSync(2026, 5, fc);
  assert.equal(second._id, first._id, "manual sync tidak boleh membuat run kedua untuk periode yang sama");
  assert.equal(second.accountCursor, 0);
  assert.deepEqual(second.failedAccountCodes, []);
  assert.equal(second.finalized, false);
  const { run } = await stepUntilFinal(second._id, fc);
  assert.equal(run?.status, "success");
  assert.equal(fc.syncLogs.docs.size, 1);
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

const PERIOD = "2026-05";

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return { transaction_date: "2026-05-10", transaction_no: "TRX-001", transaction_description: "Penjualan Jasa Lapangan", fdebit: "100", fcredit: "0", famount: "100", ...overrides };
}

async function upsert(accountCode: string, period: string, rows: Array<Record<string, unknown>>, fc: { ledgerEntries: FakeCollection }) {
  const { bulkUpsertLedgerEntries } = await import("./olsera-financial-store.ts");
  const { normalizeLedgerDetailPayload } = await import("./olsera-financial-core.ts");
  const entries = normalizeLedgerDetailPayload({ data: rows }, accountCode).entries as unknown as Array<Record<string, unknown>>;
  await bulkUpsertLedgerEntries(accountCode, period, entries, fc as any);
}

test("C2-1 + C2-2 + C2-3: koreksi nominal mengganti versi lama (satu dokumen, total & listing final)", async () => {
  const { getFinancialLedgerMovementTotals, listAllFinancialLedgerEntriesForPeriod } = await import("./olsera-financial-store.ts");
  const fc = { ledgerEntries: new FakeCollection() };
  await upsert("11105", PERIOD, [ledgerRow()], fc);
  await upsert("11105", PERIOD, [ledgerRow({ fdebit: "125", famount: "125", transaction_description: "Penjualan Jasa Lapangan (revisi)" })], fc);

  assert.equal(fc.ledgerEntries.docs.size, 1);
  const totals = await getFinancialLedgerMovementTotals(PERIOD, "11105", fc as any);
  assert.equal(totals.debit, 125);
  const rows = await listAllFinancialLedgerEntriesForPeriod(PERIOD, fc as any);
  assert.equal(rows.filter((row) => row.transactionNo === "TRX-001").length, 1);
});

test("C2-4: transactionNo sama pada akun berbeda tetap dua dokumen terpisah", async () => {
  const fc = { ledgerEntries: new FakeCollection() };
  await upsert("11105", PERIOD, [ledgerRow()], fc);
  await upsert("40001", PERIOD, [ledgerRow({ fdebit: "0", fcredit: "100" })], fc);
  assert.equal(fc.ledgerEntries.docs.size, 2);
});

test("C2-5: periode berbeda tetap terpisah", async () => {
  const fc = { ledgerEntries: new FakeCollection() };
  await upsert("11105", "2026-05", [ledgerRow()], fc);
  await upsert("11105", "2026-06", [ledgerRow({ transaction_date: "2026-06-10" })], fc);
  assert.equal(fc.ledgerEntries.docs.size, 2);
});

test("C2-6: store berbeda tetap terpisah", async () => {
  const fc = { ledgerEntries: new FakeCollection() };
  await upsert("11105", PERIOD, [ledgerRow()], fc);
  process.env.OLSERA_INTERNAL_STORE_ID = "999999";
  try {
    await upsert("11105", PERIOD, [ledgerRow()], fc);
  } finally {
    process.env.OLSERA_INTERNAL_STORE_ID = "324175";
  }
  assert.equal(fc.ledgerEntries.docs.size, 2);
});

test("C2-7: dua baris VALID dengan transactionNo sama tidak digabung jadi satu dokumen", async () => {
  const fc = { ledgerEntries: new FakeCollection() };
  const rows = [ledgerRow({ fdebit: "100", famount: "100" }), ledgerRow({ fdebit: "40", famount: "140", transaction_description: "Baris kedua jurnal yang sama" })];
  await upsert("11105", PERIOD, rows, fc);
  assert.equal(fc.ledgerEntries.docs.size, 2, "dua baris berbeda pada transaksi yang sama harus tetap dua dokumen");

  // Sync ulang payload yang sama (dengan koreksi nominal baris kedua) tetap dua dokumen, bukan empat.
  await upsert("11105", PERIOD, [rows[0], ledgerRow({ fdebit: "45", famount: "145", transaction_description: "Baris kedua jurnal yang sama" })], fc);
  assert.equal(fc.ledgerEntries.docs.size, 2);
  const debits = [...fc.ledgerEntries.docs.values()].map((doc) => doc.debit).sort();
  assert.deepEqual(debits, [100, 45].sort());
});

test("C2-8: baris lama ber-_id gaya lama dibersihkan HANYA untuk akun+periode yang berhasil di-fetch penuh", async () => {
  const fc = { ledgerEntries: new FakeCollection() };
  const now = new Date(Date.now() - 60_000);
  // Dokumen "warisan" dengan _id hash konten lama (akun 11105) + dokumen akun/periode lain.
  fc.ledgerEntries.docs.set("324175:2026-05:11105:legacyhash", { _id: "324175:2026-05:11105:legacyhash", storeId: 324175, period: PERIOD, accountCode: "11105", transactionNo: "TRX-001", debit: 100, credit: 0, syncedAt: now });
  fc.ledgerEntries.docs.set("324175:2026-05:40001:legacyhash", { _id: "324175:2026-05:40001:legacyhash", storeId: 324175, period: PERIOD, accountCode: "40001", transactionNo: "TRX-001", debit: 100, credit: 0, syncedAt: now });
  fc.ledgerEntries.docs.set("324175:2026-06:11105:legacyhash", { _id: "324175:2026-06:11105:legacyhash", storeId: 324175, period: "2026-06", accountCode: "11105", transactionNo: "TRX-001", debit: 100, credit: 0, syncedAt: now });

  await upsert("11105", PERIOD, [ledgerRow({ fdebit: "125", famount: "125" })], fc);

  assert.ok(!fc.ledgerEntries.docs.has("324175:2026-05:11105:legacyhash"), "baris lama akun+periode yang di-sync harus dibersihkan");
  assert.ok(fc.ledgerEntries.docs.has("324175:2026-05:40001:legacyhash"), "akun lain tidak boleh tersentuh");
  assert.ok(fc.ledgerEntries.docs.has("324175:2026-06:11105:legacyhash"), "periode lain tidak boleh tersentuh");
  for (const filter of fc.ledgerEntries.deleteCalls) {
    assert.equal(filter.storeId, 324175);
    assert.equal(filter.period, PERIOD);
    assert.equal(filter.accountCode, "11105");
  }
});

test("C2-9: fetch akun gagal -> data lama TIDAK dihapus (tidak ada delete sama sekali)", async () => {
  olsera.reset({ failForever: ["40004"] });
  const { startFinancialSync } = await import("./olsera-financial-sync.ts");
  const fc = fakeCollections();
  const legacy = { _id: "324175:2026-05:40004:legacyhash", storeId: 324175, period: PERIOD, accountCode: "40004", transactionNo: "TRX-LAMA", debit: 77, credit: 0, syncedAt: new Date(Date.now() - 60_000) };
  fc.ledgerEntries.docs.set(legacy._id, legacy);

  const started = await startFinancialSync(2026, 5, fc);
  await stepUntilFinal(started._id, fc);

  assert.ok(fc.ledgerEntries.docs.has(legacy._id), "akun yang fetch-nya gagal tidak boleh kehilangan data lamanya");
  for (const filter of fc.ledgerEntries.deleteCalls) assert.notEqual(filter.accountCode, "40004");

  // Payload kosong juga tidak pernah memicu delete.
  const { bulkUpsertLedgerEntries } = await import("./olsera-financial-store.ts");
  const deletesBefore = fc.ledgerEntries.deleteCalls.length;
  await bulkUpsertLedgerEntries("40004", PERIOD, [], fc);
  assert.equal(fc.ledgerEntries.deleteCalls.length, deletesBefore);
  assert.ok(fc.ledgerEntries.docs.has(legacy._id));
});

test("C2-10: saldo awal punya identitas sendiri, tidak tertabrak baris transaksi dan ikut terjaga saat koreksi", async () => {
  const { getFinancialLedgerMovementTotals } = await import("./olsera-financial-store.ts");
  const fc = { ledgerEntries: new FakeCollection() };
  const rows = [
    { transaction_date: "2026-05-01", transaction_description: "Saldo Awal", famount: "500" },
    ledgerRow(),
  ];
  await upsert("11105", PERIOD, rows, fc);
  assert.equal(fc.ledgerEntries.docs.size, 2);

  await upsert("11105", PERIOD, [rows[0], ledgerRow({ fdebit: "125", famount: "625" })], fc);
  const docs = [...fc.ledgerEntries.docs.values()];
  assert.equal(docs.length, 2, "koreksi tidak boleh menduplikasi baris maupun menghapus saldo awal");
  assert.equal(docs.filter((doc) => doc.isOpeningBalance === true).length, 1);
  const totals = await getFinancialLedgerMovementTotals(PERIOD, "11105", fc as any);
  assert.equal(totals.debit, 125, "saldo awal tidak ikut terhitung sebagai pergerakan");
});
