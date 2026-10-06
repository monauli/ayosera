import ExcelJS from "exceljs";
import type { BookingDocument } from "./mongodb.ts";
import { getFieldRevenueAmount, getRacketAddonAmount, getRevenueAmount, isCancelledTransaction, isDisplayEligibleTransaction } from "./revenue.ts";
import { sanitizeExcelCellValue } from "./excel-sanitization.ts";

/**
 * Generator workbook "Omzet Harian" mengikuti template contoh
 * (doc export/Contoh Omest Ayo harian.xlsx): 4 sheet — Summary, Walk In, AYO, ALL.
 *
 * Catatan sumber data: API AYO (list-bookings) hanya mengembalikan 17 field, jadi
 * banyak kolom template (Payment Method, Discount, Booking Oleh, Pembatalan, dll)
 * tidak punya sumber dan diisi default (0 / "-") sesuai keputusan. Kolom agregat
 * (TOTAL, subtotal, Average) ditulis sebagai FORMULA Excel persis seperti template.
 */

const MONTHS_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];
const MONEY_FMT = "#,##0";
const HEADER_FILL = "FFF2F2F2";
const ORANGE = "FFFFC000"; // penanda kolom Revenue Venue (header)
const ORANGE_LIGHT = "FFFCE4D6"; // tint sel data Revenue Venue
const YELLOW = "FFFFFF00"; // highlight baris total/subtotal

