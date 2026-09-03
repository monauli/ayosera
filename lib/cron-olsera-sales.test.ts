// Test unit endpoint cron baru Kategori/Penjualan Olsera (Tahap 7): auth,
// distributed lock, idempotency, connection-expired, MongoDB timeout -> 504.
// Jalankan: npm run test:cron-olsera-sales
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { MongoServerSelectionError } from "mongodb";

process.env.CRON_SECRET = "test-secret";

// Cron memakai auditAndSyncOlseraDay (cek Order List dulu, tarik ulang penuh
// hanya bila count/total berbeda) — BUKAN syncOlseraSalesByCategory({force:true})
// yang selalu menarik detail seluruh order.
const auditAndSyncOlseraDayMock = mock.fn(async (date: string) => ({
  date,
  action: "resynced" as string,
  expectedOrderCount: 3,
  processedOrderCount: 3,
  reason: null as string | null,
  errorMessage: null as string | null,
}));

const syncState = { lastDailyAuditDate: null as string | null };
const syncStateCollection = {
  findOne: mock.fn(async () => ({ _id: "olsera", lastDailyAuditDate: syncState.lastDailyAuditDate })),
  updateOne: mock.fn(async (_filter: unknown, update: { $set?: { lastDailyAuditDate?: string } }) => {
    syncState.lastDailyAuditDate = update.$set?.lastDailyAuditDate ?? syncState.lastDailyAuditDate;
  }),
};
mock.module("@/lib/mongodb", {
  namedExports: {
    collections: async () => ({ olseraSyncState: syncStateCollection }),
    withMongo: async <T>(fn: () => Promise<T>) => fn(),
  },
});

mock.module("@/lib/olsera-sync", {
  namedExports: {
    todayJakarta: () => "2026-07-20",
    auditAndSyncOlseraDay: auditAndSyncOlseraDayMock,
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
  syncState.lastDailyAuditDate = null;
  auditAndSyncOlseraDayMock.mock.resetCalls();
  await runOlseraSalesCron("Bearer test-secret");
  await runOlseraSalesCron("Bearer test-secret");
  assert.equal(auditAndSyncOlseraDayMock.mock.callCount(), 3);
  // Hari ini: incremental (hanya order baru/berubah). H-1: TANPA opsi =
  // tarik ulang penuh (safety-net) — jangan pernah ikut incremental.
  assert.deepEqual(auditAndSyncOlseraDayMock.mock.calls[0].arguments, ["2026-07-20", { incremental: true }]);
  assert.deepEqual(auditAndSyncOlseraDayMock.mock.calls[1].arguments, ["2026-07-19"]);
  assert.deepEqual(auditAndSyncOlseraDayMock.mock.calls[2].arguments, ["2026-07-20", { incremental: true }]);
});

test("action match (data sudah cocok) -> sukses tanpa tarik ulang, alasan diteruskan ke response", async () => {
  auditAndSyncOlseraDayMock.mock.mockImplementationOnce(async (date: string) => ({
    date,
    action: "match",
    expectedOrderCount: 42,
    processedOrderCount: 0,
    reason: "Jumlah dan total cocok",
    errorMessage: null,
  }));
  const res = await runOlseraSalesCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.action, "match");
  assert.equal(res.body.expectedCount, 42);
  assert.equal(res.body.processedCount, 0, "match berarti TIDAK ada order detail yang ditarik ulang");
  assert.equal(res.body.reason, "Jumlah dan total cocok");
});

test("audit H-1 gagal tidak menggagalkan sync hari ini dan marker tidak ditulis", async () => {
  syncState.lastDailyAuditDate = null;
  auditAndSyncOlseraDayMock.mock.resetCalls();
  auditAndSyncOlseraDayMock.mock.mockImplementation(async (date: string) => ({
    date,
    action: date === "2026-07-19" ? "failed" : "match",
    expectedOrderCount: 0,
    processedOrderCount: 0,
    reason: null,
    errorMessage: date === "2026-07-19" ? "temporary Olsera error" : null,
  }));
  const updateCallsBefore = syncStateCollection.updateOne.mock.callCount();
  const res = await runOlseraSalesCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(syncState.lastDailyAuditDate, null);
  assert.equal(syncStateCollection.updateOne.mock.callCount(), updateCallsBefore);
  auditAndSyncOlseraDayMock.mock.mockImplementation(async (date: string) => ({
    date,
    action: "resynced",
    expectedOrderCount: 3,
    processedOrderCount: 3,
    reason: null,
    errorMessage: null,
  }));
});

test("connection-expired: pesan error mengandung 401 dipetakan ke status aman, bukan pesan mentah", async () => {
  auditAndSyncOlseraDayMock.mock.mockImplementationOnce(async (date: string) => ({
    date,
    action: "failed",
    expectedOrderCount: 0,
    processedOrderCount: 0,
    reason: null,
    errorMessage: "HTTP 401 token expired",
  }));
  const res = await runOlseraSalesCron("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.equal(res.body.safeErrorCode, "connection-expired");
});

test("MongoDB timeout saat sync -> HTTP 504 terstruktur, lock tetap dilepas", async () => {
  releaseOlseraSyncLockMock.mock.resetCalls();
  auditAndSyncOlseraDayMock.mock.mockImplementationOnce(async () => {
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
