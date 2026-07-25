// Test unit endpoint cron baru Kategori/Penjualan Olsera (Tahap 7): auth,
// distributed lock, idempotency, connection-expired, MongoDB timeout -> 504.
// Jalankan: npm run test:cron-olsera-sales
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { MongoServerSelectionError } from "mongodb";

process.env.CRON_SECRET = "test-secret";

const syncOlseraSalesByCategoryMock = mock.fn(async (start_date: string, end_date: string) => ({
  status: "success" as string,
  startDate: start_date,
  endDate: end_date,
  processedOrderCount: 3,
  errorMessage: null as string | null,
}));

mock.module("@/lib/olsera-sync", {
  namedExports: {
    todayJakarta: () => "2026-07-20",
    syncOlseraSalesByCategory: syncOlseraSalesByCategoryMock,
  },
});

const acquireOlseraSyncLockMock = mock.fn(async () => ({ ok: true, runId: "run-sales-1" }));
const releaseOlseraSyncLockMock = mock.fn(async (_runId: string) => true);

mock.module("@/lib/olsera-cron-lock", {
  namedExports: {
    acquireOlseraSyncLock: acquireOlseraSyncLockMock,
    releaseOlseraSyncLock: releaseOlseraSyncLockMock,
  },
});

const { runOlseraSalesCron } = await import("./cron-olsera-sales.ts");

test("401 bila header Authorization salah", async () => {
  const res = await runOlseraSalesCron("Bearer salah");
  assert.equal(res.status, 401);
});

test("500 bila CRON_SECRET belum tersedia", async () => {
  const original = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const res = await runOlseraSalesCron("Bearer apapun");
  assert.equal(res.status, 500);
  process.env.CRON_SECRET = original;
});

test("409 sync-in-progress bila lock sedang dipegang modul lain, tanpa BSON/detail rahasia", async () => {
  acquireOlseraSyncLockMock.mock.mockImplementationOnce(async () => ({
    ok: false,
    activeModule: "inventory",
    runId: "run-inventory-9",
  }));
  const res = await runOlseraSalesCron("Bearer test-secret");
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { status: "sync-in-progress", activeModule: "inventory", runId: "run-inventory-9" });
});

test("200 sukses: memanggil sync hari ini, melepas lock, runId disertakan", async () => {
  releaseOlseraSyncLockMock.mock.resetCalls();
  const res = await runOlseraSalesCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.module, "sales");
  assert.equal(res.body.runId, "run-sales-1");
  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1);
  assert.equal(releaseOlseraSyncLockMock.mock.calls[0].arguments[0], "run-sales-1");
});

test("idempotent: dua panggilan berturut-turut sama-sama sukses tanpa efek ganda berbahaya", async () => {
  syncOlseraSalesByCategoryMock.mock.resetCalls();
  await runOlseraSalesCron("Bearer test-secret");
  await runOlseraSalesCron("Bearer test-secret");
  assert.equal(syncOlseraSalesByCategoryMock.mock.callCount(), 2);
  for (const call of syncOlseraSalesByCategoryMock.mock.calls) {
    assert.deepEqual(call.arguments, ["2026-07-20", "2026-07-20", { force: true }]);
  }
});

test("connection-expired: pesan error mengandung 401 dipetakan ke status aman, bukan pesan mentah", async () => {
  syncOlseraSalesByCategoryMock.mock.mockImplementationOnce(async () => ({
    status: "failed",
    startDate: "2026-07-20",
    endDate: "2026-07-20",
    processedOrderCount: 0,
    errorMessage: "HTTP 401 token expired",
  }));
  const res = await runOlseraSalesCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.equal(res.body.safeErrorCode, "connection-expired");
});

test("MongoDB timeout saat sync -> HTTP 504 terstruktur, lock tetap dilepas", async () => {
  releaseOlseraSyncLockMock.mock.resetCalls();
  syncOlseraSalesByCategoryMock.mock.mockImplementationOnce(async () => {
    throw new MongoServerSelectionError("Server selection timed out after 5000 ms", {} as never);
  });
  const res = await runOlseraSalesCron("Bearer test-secret");
  assert.equal(res.status, 504);
  assert.equal(res.body.safeErrorCode, "mongodb-timeout");
  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1);
});

test("response tidak pernah menyertakan CRON_SECRET", async () => {
  const res = await runOlseraSalesCron("Bearer test-secret");
  assert.ok(!JSON.stringify(res.body).includes("test-secret"));
});
