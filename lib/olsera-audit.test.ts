// Test unit helper audit sync bulan berjalan Olsera.
// Jalankan: npm run test:olsera-audit
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateDayCompleteness,
  extractOrderTotal,
  fetchDayOrderRows,
  monthDatesUntil,
  planIncrementalOrders,
  sumOrderTotals,
  ORDER_TOTAL_TOLERANCE,
  type OrderListPage,
} from "./olsera-audit.ts";

// ---- planIncrementalOrders: sync incremental per order (cron Sales hari ini) ----

test("planIncrementalOrders: 50 order, 45 tersimpan sama persis -> hanya 5 ditarik (2 nominal berubah + 3 baru), 45 di-skip", () => {
  const listed = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, total: 1000 * (i + 1) }));
  const stored = new Map<number, number | null>();
  for (let id = 1; id <= 45; id++) stored.set(id, 1000 * id); // sama persis
  stored.set(46, 999); // nominal berubah
  stored.set(47, 1); // nominal berubah
  // 48-50 belum tersimpan sama sekali
  const plan = planIncrementalOrders(listed, stored);
  assert.deepEqual(plan.fetch, [46, 47, 48, 49, 50]);
  assert.equal(plan.skip.length, 45);
  assert.deepEqual(plan.skip.slice(0, 3), [1, 2, 3]);
});

test("planIncrementalOrders: nominal null di salah satu sisi -> ditarik; selisih <= toleransi -> di-skip (toleransi SAMA dengan evaluateDayCompleteness)", () => {
  const stored = new Map<number, number | null>([
    [1, null],
    [2, 100],
    [3, 100],
    [4, 100],
  ]);
  const plan = planIncrementalOrders(
    [
      { id: 1, total: 100 }, // stored null -> tidak bisa dibandingkan -> tarik
      { id: 2, total: null }, // listed null -> tarik
      { id: 3, total: 100 + ORDER_TOTAL_TOLERANCE }, // tepat di toleransi -> skip
      { id: 4, total: 100 + ORDER_TOTAL_TOLERANCE + 0.1 }, // lewat toleransi -> tarik
    ],
    stored,
  );
  assert.deepEqual(plan.fetch, [1, 2, 4]);
  assert.deepEqual(plan.skip, [3]);
  assert.deepEqual(planIncrementalOrders([], stored), { fetch: [], skip: [] });
});

test("monthDatesUntil: pertengahan bulan menghasilkan tanggal 1 s/d hari ini", () => {
  const dates = monthDatesUntil("2026-07-14");
  assert.equal(dates.length, 14);
  assert.equal(dates[0], "2026-07-01");
  assert.equal(dates[12], "2026-07-13");
  assert.equal(dates[13], "2026-07-14");
});

test("monthDatesUntil: tanggal 1 hanya menghasilkan satu tanggal", () => {
  assert.deepEqual(monthDatesUntil("2026-08-01"), ["2026-08-01"]);
});

test("extractOrderTotal: membaca beberapa varian field dan string numerik", () => {
  assert.equal(extractOrderTotal({ total_amount: 15000 }), 15000);
  assert.equal(extractOrderTotal({ grand_total: "27500.50" }), 27500.5);
  assert.equal(extractOrderTotal({ nama: "tanpa nominal" }), null);
});

test("sumOrderTotals: null bila ada baris tanpa nominal", () => {
  assert.equal(sumOrderTotals([{ id: 1, total: 100 }, { id: 2, total: 50 }]), 150);
  assert.equal(sumOrderTotals([{ id: 1, total: 100 }, { id: 2, total: null }]), null);
  assert.equal(sumOrderTotals([]), 0);
});

// ---- evaluateDayCompleteness: aturan lengkap/belum lengkap ----

test("lengkap: jumlah dan total cocok", () => {
  const verdict = evaluateDayCompleteness({
    expectedCount: 10,
    expectedTotal: 500000,
    marked: { expectedOrderCount: 10, expectedTotal: 500000 },
    storedOrderCount: 10,
  });
  assert.equal(verdict.complete, true);
});

test("tanggal kosong di Olsera dan MongoDB dianggap lengkap", () => {
  const verdict = evaluateDayCompleteness({
    expectedCount: 0,
    expectedTotal: 0,
    marked: null,
    storedOrderCount: 0,
  });
  assert.equal(verdict.complete, true);
});

