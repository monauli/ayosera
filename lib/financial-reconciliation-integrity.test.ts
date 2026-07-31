// Task 6A.1 — Proof of Reproduction untuk dua temuan CRITICAL dari Task 6
// Financial Reconciliation Audit (tmp/ai-handoff.md, Temuan Critical C1/C2).
//
// INI BUKAN test regresi biasa: seluruh test di file ini SENGAJA dibuat untuk
// GAGAL terhadap implementasi produksi saat ini, sebagai bukti reproduksi bug
// yang sudah diaudit. Assertion menyatakan perilaku yang SEHARUSNYA benar —
// bukan perilaku aktual. Jangan "menghijaukan" test ini dengan melemahkan
// assertion; test ini baru boleh PASS setelah Task 6A.2 (perbaikan C1/C2)
// selesai dan diverifikasi terpisah.
//
// C1 — lib/olsera-financial-sync.ts:19 (fase "ledger-details"): satu akun
// yang gagal di tengah batch tidak pernah dicoba ulang (cursor tetap maju),
// dan status "partial" bisa tertimpa "success" begitu batch BERIKUTNYA (pada
// invocation cron yang berbeda, tanpa restart — lib/cron-olsera-financial.ts
// tidak punya percabangan khusus untuk status "partial", hanya "success" yang
// membuat no-op) kebetulan sukses.
//
// C2 — lib/olsera-financial-store.ts:43-44,146-190: `_id` dokumen ledger
// adalah hash KONTEN (bukan id transaksi stabil), dan `bulkUpsertLedgerEntries`
// tidak pernah membersihkan dokumen lama. Ketika Olsera mengoreksi satu field
// transaksi yang sudah pernah disinkron, hash berubah -> dokumen baru dibuat,
// dokumen lama jadi yatim dan tetap ikut terhitung.
//
// Jalankan test ini SENDIRI (tidak masuk rantai npm run test:unit — lihat
// catatan di tmp/ai-handoff.md tentang alasan tidak diikutsertakan):
//   npm run test:financial-reconciliation-integrity
import test, { mock } from "node:test";
import assert from "node:assert/strict";

process.env.OLSERA_INTERNAL_STORE_ID = "324175";

// ---------------------------------------------------------------------------
// C1 — mock klien Olsera: 5 akun (lebih dari satu batch, batch size = 4 pada
// lib/olsera-financial-sync.ts), satu akun ("40004") SELALU gagal saat
// getLedgerDetail dipanggil untuk membuktikan ia tidak pernah pulih sendiri.
// ---------------------------------------------------------------------------

const FAILING_ACCOUNT_CODE = "40004";

const ledgerDetailCallLog: string[] = [];

mock.module("./olsera-financial-client", {
  namedExports: {
    getAccounts: async () => [
      {
        data: [
          { account_id: 1, account_code: "10001", account_name: "Kas" },
          { account_id: 2, account_code: "10002", account_name: "Bank" },
          { account_id: 3, account_code: "10003", account_name: "Piutang Usaha" },
          { account_id: 4, account_code: FAILING_ACCOUNT_CODE, account_name: "Akun Bermasalah" },
          { account_id: 5, account_code: "50005", account_name: "Beban Operasional" },
        ],
      },
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
      data: {
        operational: { amount: 100 },
        investing: { amount: 50 },
        funding: { amount: 50 },
        cashIncrease: { amount: 200 },
        openingCash: { amount: 1000 },
        endingCash: { amount: 1200 },
      },
    }),
    getLedgerSummary: async () => ({ "0": { account_id: 1, account_code: "10001", fdebit: "100", fcredit: "0", famount: "100" } }),
    getLedgerDetail: async (_period: string, accountCode: string) => {
      ledgerDetailCallLog.push(accountCode);
      if (accountCode === FAILING_ACCOUNT_CODE) {
        throw new Error(`Simulated Olsera outage untuk akun ${FAILING_ACCOUNT_CODE}`);
      }
      return {
        data: [
          { transaction_date: "2026-05-05", transaction_description: "Transaksi normal", fdebit: "10", fcredit: "0", famount: "10" },
        ],
      };
    },
  },
});

