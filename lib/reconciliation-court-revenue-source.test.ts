import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCourtRevenueFindings, type CourtRevenueSourceContext } from "./reconciliation-court-revenue-source.ts";
import type { BookingDocument, OlseraOrderItemDocument } from "./mongodb.ts";
import { PADEL_UNIDENTIFIED_BUCKET, PICKLEBALL_AGGREGATE_BUCKET } from "./court-mapping.ts";
import type { AyoPaymentEvent } from "./ayo-payment-events.ts";

function fakeCollection<T>(rows: T[]) {
  return { find: (filter: Record<string, unknown>) => ({ toArray: async () => rows }) };
}

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
    booker_phone: "0800",
    booker_email: "",
    booking_source: "order",
    branch_name: "Main",
    created_at: "2026-07-01T00:00:00Z",
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

function context(bookings: BookingDocument[], items: OlseraOrderItemDocument[]): CourtRevenueSourceContext {
  return { bookings: fakeCollection(bookings), orderItems: fakeCollection(items) };
}

function paymentEvent(id: string, date: string, amount: number): AyoPaymentEvent {
  return { _id: id, identity: id, bookingId: `BK-${id}`, sourceTable: "order_detail", reservationPaymentId: id, nativeId: id, sourceId: id, eventDate: new Date(`${date}T00:00:00Z`), eventDateSource: "payment_date", amount, amountSource: "final_fee_ayo", bookingPrefix: "BK", paymentStatus: "SUCCESS", bookingStatus: "SUCCESS", source: "ayo-report-transactions", rawPayload: {}, normalizedPayload: {}, createdAt: new Date(), updatedAt: new Date(), paymentType: null, paymentNote: null, detailStatus: "SUCCESS", finalStatus: "SUCCESS", fieldName: "Court No 1", date, startTime: null, endTime: null, total: amount, finalFeeAyo: amount, isCredit: false, raw: {}, syncedAt: new Date() };
}

function activeStaging(period: "2026-06" | "2026-07", rows: number, total: number): CourtRevenueSourceContext["staging"] {
  const events = Array.from({ length: rows }, (_, index) => paymentEvent(`${period}-${index}`, `${period}-01`, index + 1 === rows ? total : 0));
  const periods = { "2026-06": { rows: 1421, total: 242895499, duplicate: 0, conflict: 0, validationStatus: "validated" as const }, "2026-07": { rows: 1359, total: 237491000, duplicate: 0, conflict: 0, validationStatus: "validated" as const } };
  return {
    activation: { findOne: async () => ({ _id: "ayo-payment-events-active", activeRunId: "run", activatedAt: new Date(), activatedBy: "test" }) },
    runs: { findOne: async () => ({ _id: "run", periods, status: "active", createdAt: new Date(), updatedAt: new Date(), createdBy: "test" }) },
    events: { find: (filter) => ({ toArray: async () => filter.runId === "run" ? events.map((event) => ({ ...event, runId: "run", period, eventIdentity: event.identity, payload: event, fetchedAt: new Date() })) : [] }) },
  };
}

test("loadCourtRevenueFindings: MATCH bila revenue AYO dan Olsera sama persis per (tanggal, court)", async () => {
  const { findings } = await loadCourtRevenueFindings(
    "2026-07-01",
    "2026-07-01",
    context([booking({})], [orderItem({})]),
  );
  const f = findings.find((x) => x.courtKey === "Court No 1");
  assert.equal(f?.status, "MATCH");
});

test("loadCourtRevenueFindings: MISMATCH bila selisih melebihi toleransi", async () => {
  const { findings } = await loadCourtRevenueFindings(
    "2026-07-01",
    "2026-07-01",
    context([booking({ total_price: 150000 })], [orderItem({ amount: 300000 })]),
  );
  const f = findings.find((x) => x.courtKey === "Court No 1");
  assert.equal(f?.status, "MISMATCH");
});

test("loadCourtRevenueFindings: cancelled booking AYO tidak dihitung (MISSING_IN_AYO bila Olsera tetap ada)", async () => {
  const { findings } = await loadCourtRevenueFindings(
    "2026-07-01",
    "2026-07-01",
    context([booking({ status: "CANCELLED" })], [orderItem({})]),
  );
  const f = findings.find((x) => x.courtKey === "Court No 1");
  assert.equal(f?.status, "MISSING_IN_AYO");
});

test("loadCourtRevenueFindings: kategori non-lapangan Olsera dikecualikan total (tidak memengaruhi court manapun)", async () => {
  const { findings } = await loadCourtRevenueFindings(
    "2026-07-01",
    "2026-07-01",
    context([], [orderItem({ itemName: "Nasi Goreng", resolvedCategoryName: "MAKANAN", amount: 50000 })]),
  );
  assert.equal(findings.length, 0);
});

test("loadCourtRevenueFindings: item Padel dengan suku kata placeholder masuk bucket 'Tidak Teridentifikasi', BUTUH_ADJUST_MANUAL", async () => {
  const { findings } = await loadCourtRevenueFindings(
    "2026-07-01",
    "2026-07-01",
    context([], [orderItem({ itemName: "COURT FEES - -", amount: 150000 })]),
  );
  const f = findings.find((x) => x.courtKey === PADEL_UNIDENTIFIED_BUCKET);
  assert.equal(f?.status, "BUTUH_ADJUST_MANUAL");
  // total Padel bulanan tetap mencakup nominal ini (lihat docs §2) — hanya tidak masuk perbandingan per-court individual.
  assert.equal(f?.olseraRevenue, 150000);
});

