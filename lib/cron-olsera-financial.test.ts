// Test unit endpoint cron Laporan Keuangan Olsera (Tahap 7 lanjutan): satu
// request menjalankan BEBERAPA step sequential dengan batas eksplisit
// (MAX_STEPS_PER_REQUEST), berhenti pada completed/connection-expired/step
// gagal/batas step/batas waktu, resume checkpoint, lock owner-only.
// Jalankan: npm run test:cron-olsera-financial
import assert from "node:assert/strict";
import { test, mock, before } from "node:test";
import { MongoServerSelectionError } from "mongodb";

process.env.CRON_SECRET = "test-secret";

mock.module("@/lib/olsera-sync", {
  namedExports: { todayJakarta: () => "2026-07-20" },
});

type FakeRun = {
  period: string;
  status: "running" | "success" | "partial" | "failed";
  finalized: boolean;
  updatedAt: Date;
  completedAt: Date | null;
  [key: string]: unknown;
};

function fakeRun(overrides: Partial<FakeRun> = {}): FakeRun {
  return {
    _id: "financial:1:2026-07",
    status: "running",
    phase: "ledger-details",
    accountCursor: 4,
    accountsProcessed: 4,
    recordsProcessed: 40,
    period: "2026-07",
    finalized: false,
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

const getFinancialSyncLogForPeriodMock = mock.fn(async (_period: string) => null as Record<string, unknown> | null);
mock.module("@/lib/olsera-financial-store", {
  namedExports: { getFinancialSyncLogForPeriod: getFinancialSyncLogForPeriodMock },
});

const financialSyncLogsFindMock = mock.fn(() => ({
  toArray: async () => [] as Record<string, unknown>[],
}));
const financialInvocationInsertMock = mock.fn(async (_doc: Record<string, unknown>) => ({ acknowledged: true }));
mock.module("@/lib/mongodb", {
  namedExports: {
    withMongo: async <T>(handler: () => Promise<T>) => handler(),
    collections: async () => ({
      olseraFinancialSyncLogs: { find: financialSyncLogsFindMock },
      olseraFinancialCronInvocations: { insertOne: financialInvocationInsertMock },
    }),
  },
});

const startFinancialSyncMock = mock.fn(async (_year: unknown, _month: unknown) =>
  fakeRun({ status: "running", phase: "monthly-reports", accountCursor: 0 }),
);
const stepFinancialSyncMock = mock.fn(async (_runId: string) => fakeRun({ accountCursor: 4, accountsProcessed: 4 }));
// FINANCIAL_INVOCATION_TIME_BUDGET_MS dan FINANCIAL_MIN_REMAINING_MS_TO_START_WORK
// harus ikut di-mock (nilai sama dengan production, lib/olsera-financial-sync.ts)
// — modul ini di-mock UTUH, jadi tanpa entri ini import-nya di
// lib/cron-olsera-financial.ts akan `undefined` dan deadlineAt/guard jadi NaN
// (Phase 3C.5 / 3C.5.1).
const FINANCIAL_INVOCATION_TIME_BUDGET_MS = 21_000;
const FINANCIAL_MIN_REMAINING_MS_TO_START_WORK = 13_000; // FINANCIAL_REQUEST_TIMEOUT_MS(10_000) + FINANCIAL_ACCOUNT_START_SAFETY_MARGIN_MS(3_000)
mock.module("@/lib/olsera-financial-sync", {
  namedExports: {
    startFinancialSync: startFinancialSyncMock,
    stepFinancialSync: stepFinancialSyncMock,
    FINANCIAL_INVOCATION_TIME_BUDGET_MS,
    FINANCIAL_MIN_REMAINING_MS_TO_START_WORK,
  },
});

const acquireOlseraSyncLockMock = mock.fn(async () => ({ ok: true, runId: "run-financial-lock-1" }));
const releaseOlseraSyncLockMock = mock.fn(async (_runId: string) => true);
mock.module("@/lib/olsera-cron-lock", {
  namedExports: {
    acquireOlseraSyncLock: acquireOlseraSyncLockMock,
    releaseOlseraSyncLock: releaseOlseraSyncLockMock,
  },
});

let runOlseraFinancialCron: typeof import("./cron-olsera-financial.ts").runOlseraFinancialCron;
let selectFinancialCronTarget: typeof import("./cron-olsera-financial.ts").selectFinancialCronTarget;
let isFinancialPeriodUnfinished: typeof import("./cron-olsera-financial.ts").isFinancialPeriodUnfinished;
let financialPeriodNeedsFreshStart: typeof import("./cron-olsera-financial.ts").financialPeriodNeedsFreshStart;
let isFinancialSyncRunStale: typeof import("./cron-olsera-financial.ts").isFinancialSyncRunStale;
let selectFinancialCronTargetWithHistory: typeof import("./cron-olsera-financial.ts").selectFinancialCronTargetWithHistory;
let FinancialClientError: typeof import("./olsera-financial-client.ts").FinancialClientError;

before(async () => {
  const cronModule = await import("./cron-olsera-financial.ts");
  runOlseraFinancialCron = cronModule.runOlseraFinancialCron;
  selectFinancialCronTarget = cronModule.selectFinancialCronTarget;
  isFinancialPeriodUnfinished = cronModule.isFinancialPeriodUnfinished;
  financialPeriodNeedsFreshStart = cronModule.financialPeriodNeedsFreshStart;
  isFinancialSyncRunStale = cronModule.isFinancialSyncRunStale;
  selectFinancialCronTargetWithHistory = cronModule.selectFinancialCronTargetWithHistory;
  FinancialClientError = (await import("./olsera-financial-client.ts")).FinancialClientError;
});

/** Reset mock ke keadaan netral sebelum tiap skenario multi-step. */
function resetAll() {
  getFinancialSyncLogForPeriodMock.mock.resetCalls();
  startFinancialSyncMock.mock.resetCalls();
  stepFinancialSyncMock.mock.resetCalls();
  acquireOlseraSyncLockMock.mock.resetCalls();
  releaseOlseraSyncLockMock.mock.resetCalls();
  financialSyncLogsFindMock.mock.resetCalls();
  financialInvocationInsertMock.mock.resetCalls();
}

test("401 bila header Authorization salah", async () => {
  const res = await runOlseraFinancialCron("Bearer salah");
  assert.equal(res.status, 401);
  assert.equal(res.body.status, "unauthorized");
});

test("409 sync-in-progress bila lock sedang dipegang modul/proses lain (mis. manual sync)", async () => {
  acquireOlseraSyncLockMock.mock.mockImplementationOnce(async () => ({ ok: false, activeModule: "financial", runId: "run-manual-3" }));
  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { status: "sync-in-progress", activeModule: "financial", runId: "run-manual-3" });
});

test("1) menjalankan BEBERAPA step sequential dalam satu request", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  let cursor = 0;
  stepFinancialSyncMock.mock.mockImplementation(async () => {
    cursor += 4;
    return fakeRun({ status: cursor >= 16 ? "success" : "running", phase: cursor >= 16 ? "completed" : "ledger-details", accountCursor: cursor, accountsProcessed: cursor });
  });

  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(startFinancialSyncMock.mock.callCount(), 1);
  assert.equal(stepFinancialSyncMock.mock.callCount(), 4); // sequential, satu per satu — bukan paralel
  assert.equal(res.body.stepsExecuted, 4);
  // Panggilan step tidak tumpang-tindih: masing-masing dipanggil dengan runId yang sama, berurutan.
  for (const call of stepFinancialSyncMock.mock.calls) assert.equal(call.arguments[0], "financial:1:2026-07");
});

