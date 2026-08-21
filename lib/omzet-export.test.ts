// Regression test untuk Task 3 (audit export Excel): lib/omzet-export.ts
// menulis nama court/lapangan (dari field_name booking AYO — data eksternal)
// sebagai HEADER kolom di sheet Summary lewat courtLabel(), yang sebelumnya
// TIDAK dibungkus sanitizeExcelCellValue seperti baris data lain di file yang
// sama (writeDataRow sudah mensanitasi). Bila field_name booking pernah berupa
// teks yang diawali karakter formula, header ini bisa dibuka Excel sebagai
// formula aktif. Test ini membuktikan header tersebut sekarang aman, baik untuk
// export harian (buildOmzetHarianWorkbook) maupun periode (buildOmzetPeriodWorkbook).
import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildOmzetHarianWorkbook, buildOmzetPeriodWorkbook, classifyBookingExportSource, type OmzetExportInput } from "./omzet-export.ts";
import type { BookingDocument } from "./mongodb.ts";
import type { AyoPaymentEvent } from "./ayo-payment-events.ts";
import { dashboardPaymentTypeByBooking } from "./dashboard-payment-metrics.ts";
import { aggregateBookingPayments, withBookingPaymentTotals } from "./booking-payment-aggregate.ts";

function fakeBooking(overrides: Partial<BookingDocument>): BookingDocument {
  return {
    order_detail_id: 1,
    booking_id: "BOOK-1",
    field_id: 1,
    field_name: "Lapangan 1",
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

async function loadFirstSheet(bytes: Uint8Array) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  return wb.worksheets[0]; // sheet Summary selalu ditambahkan pertama
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

function headerColumn(ws: ExcelJS.Worksheet, header: string, row = 4) {
  for (let col = 1; col <= ws.columnCount; col++) if (ws.getCell(row, col).value === header) return col;
  throw new Error(`Header ${header} tidak ditemukan`);
}

function revenueForBooking(ws: ExcelJS.Worksheet, bookingId: string) {
  const bookingColumn = headerColumn(ws, "Booking ID");
  const revenueColumn = headerColumn(ws, "Revenue \nVenue");
  for (let row = 5; row <= ws.rowCount; row++) {
    if (ws.getCell(row, bookingColumn).value === bookingId) return ws.getCell(row, revenueColumn).value;
  }
  throw new Error(`Booking ${bookingId} tidak ditemukan`);
}

test("buildOmzetHarianWorkbook: nama court berbahaya (field_name diawali karakter formula) disimpan sebagai teks aman di header Summary", async () => {
  const malicious = fakeBooking({ field_name: "=SUM(A1:A2)" });
  const input: OmzetExportInput = {
    date: "2026-07-01",
    venueName: "BC Padel Club",
    dayBookings: [malicious],
    monthBookings: [malicious],
  };
  const bytes = await buildOmzetHarianWorkbook(input);
  const ws = await loadFirstSheet(bytes);
  const headerValue = ws.getCell(4, 2).value; // court pertama -> kolom B, baris 4
  assert.equal(headerValue, "'=SUM(A1:A2)");
});

test("buildOmzetHarianWorkbook: nama court normal tidak berubah di header Summary", async () => {
  const normal = fakeBooking({ field_name: "Lapangan No. 3" });
  const input: OmzetExportInput = {
    date: "2026-07-01",
    venueName: "BC Padel Club",
    dayBookings: [normal],
    monthBookings: [normal],
  };
  const bytes = await buildOmzetHarianWorkbook(input);
  const ws = await loadFirstSheet(bytes);
  const headerValue = ws.getCell(4, 2).value;
  assert.equal(headerValue, "Court 3");
});

test("buildOmzetPeriodWorkbook: nama court berbahaya disimpan sebagai teks aman di header Summary (varian periode/bulanan)", async () => {
  const malicious = fakeBooking({ field_name: "+CMD|'/C calc'" });
  const input: OmzetExportInput = {
    date: "2026-07-01",
    venueName: "BC Padel Club",
    dayBookings: [malicious],
    monthBookings: [malicious],
    periodLabel: "1 - 31 Juli 2026",
    dateList: ["2026-07-01"],
  };
  const bytes = await buildOmzetPeriodWorkbook(input);
  const ws = await loadFirstSheet(bytes);
  const headerValue = ws.getCell(4, 2).value;
  assert.equal(headerValue, "'+CMD|'/C calc'");
});

test("export AYO mengeluarkan cancelled tanpa mengubah kolom, urutan, atau total baris yang tersisa", async () => {
  const bookings = [
    fakeBooking({ booking_id: "FINISHED", status: "FINISHED", total_price: 100000 }),
    fakeBooking({ booking_id: "SUCCESS", status: " SUCCESS ", total_price: 200000 }),
    fakeBooking({ booking_id: "CANCELLED", status: "CANCELLED", total_price: 300000 }),
    fakeBooking({ booking_id: "cancelled", status: " cancelled ", total_price: 400000 }),
    fakeBooking({ booking_id: "ZERO", status: "SUCCESS", total_price: 0 }),
  ];
  const bytes = await buildOmzetHarianWorkbook({ date: "2026-07-01", venueName: "BC Padel Club", dayBookings: bookings, monthBookings: bookings });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const controlBytes = await buildOmzetHarianWorkbook({ date: "2026-07-01", venueName: "BC Padel Club", dayBookings: bookings.filter((booking) => ["FINISHED", "SUCCESS"].includes(booking.booking_id)), monthBookings: bookings.filter((booking) => ["FINISHED", "SUCCESS"].includes(booking.booking_id)) });
  const control = new ExcelJS.Workbook();
  await control.xlsx.load(controlBytes as unknown as ExcelJS.Buffer);
  const ayo = workbook.getWorksheet("AYO");
  const controlAyo = control.getWorksheet("AYO");
  assert.ok(ayo);
  assert.ok(controlAyo);
  const ids = [5, 6].map((row) => ayo.getRow(row).getCell(2).value);
  assert.deepEqual(ids, ["FINISHED", "SUCCESS"]);
  assert.equal(ayo.columnCount, controlAyo.columnCount);
  assert.equal(ayo.getCell("Q7").value && typeof ayo.getCell("Q7").value === "object" ? (ayo.getCell("Q7").value as { formula: string }).formula : "", "SUM(Q5:Q6)");
});

test("Export Bulanan memakai total payment Dashboard untuk Juli tanpa mengubah metadata atau worksheet", async () => {
  const targetId = "MN/2428/260729/0002761";
  const baseId = "JULY-BASE";
  const bookings = [
    fakeBooking({ booking_id: baseId, date: "2026-07-01", field_name: "Court No 1", booking_source: "order", total_price: 237291000 }),
    fakeBooking({ booking_id: targetId, date: "2026-07-30", field_name: "Court No 4", booking_source: "reservation", total_price: 50000, start_time: "16:00:00", end_time: "17:00:00" }),
  ];
  const events = [
    paymentEvent("base", baseId, 237291000, "2026-07-01"),
    paymentEvent("first", targetId, 150000, "2026-07-30"),
    paymentEvent("second", targetId, 50000, "2026-07-30"),
  ];
  const canonical = withBookingPaymentTotals(bookings, aggregateBookingPayments(events));
  assert.equal(canonical.find((booking) => booking.booking_id === targetId)?.total_price, 200000);
  assert.equal(canonical.reduce((sum, booking) => sum + booking.total_price, 0), 237491000);
  assert.equal(canonical.find((booking) => booking.booking_id === targetId)?.field_name, "Court No 4");
  assert.equal(canonical.find((booking) => booking.booking_id === targetId)?.date, "2026-07-30");

  const bytes = await buildOmzetPeriodWorkbook({ date: "2026-07-01", venueName: "BC Padel Club", dayBookings: canonical, monthBookings: canonical, periodLabel: "Laporan Bulan Juli 2026", dateList: Array.from({ length: 31 }, (_, index) => `2026-07-${String(index + 1).padStart(2, "0")}`) });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const summary = wb.getWorksheet("Summary")!;
  const walkIn = wb.getWorksheet("Walk In")!;
  const ayo = wb.getWorksheet("AYO")!;
  const all = wb.getWorksheet("ALL")!;
  const court4 = headerColumn(summary, "Court 4");
  assert.equal(summary.getCell(35, court4 + 1).value, 200000, "Summary Walk In 30 Juli");
  assert.equal(revenueForBooking(walkIn, targetId), 200000);
  assert.equal(revenueForBooking(ayo, baseId), 237291000);
  assert.equal(revenueForBooking(all, targetId), 200000);
  assert.equal(revenueForBooking(all, baseId), 237291000);
});

test("Export Bulanan Juni menambah tepat Rp600.000 dari multi-payment, dan booking tanpa payment event tetap muncul dengan nilai aslinya (koreksi 20 Agustus)", () => {
  const ids = ["MN/2428/260525/0001581", "MN/2428/260525/0001582", "MN/2428/260606/0001835", "MN/2428/260611/0001951"];
  const bookings = [
    fakeBooking({ booking_id: "JUNE-BASE", date: "2026-06-01", total_price: 241945499 }),
    ...ids.map((booking_id, index) => fakeBooking({ booking_id, date: `2026-06-${String(index + 4).padStart(2, "0")}`, booking_source: "reservation", total_price: index < 2 ? 125000 : 50000 })),
    fakeBooking({ booking_id: "NO-PAYMENT", total_price: 999999 }),
  ];
  const events = [
    paymentEvent("june-base", "JUNE-BASE", 241945499, "2026-06-01"),
    ...ids.flatMap((bookingId, index) => [paymentEvent(`${index}-a`, bookingId, 150000, `2026-06-${String(index + 4).padStart(2, "0")}`), paymentEvent(`${index}-b`, bookingId, index < 2 ? 125000 : 50000, `2026-06-${String(index + 4).padStart(2, "0")}`)]),
  ];
  const canonical = withBookingPaymentTotals(bookings, aggregateBookingPayments(events));
  // NO-PAYMENT tidak dihapus: tidak ada payment event untuknya, jadi nilai asli (999999) dipertahankan apa adanya.
  const noPayment = canonical.find((booking) => booking.booking_id === "NO-PAYMENT");
  assert.ok(noPayment, "booking tanpa payment event tidak boleh di-drop dari export");
  assert.equal(noPayment.total_price, 999999);
  const canonicalized = canonical.filter((booking) => booking.booking_id !== "NO-PAYMENT");
  assert.equal(canonicalized.reduce((sum, booking) => sum + booking.total_price, 0), 242895499);
  assert.equal(canonicalized.reduce((sum, booking) => sum + booking.total_price, 0) - bookings.filter((booking) => booking.booking_id !== "NO-PAYMENT").reduce((sum, booking) => sum + booking.total_price, 0), 600000);
});

// ---------------------------------------------------------------------------
// Phase 7: classifyBookingExportSource — prefix MN TIDAK selalu Walk In.
// Root cause produksi: booking manual (booking_id "MN...", booking_source
// AYO "reservation") sebelumnya SELALU masuk Walk In walau dibayar customer
// lewat Payment Link — payment MECHANISM, bukan siapa yang membuat booking,
// yang menentukan channel. "BK" selalu AYO (dibuat lewat app).
// ---------------------------------------------------------------------------

test("classifyBookingExportSource: BK selalu AYO, terlepas payment method", () => {
  assert.equal(classifyBookingExportSource({ bookingId: "BK/1/1", bookingSource: "order", paymentType: "MANUAL" }), "order");
  assert.equal(classifyBookingExportSource({ bookingId: "BK/1/1", bookingSource: "order", paymentType: null }), "order");
});

test("classifyBookingExportSource: MN + Payment Link -> AYO (case/spacing dinormalisasi)", () => {
  assert.equal(classifyBookingExportSource({ bookingId: "MN/2428/260227/0001", bookingSource: "reservation", paymentType: "Payment Link" }), "order");
  assert.equal(classifyBookingExportSource({ bookingId: "MN/2428/260227/0001", bookingSource: "reservation", paymentType: "payment_link" }), "order");
  assert.equal(classifyBookingExportSource({ bookingId: "MN/2428/260227/0001", bookingSource: "reservation", paymentType: "  PAYMENT   LINK  " }), "order");
});

test("classifyBookingExportSource: MN + manual/tunai -> Walk In", () => {
  assert.equal(classifyBookingExportSource({ bookingId: "MN/2428/260227/0002", bookingSource: "reservation", paymentType: "MANUAL" }), "manual");
  assert.equal(classifyBookingExportSource({ bookingId: "MN/2428/260227/0002", bookingSource: "reservation", paymentType: "CASH" }), "manual");
});

test("classifyBookingExportSource: MN + payment method TIDAK diketahui (null/kosong) -> tetap Walk In (behavior aman existing, tidak menebak)", () => {
  assert.equal(classifyBookingExportSource({ bookingId: "MN/2428/260227/0003", bookingSource: "reservation", paymentType: null }), "manual");
  assert.equal(classifyBookingExportSource({ bookingId: "MN/2428/260227/0003", bookingSource: "reservation" }), "manual");
});

test("classifyBookingExportSource: prefix selain BK/MN fallback ke booking_source AYO existing", () => {
  assert.equal(classifyBookingExportSource({ bookingId: "OTHER-1", bookingSource: "order", paymentType: null }), "order");
  assert.equal(classifyBookingExportSource({ bookingId: "OTHER-1", bookingSource: "reservation", paymentType: null }), "manual");
});

test("REGRESSION 27 Feb: MN + Payment Link Rp200.000 muncul di sheet AYO, TIDAK di Walk In, satu kali, totals reconcile", async () => {
  const targetId = "MN/2428/260227/0001581";
  const otherAyoId = "BK/1/1";
  const bookings = [
    fakeBooking({ booking_id: targetId, date: "2026-02-27", booking_source: "reservation", total_price: 999999 }), // stale total_price sengaja beda -> dibuktikan hanya canonical amount dari payment event yang dipakai
    fakeBooking({ booking_id: otherAyoId, date: "2026-02-27", booking_source: "order", total_price: 500000 }),
  ];
  const events: AyoPaymentEvent[] = [
    { ...paymentEvent("feb27-a", targetId, 200000, "2026-02-27"), paymentType: "Payment Link" },
    paymentEvent("feb27-b", otherAyoId, 500000, "2026-02-27"),
  ];
  const paymentTypeByBooking = dashboardPaymentTypeByBooking(events);
  const canonicalBookings = withBookingPaymentTotals(bookings, aggregateBookingPayments(events));
  const input: OmzetExportInput = {
    date: "2026-02-27",
    venueName: "BC Padel Club",
    dayBookings: canonicalBookings,
    monthBookings: canonicalBookings,
    paymentTypeByBooking,
  };
  const bytes = await buildOmzetHarianWorkbook(input);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const ayo = wb.getWorksheet("AYO")!;
  const walkIn = wb.getWorksheet("Walk In")!;
  const all = wb.getWorksheet("ALL")!;

  assert.equal(revenueForBooking(ayo, targetId), 200000, "MN + Payment Link harus muncul di sheet AYO dengan nominal canonical Rp200.000");
  assert.throws(() => revenueForBooking(walkIn, targetId), /tidak ditemukan/, "MN + Payment Link TIDAK BOLEH muncul di sheet Walk In");

  // Tidak boleh muncul dua kali di AYO (no double-count), dan total gabungan (ALL) reconcile.
  let ayoOccurrences = 0;
  const bookingColumn = headerColumn(ayo, "Booking ID");
  for (let row = 5; row <= ayo.rowCount; row++) if (ayo.getCell(row, bookingColumn).value === targetId) ayoOccurrences++;
  assert.equal(ayoOccurrences, 1);
  assert.equal(revenueForBooking(all, targetId), 200000);
  assert.equal(revenueForBooking(all, otherAyoId), 500000);
});

// ---------------------------------------------------------------------------
// Koreksi 20 Agustus: 0002993 dan 0002994 adalah DUA BOOKING TERPISAH DAN
// TIDAK BERHUBUNGAN (dikonfirmasi langsung dari Dashboard AYOSERA), bukan
// satu reservasi 2-sesi. Nama pemesan kebetulan sama, jam booking berbeda,
// urusan berbeda. 0002994 sendiri adalah SATU booking (satu sesi) yang
// dibayar via 2 payment event (Rp150.000 + Rp50.000 = Rp200.000) — kasus
// "satu sesi, banyak payment" yang sudah benar sejak commit 08a5ce6.
//
// Root cause bug produksi yang sebenarnya: 0002993 tidak punya payment event
// dengan booking_id miliknya sendiri (sumber payment-events ini tidak
// mencakupnya), sehingga aturan lama "booking tanpa payment event di-drop
// dari export" menghapusnya sepenuhnya dari workbook — padahal booking itu
// nyata dan tidak ada hubungannya dengan payment 0002994. Fix: booking tanpa
// payment event match TETAP MUNCUL dengan total_price aslinya (bukan
// di-drop, bukan diganti nilai lain). Percobaan sebelumnya (fe282ca) salah
// mendiagnosis ini sebagai "grup multi-sesi" berdasarkan heuristik nama
// pemesan + jam berdekatan, yang false-positive match 0002993 dengan 0002994
// dan sudah di-revert sepenuhnya.
//
// Koreksi kedua (20 Agustus): export sempat pakai resolver terpisah
// (dashboardPaymentAmountsByBooking + withCanonicalPaymentAmountsKeepUncovered,
// lib/dashboard-payment-metrics.ts/lib/omzet-export.ts) dari yang dipakai
// Transaksi AYO (aggregateBookingPayments + withBookingPaymentTotals,
// lib/booking-payment-aggregate.ts) — dua implementasi terpisah dengan
// algoritma sum yang identik tapi tetap dua jalur kode berbeda, rawan drift.
// Terbukti drift: 0002994 (2 payment event) sempat menampilkan total berbeda
// antara Transaksi AYO (benar, Rp200.000) dan Export (Rp50.000, hanya
// installment terakhir). Fix final: export sekarang memakai PERSIS fungsi
// yang sama dengan Transaksi AYO, bukan implementasi paralel.
// ---------------------------------------------------------------------------

test("REGRESSION 12 Agu (final): booking tanpa payment event match TETAP MUNCUL dengan total_price aslinya, tidak di-drop", async () => {
  const unrelated = "MN/2428/260809/0002993"; // tidak ada payment event sama sekali untuk booking ini
  const bookings = [
    fakeBooking({ booking_id: unrelated, date: "2026-08-12", field_name: "Court No 3", booking_source: "reservation", total_price: 150000, start_time: "17:00", end_time: "18:00" }),
  ];
  const canonical = withBookingPaymentTotals(bookings, aggregateBookingPayments([]));
  assert.equal(canonical.length, 1, "booking tidak boleh di-drop hanya karena tidak ada payment event untuk booking_id-nya");
  assert.equal(canonical[0].total_price, 150000, "nilai asli yang sudah tersimpan dipertahankan, bukan diganti 0/undefined");

  const bytes = await buildOmzetHarianWorkbook({ date: "2026-08-12", venueName: "BC Padel Club", dayBookings: canonical, monthBookings: canonical });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const walkIn = wb.getWorksheet("Walk In")!;
  assert.equal(revenueForBooking(walkIn, unrelated), 150000);
});

test("REGRESSION 12 Agu (final): booking satu sesi dengan 2 payment event TETAP dikanonikalisasi ke jumlah keduanya (perilaku sejak 08a5ce6, tidak berubah)", async () => {
  const single = "MN/2428/260809/0002994"; // satu sesi, dibayar 2x: 150000 + 50000
  const bookings = [
    fakeBooking({ booking_id: single, date: "2026-08-12", field_name: "Court No 3", booking_source: "reservation", total_price: 50000, start_time: "18:00", end_time: "19:00" }),
  ];
  const events = [
    paymentEvent("p-150", single, 150000, "2026-08-12"),
    paymentEvent("p-50", single, 50000, "2026-08-12"),
  ];
  const canonical = withBookingPaymentTotals(bookings, aggregateBookingPayments(events));
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].total_price, 200000, "total_price diganti jumlah kedua payment event (150000+50000), bukan nilai lama 50000");

  const bytes = await buildOmzetHarianWorkbook({ date: "2026-08-12", venueName: "BC Padel Club", dayBookings: canonical, monthBookings: canonical, paymentTypeByBooking: dashboardPaymentTypeByBooking(events) });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const walkIn = wb.getWorksheet("Walk In")!;
  assert.equal(revenueForBooking(walkIn, single), 200000);
});

