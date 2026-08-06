// Regression test: kartu "Performa Lapangan" pada Dashboard sebelumnya
// menjumlahkan bookings.total_price per court (lib/dashboard-payment-metrics.ts
// TIDAK dipakai di sana), sementara total utama Dashboard sudah memakai
// payment-event AYO tervalidasi. Akibatnya Court 4 Juli 2026 kurang Rp150.000
// (booking MN/2428/260729/0002761 hanya tersimpan Rp50.000 padahal ada dua
// payment SUCCESS Rp150.000 + Rp50.000) dan empat court Juni 2026 kurang
// total Rp600.000. Fix: app/api/dashboard/route.ts kini menyusun bookings yang
// dipakai untuk agregasi per-court lewat withCanonicalPaymentAmounts() +
// dashboardPaymentAmountsByBooking() — helper yang SAMA dipakai Export Omzet
// Bulanan/Kategori dan total utama Dashboard — bukan formula baru.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withCanonicalPaymentAmounts } from "./omzet-export.ts";
import { dashboardPaymentAmountsByBooking } from "./dashboard-payment-metrics.ts";
import type { BookingDocument } from "./mongodb.ts";
import type { AyoPaymentEvent } from "./ayo-payment-events.ts";

function fakeBooking(overrides: Partial<BookingDocument>): BookingDocument {
  return {
    order_detail_id: 1,
    booking_id: "BOOK-1",
    field_id: 1,
    field_name: "Court No 1",
    date: "2026-07-01",
    start_time: "08:00",
    end_time: "09:00",
    total_price: 100000,
    status: "confirmed",
    booker_name: "Budi",
    booker_phone: "0812",
    booker_email: "budi@example.com",
    booking_source: "order",
    branch_name: "BC Padel",
    created_at: "2026-07-01T00:00:00.000Z",
    raw: {},
    syncedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function paymentEvent(id: string, bookingId: string, amount: number, date: string): AyoPaymentEvent {
  const now = new Date(`${date}T00:00:00.000Z`);
  return {
    _id: id,
    identity: `internal_reservation:${bookingId}:${id}`,
    bookingId,
    sourceTable: "internal_reservation",
    reservationPaymentId: id,
    nativeId: id,
    sourceId: id,
    eventDate: now,
    eventDateSource: "payment_date",
    amount,
    amountSource: "total",
    bookingPrefix: "MN",
    paymentStatus: "SUCCESS",
    bookingStatus: null,
    source: "ayo-report-transactions",
    rawPayload: {},
    normalizedPayload: {},
    createdAt: now,
    updatedAt: now,
    paymentType: "MANUAL",
    paymentNote: null,
    detailStatus: "SUCCESS",
    finalStatus: "SUCCESS",
    fieldName: "Court No 4",
    date,
    startTime: "16:00:00",
    endTime: "17:00:00",
    total: amount,
    finalFeeAyo: 0,
    isCredit: false,
    raw: {},
    syncedAt: now,
  };
}

/** Reproduksi persis komposisi yang dipakai app/api/dashboard/route.ts untuk courtEligibleBookings. */
function courtEligibleBookings(bookings: BookingDocument[], events: readonly AyoPaymentEvent[] | null) {
  return events ? withCanonicalPaymentAmounts(bookings, dashboardPaymentAmountsByBooking(events)) : bookings;
}

function groupByCourt(bookings: BookingDocument[]) {
  const acc: Record<string, { revenueValue: number; count: number }> = {};
  for (const booking of bookings) {
    const name = booking.field_name;
    acc[name] ||= { revenueValue: 0, count: 0 };
    acc[name].revenueValue += booking.total_price;
    acc[name].count += 1;
  }
  return acc;
}

test("Juli: booking MN/2428/260729/0002761 di Court 4 — dua payment SUCCESS (150rb+50rb) menggantikan total_price lama 50rb", () => {
  const booking = fakeBooking({ booking_id: "MN/2428/260729/0002761", field_name: "Court No 4", total_price: 50000 });
  const events = [
    paymentEvent("a", "MN/2428/260729/0002761", 150000, "2026-07-30"),
    paymentEvent("b", "MN/2428/260729/0002761", 50000, "2026-07-30"),
  ];
  const eligible = courtEligibleBookings([booking], events);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].total_price, 200000);
  assert.equal(eligible[0].field_name, "Court No 4"); // metadata court tetap dari booking

  const grouped = groupByCourt(eligible);
  assert.equal(grouped["Court No 4"].revenueValue, 200000);
  assert.equal(grouped["Court No 4"].count, 1); // satu booking, bukan dua entri
});