test("2) berhenti begitu status completed (success) tercapai, tidak melebihi step yang dibutuhkan", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "success", phase: "completed", accountCursor: 8, accountsProcessed: 8 }));

  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(res.body.status, "completed");
  assert.equal(res.body.completed, true);
  assert.equal(res.body.nextCheckpoint, null);
  assert.equal(stepFinancialSyncMock.mock.callCount(), 1); // selesai di step pertama -> tidak lanjut step kedua
});

test("3) partial-progress saat batas jumlah step (MAX_STEPS_PER_REQUEST) tercapai — tidak loop tanpa batas", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  // Selalu "running" — andai tidak dibatasi, loop akan berjalan selamanya.
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "running", phase: "ledger-details" }));

  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "partial-progress");
  assert.equal(res.body.completed, false);
  assert.ok(typeof res.body.stepsExecuted === "number");
  assert.ok((res.body.stepsExecuted as number) <= 8, "jumlah step per request harus dibatasi eksplisit");
  assert.equal(stepFinancialSyncMock.mock.callCount(), res.body.stepsExecuted);
});

test("4) + 5) partial-progress dapat dilanjutkan request berikutnya TANPA membuat run baru (run aktif tidak diulang)", async () => {
  resetAll();
  // Panggilan pertama: belum ada run -> start, lalu step berkali-kali sampai batas step, masih "running".
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "running", accountCursor: 8 }));
  const first = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(first.body.status, "partial-progress");
  assert.equal(startFinancialSyncMock.mock.callCount(), 1);

  // Panggilan kedua: run periode ini MASIH ada (running) -> resume dari checkpoint, TIDAK start ulang.
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => fakeRun({ status: "running", accountCursor: 8 }));
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "success", phase: "completed", accountCursor: 20 }));
  const second = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(startFinancialSyncMock.mock.callCount(), 0, "run periode masih aktif -> tidak boleh start ulang");
  assert.equal(second.body.status, "completed");
});

test("idempotent (auto mode): current DAN previous sudah success & keduanya belum lewat jendela refresh masing-masing -> no-op, tidak memanggil start/step lagi", async () => {
  resetAll();
  // Dispatch berdasarkan argumen periode (bukan urutan panggilan) — Promise.all
  // memanggil getFinancialSyncLogForPeriod(current) dan (previous) hampir bersamaan,
  // jadi mocking berbasis argumen lebih aman daripada mockImplementationOnce berurutan.
  // Kedua log WAJIB punya completedAt baru — sejak Phase 3B.1 current month juga
  // dicek refresh-due, jadi completedAt kosong akan salah dianggap "sudah lama".
  getFinancialSyncLogForPeriodMock.mock.mockImplementation(async (period: string) =>
    fakeRun({ period, status: "success", phase: "completed", completedAt: new Date() }),
  );
  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "up-to-date");
  assert.equal(res.body.stepsExecuted, 0);
  assert.equal(startFinancialSyncMock.mock.callCount(), 0);
  assert.equal(stepFinancialSyncMock.mock.callCount(), 0);
});

