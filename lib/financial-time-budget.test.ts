// Phase 3C.5 — regression tests: deadline internal (FINANCIAL_INVOCATION_TIME_BUDGET_MS)
// harus membuat fase "ledger-details" berhenti AMAN di tengah batch akun,
// tanpa kehilangan progress akun yang sudah selesai, tanpa cursor meloncat
// melewati akun yang belum diproses, dan tanpa merusak retry queue.
// Jalankan: npm run test:financial-time-budget
import test, { mock } from "node:test";
import assert from "node:assert/strict";

process.env.OLSERA_INTERNAL_STORE_ID = "324175";

/** Waktu virtual "per akun" pada `nowFromCallLogLength` di bawah — dipilih jauh di bawah
 * FINANCIAL_REQUEST_TIMEOUT_MS sungguhan (10s), murni supaya deadlineAt di test mudah dihitung. */
const ACCOUNT_TICK_MS = 1_000;

/** account_code -> berapa kali getLedgerDetail dipanggil untuknya, dalam urutan pemanggilan. */
const callLog: string[] = [];
/** account_code yang sengaja diminta GAGAL pada pemanggilan berikutnya (untuk skenario retry). */
const failOnce = new Set<string>();

mock.module("./olsera-financial-client", {
  namedExports: {
    getLedgerDetail: async (_period: string, accountCode: string) => {
      callLog.push(accountCode);
      if (failOnce.has(accountCode)) {
        failOnce.delete(accountCode);
        throw new Error(`Simulated Olsera outage untuk akun ${accountCode}`);
      }
      return { data: [{ transaction_date: "2026-07-05", transaction_description: "Transaksi normal", fdebit: "10", fcredit: "0", famount: "10" }] };
    },
    // Tidak dipakai di test ini (langsung mulai dari phase ledger-details via fixture run), tapi harus tetap ada
    // supaya import statis di lib/olsera-financial-sync.ts tidak resolve ke undefined.
    getAccounts: async () => [{ data: [] }, { data: [] }],
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
    getLedgerSummary: async () => ({ "0": { account_id: 1, account_code: "10001", fdebit: "0", fcredit: "0", famount: "0" } }),
    // Konstanta terpusat (Phase 3C.5.1) — HARUS ikut di-mock (sama seperti fungsi di atas):
    // modul client di-mock UTUH, jadi tanpa ini import-nya di lib/olsera-financial-sync.ts
    // resolve ke `undefined`, dan FINANCIAL_MIN_REMAINING_MS_TO_START_WORK di sana jadi NaN.
    FINANCIAL_REQUEST_TIMEOUT_MS: 10_000,
  },
});

// Diisi lewat test.before() di bawah (BUKAN top-level await — tidak didukung tsx/esbuild
// untuk output cjs) — tapi tetap dynamic import yang dieksekusi SESUDAH mock.module di atas
// terpasang, persis seperti dynamic import di dalam tiap test lain di file ini.
let FINANCIAL_MIN_REMAINING_MS_TO_START_WORK: number;
/** deadlineAt yang mengizinkan TEPAT 2 akun (now=0 dan now=1000ms) sebelum guard start-safety
 * (Phase 3C.5.1) menolak akun ke-3 (now=2000ms): perlu (deadlineAt - 1000) > threshold DAN
 * (deadlineAt - 2000) <= threshold — dipilih di tengah rentang itu. */
let DEADLINE_STOP_AFTER_TWO_ACCOUNTS_MS: number;
/** deadlineAt yang mengizinkan TEPAT 1 retry (now=0) sebelum guard menolak retry ke-2 (now=1000ms). */
let DEADLINE_STOP_AFTER_ONE_RETRY_MS: number;

test.before(async () => {
  ({ FINANCIAL_MIN_REMAINING_MS_TO_START_WORK } = await import("./olsera-financial-sync.ts"));
  DEADLINE_STOP_AFTER_TWO_ACCOUNTS_MS = FINANCIAL_MIN_REMAINING_MS_TO_START_WORK + 1_500;
  DEADLINE_STOP_AFTER_ONE_RETRY_MS = FINANCIAL_MIN_REMAINING_MS_TO_START_WORK + 500;
});

/** Koleksi palsu in-memory — subset minimum yang dibutuhkan lib/olsera-financial-store.ts (pola sama seperti lib/financial-reconciliation-integrity.test.ts). */
class FakeCollection {
  docs = new Map<string, Record<string, unknown>>();

  private matches(doc: Record<string, unknown>, filter: Record<string, unknown>) {
    return Object.entries(filter).every(([key, value]) => doc[key] === value);
  }

  async createIndex() {
    return "ok";
  }

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
  return { monthlyReports: new FakeCollection(), accounts: new FakeCollection(), ledgerEntries: new FakeCollection(), syncLogs: new FakeCollection() };
}