test("Juli: Court 4 bertambah tepat Rp150.000 dibanding baseline lama, court lain tidak ikut berubah", () => {
  const other = fakeBooking({ booking_id: "OTHER-1", field_name: "Court No 1", total_price: 60000 });
  const target = fakeBooking({ booking_id: "MN/2428/260729/0002761", field_name: "Court No 4", total_price: 50000 });
  const events = [
    paymentEvent("a", "MN/2428/260729/0002761", 150000, "2026-07-30"),
    paymentEvent("b", "MN/2428/260729/0002761", 50000, "2026-07-30"),
    paymentEvent("c", "OTHER-1", 60000, "2026-07-01"),
  ];
  const before = groupByCourt([other, target]);
  const after = groupByCourt(courtEligibleBookings([other, target], events));
  assert.equal(after["Court No 4"].revenueValue - before["Court No 4"].revenueValue, 150000);
  assert.equal(after["Court No 1"].revenueValue, before["Court No 1"].revenueValue);
});

test("Juni: empat booking shortfall menambah tepat Rp600.000, teralokasi ke court masing-masing", () => {
  const fixtures = [
    { bookingId: "MN/2428/260525/0001581", court: "Court No 3", oldTotal: 125000, dp: 150000, settlement: 125000 },
    { bookingId: "MN/2428/260525/0001582", court: "Court No 3", oldTotal: 125000, dp: 150000, settlement: 125000 },
    { bookingId: "MN/2428/260606/0001835", court: "Court No 2", oldTotal: 50000, dp: 150000, settlement: 50000 },
    { bookingId: "MN/2428/260611/0001951", court: "Court No 2", oldTotal: 50000, dp: 150000, settlement: 50000 },
  ];
  const bookings = fixtures.map((f) => fakeBooking({ booking_id: f.bookingId, field_name: f.court, total_price: f.oldTotal }));
  const events = fixtures.flatMap((f) => [
    paymentEvent(`${f.bookingId}-dp`, f.bookingId, f.dp, "2026-06-04"),
    paymentEvent(`${f.bookingId}-settlement`, f.bookingId, f.settlement, "2026-06-04"),
  ]);

  const before = groupByCourt(bookings);
  const after = groupByCourt(courtEligibleBookings(bookings, events));

  const totalBefore = Object.values(before).reduce((sum, c) => sum + c.revenueValue, 0);
  const totalAfter = Object.values(after).reduce((sum, c) => sum + c.revenueValue, 0);
  assert.equal(totalAfter - totalBefore, 600000);

  assert.equal(after["Court No 3"].revenueValue - before["Court No 3"].revenueValue, 300000); // 2 booking x 150rb
  assert.equal(after["Court No 2"].revenueValue - before["Court No 2"].revenueValue, 300000); // 2 booking x 150rb
});

test("Total gabungan sama dengan jumlah payment canonical per booking — tidak double count", () => {
  const bookings = [
    fakeBooking({ booking_id: "A", field_name: "Court No 1", total_price: 10 }),
    fakeBooking({ booking_id: "B", field_name: "Court No 2", total_price: 10 }),
  ];
  const events = [
    paymentEvent("a1", "A", 100000, "2026-07-01"),
    paymentEvent("a2", "A", 50000, "2026-07-01"),
    paymentEvent("b1", "B", 75000, "2026-07-01"),
  ];
  const eligible = courtEligibleBookings(bookings, events);
  const grouped = groupByCourt(eligible);
  const total = Object.values(grouped).reduce((sum, c) => sum + c.revenueValue, 0);
  const canonicalTotal = [...dashboardPaymentAmountsByBooking(events).values()].reduce((sum, v) => sum + v, 0);
  assert.equal(total, canonicalTotal);
  assert.equal(total, 225000);
});

