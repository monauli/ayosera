// Export "Omset Kategori": satu sheet "Total Keseluruhan Omset" berbentuk
// matriks bulanan (baris = kategori/subkategori, kolom = tanggal 1..N + TOTAL).
// Layout, merge, border, font, number format, dan freeze pane mengikuti file
// referensi "Total keselurhan omset.xlsx" (Mei 2026), divalidasi 1:1 oleh
// scripts/test-export-omset-kategori.ts.
//
// Sumber angka (sama dengan dashboard/Export Kategori Penjualan):
// - "Sewa Lapangan" (a. Padel / b. Pickleball) = revenue booking lapangan
//   (koleksi bookings, getRevenueAmount) — BUKAN kategori Olsera
//   LAPANGAN PADEL/PICKLEBALL, karena pembayaran walk-in via Olsera sudah
//   terwakili sebagai booking walk-in (menghindari dobel hitung; terbukti
//   cocok 1:1 dengan referensi Mei 2026).
// - Kategori lain = item penjualan Olsera (olsera_order_items) dengan mapping
//   klasifikasi katalog produk yang sama dengan Export Kategori Penjualan.
// - "Sewa Raket" dipecah subkategori dari nama item
//   ("SEWA RAKET - RAKET STANDAR" / "SEWA RAKET - RAKET PREMIUM").
import ExcelJS from "exceljs";
import { collections, withMongo } from "./mongodb.ts";
import { getRevenueAmount, isDisplayEligibleTransaction } from "./revenue.ts";
import { categoryForItem, getCategoryByNameMap } from "./olsera-category-export.ts";

const FONT = "Calibri";
const BLACK = "FF000000";
const RED = "FFFF0000";
// Format accounting persis referensi — 0 tampil sebagai "-".
const MONEY_FMT = '_-* #,##0_-;-* #,##0_-;_-* "-"_-;_-@_-';
const MONTHS_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

const MEDIUM = { style: "medium" as const, color: { argb: BLACK } };
const THIN = { style: "thin" as const, color: { argb: BLACK } };

export type OmsetKategoriRow =
  | { kind: "group"; no: number; label: string; children: { label: string; amounts: number[] }[] }
  | { kind: "single"; no: number; label: string; amounts: number[] };

export type OmsetKategoriInput = {
  month: string; // YYYY-MM
  rows: OmsetKategoriRow[];
  /** true bila tidak ada transaksi sama sekali pada bulan tsb. */
  empty: boolean;
};