test("payload tahun/bulan invalid -> status payload-invalid, tidak melempar exception", async () => {
  const res = await runOlseraFinancialCron("Bearer test-secret", { year: "abcd", month: 13 });
  assert.equal(res.body.status, "payload-invalid");
});

test("6) berhenti saat connection-expired di tengah batch, step yang sudah jalan tetap dihitung", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  let call = 0;
  stepFinancialSyncMock.mock.mockImplementation(async () => {
    call++;
    if (call === 2) throw new FinancialClientError({ status: "connection-expired", message: "Koneksi Olsera kedaluwarsa." });
    return fakeRun({ status: "running" });
  });
  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "connection-expired");
  assert.equal(res.body.completed, false);
  assert.equal(res.body.stepsExecuted, 1); // step pertama sudah jalan sebelum step kedua gagal
});

test("7) berhenti saat step gagal (exception tak terduga), status step-failed aman tanpa raw error", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  stepFinancialSyncMock.mock.mockImplementationOnce(async () => {
    throw new Error("internal ledger parsing crash with sensitive detail xyz");
  });
  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "step-failed");
  assert.ok(!JSON.stringify(res.body).includes("sensitive detail"));
});

test("8) MongoDB timeout -> HTTP 504 terstruktur, lock tetap dilepas", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => {
    throw new MongoServerSelectionError("Server selection timed out after 5000 ms", {} as never);
  });
  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(res.status, 504);
  assert.equal(res.body.status, "database-timeout");
  assert.equal(res.body.safeErrorCode, "mongodb-timeout");
  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1);
});

test("9) lock selalu dilepas baik saat sukses maupun gagal", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "success", phase: "completed" }));
  await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1);
  assert.equal(releaseOlseraSyncLockMock.mock.calls[0].arguments[0], "run-financial-lock-1");

  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  stepFinancialSyncMock.mock.mockImplementationOnce(async () => {
    throw new Error("boom");
  });
  await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1);
});

// --- Task 6A.2 (C1): status "partial" bukan alasan berhenti selama akun gagal
// masih dijadwalkan retry, dan run yang sudah final tidak pernah dipaksa jalan. ---

test("10) status partial yang belum final TETAP dilanjutkan (retry akun gagal), tidak dianggap selesai", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  let call = 0;
  stepFinancialSyncMock.mock.mockImplementation(async () => {
    call++;
    // Akun gagal pada batch pertama, pulih pada step ketiga.
    if (call < 3) return fakeRun({ status: "partial", phase: "ledger-details", finalized: false, errorMessage: "gagal akun 40004" });
    return fakeRun({ status: "success", phase: "completed", finalized: true, errorMessage: null });
  });

  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(stepFinancialSyncMock.mock.callCount(), 3, "partial belum final harus dilanjutkan, bukan dihentikan");
  assert.equal(res.body.status, "completed");
  assert.equal(res.body.completed, true);
});

test("11) run partial FINAL menghentikan loop, dilaporkan belum selesai, dan lock tetap dilepas", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  stepFinancialSyncMock.mock.mockImplementation(async () =>
    fakeRun({ status: "partial", phase: "ledger-details", finalized: true, errorMessage: "gagal permanen akun 40004" }),
  );

  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(stepFinancialSyncMock.mock.callCount(), 1);
  assert.equal(res.body.status, "partial-progress");
  assert.equal(res.body.completed, false, "run partial tidak boleh dilaporkan selesai");
  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1);
});

test("12) run partial final di-restart hanya setelah cooldown, tidak pada invocation berikutnya (previous month dikunci up-to-date supaya tidak mengganggu skenario current)", async () => {
  resetAll();
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "partial", phase: "ledger-details", finalized: true }));
  // previous month (2026-06) sengaja dibuat up-to-date (dispatch berdasarkan argumen
  // periode, bukan urutan panggilan — lihat catatan di test "idempotent" di atas),
  // supaya assertion startFinancialSyncMock murni mengukur perilaku current (cooldown).
  const previousUpToDate = fakeRun({ period: "2026-06", status: "success", phase: "completed", completedAt: new Date() });

  // Baru saja final -> jangan restart (hindari restart beruntun).
  getFinancialSyncLogForPeriodMock.mock.mockImplementation(async (period: string) =>
    period === "2026-07" ? fakeRun({ status: "partial", finalized: true, updatedAt: new Date() }) : previousUpToDate,
  );
  await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(startFinancialSyncMock.mock.callCount(), 0);

  // Sudah lewat cooldown -> mulai run baru supaya akun gagal punya kesempatan pulih.
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementation(async (period: string) =>
    period === "2026-07" ? fakeRun({ status: "partial", finalized: true, updatedAt: new Date(Date.now() - 60 * 60 * 1000) }) : previousUpToDate,
  );
  await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(startFinancialSyncMock.mock.callCount(), 1);
});

