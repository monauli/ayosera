// Export "Pembagian Hasil LABERS": rekap harian penjualan kategori LABERS
// selama satu bulan + pembagian persentase Padel (17,5%) / Labers (82,5%).
// Layout, merge, border, font, number format, freeze pane, dan page setup
// mengikuti file referensi "Pembagian hasil labers.xlsx" (sheet Mei = bulan
// 31 hari, sheet Juni = bulan 30 hari), divalidasi 1:1 oleh
// scripts/test-export-labers-sharing.ts (total Mei & Juni 2026).
//
// Sumber kategori: canonical resolver yang sama dengan dashboard/Export
// Kategori Penjualan/Omset Kategori (resolveStoredItemCategory) — bukan
// pencocokan substring nama produk.
//
// `amount` SUDAH termasuk add-on (lihat catatan di lib/mongodb.ts). Supaya
// tidak dobel hitung: Penjualan Labers (kolom B) = amount - addonPrice, lalu
// Total Penjualan Labers (kolom D, formula) = B + C mengembalikan amount asli.
import ExcelJS from "exceljs";
import { collections, withMongo } from "./mongodb.ts";
import { loadResolverContext, resolveStoredItemCategory } from "./olsera-resolver-context.ts";

const FONT = "Calibri";
const BLACK = "FF000000";
// Format accounting Rupiah persis referensi — 0 tampil sebagai "Rp -".
const MONEY_FMT = '_-"Rp"* #,##0_-;-"Rp"* #,##0_-;_-"Rp"* "-"_-;_-@_-';
const DATE_FMT = "mm-dd-yy";
const MEDIUM = { style: "medium" as const, color: { argb: BLACK } };
const CATEGORY = "LABERS";

const MONTHS_ID_UPPER = [
  "JANUARI", "FEBRUARI", "MARET", "APRIL", "MEI", "JUNI",
  "JULI", "AGUSTUS", "SEPTEMBER", "OKTOBER", "NOVEMBER", "DESEMBER",
];

const COLUMN_WIDTHS = [11.53125, 22.9296875, 12.53125, 18.19921875, 16.06640625, 17.265625];
const HEADERS = ["Tanggal", "Penjualan Labers", "Add On", "Total Penjualan Labers", "Padel (17,5%)", "Labers (82,5%)"];

export function daysInMonth(month: string): number {
  const [year, mon] = month.split("-").map(Number);
  return new Date(year, mon, 0).getDate();
}

export type LabersSharingDay = {
  date: string; // YYYY-MM-DD
  /** Penjualan Labers (kolom B) — amount dikurangi add-on. */
  penjualanLabers: number;
  /** Add On (kolom C) — informasi saja, sudah termasuk di amount. */
  addOn: number;
};

export type LabersSharingInput = {
  month: string; // YYYY-MM
  days: LabersSharingDay[]; // panjang = jumlah hari bulan tsb
  /** true bila tidak ada transaksi kategori LABERS sama sekali pada bulan tsb. */
  empty: boolean;
};

/** Kumpulkan data harian LABERS dari MongoDB untuk satu bulan. Read-only. */
export async function loadLabersSharingRows(month: string): Promise<LabersSharingInput> {
  const dayCount = daysInMonth(month);
  const start = `${month}-01`;
  const end = `${month}-${String(dayCount).padStart(2, "0")}`;

  const items = await withMongo(async () => {
    const { olseraOrderItems } = await collections();
    return olseraOrderItems
      .find({ date: { $gte: start, $lte: end } })
      .project<{
        date: string;
        itemName: string;
        qty: number;
        amount: number;
        addonPrice?: number;
        productId?: number | null;
        variantId?: number | null;
        sku?: string | null;
        barcode?: string | null;
        originalCategoryId?: string | null;
        originalCategoryName?: string | null;
        resolvedCategoryName?: string | null;
        categoryResolutionStatus?: "resolved" | "unresolved";
      }>({
        _id: 0,
        date: 1,
        itemName: 1,
        qty: 1,
        amount: 1,
        addonPrice: 1,
        productId: 1,
        variantId: 1,
        sku: 1,
        barcode: 1,
        originalCategoryId: 1,
        originalCategoryName: 1,
        resolvedCategoryName: 1,
        categoryResolutionStatus: 1,
      })
      .toArray();
  });

  const totalWithAddon = new Array<number>(dayCount).fill(0);
  const addOnSum = new Array<number>(dayCount).fill(0);
  const dayIndex = (date: string) => Number(date.slice(8, 10)) - 1;

  const resolverCtx = items.length ? (await loadResolverContext()).ctx : null;
  let hasLabers = false;
  if (resolverCtx) {
    for (const item of items) {
      const category = resolveStoredItemCategory(item, resolverCtx);
      if (category !== CATEGORY) continue;
      const idx = dayIndex(item.date);
      if (idx < 0 || idx >= dayCount) continue;
      totalWithAddon[idx] += item.amount;
      // addonPrice tersimpan per unit (lib/mongodb.ts) — kontribusi add-on
      // pada baris ini ke total transaksi adalah addonPrice × qty (divalidasi
      // 1:1 terhadap referensi Mei/Juni 2026 di scripts/test-export-labers-sharing.ts).
      addOnSum[idx] += (item.addonPrice ?? 0) * item.qty;
      hasLabers = true;
    }
  }

  const days: LabersSharingDay[] = [];
  for (let d = 0; d < dayCount; d++) {
    days.push({
      date: `${month}-${String(d + 1).padStart(2, "0")}`,
      penjualanLabers: totalWithAddon[d] - addOnSum[d],
      addOn: addOnSum[d],
    });
  }

  return { month, days, empty: !hasLabers };
}