function solidFill(argb: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

export type OmzetExportInput = {
  date: string; // YYYY-MM-DD (hari yang diekspor / tanggal awal periode)
  venueName: string;
  dayBookings: BookingDocument[]; // booking pada tanggal tsb (atau seluruh periode untuk export range/bulanan)
  monthBookings: BookingDocument[]; // semua booking di bulan tanggal tsb (untuk Summary)
  sportByFieldId?: Map<number, string>;
  /** Label periode untuk export range/bulanan. Bila kosong → label harian (1 tanggal). */
  periodLabel?: string;
  /** Daftar tanggal YYYY-MM-DD yang dicakup export periode (Summary range/bulanan). */
  dateList?: string[];
  /** booking_id -> payment type (lib/ayo-payment-events.ts paymentType) — dipakai classifyBookingExportSource untuk MN yang dibayar via Payment Link. Tanpa map ini, MN tetap fallback ke behavior lama (Walk In). */
  paymentTypeByBooking?: ReadonlyMap<string, string | null>;
  /** booking_id -> payment reference(s) from canonical AYO payment-events. */
  paymentIdByBooking?: ReadonlyMap<string, string | null>;
};

/**
 * Retains booking metadata for the workbook while replacing its revenue amount
 * with the canonical Dashboard payment total. A booking absent from the
 * validated payment source is omitted: Dashboard Court Performance does not
 * add a booking fallback while that source is active (it must only ever show
 * validated payment-event totals — see lib/dashboard-court-performance.test.ts
 * "Booking tanpa payment canonical dihilangkan saat staging aktif").
 *
 * Used ONLY by app/api/dashboard/route.ts (Court Performance card).
 *
 * Excel export routes (harian/range/bulanan) do NOT use this function or
 * withCanonicalPaymentAmountsKeepUncovered() below — they use
 * aggregateBookingPayments()/withBookingPaymentTotals() from
 * lib/booking-payment-aggregate.ts instead, the same helper already proven
 * correct on the Transaksi AYO page. A split-payment booking (e.g.
 * MN/2428/260809/0002994, 2 payments) got a different total on Export than
 * on Transaksi AYO while both used their own separate resolver — routing
 * export through the same helper as Transaksi removes that divergence by
 * construction, not just for this one booking.
 */
export function withCanonicalPaymentAmounts(bookings: BookingDocument[], paymentAmounts: ReadonlyMap<string, number>) {
  return bookings.flatMap((booking) => {
    const amount = paymentAmounts.get(booking.booking_id);
    return amount === undefined ? [] : [{ ...booking, total_price: amount }];
  });
}

/**
 * Same canonical-replace behavior as withCanonicalPaymentAmounts(), except a
 * booking absent from the validated payment source keeps its own stored
 * total_price instead of being dropped: absence from this payment-events
 * source means "not covered by this source," not "no revenue."
 *
 * Used ONLY by lib/omset-kategori-export.ts (Kategori Penjualan export) —
 * NOT by the harian/range/bulanan Excel export routes, which use
 * withBookingPaymentTotals() (lib/booking-payment-aggregate.ts) instead. This
 * function has the same known limitation the Excel routes moved away from: a
 * partially-covered split-payment booking (only some of its payment events
 * inside the queried date window) silently gets an incomplete total instead
 * of falling back — not yet fixed here, out of scope for this change.
 */
export function withCanonicalPaymentAmountsKeepUncovered(bookings: BookingDocument[], paymentAmounts: ReadonlyMap<string, number>) {
  return bookings.map((booking) => {
    const amount = paymentAmounts.get(booking.booking_id);
    return amount === undefined ? booking : { ...booking, total_price: amount };
  });
}

/** Subtitle "Laporan Periode ..." — harian pakai 1 tanggal, periode pakai label kustom. */
function periodText(input: OmzetExportInput) {
  return input.periodLabel ?? periodTextDay(input.date);
}

function colLetter(n: number) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function isPickle(fieldName: string) {
  return /pickle/i.test(fieldName);
}

function courtLabel(fieldName: string) {
  if (isPickle(fieldName)) return `pickleball ${pickleCourtNumber(fieldName)}`;
  const m = fieldName.match(/no\.?\s*(\d+)/i);
  if (m) return `Court ${m[1]}`;
  return fieldName;
}

/**
 * SATU-SATUNYA classifier AYO vs Walk In dipakai seluruh export (harian/
 * bulanan/range — semua reuse builder di file ini, lihat komentar di bawah).
 *
 * Root cause bug produksi: prefix booking_id "MN" (dibuat manual/reservation
 * oleh staff, lihat booking_source AYO "reservation") SEBELUMNYA otomatis
 * berarti Walk In — padahal booking manual bisa saja dibayar customer lewat
 * Payment Link (mekanisme pembayaran, bukan siapa yang membuat booking), yang
 * artinya tetap transaksi AYO. "BK" (dibuat lewat app AYO) selalu AYO. Untuk
 * prefix lain (jarang, bukan BK/MN) tetap pakai booking_source AYO apa adanya
 * (behavior existing, tidak diubah) sebagai fallback aman.
 *
 * `paymentType` HARUS berasal dari payment event (lib/ayo-payment-events.ts
 * paymentType, canonical field yang sudah ada) untuk booking_id yang sama —
 * TIDAK PERNAH ditebak. Bila tidak diketahui (null/kosong/tidak match), MN
 * tetap Walk In — behavior aman existing, bukan otomatis dianggap Payment Link.
 */
export function classifyBookingExportSource(input: { bookingId: string; bookingSource: string; paymentType?: string | null }): "order" | "manual" {
  const id = (input.bookingId || "").trim();
  if (id.startsWith("BK")) return "order";
  if (id.startsWith("MN")) {
    const normalized = (input.paymentType ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
    return normalized === "payment link" ? "order" : "manual";
  }
  return (input.bookingSource || "order") === "order" ? "order" : "manual";
}

function isAyoSource(b: BookingDocument, input: OmzetExportInput) {
  return classifyBookingExportSource({ bookingId: b.booking_id, bookingSource: b.booking_source, paymentType: input.paymentTypeByBooking?.get(b.booking_id) ?? null }) === "order";
}

function sessionLength(b: BookingDocument) {
  const toMin = (t?: string) => {
    if (!t) return null;
    const [h, m] = t.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  };
  const start = toMin(b.start_time);
  const end = toMin(b.end_time);
  if (start == null || end == null) return "-";
  const diff = end - start + (end < start ? 24 * 60 : 0);
  return `${diff} Minute(s)`;
}

function fmtTimestamp(value?: string | Date) {
  if (!value) return "-";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : "-";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function num(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function racketAddonAmount(b: BookingDocument) {
  return getRacketAddonAmount(b);
}

function fieldRevenueAmount(b: BookingDocument) {
  return getFieldRevenueAmount(b);
}

// ---- Kolom detail (urutan persis template) -------------------------------

type ColumnDef = {
  header: string;
  get: (b: BookingDocument, ctx: OmzetExportInput) => string | number;
  money?: boolean;
  width?: number;
};

function sportOf(b: BookingDocument, ctx: OmzetExportInput) {
  const fromMap = ctx.sportByFieldId?.get(b.field_id);
  if (fromMap) return fromMap;
  return isPickle(b.field_name) ? "Pickleball" : "Padel";
}

// Kolom dari "Booking ID" .. "Note" (dipakai Walk In; basis untuk AYO & ALL).
const BASE_COLUMNS: ColumnDef[] = [
  { header: "Booking ID", get: (b) => b.booking_id || "-", width: 24 },
  // Venue: nama venue human-readable dari config (input.venueName = AYO_BRANCH_NAME),
  // BUKAN b.branch_name yang untuk data lama masih tersimpan sebagai kode AYO_VENUE_CODE.
  { header: "Venue", get: (_b, c) => c.venueName || "—", width: 16 },
  { header: "Court", get: (b) => (b.field_name ? courtLabel(b.field_name) : "-"), width: 14 },
  { header: "Court ID", get: (b) => b.field_id || "-", width: 9 },
  { header: "Sports \nCategory", get: (b, c) => sportOf(b, c), width: 11 },
  { header: "Customer\nName", get: (b) => b.booker_name || "-", width: 18 },
  { header: "Customer Email", get: (b) => b.booker_email || "", width: 22 },
  { header: "Customer Phone", get: (b) => b.booker_phone || "", width: 16 },
  { header: "Username Customer", get: () => "-", width: 14 },
  { header: "Date of \nBooking", get: (b) => b.date || "-", width: 12 },
  { header: "Booking Period \nStart Time", get: (b) => b.start_time || "-", width: 11 },
  { header: "Booking Period End Time", get: (b) => b.end_time || "-", width: 11 },
  { header: "Session \nLength", get: (b) => sessionLength(b), width: 12 },
  { header: "Price", get: fieldRevenueAmount, money: true, width: 12 },
  { header: "Payment ID", get: (b, c) => {
    const raw = b.raw ?? {};
    const rawId = ["payment_id", "paymentId", "reservation_payment_id", "reservationPaymentId"]
      .map((key) => raw[key])
      .find((value) => value !== undefined && value !== null && String(value).trim());
    return c.paymentIdByBooking?.get(b.booking_id) || b.payment_id || (rawId ? String(rawId) : "-");
  }, width: 18 },
  { header: "Payment \nMethod", get: () => "-", width: 14 },
  { header: "Total Booking \nAmount", get: (b) => num(b.total_price), money: true, width: 13 },
  { header: "Discount", get: () => 0, money: true, width: 10 },
  { header: "Ayo Discount", get: () => 0, money: true, width: 10 },
  { header: "Voucher", get: () => "-", width: 9 },
  { header: "Net Booking \nAmount", get: (b) => num(b.total_price), money: true, width: 13 },
  { header: "First/Down \nPayment", get: () => 0, money: true, width: 11 },
  { header: "Pelunasan Online", get: () => 0, money: true, width: 11 },
  { header: "Pelunasan Offline", get: () => 0, money: true, width: 11 },
  { header: "Status", get: (b) => (isCancelledTransaction(b) ? "Cancelled" : b.status || "-"), width: 11 },
  { header: "Revenue \nVenue", get: (b) => getRevenueAmount(b), money: true, width: 12 },
  { header: "Date Revenue \nProcessed", get: () => "-", width: 16 },
  { header: "Note", get: (b) => b.note || "-", width: 14 },
];

// Kolom meta booking (AYO & ALL). Sebagian terisi (created_at, reschedule terdeteksi).
const META_COLUMNS: ColumnDef[] = [
  { header: "Booking Oleh", get: () => "-", width: 14 },
  { header: "Tanggal dan \nWaktu Booking", get: (b) => fmtTimestamp(b.created_at), width: 18 },
  { header: "Reschedule Oleh", get: () => "-", width: 14 },
  {
    header: "Tanggal dan \nWaktu Reschedule",
    get: (b) => (b.changeType === "rescheduled" && b.changedAt ? fmtTimestamp(b.changedAt) : "-"),
    width: 18,
  },
  { header: "Dibatalkan Oleh", get: () => "-", width: 14 },
  { header: "Tanggal dan Waktu \nPembatalan", get: () => "-", width: 18 },
  { header: "Alasan Pembatalan", get: () => "-", width: 16 },
];

const RACKET_ADDON_COLUMN: ColumnDef = {
  header: "Sewa Raket Add On",
  get: racketAddonAmount,
  money: true,
  width: 16,
};

function detailColumns(columns: ColumnDef[]) {
  const paymentIndex = columns.findIndex((column) => column.header === "Payment ID");
  return [...columns.slice(0, paymentIndex + 1), RACKET_ADDON_COLUMN, ...columns.slice(paymentIndex + 1)];
}

// ---- Styling helpers -----------------------------------------------------

function styleTitle(cell: ExcelJS.Cell) {
  cell.font = { bold: true, size: 14 };
  cell.alignment = { vertical: "middle", horizontal: "left" };
}

function styleHeaderCell(cell: ExcelJS.Cell) {
  cell.font = { bold: true, size: 10 };
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  cell.border = thinBorder();
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const };
  return { top: side, left: side, bottom: side, right: side };
}

// ---- Detail sheet builder (Walk In / AYO / ALL) --------------------------

function writeDetailHeader(
  ws: ExcelJS.Worksheet,
  title: string,
  periodText: string,
  columns: ColumnDef[],
  extraLegend?: { reschedule: string; paymentFail: string },
) {
  // Catatan: judul sheet detail TIDAK di-merge (sesuai template).
  styleTitle(ws.getCell("A1"));
  ws.getCell("A1").value = title;

  if (extraLegend) {
    ws.getCell("D1").value = extraLegend.reschedule;
    ws.getCell("E1").value = extraLegend.paymentFail;
  }

  ws.getCell("A2").value = periodText;
  ws.getCell("A2").font = { italic: true, size: 10 };

  const headerRow = ws.getRow(4);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    styleHeaderCell(cell);
    if (col.header.startsWith("Revenue")) cell.fill = solidFill(ORANGE);
    ws.getColumn(i + 1).width = col.width ?? 12;
  });
  headerRow.height = 30;
}

function writeDataRow(
  ws: ExcelJS.Worksheet,
  rowIndex: number,
  columns: ColumnDef[],
  values: (string | number)[],
) {
  const row = ws.getRow(rowIndex);
  values.forEach((value, i) => {
    const cell = row.getCell(i + 1);
    cell.value = sanitizeExcelCellValue(value);
    cell.border = thinBorder();
    if (columns[i].money) cell.numFmt = MONEY_FMT;
    if (columns[i].header.startsWith("Revenue")) cell.fill = solidFill(ORANGE_LIGHT);
    cell.font = { size: 10 };
  });
}

/** Tulis baris SUM untuk kolom Price..Revenue (sesuai template). */
function writeSumRow(
  ws: ExcelJS.Worksheet,
  rowIndex: number,
  columns: ColumnDef[],
  fromRow: number,
  toRow: number,
) {
  const priceIdx = columns.findIndex((c) => c.header === "Price");
  const revenueIdx = columns.findIndex((c) => c.header.startsWith("Revenue"));
  const row = ws.getRow(rowIndex);
  for (let i = priceIdx; i <= revenueIdx; i++) {
    const letter = colLetter(i + 1);
    const cell = row.getCell(i + 1);
    cell.value = { formula: `SUM(${letter}${fromRow}:${letter}${toRow})` };
    cell.numFmt = MONEY_FMT;
    cell.font = { bold: true, size: 10 };
    cell.fill = solidFill(YELLOW);
    cell.border = thinBorder();
  }
}

/** Tanggal unik (urut naik) dari kumpulan booking; tanggal kosong ikut sebagai grup "". */
function distinctDates(bookings: BookingDocument[]) {
  return Array.from(new Set(bookings.map((b) => b.date || ""))).sort();
}

function buildWalkInSheet(wb: ExcelJS.Workbook, input: OmzetExportInput) {
  const ws = wb.addWorksheet("Walk In");
  const columns = BASE_COLUMNS;
  writeDetailHeader(ws, "OMSET SEWA LAPANGAN (Walk In)", periodText(input), columns);

  const rows = input.dayBookings.filter((b) => !isAyoSource(b, input));
  // Dikelompokkan per tanggal (urut naik); tiap tanggal ditutup 1 baris subtotal.
  // Tanpa grand total di akhir (sesuai referensi; beda dengan sheet ALL).
  let r = 5;
  for (const date of distinctDates(rows)) {
    const group = rows.filter((b) => (b.date || "") === date);
    const groupStart = r;
    for (const b of group) {
      writeDataRow(ws, r, columns, columns.map((c) => c.get(b, input)));
      r++;
    }
    writeSumRow(ws, r, columns, groupStart, r - 1);
    r++;
  }
}

function buildAyoSheet(wb: ExcelJS.Workbook, input: OmzetExportInput) {
  const ws = wb.addWorksheet("AYO");
  const columns = detailColumns([
    { header: "No", get: () => "", width: 6 },
    ...BASE_COLUMNS,
    ...META_COLUMNS,
  ]);
  writeDetailHeader(ws, "OMSET SEWA LAPANGAN (AYO)", periodText(input), columns, {
    reschedule: "Reschedule",
    paymentFail: "Payment Fail",
  });

  const rows = input.dayBookings.filter((b) => isAyoSource(b, input));
  // Pola sama dengan Walk In: subtotal per tanggal, tanpa grand total.
  // Nomor urut ("No") berjalan menerus lintas tanggal.
  let r = 5;
  let no = 0;
  for (const date of distinctDates(rows)) {
    const group = rows.filter((b) => (b.date || "") === date);
    const groupStart = r;
    for (const b of group) {
      no++;
      const values = columns.map((c) => c.get(b, input));
      values[0] = no;
      writeDataRow(ws, r, columns, values);
      r++;
    }
    writeSumRow(ws, r, columns, groupStart, r - 1);
    r++;
  }
}

function buildAllSheet(wb: ExcelJS.Workbook, input: OmzetExportInput) {
  const ws = wb.addWorksheet("ALL");
  // ALL: kolom "Tanggal" memimpin (di-merge), tanpa "Date of Booking" di tengah.
  const baseWithoutDate = BASE_COLUMNS.filter((c) => !c.header.startsWith("Date of"));
  const columns = detailColumns([
    { header: "Tanggal", get: (b) => b.date || "-", width: 12 },
    ...baseWithoutDate,
    ...META_COLUMNS,
  ]);
  writeDetailHeader(ws, "OMSET SEWA LAPANGAN (ALL)", periodText(input), columns);

  // urutkan per court (padel dulu lalu pickle), dalam court urut jam mulai
  const courts = distinctCourts(input.dayBookings);
  const firstDataRow = 5;
  let r = firstDataRow;
  const subtotalRows: number[] = [];

  for (const court of courts) {
    const group = input.dayBookings
      .filter((b) => matchesCourtColumn(court, b.field_name))
      .sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));
    if (!group.length) continue;
    const groupStart = r;
    for (const b of group) {
      const values = columns.map((c) => c.get(b, input));
      writeDataRow(ws, r, columns, values);
      r++;
    }
    writeSumRow(ws, r, columns, groupStart, r - 1);
    subtotalRows.push(r);
    r++;
  }

  // grand total = jumlah semua subtotal
  if (subtotalRows.length) {
    const priceIdx = columns.findIndex((c) => c.header === "Price");
    const revenueIdx = columns.findIndex((c) => c.header.startsWith("Revenue"));
    const grandRow = ws.getRow(r);
    for (let i = priceIdx; i <= revenueIdx; i++) {
      const letter = colLetter(i + 1);
      const cell = grandRow.getCell(i + 1);
      cell.value = { formula: subtotalRows.map((sr) => `${letter}${sr}`).join("+") };
      cell.numFmt = MONEY_FMT;
      cell.font = { bold: true, size: 10 };
      cell.fill = solidFill(YELLOW);
      cell.border = thinBorder();
    }
    // merge kolom Tanggal untuk seluruh blok data (termasuk baris grand total)
    ws.mergeCells(`A${firstDataRow}:A${r}`);
    const a = ws.getCell(`A${firstDataRow}`);
    a.value = input.date;
    a.alignment = { vertical: "middle", horizontal: "center" };
    // label TOTAL di area B..kolom sebelum Price, seperti template
    ws.mergeCells(`B${r}:${colLetter(priceIdx)}${r}`);
    const label = ws.getCell(`B${r}`);
    label.value = "TOTAL";
    label.font = { bold: true, size: 10 };
    label.alignment = { horizontal: "right" };
  }
}