export function daysInMonth(month: string): number {
  const [year, mon] = month.split("-").map(Number);
  return new Date(year, mon, 0).getDate();
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

// Panjang tampilan "#,##0" (separator ribuan) untuk auto-lebar kolom uang.
function moneyLen(value: number): number {
  const digits = String(Math.round(Math.abs(value))).length;
  return digits + Math.floor((digits - 1) / 3) + (value < 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Susunan kategori mengikuti referensi. Kategori LAPANGAN PADEL/PICKLEBALL
// Olsera sengaja TIDAK dipetakan (lihat catatan di atas). Kategori Olsera di
// luar template (mis. JASA HOST) ditambahkan di bawah bila bertransaksi.
// ---------------------------------------------------------------------------

const TEMPLATE: (
  | { label: string; source: string }
  | { label: string; children: { label: string; source: string }[] }
)[] = [
  {
    label: "Sewa Lapangan",
    children: [
      { label: "a. Padel", source: "@BOOKING_PADEL" },
      { label: "b. Pickleball", source: "@BOOKING_PICKLE" },
    ],
  },
  { label: "Topi", source: "TOPI" },
  { label: "Grip", source: "GRIP" },
  {
    label: "Sewa Raket",
    children: [
      { label: "a. Raket Standar", source: "@RAKET_STANDAR" },
      { label: "b. Raket Premium", source: "@RAKET_PREMIUM" },
    ],
  },
  { label: "Salon", source: "SALON" },
  { label: "Snack", source: "SNACK" },
  { label: "Labers", source: "LABERS" },
  { label: "Minuman", source: "MINUMAN" },
  { label: "Bola Padel", source: "BOLA PADEL" },
  { label: "Raket Padel", source: "RAKET PADEL" },
  { label: "Baju Pria", source: "BAJU PRIA" },
  { label: "Skort Wanita", source: "SKORT WANITA" },
  { label: "Celana Pria", source: "CELANA PRIA" },
  { label: "Kaos Kaki", source: "KAOS KAKI" },
  { label: "Sewa keranjang & bola", source: "SEWA KERANJANG+BOLA" },
  { label: "Thermoflask", source: "THERMOFLASK" },
];

// Kategori Olsera yang sudah terwakili baris booking "Sewa Lapangan".
const EXCLUDED_OLSERA_CATEGORIES = new Set(["LAPANGAN PADEL", "LAPANGAN PICKLEBALL"]);

// Item yang tidak lagi ada di katalog produk (kategori "Tidak Diketahui")
// dicoba dipetakan dari kata kunci nama produk sebelum jatuh ke baris
// "Tidak Diketahui" (mis. "YONEX SHORTS MEN ..." → CELANA PRIA, sesuai referensi).
const FALLBACK_KEYWORDS: [RegExp, string][] = [
  [/SHORT|CELANA/i, "CELANA PRIA"],
  [/SKORT|SKIRT/i, "SKORT WANITA"],
  [/KAOS KAKI|SOCKS/i, "KAOS KAKI"],
  [/\bGRIP\b/i, "GRIP"],
  [/\bTOPI\b|\bCAP\b/i, "TOPI"],
];
const UNKNOWN_CATEGORY = "Tidak Diketahui";

function titleCaseId(value: string) {
  return value
    .toLowerCase()
    .replace(/(^|[\s/+&(])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Kumpulkan data bulanan dari MongoDB menjadi baris laporan siap tulis. */
export async function loadOmsetKategoriRows(month: string): Promise<OmsetKategoriInput> {
  const dayCount = daysInMonth(month);
  const start = `${month}-01`;
  const end = `${month}-${String(dayCount).padStart(2, "0")}`;

  const { items, monthBookings } = await withMongo(async () => {
    const { olseraOrderItems, bookings } = await collections();
    const [itemRows, bookingRows] = await Promise.all([
      olseraOrderItems
        .find({ date: { $gte: start, $lte: end } })
        .project<{ date: string; itemName: string; amount: number }>({ _id: 0, date: 1, itemName: 1, amount: 1 })
        .toArray(),
      bookings.find({ date: { $gte: start, $lte: end } }).toArray(),
    ]);
    return { items: itemRows, monthBookings: bookingRows };
  });

  const zeros = () => new Array<number>(dayCount).fill(0);
  const dayIndex = (date: string) => Number(date.slice(8, 10)) - 1;

  // Booking lapangan → Padel / Pickleball per tanggal (pola sama dengan
  // Summary Omzet Harian: display-eligible + getRevenueAmount).
  const padel = zeros();
  const pickle = zeros();
  let hasBooking = false;
  for (const b of monthBookings) {
    if (!isDisplayEligibleTransaction(b)) continue;
    const idx = dayIndex(b.date ?? "");
    if (idx < 0 || idx >= dayCount) continue;
    const amount = getRevenueAmount(b);
    if (amount) hasBooking = true;
    if (/pickle/i.test(b.field_name ?? "")) pickle[idx] += amount;
    else padel[idx] += amount;
  }

  // Item Olsera → per (kategori, tanggal); mapping katalog sama dengan
  // Export Kategori Penjualan.
  const nameMap = items.length ? await getCategoryByNameMap() : new Map<string, string>();
  const byCategory = new Map<string, number[]>();
  const add = (category: string, idx: number, amount: number) => {
    let arr = byCategory.get(category);
    if (!arr) byCategory.set(category, (arr = zeros()));
    arr[idx] += amount;
  };
  for (const item of items) {
    const idx = dayIndex(item.date);
    if (idx < 0 || idx >= dayCount) continue;
    let category = categoryForItem(item.itemName, nameMap);
    if (category === UNKNOWN_CATEGORY) {
      category = FALLBACK_KEYWORDS.find(([re]) => re.test(item.itemName))?.[1] ?? UNKNOWN_CATEGORY;
    }
    if (EXCLUDED_OLSERA_CATEGORIES.has(category)) continue;
    if (category === "SEWA RAKET") {
      category = /PREMIUM/i.test(item.itemName) ? "@RAKET_PREMIUM" : "@RAKET_STANDAR";
    }
    add(category, idx, item.amount);
  }

  const takeSource = (source: string): number[] => {
    if (source === "@BOOKING_PADEL") return padel;
    if (source === "@BOOKING_PICKLE") return pickle;
    const arr = byCategory.get(source) ?? zeros();
    byCategory.delete(source);
    return arr;
  };

  const rows: OmsetKategoriRow[] = [];
  let no = 0;
  for (const spec of TEMPLATE) {
    no++;
    if ("children" in spec) {
      rows.push({
        kind: "group",
        no,
        label: spec.label,
        children: spec.children.map((child) => ({ label: child.label, amounts: takeSource(child.source) })),
      });
    } else {
      rows.push({ kind: "single", no, label: spec.label, amounts: takeSource(spec.source) });
    }
  }
  // Kategori di luar template (JASA HOST, dll) — hanya bila bertransaksi.
  for (const [category, amounts] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0], "id"))) {
    if (!amounts.some((v) => v !== 0)) continue;
    no++;
    rows.push({
      kind: "single",
      no,
      label: category === UNKNOWN_CATEGORY ? category : titleCaseId(category),
      amounts,
    });
  }

  const empty = !hasBooking && !items.length;
  return { month, rows, empty };
}

// ---------------------------------------------------------------------------
// Workbook builder — layout persis referensi "Total keselurhan omset.xlsx".
// ---------------------------------------------------------------------------

export async function buildOmsetKategoriWorkbook(input: OmsetKategoriInput): Promise<Uint8Array> {
  const dayCount = daysInMonth(input.month);
  const [year, mon] = input.month.split("-").map(Number);
  const lastDayCol = 2 + dayCount; // C=hari 1
  const totalCol = lastDayCol + 1;
  const totalLetter = colLetter(totalCol);

  const wb = new ExcelJS.Workbook();
  wb.creator = "AYO Olsera";
  wb.created = new Date();
  wb.modified = new Date();
  wb.calcProperties.fullCalcOnLoad = true;

  const ws = wb.addWorksheet("Total Keseluruhan Omset");
  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 0, topLeftCell: "C1" }];

  // Judul + periode (merge A:B, bold, center) — "OMSET KESELURUHAN" / "Mei'26".
  ws.mergeCells("A1:B1");
  ws.getCell("A1").value = "OMSET KESELURUHAN";
  ws.mergeCells("A2:B2");
  ws.getCell("A2").value = `${MONTHS_ID[mon - 1]}'${String(year).slice(2)}`;
  for (const address of ["A1", "A2"]) {
    const cell = ws.getCell(address);
    cell.font = { name: FONT, size: 11, bold: true, color: { argb: BLACK } };
    cell.alignment = { horizontal: "center" };
  }

  // Header 2 baris: No | Kategori | Tanggal (1..N) | TOTAL.
  ws.mergeCells("A4:A5");
  ws.mergeCells("B4:B5");
  ws.mergeCells(4, 3, 4, lastDayCol);
  ws.mergeCells(4, totalCol, 5, totalCol);
  ws.getCell("A4").value = "No";
  ws.getCell("B4").value = "Kategori";
  ws.getCell(4, 3).value = "Tanggal";
  ws.getCell(4, totalCol).value = "TOTAL";
  ws.getCell("A4").font = { name: FONT, size: 10, bold: true, color: { argb: BLACK } };
  for (const cell of [ws.getCell("B4"), ws.getCell(4, 3), ws.getCell(4, totalCol)]) {
    cell.font = { name: FONT, size: 11, bold: true, color: { argb: BLACK } };
  }
  for (const address of ["A4", "B4"]) {
    ws.getCell(address).alignment = { horizontal: "center", vertical: "middle" };
    ws.getCell(address).border = { top: MEDIUM, left: MEDIUM, right: MEDIUM, bottom: MEDIUM };
  }
  ws.getCell(4, 3).alignment = { horizontal: "center", vertical: "middle" };
  ws.getCell(4, 3).border = { top: MEDIUM, left: MEDIUM, bottom: MEDIUM };
  ws.getCell(4, totalCol).alignment = { horizontal: "center", vertical: "middle" };
  ws.getCell(4, totalCol).border = { top: MEDIUM, left: MEDIUM, right: MEDIUM, bottom: MEDIUM };
  for (let day = 1; day <= dayCount; day++) {
    const cell = ws.getCell(5, 2 + day);
    cell.value = day;
    cell.numFmt = "0";
    cell.font = { name: FONT, size: 12, color: { argb: BLACK } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = {
      top: MEDIUM,
      bottom: MEDIUM,
      left: day === 1 ? MEDIUM : THIN,
      right: day === dayCount ? MEDIUM : THIN,
    };
  }
  ws.getRow(4).height = 16.15;
  ws.getRow(5).height = 16.15;

  // Baris data. Setiap cell tanggal berisi ANGKA (0 bila tanpa transaksi —
  // format accounting menampilkannya sebagai "-", persis tampilan referensi).
  const firstDataRow = 6;
  let r = firstDataRow;

  const writeLeaf = (rowNumber: number, label: string, amounts: number[], indent: boolean, no?: number) => {
    if (no !== undefined) ws.getCell(rowNumber, 1).value = no;
    const labelCell = ws.getCell(rowNumber, 2);
    labelCell.value = label;
    if (indent) labelCell.alignment = { horizontal: "left", indent: 1 };
    amounts.forEach((amount, i) => {
      const cell = ws.getCell(rowNumber, 3 + i);
      cell.value = amount;
      cell.numFmt = MONEY_FMT;
      cell.font = { name: FONT, size: 10, color: { argb: BLACK } };
    });
    const totalCell = ws.getCell(rowNumber, totalCol);
    totalCell.value = {
      formula: `SUM(C${rowNumber}:${colLetter(lastDayCol)}${rowNumber})`,
      result: amounts.reduce((x, v) => x + v, 0),
    };
    totalCell.numFmt = MONEY_FMT;
    totalCell.font = { name: FONT, size: 10, color: { argb: BLACK } };
  };

  for (const row of input.rows) {
    if (row.kind === "single") {
      writeLeaf(r, row.label, row.amounts, false, row.no);
      r++;
    } else {
      ws.getCell(r, 1).value = row.no;
      ws.getCell(r, 2).value = row.label;
      r++;
      for (const child of row.children) {
        writeLeaf(r, child.label, child.amounts, true);
        r++;
      }
    }
  }
  const lastDataRow = r - 1;

  // Border tepi area data (kolom A, B, TOTAL medium kiri/kanan; tepi atas/bawah).
  for (let rowNumber = firstDataRow; rowNumber <= lastDataRow; rowNumber++) {
    const noCell = ws.getCell(rowNumber, 1);
    noCell.font = { name: FONT, size: 10, color: { argb: BLACK } };
    noCell.alignment = { horizontal: "center", vertical: "middle" };
    noCell.border = { left: MEDIUM, right: MEDIUM };
    const labelCell = ws.getCell(rowNumber, 2);
    labelCell.font = { name: FONT, size: 11, color: { argb: BLACK } };
    labelCell.border = { left: MEDIUM, right: MEDIUM };
    ws.getCell(rowNumber, totalCol).border = { left: MEDIUM, right: MEDIUM };
  }

  // Baris TOTAL bawah: SUM per tanggal + grand total (bold merah, garis bawah
  // accounting — persis referensi).
  const totalRow = lastDataRow + 1;
  ws.mergeCells(totalRow, 1, totalRow, 2);
  const totalLabel = ws.getCell(totalRow, 1);
  totalLabel.value = "TOTAL";
  totalLabel.font = { name: FONT, size: 11, bold: true, color: { argb: BLACK } };
  totalLabel.alignment = { horizontal: "center", vertical: "middle" };
  totalLabel.border = { top: MEDIUM, left: MEDIUM, right: MEDIUM, bottom: MEDIUM };

  const columnTotals = new Array<number>(dayCount).fill(0);
  let grandTotal = 0;
  for (const row of input.rows) {
    const leaves = row.kind === "single" ? [row.amounts] : row.children.map((c) => c.amounts);
    for (const amounts of leaves) {
      amounts.forEach((v, i) => {
        columnTotals[i] += v;
      });
      grandTotal += amounts.reduce((x, v) => x + v, 0);
    }
  }
  for (let day = 1; day <= dayCount; day++) {
    const letter = colLetter(2 + day);
    const cell = ws.getCell(totalRow, 2 + day);
    cell.value = { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})`, result: columnTotals[day - 1] };
    cell.numFmt = MONEY_FMT;
    cell.font = { name: FONT, size: 10, color: { argb: BLACK } };
    cell.border = { top: MEDIUM, bottom: MEDIUM, left: day === 1 ? MEDIUM : THIN, right: day === dayCount ? MEDIUM : THIN };
  }
  const grandCell = ws.getCell(totalRow, totalCol);
  grandCell.value = {
    formula: `SUM(${totalLetter}${firstDataRow}:${totalLetter}${lastDataRow})`,
    result: grandTotal,
  };
  grandCell.numFmt = MONEY_FMT;
  grandCell.font = { name: FONT, size: 10, bold: true, underline: "singleAccounting", color: { argb: RED } };
  grandCell.border = { top: MEDIUM, left: MEDIUM, right: MEDIUM, bottom: MEDIUM };
  ws.getRow(totalRow).height = 17.65;

  // Lebar kolom mengikuti referensi; kolom uang otomatis melebar mengikuti
  // nilai terbesar agar tidak "#######".
  const widths = new Array<number>(totalCol).fill(9.5625);
  widths[0] = 2.75;
  widths[1] = 17.6875;
  widths[totalCol - 1] = 10.4375;
  for (let day = 1; day <= dayCount; day++) {
    widths[1 + day] = Math.max(widths[1 + day], moneyLen(columnTotals[day - 1]) + 1);
  }
  widths[totalCol - 1] = Math.max(widths[totalCol - 1], moneyLen(grandTotal) + 1);
  widths.forEach((width, index) => {
    ws.getColumn(index + 1).width = width;
  });

  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
