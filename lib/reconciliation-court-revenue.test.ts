// Test lib/reconciliation-court-revenue.ts — MongoDB DIGANTI koleksi tiruan
// in-memory (DI, pola sama lib/reconciliation-sources.test.ts) supaya TIDAK
// PERNAH menyentuh database sungguhan. Dijalankan via
// `tsx --conditions=react-server --test` karena modul ini memakai "server-only".
import assert from "node:assert/strict";
import test from "node:test";
import {
  loadCourtRevenueMonthDetail,
  loadCourtRevenueMonthSummary,
  recentCourtRevenuePeriods,
  type CourtRevenueSourceContext,
  type MinimalReadCollection,
} from "./reconciliation-court-revenue.ts";
import type { BookingDocument, OlseraOrderItemDocument } from "./mongodb.ts";

type Doc = Record<string, unknown>;

function matchesFilter(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Doc;
      const value = doc[key] as string | number;
      if ("$gte" in c && !(value >= (c.$gte as string | number))) return false;
      if ("$lte" in c && !(value <= (c.$lte as string | number))) return false;
      return true;
    }
    return doc[key] === cond;
  });
}

function fake<T>(docs: Array<Partial<T>>): MinimalReadCollection<T> {
  return {
    find(filter: Doc) {
      const filtered = (docs as Doc[]).filter((doc) => matchesFilter(doc, filter));
      return { toArray: async () => filtered as T[] };
    },
  };
}

function context(overrides: Partial<CourtRevenueSourceContext> = {}): CourtRevenueSourceContext {
  return {
    bookings: fake<BookingDocument>([]),
    orderItems: fake<OlseraOrderItemDocument>([]),
    ...overrides,
  };
}

/** Item lapangan siap pakai — setiap panggilan WAJIB diberi `_id` unik (pola olsera_order_items sungguhan). */
function lapanganItem(overrides: Partial<OlseraOrderItemDocument> & { _id: number }): Partial<OlseraOrderItemDocument> {
  return {
    date: "2026-05-10",
    itemName: "Sewa Lapangan Padel",
    amount: 100000,
    categoryResolutionStatus: "resolved",
    resolvedCategoryName: "LAPANGAN PADEL",
    ...overrides,
  };
}

const NOW = new Date("2026-06-15T00:00:00Z");

test("summary: revenue & count cocok -> MATCH", async () => {
  const ctx = context({
    bookings: fake<BookingDocument>([
      { date: "2026-05-10", total_price: 200000, status: "paid" },
      { date: "2026-05-11", total_price: 150000, status: "paid" },
    ]),
    orderItems: fake<OlseraOrderItemDocument>([
      lapanganItem({ _id: 1, orderNo: "ORD-1", date: "2026-05-10", amount: 200000 }),
      lapanganItem({ _id: 2, orderNo: "ORD-2", date: "2026-05-11", amount: 150000 }),
    ]),
  });
  const summary = await loadCourtRevenueMonthSummary("2026-05", ctx, NOW);
  assert.deepEqual(summary.ayo, { count: 2, revenue: 350000 });
  assert.deepEqual(summary.olsera, { count: 2, revenue: 350000 });
  assert.equal(summary.differenceRevenue, 0);
  assert.equal(summary.status, "MATCH");
  assert.equal(summary.displayStatus, "MATCH");
});

test("summary: kategori non-lapangan (F&B/LABERS) tidak ikut dihitung", async () => {
  const ctx = context({
    bookings: fake<BookingDocument>([{ date: "2026-05-10", total_price: 200000, status: "paid" }]),
    orderItems: fake<OlseraOrderItemDocument>([
      lapanganItem({ _id: 1, orderNo: "ORD-1", amount: 200000 }),
      { _id: 2, orderNo: "ORD-1", date: "2026-05-10", itemName: "Kopi Susu", amount: 25000, categoryResolutionStatus: "resolved", resolvedCategoryName: "MINUMAN" },
      { _id: 3, orderNo: "ORD-2", date: "2026-05-10", itemName: "Sewa Raket Premium", amount: 50000, categoryResolutionStatus: "resolved", resolvedCategoryName: "LABERS" },
    ]),
  });
  const summary = await loadCourtRevenueMonthSummary("2026-05", ctx, NOW);
  assert.deepEqual(summary.olsera, { count: 1, revenue: 200000 });
});

test("summary: kategori belum resolved tidak ikut dihitung (tidak dipaksakan)", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([
      { _id: 1, orderNo: "ORD-1", date: "2026-05-10", itemName: "Item Aneh", amount: 200000, categoryResolutionStatus: "unresolved", resolvedCategoryName: null },
    ]),
  });
  const summary = await loadCourtRevenueMonthSummary("2026-05", ctx, NOW);
  assert.deepEqual(summary.olsera, { count: 0, revenue: 0 });
});

test("summary: selisih besar -> MISMATCH -> NEEDS_REVIEW (bulan sudah lewat)", async () => {
  const ctx = context({
    bookings: fake<BookingDocument>([{ date: "2026-05-10", total_price: 500000, status: "paid" }]),
    orderItems: fake<OlseraOrderItemDocument>([lapanganItem({ _id: 1, orderNo: "ORD-1", amount: 200000 })]),
  });
  const summary = await loadCourtRevenueMonthSummary("2026-05", ctx, NOW);
  assert.equal(summary.status, "MISMATCH");
  assert.equal(summary.displayStatus, "NEEDS_REVIEW");
});