function distinctCourts(bookings: BookingDocument[]) {
  const set = Array.from(
    new Set(
      bookings
        .map((b) => b.field_name)
        .filter(Boolean)
        .map((fieldName) => (isPickle(fieldName) ? `Pickleball Court No ${pickleCourtNumber(fieldName)}` : fieldName)),
    ),
  );
  return set.sort((a, b) => {
    const pa = isPickle(a) ? 1 : 0;
    const pb = isPickle(b) ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

function periodTextDay(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return `Laporan Periode ${date}`;
  return `Laporan Periode ${d} ${MONTHS_ID[m - 1]} ${y}`;
}

// ---- Summary sheet (pivot bulanan) ---------------------------------------

function buildSummarySheet(wb: ExcelJS.Workbook, input: OmzetExportInput) {
  const [year, month] = input.date.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthLabel = `${MONTHS_ID[month - 1].toUpperCase()} ${year}`;
  const ws = wb.addWorksheet(`Summary ${MONTHS_ID[month - 1]}'${String(year).slice(2)}`);

  const courts = distinctCourtsForSummary(input.monthBookings);
  // Padel -> 3 kolom (AYO, Walk In, Sewa Raket); Pickleball -> 2 kolom.
  let nextCourtCol = 2;
  const courtCols = courts.map((court) => {
    const ayoCol = nextCourtCol;
    const walkCol = ayoCol + 1; // C, E, G, ...
    const pickle = isPickle(court);
    const racketCol = pickle ? undefined : walkCol + 1;
    nextCourtCol = (racketCol ?? walkCol) + 1;
    return { court, ayoCol, walkCol, racketCol, pickle };
  });
  const totalAllCol = (courtCols.at(-1)?.racketCol ?? courtCols.at(-1)?.walkCol ?? 1) + 1;
  const totalFieldCol = totalAllCol + 1;
  const lastColLetter = colLetter(totalFieldCol);

  // Judul
  ws.mergeCells(`A1:${lastColLetter}1`);
  ws.getCell("A1").value = "SUMMARY LAPANGAN PADEL & PICKLE";
  styleTitle(ws.getCell("A1"));
  ws.getCell("A1").alignment = { horizontal: "center" };
  ws.mergeCells(`A2:${lastColLetter}2`);
  ws.getCell("A2").value = `Bulan: ${monthLabel}`;
  ws.getCell("A2").font = { bold: true, size: 11 };
  ws.getCell("A2").alignment = { horizontal: "center" };

  // Header dua baris (row 4-5)
  ws.mergeCells("A4:A5");
  ws.getCell("A4").value = "Date of \nBooking";
  styleHeaderCell(ws.getCell("A4"));
  ws.getColumn(1).width = 14;

  for (const c of courtCols) {
    ws.mergeCells(4, c.ayoCol, 4, c.racketCol ?? c.walkCol);
    const head = ws.getCell(4, c.ayoCol);
    head.value = sanitizeExcelCellValue(courtLabel(c.court));
    styleHeaderCell(head);
    const ayo = ws.getCell(5, c.ayoCol);
    ayo.value = "AYO";
    styleHeaderCell(ayo);
    const walk = ws.getCell(5, c.walkCol);
    walk.value = "Walk In";
    styleHeaderCell(walk);
    if (c.racketCol) {
      const racket = ws.getCell(5, c.racketCol);
      racket.value = "Sewa Raket";
      styleHeaderCell(racket);
      ws.getColumn(c.racketCol).width = 12;
    }
    ws.getColumn(c.ayoCol).width = 12;
    ws.getColumn(c.walkCol).width = 12;
  }
  ws.mergeCells(4, totalAllCol, 5, totalAllCol);
  ws.getCell(4, totalAllCol).value = "TOTAL \nKESELURUHAN";
  styleHeaderCell(ws.getCell(4, totalAllCol));
  ws.getCell(4, totalAllCol).fill = solidFill(ORANGE);
  ws.getColumn(totalAllCol).width = 16;
  ws.mergeCells(4, totalFieldCol, 5, totalFieldCol);
  ws.getCell(4, totalFieldCol).value = "TOTAL \nLAPANGAN";
  styleHeaderCell(ws.getCell(4, totalFieldCol));
  ws.getColumn(totalFieldCol).width = 15;

  // Agregasi HANYA tanggal yang diekspor → hanya baris tanggal itu yang terisi.
  const agg = new Map<string, number>(); // key `${day}|${col}`
  for (const b of input.dayBookings) {
    const day = Number((b.date || "").slice(8, 10));
    if (!day) continue;
    const ci = courtCols.find((c) => matchesCourtColumn(c.court, b.field_name));
    if (!ci) continue;
    const col = isAyoSource(b, input) ? ci.ayoCol : ci.walkCol;
    const key = `${day}|${col}`;
    agg.set(key, (agg.get(key) ?? 0) + fieldRevenueAmount(b));
    if (ci.racketCol) {
      const racket = racketAddonAmount(b);
      if (racket) {
        const racketKey = `${day}|${ci.racketCol}`;
        agg.set(racketKey, (agg.get(racketKey) ?? 0) + racket);
      }
    }
  }

  const firstDataRow = 6;
  for (let d = 1; d <= daysInMonth; d++) {
    const rowIdx = firstDataRow + (d - 1);
    const row = ws.getRow(rowIdx);
    // kolom A: tanggal (A6 literal, sisanya =A(prev)+1)
    const aCell = row.getCell(1);
    if (d === 1) aCell.value = new Date(Date.UTC(year, month - 1, 1));
    else aCell.value = { formula: `A${rowIdx - 1}+1` };
    aCell.numFmt = "dd/mm/yyyy";
    aCell.border = thinBorder();

    for (const c of courtCols) {
      for (const col of [c.ayoCol, c.walkCol, ...(c.racketCol ? [c.racketCol] : [])]) {
        const cell = row.getCell(col);
        const v = agg.get(`${d}|${col}`);
        if (v) cell.value = v;
        cell.numFmt = MONEY_FMT;
        cell.border = thinBorder();
      }
    }
    // TOTAL KESELURUHAN memasukkan add-on sewa raket.
    const totalAllCell = row.getCell(totalAllCol);
    totalAllCell.value = { formula: `SUM(B${rowIdx}:${colLetter(totalAllCol - 1)}${rowIdx})` };
    totalAllCell.numFmt = MONEY_FMT;
    totalAllCell.fill = solidFill(ORANGE_LIGHT);
    totalAllCell.border = thinBorder();
    // TOTAL LAPANGAN hanya menjumlahkan AYO + Walk In; add-on tetap terpisah.
    const fieldColumns = courtCols.flatMap((c) => [c.ayoCol, c.walkCol]);
    const totalFieldCell = row.getCell(totalFieldCol);
    totalFieldCell.value = { formula: fieldColumns.length
      ? fieldColumns.map((col) => `${colLetter(col)}${rowIdx}`).join("+")
      : "0" };
    totalFieldCell.numFmt = MONEY_FMT;
    totalFieldCell.border = thinBorder();
  }

  // Baris TOTAL bawah
  const totalRow = firstDataRow + daysInMonth; // mis. 36
  const trow = ws.getRow(totalRow);
  trow.getCell(1).value = "TOTAL";
  trow.getCell(1).font = { bold: true };
  trow.getCell(1).fill = solidFill(YELLOW);
  trow.getCell(1).border = thinBorder();
  for (let col = 2; col <= totalFieldCol; col++) {
    const letter = colLetter(col);
    const cell = trow.getCell(col);
    cell.value = { formula: `SUM(${letter}${firstDataRow}:${letter}${totalRow - 1})` };
    cell.numFmt = MONEY_FMT;
    cell.font = { bold: true };
    cell.fill = solidFill(YELLOW);
    cell.border = thinBorder();
  }

  // Blok ringkasan bawah (PADEL / PICKLE / TOTAL / Average)
  const padelAyo = courtCols.filter((c) => !c.pickle).map((c) => `${colLetter(c.ayoCol)}${totalRow}`);
  const padelWalk = courtCols.filter((c) => !c.pickle).map((c) => `${colLetter(c.walkCol)}${totalRow}`);
  const padelRacket = courtCols.filter((c) => !c.pickle && c.racketCol).map((c) => `${colLetter(c.racketCol!)}${totalRow}`);
  const pickleAyo = courtCols.filter((c) => c.pickle).map((c) => `${colLetter(c.ayoCol)}${totalRow}`);
  const pickleWalk = courtCols.filter((c) => c.pickle).map((c) => `${colLetter(c.walkCol)}${totalRow}`);

  const base = totalRow + 2; // baris header blok
  ws.getCell(base, 10).value = "PADEL"; // J
  ws.getCell(base, 11).value = "PICKLE"; // K
  ws.getCell(base, 12).value = "Sewa Raket \nPadel"; // L
  ws.getCell(base, 13).value = "TOTAL"; // M
  for (const col of [10, 11, 12, 13]) ws.getCell(base, col).font = { bold: true };

  const sumOrZero = (cells: string[]) => (cells.length ? cells.join("+") : "0");

  // AYO
  ws.getCell(base + 1, 9).value = "AYO";
  ws.getCell(base + 1, 10).value = { formula: sumOrZero(padelAyo) };
  ws.getCell(base + 1, 11).value = { formula: sumOrZero(pickleAyo) };
  ws.getCell(base + 1, 12).value = { formula: sumOrZero(padelRacket) };
  ws.getCell(base + 1, 13).value = { formula: `SUM(J${base + 1}:K${base + 1})` };
  // WALK IN
  ws.getCell(base + 2, 9).value = "WALK IN";
  ws.getCell(base + 2, 10).value = { formula: sumOrZero(padelWalk) };
  ws.getCell(base + 2, 11).value = { formula: sumOrZero(pickleWalk) };
  ws.getCell(base + 2, 13).value = { formula: `SUM(J${base + 2}:K${base + 2})` };
  // TOTAL
  ws.getCell(base + 3, 9).value = "TOTAL";
  ws.getCell(base + 3, 10).value = { formula: `SUM(J${base + 1}:J${base + 2})` };
  ws.getCell(base + 3, 11).value = { formula: `SUM(K${base + 1}:K${base + 2})` };
  ws.getCell(base + 3, 12).value = { formula: `SUM(L${base + 1}:L${base + 2})` };
  ws.getCell(base + 3, 13).value = { formula: `SUM(J${base + 3}:K${base + 3})` };
  // Average
  ws.getCell(base + 4, 9).value = "Average";
  ws.getCell(base + 4, 10).value = { formula: `J${base + 3}/${daysInMonth}` };
  ws.getCell(base + 4, 11).value = { formula: `K${base + 3}/${daysInMonth}` };

  for (let rr = base + 1; rr <= base + 4; rr++) {
    for (const col of [10, 11, 12, 13]) ws.getCell(rr, col).numFmt = MONEY_FMT;
    ws.getCell(rr, 9).font = { bold: true };
  }
}

// Nama lapangan Pickleball di data punya beberapa variasi persis
// ("Pickleball 1", "Pickleball 2", "Pickleball Court No 1", "Pickleball Court No 2", dst)
// Data booking dapat memakai beberapa variasi nama, tetapi venue memiliki dua
// lapangan pickleball yang harus tetap menjadi dua kolom terpisah di export.
const PICKLE_CANONICAL_1 = "Pickleball Court No 1";
const PICKLE_CANONICAL_2 = "Pickleball Court No 2";

function pickleCourtNumber(fieldName: string) {
  return /(?:no\.?|court|pickleball)\s*2\b/i.test(fieldName) ? 2 : 1;
}

function distinctCourtsForSummary(bookings: BookingDocument[]) {
  // Format Summary mengikuti laporan operasional: selalu tampilkan empat
  // court padel dan dua court pickleball, termasuk bila salah satunya kosong
  // pada periode yang dipilih. Nama lapangan asing tetap ditambahkan setelah
  // kolom standar agar tidak hilang dari laporan dan tetap tersanitasi.
  const standardPadel = ["Court No 1", "Court No 2", "Court No 3", "Court No 4"];
  const extras = Array.from(new Set(bookings.map((b) => b.field_name).filter((f) => {
    if (!f || isPickle(f)) return false;
    const number = f.match(/no\.?\s*(\d+)/i)?.[1] ?? f.match(/court\s*(\d+)/i)?.[1];
    return !number || Number(number) < 1 || Number(number) > 4;
  }))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return [...standardPadel, ...extras, PICKLE_CANONICAL_1, PICKLE_CANONICAL_2];
}

/** Cocokkan booking ke entri Summary; pickleball dipisahkan berdasarkan nomor lapangan. */
function matchesCourtColumn(court: string, fieldName: string) {
  if (isPickle(court)) return isPickle(fieldName) && pickleCourtNumber(court) === pickleCourtNumber(fieldName);
  if (isPickle(fieldName)) return false;
  const courtNumber = court.match(/no\.?\s*(\d+)/i)?.[1] ?? court.match(/court\s*(\d+)/i)?.[1];
  const fieldNumber = fieldName.match(/no\.?\s*(\d+)/i)?.[1] ?? fieldName.match(/court\s*(\d+)/i)?.[1];
  return courtNumber && fieldNumber ? Number(courtNumber) === Number(fieldNumber) : court === fieldName;
}

export async function buildOmzetHarianWorkbook(input: OmzetExportInput): Promise<Uint8Array> {
  const eligibleInput = displayEligibleInput(input);
  const wb = new ExcelJS.Workbook();
  wb.creator = "AYO Integration";
  wb.created = new Date();

  buildSummarySheet(wb, eligibleInput);
  buildWalkInSheet(wb, eligibleInput);
  buildAyoSheet(wb, eligibleInput);
  buildAllSheet(wb, eligibleInput);

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(arrayBuffer as ArrayBuffer);
}

// ==========================================================================
// Export PERIODE (Range Tanggal / Bulanan) — pakai ulang helper & kolom yang
// sama dengan harian. Sheet detail (Walk In, AYO) di-reuse apa adanya dengan
// memasok seluruh booking periode sebagai `dayBookings`. Summary & ALL pakai
// varian periode (per-tanggal) agar tetap benar untuk banyak hari/bulan.
// ==========================================================================

/** Daftar tanggal YYYY-MM-DD inklusif dari start..end. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (!sy || !ey) return out;
  let cur = Date.UTC(sy, sm - 1, sd);
  const last = Date.UTC(ey, em - 1, ed);
  // batas aman supaya tidak loop tak hingga bila input terbalik
  for (let i = 0; cur <= last && i < 1000; i++) {
    const d = new Date(cur);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    out.push(`${yyyy}-${mm}-${dd}`);
    cur += 24 * 60 * 60 * 1000;
  }
  return out;
}

function fmtDateId(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return `${d} ${MONTHS_ID[m - 1]} ${y}`;
}

/** Label periode untuk subtitle sheet detail. */
export function periodLabelRange(start: string, end: string) {
  if (start === end) return `Laporan Periode ${fmtDateId(start)}`;
  return `Laporan Periode ${fmtDateId(start)} - ${fmtDateId(end)}`;
}

export function periodLabelMonth(monthValue: string) {
  const [y, m] = monthValue.split("-").map(Number);
  if (!y || !m) return `Laporan Bulan ${monthValue}`;
  return `Laporan Bulan ${MONTHS_ID[m - 1]} ${y}`;
}

/** Summary versi periode: satu baris per tanggal pada rentang (bisa lintas bulan). */
function buildSummarySheetPeriod(wb: ExcelJS.Workbook, input: OmzetExportInput) {
  const dates = input.dateList ?? [];
  const dayCount = dates.length;
  const ws = wb.addWorksheet("Summary");

  const courts = distinctCourtsForSummary(input.monthBookings);
  let nextCourtCol = 2;
  const courtCols = courts.map((court) => {
    const ayoCol = nextCourtCol;
    const walkCol = ayoCol + 1;
    const pickle = isPickle(court);
    const racketCol = pickle ? undefined : walkCol + 1;
    nextCourtCol = (racketCol ?? walkCol) + 1;
    return { court, ayoCol, walkCol, racketCol, pickle };
  });
  const totalAllCol = (courtCols.at(-1)?.racketCol ?? courtCols.at(-1)?.walkCol ?? 1) + 1;
  const totalFieldCol = totalAllCol + 1;
  const lastColLetter = colLetter(totalFieldCol);

  ws.mergeCells(`A1:${lastColLetter}1`);
  ws.getCell("A1").value = "SUMMARY LAPANGAN PADEL & PICKLE";
  styleTitle(ws.getCell("A1"));
  ws.getCell("A1").alignment = { horizontal: "center" };
  ws.mergeCells(`A2:${lastColLetter}2`);
  ws.getCell("A2").value = input.periodLabel ?? periodTextDay(input.date);
  ws.getCell("A2").font = { bold: true, size: 11 };
  ws.getCell("A2").alignment = { horizontal: "center" };

  ws.mergeCells("A4:A5");
  ws.getCell("A4").value = "Date of \nBooking";
  styleHeaderCell(ws.getCell("A4"));
  ws.getColumn(1).width = 14;

  for (const c of courtCols) {
    ws.mergeCells(4, c.ayoCol, 4, c.racketCol ?? c.walkCol);
    const head = ws.getCell(4, c.ayoCol);
    head.value = sanitizeExcelCellValue(courtLabel(c.court));
    styleHeaderCell(head);
    const ayo = ws.getCell(5, c.ayoCol);
    ayo.value = "AYO";
    styleHeaderCell(ayo);
    const walk = ws.getCell(5, c.walkCol);
    walk.value = "Walk In";
    styleHeaderCell(walk);
    if (c.racketCol) {
      const racket = ws.getCell(5, c.racketCol);
      racket.value = "Sewa Raket";
      styleHeaderCell(racket);
      ws.getColumn(c.racketCol).width = 12;
    }
    ws.getColumn(c.ayoCol).width = 12;
    ws.getColumn(c.walkCol).width = 12;
  }
  ws.mergeCells(4, totalAllCol, 5, totalAllCol);
  ws.getCell(4, totalAllCol).value = "TOTAL \nKESELURUHAN";
  styleHeaderCell(ws.getCell(4, totalAllCol));
  ws.getCell(4, totalAllCol).fill = solidFill(ORANGE);
  ws.getColumn(totalAllCol).width = 16;
  ws.mergeCells(4, totalFieldCol, 5, totalFieldCol);
  ws.getCell(4, totalFieldCol).value = "TOTAL \nLAPANGAN";
  styleHeaderCell(ws.getCell(4, totalFieldCol));
  ws.getColumn(totalFieldCol).width = 15;

  // Agregasi seluruh booking periode → key `${date}|${col}`.
  const agg = new Map<string, number>();
  for (const b of input.dayBookings) {
    const ci = courtCols.find((c) => matchesCourtColumn(c.court, b.field_name));
    if (!ci) continue;
    const col = isAyoSource(b, input) ? ci.ayoCol : ci.walkCol;
    const key = `${b.date}|${col}`;
    agg.set(key, (agg.get(key) ?? 0) + fieldRevenueAmount(b));
    if (ci.racketCol) {
      const racket = racketAddonAmount(b);
      if (racket) {
        const racketKey = `${b.date}|${ci.racketCol}`;
        agg.set(racketKey, (agg.get(racketKey) ?? 0) + racket);
      }
    }
  }

  const firstDataRow = 6;
  dates.forEach((date, i) => {
    const rowIdx = firstDataRow + i;
    const row = ws.getRow(rowIdx);
    const [y, m, d] = date.split("-").map(Number);
    const aCell = row.getCell(1);
    if (i === 0) aCell.value = new Date(Date.UTC(y, m - 1, d));
    else aCell.value = { formula: `A${rowIdx - 1}+1` };
    aCell.numFmt = "dd/mm/yyyy";
    aCell.border = thinBorder();

    for (const c of courtCols) {
      for (const col of [c.ayoCol, c.walkCol, ...(c.racketCol ? [c.racketCol] : [])]) {
        const cell = row.getCell(col);
        const v = agg.get(`${date}|${col}`);
        if (v) cell.value = v;
        cell.numFmt = MONEY_FMT;
        cell.border = thinBorder();
      }
    }
    const totalAllCell = row.getCell(totalAllCol);
    totalAllCell.value = { formula: `SUM(B${rowIdx}:${colLetter(totalAllCol - 1)}${rowIdx})` };
    totalAllCell.numFmt = MONEY_FMT;
    totalAllCell.fill = solidFill(ORANGE_LIGHT);
    totalAllCell.border = thinBorder();
    const fieldColumns = courtCols.flatMap((c) => [c.ayoCol, c.walkCol]);
    const totalFieldCell = row.getCell(totalFieldCol);
    totalFieldCell.value = { formula: fieldColumns.length
      ? fieldColumns.map((col) => `${colLetter(col)}${rowIdx}`).join("+")
      : "0" };
    totalFieldCell.numFmt = MONEY_FMT;
    totalFieldCell.border = thinBorder();
  });

  const totalRow = firstDataRow + dayCount;
  const trow = ws.getRow(totalRow);
  trow.getCell(1).value = "TOTAL";
  trow.getCell(1).font = { bold: true };
  trow.getCell(1).fill = solidFill(YELLOW);
  trow.getCell(1).border = thinBorder();
  for (let col = 2; col <= totalFieldCol; col++) {
    const letter = colLetter(col);
    const cell = trow.getCell(col);
    cell.value = { formula: `SUM(${letter}${firstDataRow}:${letter}${totalRow - 1})` };
    cell.numFmt = MONEY_FMT;
    cell.font = { bold: true };
    cell.fill = solidFill(YELLOW);
    cell.border = thinBorder();
  }

  const padelAyo = courtCols.filter((c) => !c.pickle).map((c) => `${colLetter(c.ayoCol)}${totalRow}`);
  const padelWalk = courtCols.filter((c) => !c.pickle).map((c) => `${colLetter(c.walkCol)}${totalRow}`);
  const padelRacket = courtCols.filter((c) => !c.pickle && c.racketCol).map((c) => `${colLetter(c.racketCol!)}${totalRow}`);
  const pickleAyo = courtCols.filter((c) => c.pickle).map((c) => `${colLetter(c.ayoCol)}${totalRow}`);
  const pickleWalk = courtCols.filter((c) => c.pickle).map((c) => `${colLetter(c.walkCol)}${totalRow}`);

  const base = totalRow + 2;
  ws.getCell(base, 10).value = "PADEL";
  ws.getCell(base, 11).value = "PICKLE";
  ws.getCell(base, 12).value = "Sewa Raket \nPadel";
  ws.getCell(base, 13).value = "TOTAL";
  for (const col of [10, 11, 12, 13]) ws.getCell(base, col).font = { bold: true };

  const sumOrZero = (cells: string[]) => (cells.length ? cells.join("+") : "0");
  const safeDiv = Math.max(dayCount, 1);

  ws.getCell(base + 1, 9).value = "AYO";
  ws.getCell(base + 1, 10).value = { formula: sumOrZero(padelAyo) };
  ws.getCell(base + 1, 11).value = { formula: sumOrZero(pickleAyo) };
  ws.getCell(base + 1, 12).value = { formula: sumOrZero(padelRacket) };
  ws.getCell(base + 1, 13).value = { formula: `SUM(J${base + 1}:K${base + 1})` };
  ws.getCell(base + 2, 9).value = "WALK IN";
  ws.getCell(base + 2, 10).value = { formula: sumOrZero(padelWalk) };
  ws.getCell(base + 2, 11).value = { formula: sumOrZero(pickleWalk) };
  ws.getCell(base + 2, 13).value = { formula: `SUM(J${base + 2}:K${base + 2})` };
  ws.getCell(base + 3, 9).value = "TOTAL";
  ws.getCell(base + 3, 10).value = { formula: `SUM(J${base + 1}:J${base + 2})` };
  ws.getCell(base + 3, 11).value = { formula: `SUM(K${base + 1}:K${base + 2})` };
  ws.getCell(base + 3, 12).value = { formula: `SUM(L${base + 1}:L${base + 2})` };
  ws.getCell(base + 3, 13).value = { formula: `SUM(J${base + 3}:K${base + 3})` };
  ws.getCell(base + 4, 9).value = "Average";
  ws.getCell(base + 4, 10).value = { formula: `J${base + 3}/${safeDiv}` };
  ws.getCell(base + 4, 11).value = { formula: `K${base + 3}/${safeDiv}` };

  for (let rr = base + 1; rr <= base + 4; rr++) {
    for (const col of [10, 11, 12, 13]) ws.getCell(rr, col).numFmt = MONEY_FMT;
    ws.getCell(rr, 9).font = { bold: true };
  }
}

/**
 * ALL versi periode, mengikuti referensi:
 * per TANGGAL → per COURT (subtotal court) → total tanggal → grand total keseluruhan.
 */
function buildAllSheetPeriod(wb: ExcelJS.Workbook, input: OmzetExportInput) {
  const ws = wb.addWorksheet("ALL");
  const baseWithoutDate = BASE_COLUMNS.filter((c) => !c.header.startsWith("Date of"));
  const columns = detailColumns([
    { header: "Tanggal", get: (b) => b.date || "-", width: 12 },
    ...baseWithoutDate,
    ...META_COLUMNS,
  ]);
  writeDetailHeader(ws, "OMSET SEWA LAPANGAN (ALL)", periodText(input), columns);

  const priceIdx = columns.findIndex((c) => c.header === "Price");
  const revenueIdx = columns.findIndex((c) => c.header.startsWith("Revenue"));
  const firstDataRow = 5;
  let r = firstDataRow;
  const dateTotalRows: number[] = [];

  /** Baris total (kuning, bold) berisi penjumlahan baris-baris subtotal lain. */
  function writeTotalOfRows(rowIndex: number, sourceRows: number[], label: string) {
    const row = ws.getRow(rowIndex);
    for (let i = priceIdx; i <= revenueIdx; i++) {
      const letter = colLetter(i + 1);
      const cell = row.getCell(i + 1);
      cell.value = { formula: sourceRows.map((sr) => `${letter}${sr}`).join("+") };
      cell.numFmt = MONEY_FMT;
      cell.font = { bold: true, size: 10 };
      cell.fill = solidFill(YELLOW);
      cell.border = thinBorder();
    }
    ws.mergeCells(`B${rowIndex}:${colLetter(priceIdx)}${rowIndex}`);
    const labelCell = ws.getCell(`B${rowIndex}`);
    labelCell.value = sanitizeExcelCellValue(label);
    labelCell.font = { bold: true, size: 10 };
    labelCell.alignment = { horizontal: "right" };
  }

  // hanya tanggal yang punya booking, urut sesuai dateList
  const dates = (input.dateList ?? []).filter((d) =>
    input.dayBookings.some((b) => b.date === d),
  );

  for (const date of dates) {
    const dayRows = input.dayBookings.filter((b) => b.date === date);
    if (!dayRows.length) continue;
    const dateStart = r;
    const courtSubtotalRows: number[] = [];

    // di dalam tanggal: per court (padel dulu lalu pickle) dengan subtotal per court
    for (const court of distinctCourts(dayRows)) {
      const group = dayRows
        .filter((b) => matchesCourtColumn(court, b.field_name))
        .sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));
      if (!group.length) continue;
      const groupStart = r;
      for (const b of group) {
        writeDataRow(ws, r, columns, columns.map((c) => c.get(b, input)));
        r++;
      }
      writeSumRow(ws, r, columns, groupStart, r - 1);
      courtSubtotalRows.push(r);
      r++;
    }

    // total tanggal = jumlah subtotal court pada tanggal itu
    writeTotalOfRows(r, courtSubtotalRows, "TOTAL");
    // merge kolom Tanggal untuk blok hari ini (data + subtotal court + total tanggal)
    ws.mergeCells(`A${dateStart}:A${r}`);
    const a = ws.getCell(`A${dateStart}`);
    a.value = date;
    a.alignment = { vertical: "middle", horizontal: "center" };
    a.border = thinBorder();
    dateTotalRows.push(r);
    r++;
  }

  // grand total keseluruhan = jumlah total tanggal
  if (dateTotalRows.length) writeTotalOfRows(r, dateTotalRows, "GRAND TOTAL");
}

export async function buildOmzetPeriodWorkbook(input: OmzetExportInput): Promise<Uint8Array> {
  const eligibleInput = displayEligibleInput(input);
  const wb = new ExcelJS.Workbook();
  wb.creator = "AYO Integration";
  wb.created = new Date();

  buildSummarySheetPeriod(wb, eligibleInput);
  buildWalkInSheet(wb, eligibleInput); // reuse: dayBookings = seluruh booking periode
  buildAyoSheet(wb, eligibleInput);
  buildAllSheetPeriod(wb, eligibleInput);

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(arrayBuffer as ArrayBuffer);
}

function displayEligibleInput(input: OmzetExportInput): OmzetExportInput {
  const exportable = (booking: BookingDocument) => isDisplayEligibleTransaction(booking) && !isCancelledTransaction(booking);
  return {
    ...input,
    dayBookings: input.dayBookings.filter(exportable),
    monthBookings: input.monthBookings.filter(exportable),
  };
}
