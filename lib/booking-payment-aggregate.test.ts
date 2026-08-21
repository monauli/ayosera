import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { aggregateBookingPayments, paymentDetailsFor, withBookingPaymentTotals } from "./booking-payment-aggregate.ts";
import type { AyoPaymentEvent } from "./ayo-payment-events.ts";

// Fixture example only — mirrors the real production booking found during the
// 2026-08-13 audit (Rp150.000 + Rp50.000 split payment). The helper itself
// never branches on any specific booking_id.
const SPLIT_PAYMENT_BOOKING_ID = "MN/2428/260809/0002994";

function event(bookingId: string, reservationPaymentId: string, amount: number, id = reservationPaymentId): AyoPaymentEvent {
  const now = new Date("2026-08-12T00:00:00.000Z");
  return {
    _id: `internal_reservation:${bookingId}:${reservationPaymentId}`,
    identity: `internal_reservation:${bookingId}:${reservationPaymentId}`,
    bookingId,
    sourceTable: "internal_reservation",
    reservationPaymentId,
    nativeId: id,
    sourceId: id,
    eventDate: now,
    eventDateSource: "payment_date",
    amount,
    amountSource: "final_fee_ayo",
    bookingPrefix: bookingId.startsWith("BK") ? "BK" : bookingId.startsWith("MN") ? "MN" : "OTHER",
    paymentStatus: "SUCCESS",
    bookingStatus: "FINISHED",
    source: "ayo-report-transactions",
    rawPayload: {},
    normalizedPayload: {},
    createdAt: now,
    updatedAt: now,
    paymentType: null,
    paymentNote: null,
    detailStatus: "SUCCESS",
    finalStatus: "SUCCESS",
    fieldName: "Padel Court 1",
    date: "2026-08-12",
    startTime: null,
    endTime: null,
    total: amount,
    finalFeeAyo: amount,
    isCredit: false,
    raw: {},
    syncedAt: now,
  };
}

test("1 payment event -> nominal sama dengan payment tersebut", () => {
  const events = [event("BK-1", "1001", 75000)];
  const aggregate = aggregateBookingPayments(events);
  assert.equal(aggregate.get("BK-1")?.totalAmount, 75000);
  assert.equal(aggregate.get("BK-1")?.paymentCount, 1);
});

test("2 payment event (split payment) -> nominal dijumlahkan, tidak tertimpa", () => {
  const events = [
    event(SPLIT_PAYMENT_BOOKING_ID, "2742703", 150000),
    event(SPLIT_PAYMENT_BOOKING_ID, "2760168", 50000),
  ];
  const aggregate = aggregateBookingPayments(events);
  const entry = aggregate.get(SPLIT_PAYMENT_BOOKING_ID);
  assert.equal(entry?.totalAmount, 200000);
  assert.equal(entry?.paymentCount, 2);
  assert.equal(entry?.events.length, 2);
});

test("3 payment event -> nominal dijumlahkan ketiganya", () => {
  const events = [
    event("BK-3", "3001", 100000),
    event("BK-3", "3002", 25000),
    event("BK-3", "3003", 5000),
  ];
  const aggregate = aggregateBookingPayments(events);
  assert.equal(aggregate.get("BK-3")?.totalAmount, 130000);
  assert.equal(aggregate.get("BK-3")?.paymentCount, 3);
});

test("tanpa payment event sama sekali -> fallback ke bookings.total_price, bukan Rp0", () => {
  const bookings = [{ booking_id: "BK-NO-EVENT", total_price: 88000 }];
  const aggregate = aggregateBookingPayments([]);
  const result = withBookingPaymentTotals(bookings, aggregate);
  assert.equal(result[0].total_price, 88000);
});

test("null paymentEvents -> semua booking fallback ke total_price asli", () => {
  const bookings = [{ booking_id: "BK-X", total_price: 12345 }];
  const aggregate = aggregateBookingPayments(null);
  const result = withBookingPaymentTotals(bookings, aggregate);
  assert.deepEqual(result, bookings);
});

test("duplicate event (identity sama, re-sync) -> tidak double count", () => {
  const first = event("BK-DUP", "9001", 60000);
  const resynced = { ...first }; // same identity, re-synced row
  const aggregate = aggregateBookingPayments([first, resynced]);
  assert.equal(aggregate.get("BK-DUP")?.totalAmount, 60000);
  assert.equal(aggregate.get("BK-DUP")?.paymentCount, 1);
});

test("withBookingPaymentTotals: booking dengan payment event memakai total agregat, booking lain fallback", () => {
  const bookings = [
    { booking_id: SPLIT_PAYMENT_BOOKING_ID, total_price: 50000 /* nilai lama yang tertimpa sync terakhir */ },
    { booking_id: "BK-UNCOVERED", total_price: 42000 },
  ];
  const events = [
    event(SPLIT_PAYMENT_BOOKING_ID, "2742703", 150000),
    event(SPLIT_PAYMENT_BOOKING_ID, "2760168", 50000),
  ];
  const result = withBookingPaymentTotals(bookings, aggregateBookingPayments(events));
  assert.equal(result.find((b) => b.booking_id === SPLIT_PAYMENT_BOOKING_ID)?.total_price, 200000);
  assert.equal(result.find((b) => b.booking_id === "BK-UNCOVERED")?.total_price, 42000);
});

// --- Detail per payment (fitur expand "N pembayaran" di UI Transaksi) ---

