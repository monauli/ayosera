// Test unit endpoint cron Inventori Olsera (Tahap 7): auth, lock, resume
// checkpoint (start melanjutkan run lama), step gagal, MongoDB timeout.
// Jalankan: npm run test:cron-olsera-inventory
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { MongoServerSelectionError } from "mongodb";

process.env.CRON_SECRET = "test-secret";

function fakeRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    status: "running",
    phase: "movements",
    startDate: "2026-07-01",
    endDate: "2026-07-20",
    currentDate: "2026-07-10",
    processedDays: 9,
    totalDays: 20,
    totalProducts: 100,
    totalMovements: 50,
    createdRecords: 10,
    updatedRecords: 5,
    failedDates: [],
    errorMessage: null,
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt: null,
    isStale: false,
    lastHeartbeatAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

const startInventorySyncMock = mock.fn(async () => fakeRun());
const stepInventorySyncMock = mock.fn(
  async (): Promise<{ done: boolean; run: ReturnType<typeof fakeRun> } | { error: string }> => ({
    done: false,
    run: fakeRun({ processedDays: 10 }),
  }),
);

mock.module("@/lib/olsera-inventory", {
  namedExports: {
    startInventorySync: startInventorySyncMock,
    stepInventorySync: stepInventorySyncMock,
  },
});

const acquireOlseraSyncLockMock = mock.fn(async () => ({ ok: true, runId: "run-inventory-lock-1" }));
const releaseOlseraSyncLockMock = mock.fn(async () => true);

mock.module("@/lib/olsera-cron-lock", {
  namedExports: {
    acquireOlseraSyncLock: acquireOlseraSyncLockMock,
    releaseOlseraSyncLock: releaseOlseraSyncLockMock,
  },
});

const { runOlseraInventoryCron } = await import("./cron-olsera-inventory.ts");

test("401 bila header Authorization salah", async () => {
  const res = await runOlseraInventoryCron("Bearer salah");
  assert.equal(res.status, 401);
});

test("409 sync-in-progress bila lock sedang dipegang cron/manual lain", async () => {
  acquireOlseraSyncLockMock.mock.mockImplementationOnce(async () => ({
    ok: false,
    activeModule: "financial",
    runId: "run-financial-2",
  }));
  const res = await runOlseraInventoryCron("Bearer test-secret");
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { status: "sync-in-progress", activeModule: "financial", runId: "run-financial-2" });
});

test("200: start melanjutkan run lama (checkpoint) lalu step satu langkah", async () => {
  startInventorySyncMock.mock.resetCalls();
  stepInventorySyncMock.mock.resetCalls();
  const res = await runOlseraInventoryCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(startInventorySyncMock.mock.callCount(), 1);
  assert.equal(stepInventorySyncMock.mock.callCount(), 1);
  assert.equal(res.body.currentStep, "movements");
  assert.equal(res.body.processedDays, 10);
  assert.equal(res.body.done, false);
});

test("step failed (\"error\" pada hasil) -> status failed aman, tanpa raw payload", async () => {
  stepInventorySyncMock.mock.mockImplementationOnce(async () => ({ error: "Tidak ada sync inventori yang sedang berjalan." }));
  const res = await runOlseraInventoryCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.equal(res.body.status, "failed");
  assert.equal(res.body.safeErrorCode, "step-failed");
});

test("resume: pemanggilan berulang melanjutkan checkpoint (processedDays naik, bukan diulang dari 0)", async () => {
  stepInventorySyncMock.mock.mockImplementationOnce(async () => ({ done: false, run: fakeRun({ processedDays: 11 }) }));
  const res = await runOlseraInventoryCron("Bearer test-secret");
  assert.equal(res.body.processedDays, 11);
});

test("MongoDB timeout -> HTTP 504 terstruktur, lock tetap dilepas", async () => {
  releaseOlseraSyncLockMock.mock.resetCalls();
  startInventorySyncMock.mock.mockImplementationOnce(async () => {
    throw new MongoServerSelectionError("Server selection timed out after 5000 ms", {} as never);
  });
  const res = await runOlseraInventoryCron("Bearer test-secret");
  assert.equal(res.status, 504);
  assert.equal(res.body.safeErrorCode, "mongodb-timeout");
  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1);
});