function excelDateSerial(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

// ---------------------------------------------------------------------------
// Workbook builder — layout persis referensi "Pembagian hasil labers.xlsx".
// ---------------------------------------------------------------------------

export async function buildLabersSharingWorkbook(input: LabersSharingInput): Promise<Uint8Array> {
  const [year, mon] = input.month.split("-").map(Number);
  const monthLabel = `${MONTHS_ID_UPPER[mon - 1]}'${String(year).slice(2)}`;

  const wb = new ExcelJS.Workbook();
  wb.creator = "AYO Olsera";
  wb.created = new Date();
  wb.modified = new Date();
  wb.calcProperties.fullCalcOnLoad = true;

  const ws = wb.addWorksheet(`Pembagian Hasil - ${monthLabel}`, {
    properties: { defaultRowHeight: 14.25 },
    pageSetup: {
      orientation: "portrait",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      margins: { left: 0, right: 0, top: 0.7480314960629921, bottom: 0.7480314960629921, header: 0.31496062992125984, footer: 0.31496062992125984 },
    },
    views: [{ state: "frozen", xSplit: 1, ySplit: 4, topLeftCell: "B5", showGridLines: true, zoomScale: 100 }],
  });
  ws.columns = COLUMN_WIDTHS.map((width) => ({ width }));

  // Judul + periode — merge A:F, bold 14, center, Calibri.
  ws.mergeCells("A1:F1");
  ws.getCell("A1").value = "Rekap Penjualan Labers & Pembagian Persentase";
  ws.mergeCells("A2:F2");
  ws.getCell("A2").value = `Periode: ${monthLabel}`;
  for (const address of ["A1", "A2"]) {
    const cell = ws.getCell(address);
    cell.font = { name: FONT, size: 14, bold: true, color: { argb: BLACK } };
    cell.alignment = { horizontal: "center" };
  }
  ws.getRow(1).height = 18;
  ws.getRow(2).height = 18;
  ws.getRow(3).height = 14.65; // baris kosong pemisah, persis referensi

  // Header baris 4 — bold 12, center/middle, border medium penuh, tinggi 30.
  HEADERS.forEach((text, index) => {
    const cell = ws.getCell(4, index + 1);
    cell.value = text;
    cell.font = { name: FONT, size: 12, bold: true, color: { argb: BLACK } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: index === 3 };
    cell.border = { top: MEDIUM, bottom: MEDIUM, left: MEDIUM, right: MEDIUM };
  });
  ws.getRow(4).height = 30;

  // Baris data harian — tanggal (Excel date, mm-dd-yy) + formula D/E/F dengan
  // cached result (ExcelJS tidak menghitung formula sendiri).
  const firstDataRow = 5;
  const lastDataRow = firstDataRow + input.days.length - 1;
  input.days.forEach((day, index) => {
    const rowNumber = firstDataRow + index;
    const total = day.penjualanLabers + day.addOn;
    const padel = total * 0.175;
    const labers = total * 0.825;

    const values: [ExcelJS.CellValue, string][] = [
      [excelDateSerial(day.date), DATE_FMT],
      [day.penjualanLabers, MONEY_FMT],
      [day.addOn, MONEY_FMT],
      [{ formula: `B${rowNumber}+C${rowNumber}`, result: total }, MONEY_FMT],
      [{ formula: `D${rowNumber}*17.5%`, result: padel }, MONEY_FMT],
      [{ formula: `D${rowNumber}*82.5%`, result: labers }, MONEY_FMT],
    ];
    values.forEach(([value, numFmt], columnIndex) => {
      const cell = ws.getCell(rowNumber, columnIndex + 1);
      cell.value = value;
      cell.numFmt = numFmt;
      cell.font = { name: FONT, size: 11, color: { argb: BLACK } };
      cell.border = { left: MEDIUM, right: MEDIUM };
    });
  });

  // Baris TOTAL — tepat setelah tanggal terakhir, box border penuh, SUM per kolom.
  const totalRow = lastDataRow + 1;
  const totalLabel = ws.getCell(totalRow, 1);
  totalLabel.value = "TOTAL";
  totalLabel.font = { name: FONT, size: 11, bold: true, color: { argb: BLACK } };
  totalLabel.alignment = { horizontal: "center" };
  totalLabel.border = { top: MEDIUM, bottom: MEDIUM, left: MEDIUM, right: MEDIUM };

  // Total dihitung dari nilai sumber (bukan dibaca ulang dari cell) agar akurat.
  const totalB = input.days.reduce((x, d) => x + d.penjualanLabers, 0);
  const totalC = input.days.reduce((x, d) => x + d.addOn, 0);
  const totalD = totalB + totalC;
  const totalE = totalD * 0.175;
  const totalF = totalD * 0.825;
  const totalValues: [string, number][] = [
    ["B", totalB],
    ["C", totalC],
    ["D", totalD],
    ["E", totalE],
    ["F", totalF],
  ];
  for (const [col, result] of totalValues) {
    const cell = ws.getCell(`${col}${totalRow}`);
    cell.value = { formula: `SUM(${col}${firstDataRow}:${col}${lastDataRow})`, result };
    cell.numFmt = MONEY_FMT;
    cell.font = { name: FONT, size: 11, color: { argb: BLACK } };
    cell.border = { top: MEDIUM, bottom: MEDIUM, left: MEDIUM, right: MEDIUM };
  }
  ws.getRow(lastDataRow).height = 14.65;
  ws.getRow(totalRow).height = 14.65;

  // Catatan: printArea sengaja tidak diset — ExcelJS gagal menulis ulang
  // defined name Print_Area saat nama sheet mengandung apostrof (mis.
  // "MEI'26"), yang wajib dipakai sesuai konvensi penamaan sheet di sini.
  // fitToPage/fitToWidth/fitToHeight di pageSetup sudah cukup untuk cetak.

  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