const PERIOD = "2026-07";
const ACCOUNTS = ["10001", "10002", "10003", "10004"]; // == LEDGER_BATCH_SIZE (4) di lib/olsera-financial-sync.ts

/** Buat run langsung di fase ledger-details (skip monthly-reports) — fokus test pada loop akun. */
async function seedLedgerDetailsRun(fc: ReturnType<typeof fakeCollections>, overrides: Record<string, unknown> = {}) {
  const { createFinancialSyncRun } = await import("./olsera-financial-store.ts");
  const run = await createFinancialSyncRun(PERIOD, ACCOUNTS, fc as any);
  const { updateFinancialSyncRun } = await import("./olsera-financial-store.ts");
  const seeded = await updateFinancialSyncRun(run._id, { phase: "ledger-details", reportsCompleted: ["balance-sheet", "profit-loss", "cash-flow", "ledger-summary"], status: "running", ...overrides }, fc as any);
  if (!seeded) throw new Error("Fixture setup gagal: updateFinancialSyncRun mengembalikan null.");
  return seeded;
}

test.beforeEach(() => {
  callLog.length = 0;
  failOnce.clear();
});

test("A) deadline masih jauh -> batch normal diproses penuh (4 akun, cursor maju penuh)", async () => {
  const fc = fakeCollections();
  const seeded = await seedLedgerDetailsRun(fc);
  const { stepFinancialSync } = await import("./olsera-financial-sync.ts");

  const result = await stepFinancialSync(seeded._id, fc as any, /* deadlineAt */ 1_000_000, () => 0);

  assert.equal(result!.accountCursor, 4, "seluruh 4 akun harus diproses karena deadline sangat jauh");
  assert.deepEqual(callLog, ACCOUNTS);
});

test("B) deadline tercapai setelah 2 dari 4 akun -> hanya 2 akun dicatat selesai", async () => {
  const fc = fakeCollections();
  const seeded = await seedLedgerDetailsRun(fc);
  const { stepFinancialSync } = await import("./olsera-financial-sync.ts");

  // `now()` dibaca SEBELUM setiap akun mulai diproses (lihat lib/olsera-financial-sync.ts) —
  // memakai jumlah panggilan getLedgerDetail SEJAUH INI sebagai jam palsu deterministik
  // (Phase 3C.5.1 — guard start-safety: deadlineAt - now() <= FINANCIAL_MIN_REMAINING_MS_TO_START_WORK):
  // iterasi ke-1: now()=0ms    (sisa > ambang, proses akun#1 -> callLog.length jadi 1)
  // iterasi ke-2: now()=1000ms (sisa > ambang, proses akun#2 -> callLog.length jadi 2)
  // iterasi ke-3: now()=2000ms (sisa <= ambang -> BERHENTI, akun#3 & #4 tidak pernah mulai)
  const nowFromCallLogLength = () => callLog.length * ACCOUNT_TICK_MS;

  const result = await stepFinancialSync(seeded._id, fc as any, DEADLINE_STOP_AFTER_TWO_ACCOUNTS_MS, nowFromCallLogLength);

  assert.equal(callLog.length, 2, "hanya 2 akun yang benar-benar sempat di-fetch dari Olsera");
  assert.equal(result!.accountCursor, 2, "cursor hanya maju sebesar akun yang BENAR-BENAR selesai (2), bukan 4");
  assert.equal(result!.accountsProcessed, 2);
  assert.deepEqual(callLog, ["10001", "10002"]);
});

test("C) cursor tidak meloncat melewati akun yang belum diproses", async () => {
  const fc = fakeCollections();
  const seeded = await seedLedgerDetailsRun(fc);
  const { stepFinancialSync } = await import("./olsera-financial-sync.ts");
  const nowFromCallLogLength = () => callLog.length * ACCOUNT_TICK_MS;

  const result = await stepFinancialSync(seeded._id, fc as any, DEADLINE_STOP_AFTER_TWO_ACCOUNTS_MS, nowFromCallLogLength);

  assert.ok(result!.accountCursor < ACCOUNTS.length, "cursor harus tetap di bawah total akun — akun#3/#4 belum diproses");
  assert.equal(result!.accountCursor, 2);
});