test("response tidak pernah menyertakan CRON_SECRET, BSON, atau field mentah", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "success", phase: "completed" }));
  const res = await runOlseraFinancialCron("Bearer test-secret");
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes("test-secret"));
  assert.ok(!serialized.includes("ObjectId"));
});

// =============================================================================
// Phase 3B — jendela pemeliharaan otomatis current + previous month.
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ---- Pure functions: selectFinancialCronTarget / isFinancialPeriodUnfinished / financialPeriodNeedsFreshStart / isFinancialSyncRunStale ----

test("selectFinancialCronTarget: current belum ada log sama sekali -> pilih current, startFresh", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog: null, previousLog: null, now });
  assert.deepEqual(target, { period: "2026-08", startFresh: true, reason: "current-unfinished" });
});

test("selectFinancialCronTarget: current success, previous belum ada log -> pilih previous (Test B: previous month ikut masuk daftar maintenance)", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  const currentLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now };
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog, previousLog: null, now });
  assert.deepEqual(target, { period: "2026-07", startFresh: true, reason: "previous-unfinished" });
});

test("selectFinancialCronTarget: current DAN previous success, previous BARU SAJA selesai (< interval) -> null (no-op) — Test C", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  const currentLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now };
  const previousLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: new Date(now.getTime() - HOUR_MS) }; // 1 jam lalu, < 24 jam
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog, previousLog, now });
  assert.equal(target, null);
});

test("selectFinancialCronTarget: current DAN previous success, previous sudah LEWAT interval refresh -> pilih previous, startFresh — Test D", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  const currentLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now };
  const previousLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: new Date(now.getTime() - DAY_MS - HOUR_MS) }; // 25 jam lalu, > 24 jam
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog, previousLog, now });
  assert.deepEqual(target, { period: "2026-07", startFresh: true, reason: "previous-refresh-due" });
});

test("selectFinancialCronTarget: bulan 2 bulan ke belakang TIDAK PERNAH masuk parameter sama sekali (fungsi hanya menerima current+previous, tidak ada slot ketiga)", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog: { status: "success", finalized: true, updatedAt: now, completedAt: now }, previousLog: { status: "success", finalized: true, updatedAt: now, completedAt: now }, now });
  assert.equal(target, null); // current+previous up to date -> no-op, TIDAK ada fallback ke bulan lebih lama
});

test("selectFinancialCronTarget: previousPeriod null (di/sebelum baseline) -> tidak pernah memilih previous, hanya current", () => {
  const now = new Date("2026-02-09T00:00:00Z");
  const target = selectFinancialCronTarget({ currentPeriod: "2026-02", previousPeriod: null, currentLog: null, previousLog: null, now });
  assert.deepEqual(target, { period: "2026-02", startFresh: true, reason: "current-unfinished" });
});

test("selectFinancialCronTarget: current unfinished DIDAHULUKAN dari previous unfinished (prioritas current > previous)", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog: { status: "running", finalized: false, updatedAt: now, completedAt: null }, previousLog: null, now });
  assert.equal(target?.period, "2026-08");
  assert.equal(target?.reason, "current-unfinished");
});

test("isFinancialPeriodUnfinished: running SELALU 'belum selesai' (fresh maupun stale) — resume, bukan reset", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  assert.equal(isFinancialPeriodUnfinished({ status: "running", finalized: false, updatedAt: now, completedAt: null }, now), true);
  assert.equal(isFinancialPeriodUnfinished({ status: "running", finalized: false, updatedAt: new Date(now.getTime() - 10 * HOUR_MS), completedAt: null }, now), true);
});

test("isFinancialPeriodUnfinished: partial belum final -> 'belum selesai' (retry akun gagal jalan terus)", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  assert.equal(isFinancialPeriodUnfinished({ status: "partial", finalized: false, updatedAt: now, completedAt: null }, now), true);
});

test("isFinancialPeriodUnfinished: partial final baru saja -> 'sudah selesai' (cooldown belum lewat, jangan restart)", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  assert.equal(isFinancialPeriodUnfinished({ status: "partial", finalized: true, updatedAt: now, completedAt: null }, now), false);
});

test("isFinancialPeriodUnfinished: partial final sudah lewat cooldown -> 'belum selesai' (boleh restart)", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  assert.equal(isFinancialPeriodUnfinished({ status: "partial", finalized: true, updatedAt: new Date(now.getTime() - HOUR_MS), completedAt: null }, now), true);
});

test("financialPeriodNeedsFreshStart: running/partial-belum-final -> resume (false), TIDAK start baru", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  assert.equal(financialPeriodNeedsFreshStart({ status: "running", finalized: false, updatedAt: now, completedAt: null }, now), false);
  assert.equal(financialPeriodNeedsFreshStart({ status: "partial", finalized: false, updatedAt: now, completedAt: null }, now), false);
});

test("financialPeriodNeedsFreshStart: tidak ada log sama sekali ATAU partial-final-lewat-cooldown -> true (start baru)", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  assert.equal(financialPeriodNeedsFreshStart(null, now), true);
  assert.equal(financialPeriodNeedsFreshStart({ status: "partial", finalized: true, updatedAt: new Date(now.getTime() - HOUR_MS), completedAt: null }, now), true);
});