test("REGRESSION 12 Agu (final): kedua booking berdampingan bersama tidak digabung, tidak ada kolom grup, dan tidak double count", async () => {
  const unrelated = "MN/2428/260809/0002993"; // tidak ada payment event -> nilai asli dipertahankan
  const single = "MN/2428/260809/0002994"; // satu sesi, 2 payment event -> dikanonikalisasi
  const bookings = [
    fakeBooking({ booking_id: unrelated, date: "2026-08-12", field_name: "Court No 3", booking_source: "reservation", total_price: 150000, start_time: "17:00", end_time: "18:00" }),
    fakeBooking({ booking_id: single, date: "2026-08-12", field_name: "Court No 3", booking_source: "reservation", total_price: 50000, start_time: "18:00", end_time: "19:00" }),
  ];
  const events = [
    paymentEvent("p-150", single, 150000, "2026-08-12"),
    paymentEvent("p-50", single, 50000, "2026-08-12"),
  ];
  const canonical = withBookingPaymentTotals(bookings, aggregateBookingPayments(events));
  assert.equal(canonical.length, 2, "kedua booking tetap ada sebagai baris terpisah, tidak ada yang hilang atau digabung");
  const byId = new Map(canonical.map((b) => [b.booking_id, b.total_price]));
  assert.equal(byId.get(unrelated), 150000);
  assert.equal(byId.get(single), 200000);
  assert.equal(canonical.reduce((sum, b) => sum + b.total_price, 0), 350000, "tidak ada double count: 150000 (0002993, tidak berhubungan) + 200000 (0002994, satu sesi 2 payment)");

  const paymentTypeByBooking = dashboardPaymentTypeByBooking(events);
  const bytes = await buildOmzetHarianWorkbook({ date: "2026-08-12", venueName: "BC Padel Club", dayBookings: canonical, monthBookings: canonical, paymentTypeByBooking });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const walkIn = wb.getWorksheet("Walk In")!;
  assert.equal(revenueForBooking(walkIn, unrelated), 150000);
  assert.equal(revenueForBooking(walkIn, single), 200000);
  for (const header of ["Group Booking ID", "Jumlah Sesi", "Total Grup"]) {
    assert.throws(() => headerColumn(walkIn, header), /tidak ditemukan/, `kolom "${header}" tidak boleh ada di output`);
  }
});