/** Koleksi palsu in-memory — subset minimum yang dipakai lib/olsera-financial-store.ts. */
class FakeCollection {
  docs = new Map<string, Record<string, unknown>>();

  private matches(doc: Record<string, unknown>, filter: Record<string, unknown>) {
    return Object.entries(filter).every(([key, value]) => doc[key] === value);
  }

  async createIndex() {
    return "ok";
  }

  // PENTING (bukan bug produksi, bug fixture): setiap update membuat OBJEK BARU
  // (immutable-update), tidak pernah `Object.assign` ke objek lama secara in-place.
  // MongoDB sungguhan selalu mengembalikan dokumen sebagai snapshot baru — bila
  // fixture ini memutasi objek lama secara in-place, sebuah `run` yang sudah
  // dikembalikan ke pemanggil (mis. `afterFirstBatch`) akan ikut "berubah sendiri"
  // ketika step BERIKUTNYA menulis ulang dokumen yang sama, membuat assertion pada
  // snapshot lama tidak valid — persis skenario yang perlu dibedakan tegas dari
  // batch berikutnya pada test reproduksi C1 di file ini.
  async updateOne(filter: Record<string, unknown>, update: Record<string, any>, options: { upsert?: boolean } = {}) {
    const id = filter._id as string;
    const existing = this.docs.get(id);
    if (!existing) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const inserted = { ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) };
      this.docs.set(id, inserted);
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 1 };
    }
    const merged = { ...existing, ...(update.$set ?? {}) };
    this.docs.set(id, merged);
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 1 };
  }

  async bulkWrite(ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, any>; upsert?: boolean } }>) {
    for (const op of ops) await this.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert });
    return { ok: 1 };
  }

  async findOne(filter: Record<string, unknown>) {
    const doc = [...this.docs.values()].find((doc) => this.matches(doc, filter));
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
}

function fakeCollections() {
  return {
    monthlyReports: new FakeCollection(),
    accounts: new FakeCollection(),
    ledgerEntries: new FakeCollection(),
    syncLogs: new FakeCollection(),
  };
}

/**
 * Menjalankan urutan LENGKAP yang membuktikan C1:
 *  1. monthly-reports (1 step)
 *  2. batch ledger-details PERTAMA (akun 10001,10002,10003,40004) — 40004 gagal
 *  3. batch ledger-details KEDUA (akun 50005) — sukses, dipanggil dari
 *     invocation TERPISAH memakai runId yang SAMA, persis seperti
 *     lib/cron-olsera-financial.ts:100-102 melanjutkan checkpoint "partial"
 *     tanpa restart (satu-satunya percabangan khusus di sana adalah untuk
 *     status "success", bukan "partial" — lihat baris 81 file itu).
 */
async function reproduceC1() {
  ledgerDetailCallLog.length = 0;
  const { startFinancialSync, stepFinancialSync } = await import("./olsera-financial-sync.ts");
  const fc = fakeCollections();

  let run = await startFinancialSync(2026, 5, fc);
  run = await stepFinancialSync(run._id, fc); // fase monthly-reports -> ledger-details
  assert.equal(run.phase, "ledger-details", "setup rusak: sync belum sampai fase ledger-details");

  const afterFirstBatch = await stepFinancialSync(run._id, fc); // batch 1: akun gagal ikut di sini
  const afterSecondBatch = await stepFinancialSync(afterFirstBatch._id, fc); // batch 2 (invocation terpisah, checkpoint sama)

  return { fc, afterFirstBatch, afterSecondBatch, ledgerDetailCallLog: [...ledgerDetailCallLog] };
}