test("isFinancialSyncRunStale: running yang masih fresh (baru diupdate) -> TIDAK stale — Test 7", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  assert.equal(isFinancialSyncRunStale({ status: "running", finalized: false, updatedAt: new Date(now.getTime() - 30 * 60 * 1000), completedAt: null }, now), false);
});

test("isFinancialSyncRunStale: running yang sudah lewat ambang (beberapa jam tanpa progres) -> stale — Test 8", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  assert.equal(isFinancialSyncRunStale({ status: "running", finalized: false, updatedAt: new Date(now.getTime() - 5 * HOUR_MS), completedAt: null }, now), true);
});

test("isFinancialSyncRunStale: status success/partial-final TIDAK PERNAH dianggap 'stale running' (label ini hanya utk running/partial-belum-final)", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  assert.equal(isFinancialSyncRunStale({ status: "success", finalized: true, updatedAt: new Date(now.getTime() - 10 * HOUR_MS), completedAt: now }, now), false);
  assert.equal(isFinancialSyncRunStale(null, now), false);
});

// ---- Integration: runOlseraFinancialCron auto-mode dual-period behavior ----

test("Test A: previous month punya jurnal baru setelah sync lama (success TAPI lewat interval) -> refresh berikutnya memperbarui data (startFinancialSync dipanggil utk previous)", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementation(async (period: string) =>
    period === "2026-07"
      ? fakeRun({ status: "success", phase: "completed", finalized: true, completedAt: new Date() }) // current sudah selesai
      : fakeRun({ period, status: "success", phase: "completed", finalized: true, completedAt: new Date(Date.now() - DAY_MS - HOUR_MS) }), // previous success TAPI 25 jam lalu
  );
  startFinancialSyncMock.mock.mockImplementationOnce(async (_year: unknown, _month: unknown) => fakeRun({ period: "2026-06", status: "running", phase: "monthly-reports", accountCursor: 0 }));
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ period: "2026-06", status: "success", phase: "completed" }));

  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(res.body.period, "2026-06");
  assert.equal(startFinancialSyncMock.mock.callCount(), 1);
  assert.deepEqual(startFinancialSyncMock.mock.calls[0].arguments, ["2026", "06"]);
});

test("Test E: bulan berjalan tetap refresh normal ketika belum pernah sync (perilaku existing tidak berubah)", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementation(async () => null);
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "success", phase: "completed" }));

  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(res.body.period, "2026-07");
  assert.equal(startFinancialSyncMock.mock.callCount(), 1);
});

test("Test G: mode manual (year/month eksplisit) HANYA memanggil getFinancialSyncLogForPeriod SATU KALI — previous month TIDAK ikut diperiksa", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementation(async () => null);
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "success", phase: "completed" }));

  await runOlseraFinancialCron("Bearer test-secret", { year: "2026", month: "5" });
  assert.equal(getFinancialSyncLogForPeriodMock.mock.callCount(), 1, "mode manual tidak boleh ikut memeriksa bulan lain");
});

test("staleRunningDetected: run current 'running' sudah lewat ambang stale -> tetap di-resume (BUKAN direset/dihapus), response menandai stale=true", async () => {
  resetAll();
  const staleUpdatedAt = new Date(Date.now() - 5 * HOUR_MS);
  getFinancialSyncLogForPeriodMock.mock.mockImplementation(async (period: string) =>
    period === "2026-07"
      ? fakeRun({ status: "running", phase: "ledger-details", finalized: false, updatedAt: staleUpdatedAt, accountCursor: 4 })
      : fakeRun({ period, status: "success", phase: "completed", finalized: true, completedAt: new Date() }),
  );
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "success", phase: "completed", accountCursor: 88 }));

  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(startFinancialSyncMock.mock.callCount(), 0, "run stale tetap di-RESUME lewat step, bukan di-restart dari nol");
  assert.equal(stepFinancialSyncMock.mock.callCount(), 1);
  assert.equal(res.body.staleRunningDetected, true);
});

test("staleRunningDetected: run current 'running' masih fresh -> stale=false di response", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementation(async (period: string) =>
    period === "2026-07"
      ? fakeRun({ status: "running", phase: "ledger-details", finalized: false, updatedAt: new Date(), accountCursor: 4 })
      : fakeRun({ period, status: "success", phase: "completed", finalized: true, completedAt: new Date() }),
  );
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "running", phase: "ledger-details" }));

  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(res.body.staleRunningDetected, false);
});

// =============================================================================
// Phase 3B.1 — perbaikan: current month WAJIB bisa refresh ulang berkala
// (bug Phase 3B: current yang sudah "success" dulu tidak pernah di-refresh
// otomatis lagi, sama persis dengan bug asli Juli yang seharusnya sudah
// diperbaiki). Test A-J mengikuti penomoran task Phase 3B.1.
// =============================================================================

test("Test A (3B.1): current success + refresh interval BELUM lewat -> no-op current (tetap dipercaya, tidak di-refresh terlalu sering)", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const currentLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: new Date(now.getTime() - 2 * HOUR_MS) }; // 2 jam lalu, < 6 jam
  const previousLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now }; // previous juga up to date
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog, previousLog, now });
  assert.equal(target, null);
});

