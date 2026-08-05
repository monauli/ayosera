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
import { buildOmzetHarianWorkbook, buildOmzetPeriodWorkbook, type OmzetExportInput } from "./omzet-export.ts";
import type { BookingDocument } from "./mongodb.ts";

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