test("Duplicate payment identity tidak dihitung dua kali (memakai dedupe Dashboard yang sama)", () => {
  const booking = fakeBooking({ booking_id: "A", field_name: "Court No 1", total_price: 10 });
  const first = paymentEvent("dup", "A", 150000, "2026-07-01");
  const duplicateSameIdentity = { ...first, amount: 150000, syncedAt: new Date("2026-07-02T00:00:00.000Z") };
  const grouped = groupByCourt(courtEligibleBookings([booking], [first, duplicateSameIdentity]));
  assert.equal(grouped["Court No 1"].revenueValue, 150000); // bukan 300000
});

test("Booking tanpa payment canonical dihilangkan saat staging aktif — tidak dipaksa pakai total_price lama", () => {
  const withEvent = fakeBooking({ booking_id: "A", field_name: "Court No 1", total_price: 10 });
  const withoutEvent = fakeBooking({ booking_id: "B", field_name: "Court No 2", total_price: 999999 });
  const events = [paymentEvent("a1", "A", 100000, "2026-07-01")];
  const eligible = courtEligibleBookings([withEvent, withoutEvent], events);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].booking_id, "A");
  const grouped = groupByCourt(eligible);
  assert.equal(grouped["Court No 2"], undefined); // court tanpa payment tidak muncul dengan angka lama
});

test("Booking tanpa staging (fallback null) tetap memakai total_price booking apa adanya", () => {
  const bookings = [fakeBooking({ booking_id: "A", field_name: "Court No 4", total_price: 50000 })];
  const eligible = courtEligibleBookings(bookings, null);
  assert.deepEqual(eligible, bookings);
});

test("Metadata court event tidak menimpa court booking (pickleball tidak tertukar ke padel)", () => {
  // Event.fieldName sengaja berbeda dari booking.field_name untuk membuktikan
  // grouping tetap memakai metadata booking, bukan payment event.
  const booking = fakeBooking({ booking_id: "A", field_name: "Lapangan Pickleball 1", total_price: 10 });
  const event = paymentEvent("a1", "A", 100000, "2026-07-01"); // event.fieldName = "Court No 4"
  const eligible = courtEligibleBookings([booking], [event]);
  assert.equal(eligible[0].field_name, "Lapangan Pickleball 1");
  const grouped = groupByCourt(eligible);
  assert.equal(grouped["Lapangan Pickleball 1"].revenueValue, 100000);
  assert.equal(grouped["Court No 4"], undefined);
});

test("app/api/dashboard/route.ts memakai helper shared yang sama untuk Court Performance (bukan logic baru)", async () => {
  const route = await readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8");
  assert.match(route, /withCanonicalPaymentAmounts/);
  assert.match(route, /dashboardPaymentAmountsByBooking\(validatedPaymentEvents\.events\)/);
  assert.match(route, /courtEligibleBookings\.reduce/);
  // Total utama Dashboard tidak boleh berubah oleh perubahan ini.
  assert.match(route, /revenueMonth: toIdrFull\(paymentMetrics\.revenueMonth\)/);
});

// ---------------------------------------------------------------------------
// Card "Performa Lapangan" — urutan tetap (bukan omzet) + "Total Pendapatan
// Lapangan" (SUM dari data yang sama, bukan sumber baru). app/page.tsx adalah
// client component ("use client") sehingga tidak diimpor langsung di sini —
// mengikuti pola inspeksi source yang sudah dipakai test lain di repo ini
// (mis. lib/olsera-inventory-ui.test.ts) untuk memverifikasi struktur kode
// tanpa merender React.
// ---------------------------------------------------------------------------