test("Test B (3B.1): current success + refresh interval SUDAH lewat -> current eligible refresh (BUG Phase 3B yang diperbaiki)", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const currentLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: new Date(now.getTime() - 7 * HOUR_MS) }; // 7 jam lalu, > 6 jam
  const previousLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now };
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog, previousLog, now });
  assert.deepEqual(target, { period: "2026-08", startFresh: true, reason: "current-refresh-due" });
});

test("Test C (3B.1): previous success + 24 jam BELUM lewat -> tidak refresh (duplikat Test C lama, dipertahankan)", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const currentLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now };
  const previousLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: new Date(now.getTime() - 10 * HOUR_MS) };
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog, previousLog, now });
  assert.equal(target, null);
});

test("Test D (3B.1): previous success + 24 jam SUDAH lewat -> eligible refresh (duplikat Test D lama, dipertahankan)", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const currentLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now };
  const previousLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: new Date(now.getTime() - 25 * HOUR_MS) };
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog, previousLog, now });
  assert.deepEqual(target, { period: "2026-07", startFresh: true, reason: "previous-refresh-due" });
});

test("Test E (3B.1): current success fresh + previous running stale -> previous di-resume (bukan current yang dipaksa refresh)", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const currentLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now }; // baru saja, belum due
  const previousLog = { status: "running" as const, finalized: false, updatedAt: new Date(now.getTime() - 5 * HOUR_MS), completedAt: null }; // stale (>4h) tapi tetap "belum selesai"
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog, previousLog, now });
  assert.deepEqual(target, { period: "2026-07", startFresh: false, reason: "previous-unfinished" });
});

test("Test F (3B.1) — KASUS UTAMA anti-starvation: current REFRESH DUE + previous running stale -> previous TETAP MENANG (previous-unfinished didahulukan dari current-refresh-due)", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const currentLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: new Date(now.getTime() - 7 * HOUR_MS) }; // current SUDAH due (>6h)
  const previousLog = { status: "running" as const, finalized: false, updatedAt: new Date(now.getTime() - 5 * HOUR_MS), completedAt: null }; // previous stale & belum selesai
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog, previousLog, now });
  assert.deepEqual(target, { period: "2026-07", startFresh: false, reason: "previous-unfinished" }, "previous yang belum selesai TIDAK BOLEH kelaparan hanya karena current kebetulan due untuk refresh");
});

test("Test G (3B.1): current running fresh -> lanjut checkpoint current (resume, bukan restart)", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const currentLog = { status: "running" as const, finalized: false, updatedAt: new Date(now.getTime() - 10 * 60 * 1000), completedAt: null };
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog, previousLog: null, now });
  assert.deepEqual(target, { period: "2026-08", startFresh: false, reason: "current-unfinished" });
});

test("Test H (3B.1): Juli pada tanggal Agustus -> diklasifikasikan sebagai PREVIOUS, bukan current (koreksi terminologi Phase 3B)", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const currentPeriod = "2026-08";
  const previousPeriod = "2026-07";
  const julyStaleRunning = { status: "running" as const, finalized: false, updatedAt: new Date("2026-08-07T07:34:54.385Z"), completedAt: null };
  const target = selectFinancialCronTarget({ currentPeriod, previousPeriod, currentLog: null, previousLog: julyStaleRunning, now });
  // current (Agustus) belum ada log -> unfinished juga, jadi Agustus menang lebih dulu (prioritas current > previous).
  // Test ini murni membuktikan Juli identifiable sebagai previousPeriod, bukan currentPeriod.
  assert.equal(previousPeriod, "2026-07");
  assert.notEqual(currentPeriod, "2026-07");
  assert.equal(target?.period, "2026-08"); // current menang dulu (unfinished, belum ada log) -- lihat test terpisah utk giliran Juli murni
});

test("Test I (3B.1): bulan 2 bulan ke belakang (2026-06) tidak pernah dipilih walau current+previous keduanya up to date", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const currentLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now };
  const previousLog = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now };
  const target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog, previousLog, now });
  assert.equal(target, null); // TIDAK ada mekanisme apa pun yang bisa menjangkau 2026-06 dari sini
});