test("financial sync must not report success after a failed ledger account is skipped", async () => {
  const { afterFirstBatch, afterSecondBatch, ledgerDetailCallLog: calls } = await reproduceC1();

  // Kondisi awal (bukti akun benar-benar gagal pada batch pertama):
  assert.equal(
    afterFirstBatch.status,
    "partial",
    `Setup reproduksi tidak sesuai skenario: status setelah batch pertama seharusnya "partial" karena akun ` +
      `${FAILING_ACCOUNT_CODE} gagal. Status aktual: "${afterFirstBatch.status}".`,
  );

  // --- Perilaku yang SEHARUSNYA benar ---
  // Run tidak boleh dianggap "success" selama akun yang pernah gagal belum
  // pernah berhasil disinkron ulang secara spesifik.
  const failingAccountRetries = calls.filter((code) => code === FAILING_ACCOUNT_CODE).length;
  assert.notEqual(
    afterSecondBatch.status,
    "success",
    `Run TIDAK BOLEH berstatus "success" selama akun ${FAILING_ACCOUNT_CODE} belum pernah berhasil disinkron ulang.\n` +
      `  Status yang diharapkan : bukan "success" (mis. tetap "partial", atau field terpisah menandai akun gagal)\n` +
      `  Status aktual          : "${afterSecondBatch.status}"\n` +
      `  phase aktual           : "${afterSecondBatch.phase}"\n` +
      `  Akun gagal             : ${FAILING_ACCOUNT_CODE}\n` +
      `  Akun gagal di-retry?   : ${failingAccountRetries >= 2 ? "ya" : "tidak"} (dipanggil getLedgerDetail ${failingAccountRetries}x, seharusnya >= 2)`,
  );
});

test("failed ledger account must be retried, not permanently skipped", async () => {
  const { ledgerDetailCallLog: calls } = await reproduceC1();
  const callsForFailingAccount = calls.filter((code) => code === FAILING_ACCOUNT_CODE).length;
  assert.ok(
    callsForFailingAccount >= 2,
    `Akun ${FAILING_ACCOUNT_CODE} yang gagal pada batch pertama harus dicoba ulang sebelum run dianggap selesai.\n` +
      `  Jumlah percobaan yang diharapkan : >= 2\n` +
      `  Jumlah percobaan aktual          : ${callsForFailingAccount}\n` +
      `  Kesimpulan                       : akun ini di-skip permanen begitu cursor melewatinya (lib/olsera-financial-sync.ts:19).`,
  );
});

test("sync error message must not be silently cleared once a later batch succeeds", async () => {
  const { afterSecondBatch } = await reproduceC1();
  assert.ok(
    afterSecondBatch.errorMessage,
    `errorMessage seharusnya tetap mencatat kegagalan akun ${FAILING_ACCOUNT_CODE} walau batch berikutnya sukses.\n` +
      `  errorMessage yang diharapkan : string non-null yang menyebut kegagalan\n` +
      `  errorMessage aktual          : ${JSON.stringify(afterSecondBatch.errorMessage)}\n` +
      `  status akhir aktual          : "${afterSecondBatch.status}"`,
  );
});

test("ledger-summary reconciliation must not treat a run with a permanently skipped account as complete", async () => {
  const { fc } = await reproduceC1();
  const storedForFailingAccount = [...fc.ledgerEntries.docs.values()].filter((doc) => doc.accountCode === FAILING_ACCOUNT_CODE);
  assert.ok(
    storedForFailingAccount.length > 0,
    `Setelah run dianggap selesai, akun ${FAILING_ACCOUNT_CODE} seharusnya sudah punya entri buku besar tersimpan ` +
      `(karena reconcileLedgerSummarySnapshot otomatis berjalan begitu run dianggap "completed").\n` +
      `  Entri tersimpan yang diharapkan : > 0\n` +
      `  Entri tersimpan aktual          : ${storedForFailingAccount.length}\n` +
      `  Kesimpulan                      : data akun ini hilang PERMANEN walau sync dianggap sukses & rekonsiliasi sudah jalan.`,
  );
});

// ---------------------------------------------------------------------------
// C2 — ledger correction menghasilkan dokumen duplikat + dobel-hitung.
// Tidak memakai FakeCollection/mock klien di atas — menguji langsung
// lib/olsera-financial-store.ts dan lib/olsera-financial-core.ts (REAL,
// tidak dimock) dengan koleksi in-memory terisolasi.
// ---------------------------------------------------------------------------