test("summary: bulan berjalan (Asia/Jakarta) selalu CURRENT_PERIOD walau ada selisih", async () => {
  const ctx = context({
    bookings: fake<BookingDocument>([{ date: "2026-06-10", total_price: 500000, status: "paid" }]),
    orderItems: fake<OlseraOrderItemDocument>([lapanganItem({ _id: 1, orderNo: "ORD-1", date: "2026-06-10", amount: 100000 })]),
  });
  const summary = await loadCourtRevenueMonthSummary("2026-06", ctx, NOW);
  assert.equal(summary.displayStatus, "CURRENT_PERIOD");
});

test("summary: booking cancelled tidak dihitung ke omset AYO", async () => {
  const ctx = context({
    bookings: fake<BookingDocument>([{ date: "2026-05-10", total_price: 200000, status: "cancelled" }]),
  });
  const summary = await loadCourtRevenueMonthSummary("2026-05", ctx, NOW);
  assert.deepEqual(summary.ayo, { count: 0, revenue: 0 });
});

// ---- Deduplikasi order Olsera (audit: "Jumlah Transaksi Olsera" harus order unik, bukan baris item) ----

test("order Olsera: satu order dengan dua item lapangan dihitung SATU transaksi, revenue dijumlahkan penuh", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([
      lapanganItem({ _id: 1, orderNo: "ORD-100", itemName: "Sewa Lapangan Padel", amount: 100000 }),
      lapanganItem({ _id: 2, orderNo: "ORD-100", itemName: "Sewa Lapangan Pickleball", amount: 50000 }),
    ]),
  });
  const summary = await loadCourtRevenueMonthSummary("2026-05", ctx, NOW);
  assert.deepEqual(summary.olsera, { count: 1, revenue: 150000 });
});

test("order Olsera: order berisi item lapangan + non-lapangan tetap SATU transaksi, hanya nilai lapangan yang dijumlahkan", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([
      lapanganItem({ _id: 1, orderNo: "ORD-200", itemName: "Sewa Lapangan Padel", amount: 200000 }),
      { _id: 2, orderNo: "ORD-200", date: "2026-05-10", itemName: "Es Teh", amount: 15000, categoryResolutionStatus: "resolved", resolvedCategoryName: "MINUMAN" },
    ]),
  });
  const summary = await loadCourtRevenueMonthSummary("2026-05", ctx, NOW);
  assert.deepEqual(summary.olsera, { count: 1, revenue: 200000 });
});

test("order Olsera: dua order berbeda pada tanggal yang sama dihitung DUA transaksi", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([
      lapanganItem({ _id: 1, orderNo: "ORD-300", amount: 100000 }),
      lapanganItem({ _id: 2, orderNo: "ORD-301", amount: 120000 }),
    ]),
  });
  const summary = await loadCourtRevenueMonthSummary("2026-05", ctx, NOW);
  assert.deepEqual(summary.olsera, { count: 2, revenue: 220000 });
});

test("order Olsera: item tanpa orderNo valid (kosong/hilang) TIDAK digabung menebak-nebak — dihitung per baris", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([
      lapanganItem({ _id: 501, orderNo: undefined as unknown as string, amount: 100000 }),
      lapanganItem({ _id: 502, orderNo: "", amount: 80000 }),
    ]),
  });
  const summary = await loadCourtRevenueMonthSummary("2026-05", ctx, NOW);
  assert.deepEqual(summary.olsera, { count: 2, revenue: 180000 });
});

test("detail per tanggal: jumlah transaksi Olsera memakai order unik, bukan jumlah baris", async () => {
  const ctx = context({
    bookings: fake<BookingDocument>([{ date: "2026-05-10", total_price: 100000, status: "paid" }]),
    orderItems: fake<OlseraOrderItemDocument>([
      lapanganItem({ _id: 1, orderNo: "ORD-400", itemName: "Sewa Lapangan Padel", amount: 60000 }),
      lapanganItem({ _id: 2, orderNo: "ORD-400", itemName: "Sewa Lapangan Pickleball", amount: 40000 }),
    ]),
  });
  const detail = await loadCourtRevenueMonthDetail("2026-05", ctx, NOW);
  assert.deepEqual(detail.olsera, { count: 1, revenue: 100000 });
  assert.equal(detail.mismatchedDays.length, 0);
});

test("detail: mismatchedDays hanya berisi tanggal yang tidak match", async () => {
  const ctx = context({
    bookings: fake<BookingDocument>([
      { date: "2026-05-10", total_price: 200000, status: "paid" },
      { date: "2026-05-11", total_price: 100000, status: "paid" },
    ]),
    orderItems: fake<OlseraOrderItemDocument>([
      lapanganItem({ _id: 1, orderNo: "ORD-1", date: "2026-05-10", amount: 200000 }),
      lapanganItem({ _id: 2, orderNo: "ORD-2", date: "2026-05-11", amount: 400000 }),
    ]),
  });
  const detail = await loadCourtRevenueMonthDetail("2026-05", ctx, NOW);
  assert.equal(detail.mismatchedDays.length, 1);
  assert.equal(detail.mismatchedDays[0].date, "2026-05-11");
  assert.equal(detail.mismatchedDays[0].differenceRevenue, 300000);
});

test("recentCourtRevenuePeriods: mundur dari bulan berjalan, menangani pergantian tahun", () => {
  assert.deepEqual(recentCourtRevenuePeriods(3, new Date("2026-01-15T00:00:00Z")), ["2026-01", "2025-12", "2025-11"]);
});