test("Test J (3B.1): panggilan cron berulang akhirnya memberi giliran current DAN previous sesuai interval/checkpoint masing-masing (simulasi manual, bukan real timer)", () => {
  // t0: current belum ada log sama sekali -> current menang (unfinished).
  let now = new Date("2026-08-09T00:00:00Z");
  let target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog: null, previousLog: null, now });
  assert.equal(target?.period, "2026-08");
  assert.equal(target?.reason, "current-unfinished");

  // t0 + sedikit: anggap current SUDAH selesai (success) barusan; previous belum pernah -> previous dapat giliran.
  const currentJustSucceeded = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now };
  target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog: currentJustSucceeded, previousLog: null, now });
  assert.equal(target?.period, "2026-07");
  assert.equal(target?.reason, "previous-unfinished");

  // t0 + sedikit lagi: previous juga sudah selesai barusan -> keduanya up to date -> no-op.
  const previousJustSucceeded = { status: "success" as const, finalized: true, updatedAt: now, completedAt: now };
  target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog: currentJustSucceeded, previousLog: previousJustSucceeded, now });
  assert.equal(target, null);

  // t0 + 7 jam: current sudah due (>6h), previous belum (<24h) -> giliran current.
  now = new Date(now.getTime() + 7 * HOUR_MS);
  target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog: currentJustSucceeded, previousLog: previousJustSucceeded, now });
  assert.equal(target?.period, "2026-08");
  assert.equal(target?.reason, "current-refresh-due");

  // t0 + 25 jam: current sudah di-refresh ulang (anggap barusan berhasil lagi), previous sekarang due (>24h) -> giliran previous.
  now = new Date(now.getTime() + 18 * HOUR_MS); // total +25 jam dari t0
  const currentRefreshedAgain = { status: "success" as const, finalized: true, updatedAt: new Date(now.getTime() - 1 * HOUR_MS), completedAt: new Date(now.getTime() - 1 * HOUR_MS) };
  target = selectFinancialCronTarget({ currentPeriod: "2026-08", previousPeriod: "2026-07", currentLog: currentRefreshedAgain, previousLog: previousJustSucceeded, now });
  assert.equal(target?.period, "2026-07");
  assert.equal(target?.reason, "previous-refresh-due");
});

// --- Phase 3C.5 — deadline internal (F, G): berhenti karena time budget
// adalah PROGRESS NORMAL (bukan error/timeout/409), dan lock tetap dilepas
// tepat seperti alasan berhenti lain (step-limit, completed, dst). Dipakai
// mock.timers untuk memajukan Date.now() secara deterministik TANPA
// menunggu 21 detik sungguhan di dalam test. ---

test("F) deadline internal tercapai -> response partial-progress normal (bukan error/409/timeout), stoppedForTimeBudget:true", async (t) => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // Step pertama "memakan waktu" >= TIME_BUDGET_MS (21 detik) — mensimulasikan
  // satu step ledger-details lambat yang melewati deadline (Phase 3C.4).
  stepFinancialSyncMock.mock.mockImplementation(async () => {
    t.mock.timers.tick(21_000);
    return fakeRun({ status: "running", phase: "ledger-details", accountCursor: 6 });
  });

  const res = await runOlseraFinancialCron("Bearer test-secret");

  assert.equal(res.status, 200, "berhenti karena deadline BUKAN error — tetap HTTP 200");
  assert.equal(res.body.status, "partial-progress");
  assert.equal(res.body.completed, false);
  assert.equal(res.body.stoppedForTimeBudget, true);
  assert.equal(res.body.nextCheckpoint, 6, "checkpoint step yang sudah selesai tetap dikembalikan");
  // Deadline sudah lewat setelah step pertama -> TIDAK lanjut ke step kedua
  // (membuktikan berhenti karena DEADLINE, bukan karena MAX_STEPS_PER_REQUEST).
  assert.equal(stepFinancialSyncMock.mock.callCount(), 1);
  assert.equal(res.body.stepsExecuted, 1);
});

test("G) lock tetap dilepas setelah invocation berhenti karena deadline internal", async (t) => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  stepFinancialSyncMock.mock.mockImplementation(async () => {
    t.mock.timers.tick(21_000);
    return fakeRun({ status: "running", phase: "ledger-details" });
  });

  await runOlseraFinancialCron("Bearer test-secret");

  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1);
  assert.equal(releaseOlseraSyncLockMock.mock.calls[0].arguments[0], "run-financial-lock-1");
});

test("deadline BELUM tercapai -> beberapa step tetap berjalan sequential seperti biasa (tidak berhenti prematur)", async (t) => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let cursor = 0;
  stepFinancialSyncMock.mock.mockImplementation(async () => {
    t.mock.timers.tick(500); // jauh di bawah deadline 21 detik
    cursor += 4;
    return fakeRun({ status: cursor >= 16 ? "success" : "running", phase: cursor >= 16 ? "completed" : "ledger-details", accountCursor: cursor });
  });

  const res = await runOlseraFinancialCron("Bearer test-secret");

  assert.equal(res.body.completed, true);
  assert.equal(res.body.stoppedForTimeBudget, false, "selesai normal sebelum deadline -> bukan karena time budget");
  assert.equal(stepFinancialSyncMock.mock.callCount(), 4);
});

test("anti-starvation: current unfinished tetap mengalahkan historical unfinished", () => {
  const now = new Date("2026-08-12T00:00:00Z");
  const target = selectFinancialCronTargetWithHistory({
    currentPeriod: "2026-08",
    previousPeriod: "2026-07",
    currentLog: fakeRun({ status: "running", finalized: false, completedAt: null, updatedAt: new Date("2026-08-11T23:00:00Z") }),
    previousLog: { status: "success", finalized: true, updatedAt: now, completedAt: now },
    historicalLogs: [{ ...fakeRun({ _id: "financial:1:2026-02", period: "2026-02", status: "running", finalized: false, updatedAt: new Date("2026-01-01T00:00:00Z") }), completedAt: null }],
    now,
  });
  assert.equal(target?.period, "2026-08");
  assert.equal(target?.reason, "current-unfinished");
  assert.equal(target?.startFresh, false);
});