test("REGRESSION 20 Agustus (unifikasi resolver): export harian untuk MN/2428/260809/0002994 memakai fixture PERSIS lib/booking-payment-aggregate.test.ts (2742703 + 2760168) dan hasilnya Rp200.000, sama dengan Transaksi AYO", async () => {
  // Fixture identik dengan SPLIT_PAYMENT_BOOKING_ID di
  // lib/booking-payment-aggregate.test.ts — data produksi nyata yang sudah
  // terbukti benar di Transaksi AYO (lihat test "paymentDetailsFor: booking
  // real MN/2428/260809/0002994"). Dibangun manual di sini (bukan import
  // konstanta) supaya test ini tetap berdiri sendiri kalau file lain berubah,
  // tapi nilai bookingId/reservationPaymentId/amount HARUS tetap sama persis.
  const bookingId = "MN/2428/260809/0002994";
  const now = new Date("2026-08-12T00:00:00.000Z");
  function internalReservationEvent(reservationPaymentId: string, amount: number): AyoPaymentEvent {
    return {
      _id: `internal_reservation:${bookingId}:${reservationPaymentId}`,
      identity: `internal_reservation:${bookingId}:${reservationPaymentId}`,
      bookingId,
      sourceTable: "internal_reservation",
      reservationPaymentId,
      nativeId: reservationPaymentId,
      sourceId: reservationPaymentId,
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
      fieldName: "Court No 3",
      date: "2026-08-12",
      startTime: "18:00:00",
      endTime: "19:00:00",
      total: amount,
      finalFeeAyo: 0,
      isCredit: false,
      raw: {},
      syncedAt: now,
    };
  }
  const events = [internalReservationEvent("2742703", 150000), internalReservationEvent("2760168", 50000)];
  const bookings = [
    fakeBooking({ booking_id: bookingId, date: "2026-08-12", field_name: "Court No 3", booking_source: "reservation", total_price: 50000, start_time: "18:00", end_time: "19:00" }),
  ];

  // Resolver yang SEKARANG dipakai export (sama persis dengan
  // app/api/transactions/route.ts, Transaksi AYO) — bukan lagi
  // dashboardPaymentAmountsByBooking + withCanonicalPaymentAmountsKeepUncovered.
  const canonical = withBookingPaymentTotals(bookings, aggregateBookingPayments(events));
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].total_price, 200000, "resolver export harus menjumlahkan KEDUA payment event (150000+50000), bukan hanya nilai lama 50000");

  const bytes = await buildOmzetHarianWorkbook({ date: "2026-08-12", venueName: "BC Padel Club", dayBookings: canonical, monthBookings: canonical, paymentTypeByBooking: dashboardPaymentTypeByBooking(events) });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const walkIn = wb.getWorksheet("Walk In")!;
  assert.equal(revenueForBooking(walkIn, bookingId), 200000, "Revenue Venue di workbook export harus Rp200.000, sama dengan Transaksi AYO");
});
