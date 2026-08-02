import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBookingTransactionCandidates, buildHourlySlotDrilldown } from "./reconciliation-court-revenue-drilldown.ts";
import type { BookingDocument, OlseraOrderItemDocument } from "./mongodb.ts";

function booking(overrides: Partial<BookingDocument>): BookingDocument {
  return {
    order_detail_id: 1,
    booking_id: "BK-1",
    field_id: 1,
    field_name: "Court No 1",
    date: "2026-07-01",
    start_time: "08:00",
    end_time: "09:00",
    total_price: 150000,
    status: "SUCCESS",
    booker_name: "Test",
    booker_phone: "",
    booker_email: "",
    booking_source: "order",
    branch_name: "Main",
    created_at: "",
    raw: {},
    syncedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function orderItem(overrides: Partial<OlseraOrderItemDocument>): OlseraOrderItemDocument {
  return {
    _id: Math.floor(Math.random() * 1e9),
    date: "2026-07-01",
    orderNo: "ORD-1",
    orderDate: "2026-07-01 08:05:00",
    customerId: null,
    customerName: null,
    tableNo: null,
    salesByName: null,
    itemName: "COURT FEES - 1",
    qty: 1,
    amount: 150000,
    costAmount: 0,
    discount: 0,
    resolvedCategoryName: "LAPANGAN PADEL",
    syncedAt: new Date(),
    ...overrides,
  };
}

test("buildHourlySlotDrilldown: mengelompokkan AYO per jam mulai dan Olsera per jam order, terpisah", () => {
  const rows = buildHourlySlotDrilldown(
    "2026-07-01",
    "Court No 1",
    [booking({ start_time: "08:00", total_price: 150000 }), booking({ start_time: "10:00", total_price: 150000, booking_id: "BK-2" })],
    [orderItem({ orderDate: "2026-07-01 08:10:00" })],
  );
  const row8 = rows.find((r) => r.hour === 8);
  const row10 = rows.find((r) => r.hour === 10);
  assert.equal(row8?.ayoRevenue, 150000);
  assert.equal(row8?.olseraRevenue, 150000);
  assert.equal(row10?.ayoRevenue, 150000);
  assert.equal(row10?.olseraCount, 0);
});

test("buildHourlySlotDrilldown: booking cancelled tidak dihitung", () => {
  const rows = buildHourlySlotDrilldown("2026-07-01", "Court No 1", [booking({ status: "CANCELLED" })], []);
  assert.equal(rows.length, 0);
});

test("buildBookingTransactionCandidates: nominal sama + jam dekat (<=15 menit) -> NEEDS_MANUAL_REVIEW, confidence MEDIUM", () => {
  const results = buildBookingTransactionCandidates("2026-07-01", "Court No 1", [booking({ start_time: "08:00", total_price: 150000 })], [orderItem({ orderDate: "2026-07-01 08:10:00", amount: 150000 })]);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "NEEDS_MANUAL_REVIEW");
  assert.equal(results[0].mappingConfidence, "MEDIUM");
});

test("buildBookingTransactionCandidates: nominal sama + jam agak jauh (15-60 menit) -> confidence LOW", () => {
  const results = buildBookingTransactionCandidates("2026-07-01", "Court No 1", [booking({ start_time: "08:00", total_price: 150000 })], [orderItem({ orderDate: "2026-07-01 08:45:00", amount: 150000 })]);
  assert.equal(results[0].mappingConfidence, "LOW");
});

test("buildBookingTransactionCandidates: tidak pernah HIGH confidence dan tidak pernah status MATCH", () => {
  const results = buildBookingTransactionCandidates("2026-07-01", "Court No 1", [booking({ start_time: "08:00", total_price: 150000 })], [orderItem({ orderDate: "2026-07-01 08:00:00", amount: 150000 })]);
  assert.notEqual(results[0].mappingConfidence, "HIGH");
  assert.notEqual((results[0].status as string), "MATCH");
});

test("buildBookingTransactionCandidates: nominal berbeda atau jam di luar 60 menit -> NOT_COMPARABLE, tidak dipaksakan", () => {
  const results = buildBookingTransactionCandidates("2026-07-01", "Court No 1", [booking({ start_time: "08:00", total_price: 150000 })], [orderItem({ orderDate: "2026-07-01 10:00:00", amount: 150000 })]);
  assert.equal(results[0].status, "NOT_COMPARABLE");
  assert.equal(results[0].mappingConfidence, null);
});

test("buildBookingTransactionCandidates: transaksi Olsera tanpa booking AYO pasangan tetap muncul sebagai NOT_COMPARABLE", () => {
  const results = buildBookingTransactionCandidates("2026-07-01", "Court No 1", [], [orderItem({})]);
  assert.equal(results.length, 1);
  assert.equal(results[0].bookingId, null);
  assert.equal(results[0].orderNo, "ORD-1");
  assert.equal(results[0].status, "NOT_COMPARABLE");
});

test("buildBookingTransactionCandidates: satu transaksi Olsera tidak dipakai dua kali (greedy tanpa duplikasi)", () => {
  const results = buildBookingTransactionCandidates(
    "2026-07-01",
    "Court No 1",
    [booking({ start_time: "08:00", total_price: 150000, booking_id: "BK-1" }), booking({ start_time: "08:05", total_price: 150000, booking_id: "BK-2" })],
    [orderItem({ orderDate: "2026-07-01 08:02:00", amount: 150000 })],
  );
  const matched = results.filter((r) => r.orderNo === "ORD-1");
  assert.equal(matched.length, 1);
  const unmatched = results.find((r) => r.orderNo === null);
  assert.equal(unmatched?.status, "NOT_COMPARABLE");
});