test("app/page.tsx: COURT_DISPLAY_ORDER tetap Court No 1-4 lalu Pickleball 1-2, urutan tidak diubah menjadi berdasarkan omzet", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /const COURT_DISPLAY_ORDER = \["Court No 1", "Court No 2", "Court No 3", "Court No 4", "Pickleball 1", "Pickleball 2"\];/,
  );
  // courtPerformance dibangun langsung dari COURT_DISPLAY_ORDER.map(...) TANPA
  // .sort(...) mengikat langsung ke hasilnya (item 8-9: urutan tetap, omzet
  // tinggi tidak mengubah urutan tampil).
  const mapMatch = source.match(/const courtPerformance = COURT_DISPLAY_ORDER\.map\(\(name\) => \{[\s\S]*?\n {2}\}\);/);
  assert.ok(mapMatch, "courtPerformance harus dibangun dari COURT_DISPLAY_ORDER.map(...) yang diakhiri '});', bukan '}).sort(...)'");
});

test("app/page.tsx: courtRevenueByName di-lookup per nama tetap (item 10 — lapangan tanpa data tidak menggeser/merusak urutan lapangan lain)", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /const entry = courtRevenueByName\.get\(name\) \?\? \{ revenueValue: 0, count: 0 \};/);
});

test("app/page.tsx: 'Lapangan Teratas' (badge ringkasan) boleh tetap dihitung dari omzet tertinggi via salinan terpisah, TIDAK menyortir ulang array courtPerformance yang dikirim ke card", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /const courtTopCourt = \[\.\.\.courtPerformance\]\.sort\(\(a, b\) => b\.revenueValue - a\.revenueValue\)\[0\];/);
});

test("app/page.tsx: Total Pendapatan Lapangan = reduce SUM courtPerformance yang SAMA dikirim ke card (item 11, 14 — bukan sumber baru, tidak double count)", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /const courtTotalRevenue = courtPerformance\.reduce\(\(sum, item\) => sum \+ item\.revenueValue, 0\);/);
  // Jumlah pesanan dihitung terpisah dari nominal (tidak tercampur, item 16).
  assert.match(source, /const courtTotalOrders = courtPerformance\.reduce\(\(sum, item\) => sum \+ item\.count, 0\);/);
  // Diteruskan terformat ke card, memakai formatRupiah yang sama dengan kartu lain.
  assert.match(source, /courtTotalRevenue=\{formatRupiah\(courtTotalRevenue\)\}/);
});

test("app/page.tsx: total utama Dashboard (revenueMonth/card Pendapatan) tidak disentuh oleh perubahan Performa Lapangan (item 17)", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  // dashboard.topServices tetap sumber tunggal courtRevenueByName — bukan
  // hasil hitung ulang dari koleksi lain.
  assert.match(source, /for \(const service of dashboard\?\.topServices \?\? \[\]\) \{/);
});

test("components/redesign/dashboard-overview.tsx: courtTotalRevenue diteruskan apa adanya ke CourtPerformance (tidak dihitung ulang di lapisan ini)", async () => {
  const source = await readFile(new URL("../components/redesign/dashboard-overview.tsx", import.meta.url), "utf8");
  assert.match(source, /courtTotalRevenue: string;/);
  assert.match(source, /totalRevenue=\{courtTotalRevenue\}/);
});

test("components/redesign/court-performance.tsx: 'Total Pendapatan Lapangan' dirender terpisah dari 'Total Pesanan' (nominal tidak tercampur dengan jumlah pesanan)", async () => {
  const source = await readFile(new URL("../components/redesign/court-performance.tsx", import.meta.url), "utf8");
  assert.match(source, /totalRevenue: string;/);
  assert.match(source, />Total Pendapatan Lapangan</);
  assert.match(source, />Total Pesanan</);
  // Label baru muncul SETELAH baris "Total Pesanan" pada source (posisi bawah card).
  const totalOrdersIndex = source.indexOf(">Total Pesanan<");
  const totalRevenueIndex = source.indexOf(">Total Pendapatan Lapangan<");
  assert.ok(totalOrdersIndex >= 0 && totalRevenueIndex > totalOrdersIndex);
});

// ---- Verifikasi numerik: total 6 court fixed-order sama dengan total canonical, tidak double count (item 11-14) ----