/** Koleksi ledger palsu yang juga mendukung .aggregate() sederhana (subset getFinancialLedgerMovementTotals). */
class FakeAggregatableLedgerCollection {
  docs = new Map<string, Record<string, unknown>>();

  // Immutable-update yang sama seperti FakeCollection di atas — lihat komentar
  // di sana untuk alasannya (bukan bug produksi, mencegah aliasing objek lama).
  async bulkWrite(ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, any>; upsert?: boolean } }>) {
    for (const op of ops) {
      const { filter, update, upsert } = op.updateOne;
      const id = filter._id as string;
      const existing = this.docs.get(id);
      if (!existing) {
        if (!upsert) continue;
        this.docs.set(id, { ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) });
        continue;
      }
      this.docs.set(id, { ...existing, ...(update.$set ?? {}) });
    }
    return { ok: 1 };
  }

  find(filter: Record<string, unknown> = {}) {
    const docs = [...this.docs.values()]
      .filter((doc) => Object.entries(filter).every(([key, value]) => doc[key] === value))
      .map((doc) => ({ ...doc }));
    return { toArray: async () => docs };
  }

  aggregate(pipeline: Array<Record<string, any>>) {
    const matchStage = pipeline.find((stage) => stage.$match);
    const filter: Record<string, unknown> = matchStage ? matchStage.$match : {};
    const matchesValue = (actual: unknown, expected: unknown) => {
      if (expected && typeof expected === "object" && "$ne" in (expected as object)) {
        return actual !== (expected as { $ne: unknown }).$ne;
      }
      return actual === expected;
    };
    const docs = [...this.docs.values()].filter((doc) => Object.entries(filter).every(([key, value]) => matchesValue(doc[key], value)));
    const debit = docs.reduce((sum, doc) => sum + (Number(doc.debit) || 0), 0);
    const credit = docs.reduce((sum, doc) => sum + (Number(doc.credit) || 0), 0);
    return { toArray: async () => [{ debit, credit }] };
  }
}

const CORRECTED_PERIOD = "2026-05";
const CORRECTED_ACCOUNT_CODE = "11105";
const CORRECTED_TRANSACTION_NO = "TRX-001";

function rawLedgerPayload(fdebit: string) {
  return {
    data: [
      {
        transaction_date: "2026-05-10",
        transaction_no: CORRECTED_TRANSACTION_NO,
        transaction_description: "Penjualan Jasa Lapangan",
        fdebit,
        fcredit: "0",
        famount: fdebit,
      },
    ],
  };
}

test("ledgerEntryId must stay stable when only the transaction amount is corrected", async () => {
  const { ledgerEntryId } = await import("./olsera-financial-store.ts");
  const { normalizeLedgerDetailPayload } = await import("./olsera-financial-core.ts");

  const entryBefore = normalizeLedgerDetailPayload(rawLedgerPayload("100"), CORRECTED_ACCOUNT_CODE).entries[0];
  const entryAfter = normalizeLedgerDetailPayload(rawLedgerPayload("125"), CORRECTED_ACCOUNT_CODE).entries[0];

  const idBefore = ledgerEntryId(324175, CORRECTED_PERIOD, CORRECTED_ACCOUNT_CODE, entryBefore as unknown as Record<string, unknown>);
  const idAfter = ledgerEntryId(324175, CORRECTED_PERIOD, CORRECTED_ACCOUNT_CODE, entryAfter as unknown as Record<string, unknown>);

  assert.equal(
    idBefore,
    idAfter,
    `_id dokumen ledger untuk transaksi bisnis YANG SAMA (transactionNo ${CORRECTED_TRANSACTION_NO}, tanggal sama) harus ` +
      `tetap identik walau nominalnya dikoreksi Olsera, supaya koreksi meng-upsert dokumen yang sama (bukan membuat baru).\n` +
      `  _id sebelum koreksi (debit 100) : ${idBefore}\n` +
      `  _id sesudah koreksi (debit 125) : ${idAfter}\n` +
      `  Kesimpulan                      : _id berbasis hash konten, BERUBAH saat nominal dikoreksi -> dokumen lama jadi yatim.`,
  );
});