test("D) cron berikutnya melanjutkan akun berikutnya tanpa duplicate", async () => {
  const fc = fakeCollections();
  const seeded = await seedLedgerDetailsRun(fc);
  const { stepFinancialSync } = await import("./olsera-financial-sync.ts");

  // Invocation 1: deadline dicapai setelah 2 akun.
  const nowFromCallLogLength = () => callLog.length * ACCOUNT_TICK_MS;
  const afterFirst = await stepFinancialSync(seeded._id, fc as any, DEADLINE_STOP_AFTER_TWO_ACCOUNTS_MS, nowFromCallLogLength);
  assert.equal(afterFirst!.accountCursor, 2);
  assert.deepEqual(callLog, ["10001", "10002"]);

  // Invocation 2 (checkpoint sama, deadline jauh) -> lanjut TEPAT dari akun#3, tidak mengulang #1/#2.
  const afterSecond = await stepFinancialSync(afterFirst!._id, fc as any, 1_000_000, () => 0);
  assert.deepEqual(callLog, ["10001", "10002", "10003", "10004"], "akun#1/#2 TIDAK boleh di-fetch ulang, lanjut dari #3");
  assert.equal(afterSecond!.accountCursor, 4);

  // Tidak ada entri ledger duplikat untuk akun manapun.
  const entries = [...fc.ledgerEntries.docs.values()];
  for (const code of ACCOUNTS) {
    const forAccount = entries.filter((doc) => doc.accountCode === code);
    assert.equal(forAccount.length, 1, `akun ${code} seharusnya hanya punya 1 entri ledger, dapat ${forAccount.length}`);
  }
});

test("E) deadline tercapai saat retry queue -> retry yang belum dicoba tetap tersimpan, tidak hilang", async () => {
  const fc = fakeCollections();
  // Dua akun sudah pernah gagal sebelumnya (failedAccountCodes) — keduanya jadi retryBatch (RETRY_SLOTS_PER_STEP=2)
  // dan diproses SEBELUM akun baru (lihat lib/olsera-financial-sync.ts).
  const seeded = await seedLedgerDetailsRun(fc, {
    accountCursor: 4, // seluruh akun "baru" sudah pernah diproses sebelumnya -> nextBatch kosong, murni fokus ke retry
    failedAccountCodes: ["10001", "10002"],
    accountAttempts: [{ code: "10001", attempts: 1 }, { code: "10002", attempts: 1 }],
  });
  const { stepFinancialSync } = await import("./olsera-financial-sync.ts");

  // Deadline tercapai TEPAT setelah retry pertama (10001) selesai diproses, SEBELUM retry kedua (10002) mulai.
  const nowFromCallLogLength = () => callLog.length * ACCOUNT_TICK_MS;
  const result = await stepFinancialSync(seeded._id, fc as any, DEADLINE_STOP_AFTER_ONE_RETRY_MS, nowFromCallLogLength);

  assert.deepEqual(callLog, ["10001"], "hanya retry pertama yang benar-benar dicoba");
  // 10001 berhasil (mock default sukses) -> pindah dari failed ke recovered.
  assert.ok(!result!.failedAccountCodes.includes("10001"), "10001 sudah berhasil -> tidak lagi di failedAccountCodes");
  assert.ok(result!.recoveredAccountCodes.includes("10001"));
  // 10002 TIDAK PERNAH mulai diproses -> tetap utuh di failedAccountCodes, attempts TIDAK bertambah.
  assert.ok(result!.failedAccountCodes.includes("10002"), "10002 yang belum sempat di-retry TIDAK BOLEH hilang dari antrean");
  const attemptsFor10002 = result!.accountAttempts.find((row: { code: string; attempts: number }) => row.code === "10002");
  assert.equal(attemptsFor10002?.attempts, 1, "attempts untuk 10002 tidak boleh berubah karena belum sempat dicoba");
  // Cursor akun baru tidak bergerak sama sekali (tidak ada nextBatch yang sempat diproses).
  assert.equal(result!.accountCursor, 4);
});

test("F) response step tetap bentuk normal (bukan exception) ketika berhenti karena deadline", async () => {
  const fc = fakeCollections();
  const seeded = await seedLedgerDetailsRun(fc);
  const { stepFinancialSync } = await import("./olsera-financial-sync.ts");
  const nowFromCallLogLength = () => callLog.length * ACCOUNT_TICK_MS;

  const result = await stepFinancialSync(seeded._id, fc as any, DEADLINE_STOP_AFTER_TWO_ACCOUNTS_MS, nowFromCallLogLength);

  assert.ok(result, "harus tetap mengembalikan run object, bukan throw/undefined");
  assert.notEqual(result!.status, "failed");
  assert.ok(["running", "partial"].includes(result!.status));
});