test("paymentDetailsFor: 1 payment event -> 1 detail, tidak ada badge (dites di sisi UI)", () => {
  const events = [event("BK-1", "1001", 75000)];
  const aggregate = aggregateBookingPayments(events);
  const details = paymentDetailsFor(aggregate.get("BK-1")!);
  assert.equal(details.length, 1);
  assert.equal(details[0].referenceId, "1001");
  assert.equal(details[0].amount, 75000);
});

test("paymentDetailsFor: booking real MN/2428/260809/0002994 (2 pembayaran) -> total dan detail konsisten", () => {
  // Data ini persis hasil query read-only produksi (2026-08-13): kedua event
  // punya reservationPaymentId berbeda dan nominal berbeda, TAPI eventDate
  // yang sama (fallback tanggal sesi untuk source_table internal_reservation)
  // — karena itu UI sengaja tidak menampilkan tanggal/jam sama sekali, hanya
  // nominal + reference id (lihat lib/booking-payment-detail-ui.ts).
  const events = [
    event(SPLIT_PAYMENT_BOOKING_ID, "2742703", 150000),
    event(SPLIT_PAYMENT_BOOKING_ID, "2760168", 50000),
  ];
  const aggregate = aggregateBookingPayments(events);
  const entry = aggregate.get(SPLIT_PAYMENT_BOOKING_ID)!;
  const details = paymentDetailsFor(entry);

  // Total baris utama dan jumlah nominal detail HARUS identik — sumber sama persis.
  assert.equal(entry.totalAmount, 200000);
  assert.equal(
    details.reduce((sum, d) => sum + d.amount, 0),
    entry.totalAmount,
  );
  assert.equal(details.length, 2);
  assert.deepEqual(
    details.map((d) => d.referenceId),
    ["2742703", "2760168"],
  );
  assert.deepEqual(
    details.map((d) => d.amount),
    [150000, 50000],
  );
});

test("paymentDetailsFor: 3 payment event -> 3 detail, jumlah nominal = total", () => {
  const events = [
    event("BK-3", "3001", 100000),
    event("BK-3", "3002", 25000),
    event("BK-3", "3003", 5000),
  ];
  const aggregate = aggregateBookingPayments(events);
  const entry = aggregate.get("BK-3")!;
  const details = paymentDetailsFor(entry);
  assert.equal(details.length, 3);
  assert.equal(
    details.reduce((sum, d) => sum + d.amount, 0),
    entry.totalAmount,
  );
});

test("paymentDetailsFor: duplicate event (identity sama, re-sync) -> tidak double count di detail", () => {
  const first = event("BK-DUP", "9001", 60000);
  const resynced = { ...first };
  const aggregate = aggregateBookingPayments([first, resynced]);
  const entry = aggregate.get("BK-DUP")!;
  const details = paymentDetailsFor(entry);
  assert.equal(details.length, 1);
  assert.equal(entry.totalAmount, 60000);
});

test("Transaksi, Dashboard, Rekonsiliasi, dan Export memakai helper agregasi payment yang sama (jalur konsisten)", async () => {
  const [transactionsRoute, dashboardRoute, exportBulananRoute, exportHarianRoute, courtRevenueSource, omzetLedger] = await Promise.all([
    readFile(new URL("../app/api/transactions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/transactions/export/bulanan/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/transactions/export/harian/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/reconciliation-court-revenue-source.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/reconciliation-omzet-ledger.ts", import.meta.url), "utf8"),
  ]);
  // Rekonsiliasi (court-revenue dan omzet ledger) sudah memakai payment-events
  // yang sama, dedup-by-identity, dengan fallback ke bookings mentah hanya
  // ketika staging benar-benar tidak tersedia — bukan lagi total_price mentah
  // tanpa overlay.
  assert.match(courtRevenueSource, /readActiveStagedPaymentEvents/);
  assert.match(omzetLedger, /readActiveStagedPaymentEvents/);
  // Transaksi dan Dashboard detail memakai helper baru lib/booking-payment-aggregate.ts.
  assert.match(transactionsRoute, /aggregateBookingPayments/);
  assert.match(transactionsRoute, /withBookingPaymentTotals/);
  assert.match(dashboardRoute, /aggregateBookingPayments/);
  assert.match(dashboardRoute, /withBookingPaymentTotals/);
  // Koreksi 20 Agustus: Export SEKARANG memakai jalur PERSIS sama dengan
  // Transaksi/Dashboard (aggregateBookingPayments + withBookingPaymentTotals),
  // bukan lagi resolver terpisah (dashboardPaymentAmountsByBooking +
  // withCanonicalPaymentAmountsKeepUncovered) — dua implementasi paralel
  // dengan algoritma sum identik itu terbukti bisa drift (booking split-payment
  // MN/2428/260809/0002994 sempat menampilkan total berbeda antara Transaksi
  // AYO dan Export). Satu jalur kode menghilangkan kemungkinan drift itu sama sekali.
  assert.match(exportBulananRoute, /aggregateBookingPayments/);
  assert.match(exportBulananRoute, /withBookingPaymentTotals/);
  assert.match(exportHarianRoute, /aggregateBookingPayments/);
  assert.match(exportHarianRoute, /withBookingPaymentTotals/);
  assert.doesNotMatch(exportBulananRoute, /withCanonicalPaymentAmounts/);
  assert.doesNotMatch(exportHarianRoute, /withCanonicalPaymentAmounts/);
  // Semua jalur pada akhirnya membaca payment events lewat readActiveStagedPaymentEvents.
  assert.match(transactionsRoute, /readActiveStagedPaymentEvents/);
  assert.match(dashboardRoute, /readActiveStagedPaymentEvents/);
});