test("Total 6 court (fixed order) == total payment canonical gabungan, mencakup SEMUA court sekaligus tanpa double count", () => {
  const bookings = [
    fakeBooking({ booking_id: "C1", field_name: "Court No 1", total_price: 10 }),
    fakeBooking({ booking_id: "C2", field_name: "Court No 2", total_price: 10 }),
    fakeBooking({ booking_id: "C3", field_name: "Court No 3", total_price: 10 }),
    fakeBooking({ booking_id: "C4", field_name: "Court No 4", total_price: 10 }),
    fakeBooking({ booking_id: "P1", field_name: "Pickleball 1", total_price: 10 }),
    fakeBooking({ booking_id: "P2", field_name: "Pickleball 2", total_price: 10 }),
  ];
  const events = [
    paymentEvent("c1", "C1", 100000, "2026-07-01"),
    paymentEvent("c2", "C2", 200000, "2026-07-01"),
    paymentEvent("c3", "C3", 300000, "2026-07-01"),
    paymentEvent("c4", "C4", 150000, "2026-07-30"),
    paymentEvent("p1", "P1", 400000, "2026-07-01"),
    paymentEvent("p2", "P2", 500000, "2026-07-01"),
  ];
  const eligible = courtEligibleBookings(bookings, events);
  const grouped = groupByCourt(eligible);
  const COURT_DISPLAY_ORDER = ["Court No 1", "Court No 2", "Court No 3", "Court No 4", "Pickleball 1", "Pickleball 2"];
  const fixedOrderTotal = COURT_DISPLAY_ORDER.reduce((sum, name) => sum + (grouped[name]?.revenueValue ?? 0), 0);
  const canonicalTotal = [...dashboardPaymentAmountsByBooking(events).values()].reduce((sum, v) => sum + v, 0);
  assert.equal(fixedOrderTotal, canonicalTotal);
  assert.equal(fixedOrderTotal, 1650000);
});

test("Court tanpa data (Rp0/0 pesanan) tidak mengubah total maupun urutan court lain (item 10-11)", () => {
  const bookings = [
    fakeBooking({ booking_id: "C1", field_name: "Court No 1", total_price: 10 }),
    fakeBooking({ booking_id: "C3", field_name: "Court No 3", total_price: 10 }),
  ];
  const events = [
    paymentEvent("c1", "C1", 237491000 - 100, "2026-07-01"),
    paymentEvent("c3", "C3", 100, "2026-07-01"),
  ];
  const eligible = courtEligibleBookings(bookings, events);
  const grouped = groupByCourt(eligible);
  const COURT_DISPLAY_ORDER = ["Court No 1", "Court No 2", "Court No 3", "Court No 4", "Pickleball 1", "Pickleball 2"];
  // Court No 2/4/Pickleball 1/2 tidak punya data — tetap 0, tidak dihilangkan dari urutan.
  const rows = COURT_DISPLAY_ORDER.map((name) => ({ name, revenueValue: grouped[name]?.revenueValue ?? 0 }));
  assert.deepEqual(rows.map((r) => r.name), COURT_DISPLAY_ORDER); // urutan tidak berubah
  assert.equal(rows.find((r) => r.name === "Court No 2")!.revenueValue, 0);
  assert.equal(rows.find((r) => r.name === "Court No 4")!.revenueValue, 0);
  const total = rows.reduce((sum, r) => sum + r.revenueValue, 0);
  assert.equal(total, 237491000);
});

// ---- Angka target Juli/Juni 2026 (item 12-13) — sudah diverifikasi read-only
// terhadap data production (Mongo, via .env.local) di luar test ini:
// Juli 2026: revenueMonth (paymentMetrics, sumber card Pendapatan Dashboard)
// == total 6 court fixed-order == Rp237.491.000.
// Juni 2026: revenueMonth == total 6 court fixed-order == Rp242.895.499.
// Kedua angka SAMA PERSIS (bukan didekati) karena courtEligibleBookings dan
// paymentMetrics.revenueMonth berasal dari sumber canonical yang sama
// (payment-event AYO tervalidasi via withCanonicalPaymentAmounts +
// dashboardPaymentAmountsByBooking) — tidak ada agregasi terpisah untuk
// Performa Lapangan yang bisa berbeda dari total utama Dashboard.