test("Olsera kosong tetapi MongoDB berisi transaksi lama → belum lengkap", () => {
  const verdict = evaluateDayCompleteness({
    expectedCount: 0,
    expectedTotal: 0,
    marked: { expectedOrderCount: 5, expectedTotal: 100000 },
    storedOrderCount: 5,
  });
  assert.equal(verdict.complete, false);
});

test("MongoDB kosong tetapi Olsera memiliki transaksi → belum lengkap (kasus 13 Juli)", () => {
  // Reproduksi bug 13 Juli 2026: tanggal ditandai tuntas dengan 0 order,
  // padahal Olsera kini memiliki transaksi.
  const markedZero = evaluateDayCompleteness({
    expectedCount: 57,
    expectedTotal: 3500000,
    marked: { expectedOrderCount: 0, expectedTotal: 0 },
    storedOrderCount: 0,
  });
  assert.equal(markedZero.complete, false);

  // Variasi: catatan jumlah cocok tetapi koleksi Mongo kosong (data terhapus).
  const mongoEmpty = evaluateDayCompleteness({
    expectedCount: 57,
    expectedTotal: 3500000,
    marked: { expectedOrderCount: 57, expectedTotal: 3500000 },
    storedOrderCount: 0,
  });
  assert.equal(mongoEmpty.complete, false);
});

test("jumlah transaksi berbeda → belum lengkap", () => {
  const verdict = evaluateDayCompleteness({
    expectedCount: 12,
    expectedTotal: 800000,
    marked: { expectedOrderCount: 10, expectedTotal: 800000 },
    storedOrderCount: 10,
  });
  assert.equal(verdict.complete, false);
});

test("total penjualan berbeda → belum lengkap", () => {
  const verdict = evaluateDayCompleteness({
    expectedCount: 10,
    expectedTotal: 900000,
    marked: { expectedOrderCount: 10, expectedTotal: 800000 },
    storedOrderCount: 10,
  });
  assert.equal(verdict.complete, false);
});

test("belum pernah tuntas disync → belum lengkap", () => {
  const verdict = evaluateDayCompleteness({
    expectedCount: 3,
    expectedTotal: 45000,
    marked: null,
    storedOrderCount: 0,
  });
  assert.equal(verdict.complete, false);
});

test("total tidak tersedia (null) tidak menggagalkan tanggal yang jumlahnya cocok", () => {
  const verdict = evaluateDayCompleteness({
    expectedCount: 10,
    expectedTotal: null,
    marked: { expectedOrderCount: 10 },
    storedOrderCount: 10,
  });
  assert.equal(verdict.complete, true);
});

// ---- fetchDayOrderRows: pagination, dedup, 404, error ----

function page(rows: { id: number; total_amount?: number }[], lastPage: number): OrderListPage {
  return { data: rows, meta: { last_page: lastPage } };
}

test("fetchDayOrderRows: pagination lebih dari satu halaman terbaca semua", async () => {
  const rows = await fetchDayOrderRows(async (kind, pageNo) => {
    if (kind === "openorder") return null; // 404 = tidak ada open order
    if (pageNo === 1) return page([{ id: 1, total_amount: 100 }, { id: 2, total_amount: 200 }], 2);
    return page([{ id: 3, total_amount: 300 }], 2);
  });
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3]);
  assert.equal(sumOrderTotals(rows), 600);
});

test("fetchDayOrderRows: dedup id yang muncul di close dan open order", async () => {
  const rows = await fetchDayOrderRows(async (kind) =>
    kind === "closeorder"
      ? page([{ id: 1, total_amount: 100 }], 1)
      : page([{ id: 1, total_amount: 100 }, { id: 2, total_amount: 50 }], 1),
  );
  assert.equal(rows.length, 2);
});

test("fetchDayOrderRows: kedua endpoint 404 berarti benar-benar kosong", async () => {
  const rows = await fetchDayOrderRows(async () => null);
  assert.deepEqual(rows, []);
});

test("fetchDayOrderRows: error API dilempar, tidak dikembalikan sebagai kosong", async () => {
  await assert.rejects(
    fetchDayOrderRows(async (kind, pageNo) => {
      if (pageNo === 2) throw new Error("HTTP 500");
      return page([{ id: 1 }], 3);
    }),
    /HTTP 500/,
  );
});