test("loadCourtRevenueFindings: dua booking Pickleball field_name berbeda digabung ke satu bucket agregat (revenue dan count sisi AYO terhitung benar)", async () => {
  const { findings } = await loadCourtRevenueFindings(
    "2026-07-01",
    "2026-07-01",
    context(
      [booking({ field_name: "Pickleball 1", total_price: 100000 }), booking({ field_name: "Pickleball 2", total_price: 100000, booking_id: "BK-2" })],
      [
        orderItem({ itemName: "PICKLEBALL COURT FEE - -", resolvedCategoryName: "LAPANGAN PICKLEBALL", amount: 100000, orderNo: "ORD-1" }),
        orderItem({ itemName: "PICKLEBALL COURT FEE - -", resolvedCategoryName: "LAPANGAN PICKLEBALL", amount: 100000, orderNo: "ORD-2" }),
      ],
    ),
  );
  const f = findings.find((x) => x.courtKey === PICKLEBALL_AGGREGATE_BUCKET);
  assert.equal(f?.status, "MATCH");
  assert.equal(f?.ayoRevenue, 200000);
  assert.equal(f?.olseraRevenue, 200000);
  assert.equal((f?.expected.count as number), 2);
});

test("loadCourtRevenueFindings: jumlah booking AYO beda dari jumlah transaksi Olsera (walau revenue sama) -> MINOR_DIFFERENCE, bukan MATCH dipaksakan", async () => {
  const { findings } = await loadCourtRevenueFindings(
    "2026-07-01",
    "2026-07-01",
    context(
      [booking({ field_name: "Pickleball 1", total_price: 100000 }), booking({ field_name: "Pickleball 2", total_price: 100000, booking_id: "BK-2" })],
      [orderItem({ itemName: "PICKLEBALL COURT FEE - -", resolvedCategoryName: "LAPANGAN PICKLEBALL", amount: 200000 })],
    ),
  );
  const f = findings.find((x) => x.courtKey === PICKLEBALL_AGGREGATE_BUCKET);
  assert.equal(f?.status, "MINOR_DIFFERENCE");
  assert.equal(f?.diagnostics.countStatus, "MINOR_DIFFERENCE");
});

test("loadCourtRevenueFindings: tanggal tanpa data AYO maupun Olsera tidak menghasilkan finding sama sekali", async () => {
  const { findings } = await loadCourtRevenueFindings("2026-07-01", "2026-07-03", context([], []));
  assert.equal(findings.length, 0);
});

test("loadCourtRevenueFindings: sourceRefs membawa referensi id, bukan payload mentah", async () => {
  const { findings } = await loadCourtRevenueFindings(
    "2026-07-01",
    "2026-07-01",
    context([booking({})], [orderItem({})]),
  );
  const f = findings.find((x) => x.courtKey === "Court No 1");
  assert.deepEqual(f?.sourceRefs.ayoBookingIds, ["BK-1"]);
  assert.deepEqual(f?.sourceRefs.olseraOrderNos, ["ORD-1"]);
});

test("loadCourtRevenueFindings: total gabungan per court == jumlah tiap booking/item (no double count)", async () => {
  const { findings } = await loadCourtRevenueFindings(
    "2026-07-01",
    "2026-07-01",
    context(
      [booking({ total_price: 100000 }), booking({ total_price: 50000, booking_id: "BK-2" })],
      [orderItem({ amount: 90000, orderNo: "ORD-1" }), orderItem({ amount: 60000, orderNo: "ORD-2" })],
    ),
  );
  const f = findings.find((x) => x.courtKey === "Court No 1");
  assert.equal(f?.ayoRevenue, 150000);
  assert.equal(f?.olseraRevenue, 150000);
  assert.equal(f?.status, "MATCH");
});

test("rekonsiliasi Juni/Juli memakai nominal payment-event aktif, bukan nominal booking lama", async () => {
  for (const [period, rows, total] of [["2026-06", 1421, 242895499], ["2026-07", 1359, 237491000]] as const) {
    const { findings } = await loadCourtRevenueFindings(`${period}-01`, `${period}-01`, {
      ...context([booking({ date: `${period}-01`, total_price: total - 600000 })], [orderItem({ date: `${period}-01`, amount: total })]),
      staging: activeStaging(period, rows, total),
    });
    const finding = findings.find((item) => item.courtKey === "Court No 1");
    assert.equal(finding?.ayoRevenue, total);
    assert.equal(finding?.olseraRevenue, total);
  }
});

test("gagal membaca staging tetap fallback ke booking tanpa mengubah Olsera", async () => {
  const broken = { ...context([booking({ total_price: 150000 })], [orderItem({ amount: 150000 })]), staging: { activation: { findOne: async () => { throw new Error("Mongo unavailable"); } }, runs: { findOne: async () => null }, events: { find: () => ({ toArray: async () => [] }) } } };
  const { findings } = await loadCourtRevenueFindings("2026-07-01", "2026-07-01", broken);
  const finding = findings.find((item) => item.courtKey === "Court No 1");
  assert.equal(finding?.ayoRevenue, 150000);
  assert.equal(finding?.olseraRevenue, 150000);
});
