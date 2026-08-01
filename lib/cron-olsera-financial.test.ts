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

function fakeRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: "financial:1:2026-07",
    status: "running",
    phase: "ledger-details",
    accountCursor: 4,
    accountsProcessed: 4,
    recordsProcessed: 40,
    period: "2026-07",
    ...overrides,
  };
}

const getFinancialSyncLogForPeriodMock = mock.fn(async () => null as Record<string, unknown> | null);
mock.module("@/lib/olsera-financial-store", {
  namedExports: { getFinancialSyncLogForPeriod: getFinancialSyncLogForPeriodMock },
});

const startFinancialSyncMock = mock.fn(async (_year: unknown, _month: unknown) =>
  fakeRun({ status: "running", phase: "monthly-reports", accountCursor: 0 }),
);
const stepFinancialSyncMock = mock.fn(async (_runId: string) => fakeRun({ accountCursor: 4, accountsProcessed: 4 }));
mock.module("@/lib/olsera-financial-sync", {
  namedExports: { startFinancialSync: startFinancialSyncMock, stepFinancialSync: stepFinancialSyncMock },
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
let FinancialClientError: typeof import("./olsera-financial-client.ts").FinancialClientError;

before(async () => {
  runOlseraFinancialCron = (await import("./cron-olsera-financial.ts")).runOlseraFinancialCron;
  FinancialClientError = (await import("./olsera-financial-client.ts")).FinancialClientError;
});

/** Reset mock ke keadaan netral sebelum tiap skenario multi-step. */
function resetAll() {
  getFinancialSyncLogForPeriodMock.mock.resetCalls();
  startFinancialSyncMock.mock.resetCalls();
  stepFinancialSyncMock.mock.resetCalls();
  acquireOlseraSyncLockMock.mock.resetCalls();
  releaseOlseraSyncLockMock.mock.resetCalls();
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

test("idempotent: proses sudah success -> no-op, tidak memanggil start/step lagi", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => fakeRun({ status: "success", phase: "completed" }));
  const res = await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "completed");
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

test("12) run partial final di-restart hanya setelah cooldown, tidak pada invocation berikutnya", async () => {
  resetAll();
  stepFinancialSyncMock.mock.mockImplementation(async () => fakeRun({ status: "partial", phase: "ledger-details", finalized: true }));

  // Baru saja final -> jangan restart (hindari restart beruntun).
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () =>
    fakeRun({ status: "partial", finalized: true, updatedAt: new Date() }),
  );
  await runOlseraFinancialCron("Bearer test-secret");
  assert.equal(startFinancialSyncMock.mock.callCount(), 0);

  // Sudah lewat cooldown -> mulai run baru supaya akun gagal punya kesempatan pulih.
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () =>
    fakeRun({ status: "partial", finalized: true, updatedAt: new Date(Date.now() - 60 * 60 * 1000) }),
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