test("anti-starvation: historical unfinished tertua dipilih setelah current selesai", () => {
  const now = new Date("2026-08-12T00:00:00Z");
  const target = selectFinancialCronTargetWithHistory({
    currentPeriod: "2026-08",
    previousPeriod: "2026-07",
    currentLog: { status: "success", finalized: true, updatedAt: now, completedAt: now },
    previousLog: { status: "success", finalized: true, updatedAt: now, completedAt: now },
    historicalLogs: [
      { ...fakeRun({ _id: "financial:1:2026-06", period: "2026-06", status: "partial", finalized: true, updatedAt: new Date("2026-06-03T00:00:00Z") }), completedAt: null },
      { ...fakeRun({ _id: "financial:1:2026-02", period: "2026-02", status: "running", finalized: false, updatedAt: new Date("2026-08-11T00:00:00Z") }), completedAt: null },
      { ...fakeRun({ _id: "financial:1:2026-04", period: "2026-04", status: "failed", finalized: true, updatedAt: new Date("2026-04-03T00:00:00Z") }), completedAt: null },
    ],
    now,
  });
  assert.equal(target?.period, "2026-02");
  assert.equal(target?.reason, "historical-unfinished");
  assert.equal(target?.startFresh, false);
});

test("historical backlog: running Mei cursor 76 dipilih lalu periode kosong Juni dan Juli dipilih berurutan", () => {
  const now = new Date("2026-08-16T00:00:00Z");
  const may = fakeRun({ period: "2026-05", status: "running", phase: "ledger-details", accountCursor: 76, updatedAt: now });
  const june = selectFinancialCronTargetWithHistory({
    currentPeriod: "2026-08",
    previousPeriod: "2026-07",
    currentLog: fakeRun({ period: "2026-08", status: "success", completedAt: now, updatedAt: now }),
    previousLog: null,
    historicalLogs: [may],
    historicalPeriods: ["2026-05", "2026-06", "2026-07"],
    now,
  });
  assert.equal(june?.period, "2026-05");
  assert.equal(june?.startFresh, false);

  const afterMay = selectFinancialCronTargetWithHistory({
    currentPeriod: "2026-08",
    previousPeriod: "2026-07",
    currentLog: fakeRun({ period: "2026-08", status: "success", completedAt: now, updatedAt: now }),
    previousLog: null,
    historicalLogs: [
      fakeRun({ period: "2026-02", status: "success", phase: "completed", completedAt: now, updatedAt: now }),
      fakeRun({ period: "2026-03", status: "success", phase: "completed", completedAt: now, updatedAt: now }),
      fakeRun({ period: "2026-04", status: "success", phase: "completed", completedAt: now, updatedAt: now }),
      { ...may, status: "success", phase: "completed", completedAt: now, updatedAt: now },
    ],
    historicalPeriods: ["2026-05", "2026-06", "2026-07"],
    now,
  });
  assert.equal(afterMay?.period, "2026-06");
  assert.equal(afterMay?.startFresh, true);
});

test("telemetry success menyimpan safeErrorCode null tanpa raw error", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "success", phase: "completed" }));
  await runOlseraFinancialCron("Bearer test-secret");
  const telemetry = financialInvocationInsertMock.mock.calls.at(-1)?.arguments[0] as Record<string, unknown>;
  assert.equal(telemetry.safeErrorCode, null);
  assert.equal("errorMessage" in telemetry, false);
  assert.equal(JSON.stringify(telemetry).toLowerCase().includes("secret"), false);
});

test("telemetry thrown error memakai UNKNOWN dan tidak menyimpan raw error/secret", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  stepFinancialSyncMock.mock.mockImplementation(async () => { throw new Error("secret-token https://private.example/abc"); });
  await runOlseraFinancialCron("Bearer test-secret");
  const telemetry = financialInvocationInsertMock.mock.calls.at(-1)?.arguments[0] as Record<string, unknown>;
  assert.equal(telemetry.safeErrorCode, "UNKNOWN");
  assert.equal(JSON.stringify(telemetry).includes("private.example"), false);
  assert.equal(JSON.stringify(telemetry).includes("secret-token"), false);
});

test("telemetry timeout/deadline memakai kode pendek yang aman", async (t) => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  stepFinancialSyncMock.mock.mockImplementation(async () => { throw new MongoServerSelectionError("Server selection timed out after 5000 ms", {} as never); });
  await runOlseraFinancialCron("Bearer test-secret");
  const timeoutTelemetry = financialInvocationInsertMock.mock.calls.at(-1)?.arguments[0] as Record<string, unknown>;
  assert.equal(timeoutTelemetry.safeErrorCode, "TIMEOUT");

  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => null);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  stepFinancialSyncMock.mock.mockImplementation(async () => {
    t.mock.timers.tick(21_000);
    return fakeRun({ status: "running", phase: "ledger-details" });
  });
  await runOlseraFinancialCron("Bearer test-secret");
  const deadlineTelemetry = financialInvocationInsertMock.mock.calls.at(-1)?.arguments[0] as Record<string, unknown>;
  assert.equal(deadlineTelemetry.safeErrorCode, "DEADLINE");
});