test("D) checkpoint TERSIMPAN di storage (bukan cuma nilai return) setelah berhenti karena start-safety guard", async () => {
  const fc = fakeCollections();
  const seeded = await seedLedgerDetailsRun(fc);
  const { stepFinancialSync } = await import("./olsera-financial-sync.ts");
  const nowFromCallLogLength = () => callLog.length * ACCOUNT_TICK_MS;

  await stepFinancialSync(seeded._id, fc as any, DEADLINE_STOP_AFTER_TWO_ACCOUNTS_MS, nowFromCallLogLength);

  // Baca LANGSUNG dari koleksi palsu (bukan dari nilai return stepFinancialSync) — membuktikan
  // checkpoint benar-benar ditulis ke storage, bukan cuma dikembalikan di memori.
  const persisted = await fc.syncLogs.findOne({ _id: seeded._id });
  assert.ok(persisted, "run harus tetap ada di storage setelah berhenti karena deadline");
  assert.equal(persisted!.accountCursor, 2, "cursor yang tersimpan di storage harus 2 (bukan 4/tidak berubah/tidak tersimpan sama sekali)");
  assert.equal(persisted!.phase, "ledger-details", "fase tetap ledger-details — belum selesai, bukan dipaksa lanjut ke reconcile");
});

test("C) worst-case matematis: akun terakhir yang diizinkan memakai FULL request timeout tetap menyisakan margin sebelum batas eksternal 30 detik", async () => {
  const { FINANCIAL_INVOCATION_TIME_BUDGET_MS } = await import("./olsera-financial-sync.ts");
  const EXTERNAL_CLIENT_TIMEOUT_MS = 30_000; // batas tunggu cron-job.org (Phase 3C.4) — bukan konfigurasi kita, referensi perhitungan saja.
  const OLSERA_REQUEST_TIMEOUT_MS = 10_000; // FINANCIAL_REQUEST_TIMEOUT_MS (lib/olsera-financial-client.ts)
  const SAFETY_MARGIN_MS = 3_000; // FINANCIAL_ACCOUNT_START_SAFETY_MARGIN_MS (lib/olsera-financial-sync.ts)

  // Akun TERAKHIR yang boleh mulai adalah saat sisa waktu TEPAT DI ATAS ambang —
  // yaitu saat (deadlineAt - now) sedikit lebih besar dari FINANCIAL_MIN_REMAINING_MS_TO_START_WORK.
  // Dalam artian "now" ter-lambat yang masih lolos guard adalah:
  const latestSafeAccountStartMs = FINANCIAL_INVOCATION_TIME_BUDGET_MS - FINANCIAL_MIN_REMAINING_MS_TO_START_WORK;
  // Worst case: akun itu memakai FULL timeout Olsera (10 detik).
  const worstCaseAccountFinishMs = latestSafeAccountStartMs + OLSERA_REQUEST_TIMEOUT_MS;
  // Waktu yang MASIH TERSISA sampai batas eksternal cron-job.org setelah akun terlambat itu selesai —
  // ini HARUS positif dan bermakna (bukan cuma > 0) supaya checkpoint Mongo + release lock +
  // serialisasi response + overhead jaringan punya ruang nyata untuk selesai.
  const marginAfterWorstCase = EXTERNAL_CLIENT_TIMEOUT_MS - worstCaseAccountFinishMs;

  assert.equal(latestSafeAccountStartMs, 8_000, "akun terakhir yang aman dimulai pada t=8 detik dari awal invocation");
  assert.equal(worstCaseAccountFinishMs, 18_000, "worst-case akun tersebut selesai pada t=18 detik (masih di bawah 30 detik)");
  assert.ok(worstCaseAccountFinishMs < EXTERNAL_CLIENT_TIMEOUT_MS, "worst-case selesai SEBELUM batas eksternal 30 detik");
  assert.ok(marginAfterWorstCase >= SAFETY_MARGIN_MS, `margin sisa (${marginAfterWorstCase}ms) harus >= margin finalisasi yang dijanjikan (${SAFETY_MARGIN_MS}ms)`);
  assert.equal(marginAfterWorstCase, 12_000, "margin akhir seharusnya 12 detik — jauh di atas margin finalisasi minimum 3 detik (double safety)");
});

test("H) monthly-reports behavior tidak regress (deadline tidak diterapkan pada fase ini, tetap Promise.all seperti semula)", async () => {
  const fc = fakeCollections();
  const { startFinancialSync, stepFinancialSync } = await import("./olsera-financial-sync.ts");
  const started = await startFinancialSync(2026, 7, fc as any);
  assert.equal(started.phase, "monthly-reports");

  const afterMonthlyReports = await stepFinancialSync(started._id, fc as any); // tanpa deadlineAt sama sekali (seperti pemanggil manual existing)
  assert.equal(afterMonthlyReports!.phase, "ledger-details", "transisi monthly-reports -> ledger-details tidak berubah");
  assert.deepEqual([...afterMonthlyReports!.reportsCompleted].sort(), ["balance-sheet", "cash-flow", "ledger-summary", "profit-loss"]);
});