async function reproduceC2() {
  const { bulkUpsertLedgerEntries } = await import("./olsera-financial-store.ts");
  const { normalizeLedgerDetailPayload } = await import("./olsera-financial-core.ts");

  const fc = { ledgerEntries: new FakeAggregatableLedgerCollection() };
  const entriesBefore = normalizeLedgerDetailPayload(rawLedgerPayload("100"), CORRECTED_ACCOUNT_CODE).entries as unknown as Array<
    Record<string, unknown>
  >;
  const entriesAfter = normalizeLedgerDetailPayload(rawLedgerPayload("125"), CORRECTED_ACCOUNT_CODE).entries as unknown as Array<
    Record<string, unknown>
  >;

  // Sync pertama: transaksi asli (debit 100).
  await bulkUpsertLedgerEntries(CORRECTED_ACCOUNT_CODE, CORRECTED_PERIOD, entriesBefore, fc as any);
  // Sync kedua: Olsera sudah mengoreksi transaksi yang SAMA menjadi debit 125.
  await bulkUpsertLedgerEntries(CORRECTED_ACCOUNT_CODE, CORRECTED_PERIOD, entriesAfter, fc as any);

  return fc;
}

test("ledger correction must replace the previous transaction version instead of double counting", async () => {
  const fc = await reproduceC2();
  const rowsForTransaction = [...fc.ledgerEntries.docs.values()].filter(
    (doc) => doc.accountCode === CORRECTED_ACCOUNT_CODE && doc.transactionNo === CORRECTED_TRANSACTION_NO,
  );
  assert.equal(
    rowsForTransaction.length,
    1,
    `Setelah Olsera mengoreksi transaksi ${CORRECTED_TRANSACTION_NO}, hanya SATU versi yang boleh tersimpan.\n` +
      `  Jumlah dokumen yang diharapkan : 1\n` +
      `  Jumlah dokumen aktual          : ${rowsForTransaction.length}\n` +
      `  _id dokumen tersimpan          : ${rowsForTransaction.map((doc) => doc._id).join(", ")}\n` +
      `  debit per dokumen              : ${rowsForTransaction.map((doc) => doc.debit).join(", ")}`,
  );
});

test("movement totals must reflect only the corrected transaction amount, not both versions", async () => {
  const { getFinancialLedgerMovementTotals } = await import("./olsera-financial-store.ts");
  const fc = await reproduceC2();
  const totals = await getFinancialLedgerMovementTotals(CORRECTED_PERIOD, CORRECTED_ACCOUNT_CODE, fc as any);
  assert.equal(
    totals.debit,
    125,
    `Total debit pergerakan akun ${CORRECTED_ACCOUNT_CODE} periode ${CORRECTED_PERIOD} harus 125 (nilai TRX-001 SETELAH ` +
      `dikoreksi), bukan penjumlahan versi lama (100) + versi baru (125).\n` +
      `  Total debit yang diharapkan : 125\n` +
      `  Total debit aktual          : ${totals.debit}`,
  );
});

test("ledger detail listing must not return duplicate rows for a corrected transaction", async () => {
  const { listAllFinancialLedgerEntriesForPeriod } = await import("./olsera-financial-store.ts");
  const fc = await reproduceC2();
  const rows = await listAllFinancialLedgerEntriesForPeriod(CORRECTED_PERIOD, fc as any);
  const forTransaction = rows.filter((row) => row.transactionNo === CORRECTED_TRANSACTION_NO);
  assert.equal(
    forTransaction.length,
    1,
    `Buku Besar Detail (dan export Excel/PDF yang memakai fungsi ini) tidak boleh menampilkan transaksi ` +
      `${CORRECTED_TRANSACTION_NO} dua kali.\n` +
      `  Jumlah baris yang diharapkan : 1\n` +
      `  Jumlah baris aktual          : ${forTransaction.length}\n` +
      `  debit per baris              : ${forTransaction.map((row) => row.debit).join(", ")}`,
  );
});
