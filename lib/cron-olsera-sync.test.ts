// Test unit endpoint cron Sync Olsera: authorization + selalu sync hari ini.
// Jalankan: npm run test:cron-olsera-sync
import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.CRON_SECRET = "test-secret";

const syncOlseraSalesByCategoryMock = mock.fn(
  async (start_date: string, end_date: string, options?: { force?: boolean }) => ({
    status: "success",
    startDate: start_date,
    endDate: end_date,
    force: options?.force ?? false,
  }),
);

mock.module("@/lib/olsera-sync", {
  namedExports: {
    todayJakarta: () => "2026-07-20",
    syncOlseraSalesByCategory: syncOlseraSalesByCategoryMock,
  },
});

const { runOlseraCronSync } = await import("./cron-olsera-sync.ts");

test("500 bila CRON_SECRET belum tersedia", async () => {
  const original = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const res = await runOlseraCronSync("Bearer apapun");
  assert.equal(res.status, 500);
  assert.equal(res.body.success, false);
  process.env.CRON_SECRET = original;
});

test("401 bila header Authorization salah", async () => {
  const res = await runOlseraCronSync("Bearer salah");
  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
});

test("401 bila header Authorization tidak ada", async () => {
  const res = await runOlseraCronSync(null);
  assert.equal(res.status, 401);
});

test("200 dan selalu memanggil syncOlseraSalesByCategory untuk hari ini dengan force", async () => {
  syncOlseraSalesByCategoryMock.mock.resetCalls();
  const res = await runOlseraCronSync("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.mode, "cron");
  assert.deepEqual(res.body.period, { start_date: "2026-07-20", end_date: "2026-07-20" });
  assert.equal((res.body.result as { status: string }).status, "success");
  assert.equal(syncOlseraSalesByCategoryMock.mock.callCount(), 1);
  assert.deepEqual(syncOlseraSalesByCategoryMock.mock.calls[0].arguments, [
    "2026-07-20",
    "2026-07-20",
    { force: true },
  ]);
});

test("tetap memanggil sync hari ini meski hari ini sudah pernah fully synced sebelumnya", async () => {
  // Tidak ada lagi pengecekan lastFullySyncedDate di cron — cron tidak boleh
  // menganggap "sudah tersinkron hari ini" sebagai alasan untuk skip.
  syncOlseraSalesByCategoryMock.mock.resetCalls();
  const res = await runOlseraCronSync("Bearer test-secret");
  assert.equal(res.status, 200);
  assert.equal(syncOlseraSalesByCategoryMock.mock.callCount(), 1);
  const [start_date, end_date, options] = syncOlseraSalesByCategoryMock.mock.calls[0].arguments as [
    string,
    string,
    { force?: boolean },
  ];
  assert.equal(start_date, "2026-07-20");
  assert.equal(end_date, "2026-07-20");
  assert.equal(options?.force, true);
});

test("500 dan pesan error dipropagasi bila syncOlseraSalesByCategory gagal", async () => {
  syncOlseraSalesByCategoryMock.mock.mockImplementationOnce(async () => {
    throw new Error("Olsera API down");
  });
  const res = await runOlseraCronSync("Bearer test-secret");
  assert.equal(res.status, 500);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, "Olsera API down");
});
