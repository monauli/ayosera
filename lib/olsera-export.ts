import ExcelJS from "exceljs";
import type { OlseraSalesByCategoryDocument } from "./mongodb.ts";
import { sanitizeExcelCellValue } from "./excel-sanitization.ts";

/**
 * Generator workbook "Total Keseluruhan Omset" Olsera — matriks kategori x tanggal.
 * Sepenuhnya terpisah dari lib/omzet-export.ts (AYO); helper styling generik
 * (colLetter, solidFill, thinBorder, konstanta warna/format) diduplikasi di sini
 * dengan sengaja agar tidak ada dependensi silang ke modul AYO.
 */

const MONTHS_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

const MONEY_FMT = "#,##0";
const HEADER_FILL = "FFF2F2F2";
const YELLOW = "FFFFFF00";

function solidFill(argb: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const };
  return { top: side, left: side, bottom: side, right: side };
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

/** Daftar tanggal YYYY-MM-DD inklusif dari start..end. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (!sy || !ey) return out;
  let cur = Date.UTC(sy, sm - 1, sd);
  const last = Date.UTC(ey, em - 1, ed);
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

/** "DD/MM" — dipakai sebagai header kolom tanggal (jelas walau rentang lintas bulan). */
function fmtDateShort(date: string) {
  const [, m, d] = date.split("-");
  return `${d}/${m}`;
}

/** Label rentang: "Juni'26" bila persis 1 bulan penuh, selain itu "01 Jun - 30 Jun 2026". */
function periodLabel(start: string, end: string) {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (!sy || !ey) return `${start} - ${end}`;

  const daysInStartMonth = new Date(sy, sm, 0).getDate();
  const isFullMonth = sy === ey && sm === em && sd === 1 && ed === daysInStartMonth;
  if (isFullMonth) return `${MONTHS_ID[sm - 1]}'${String(sy).slice(2)}`;

  const shortMonthsId = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const startLabel = `${String(sd).padStart(2, "0")} ${shortMonthsId[sm - 1]}`;
  const endLabel = `${String(ed).padStart(2, "0")} ${shortMonthsId[em - 1]} ${ey}`;
  return `${startLabel} - ${endLabel}`;
}

export type OlseraOmsetExportInput = {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  rows: Pick<OlseraSalesByCategoryDocument, "date" | "category" | "totalAmount" | "costAmount">[];
};

/** Tulis satu sheet matriks kategori x tanggal (dipakai untuk sheet Omset & Laba). */
function buildMatrixSheet(
  wb: ExcelJS.Workbook,
  opts: {
    sheetName: string;
    title: string;
    start: string;
    end: string;
    categories: string[];
    dates: string[];
    valueFor: (category: string, date: string) => number | undefined;
  },
) {
  const { sheetName, title, start, end, categories, dates, valueFor } = opts;
  const ws = wb.addWorksheet(sheetName);

  const firstDateCol = 3; // A=No, B=Kategori, C..=tanggal
  const totalCol = firstDateCol + dates.length;
  const lastColLetter = colLetter(totalCol);

  // Judul
  ws.mergeCells(`A1:${lastColLetter}1`);
  const titleCell = ws.getCell("A1");
  titleCell.value = title;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };

  ws.mergeCells(`A2:${lastColLetter}2`);
  const subtitleCell = ws.getCell("A2");
  subtitleCell.value = periodLabel(start, end);
  subtitleCell.font = { italic: true, size: 10 };
  subtitleCell.alignment = { vertical: "middle", horizontal: "left" };

  // Header (baris 4)
  const headerRow = 4;
  const noHeader = ws.getCell(headerRow, 1);
  noHeader.value = "No";
  ws.getColumn(1).width = 6;

  const kategoriHeader = ws.getCell(headerRow, 2);
  kategoriHeader.value = "Kategori";
  ws.getColumn(2).width = 24;

  dates.forEach((date, i) => {
    const cell = ws.getCell(headerRow, firstDateCol + i);
    cell.value = fmtDateShort(date);
    ws.getColumn(firstDateCol + i).width = 11;
  });

  const totalHeader = ws.getCell(headerRow, totalCol);
  totalHeader.value = "TOTAL";
  ws.getColumn(totalCol).width = 14;

  for (let col = 1; col <= totalCol; col++) {
    const cell = ws.getCell(headerRow, col);
    cell.font = { bold: true, size: 10 };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.fill = solidFill(HEADER_FILL);
    cell.border = thinBorder();
  }
  ws.getRow(headerRow).height = 22;

  // Baris data per kategori
  const firstDataRow = headerRow + 1;
  categories.forEach((category, idx) => {
    const rowIdx = firstDataRow + idx;
    const row = ws.getRow(rowIdx);

    row.getCell(1).value = idx + 1;
    row.getCell(2).value = sanitizeExcelCellValue(category);

    dates.forEach((date, i) => {
      const cell = row.getCell(firstDateCol + i);
      const value = valueFor(category, date);
      if (value) cell.value = value;
      cell.numFmt = MONEY_FMT;
    });

    const totalCell = row.getCell(totalCol);
    totalCell.value = { formula: `SUM(${colLetter(firstDateCol)}${rowIdx}:${colLetter(totalCol - 1)}${rowIdx})` };
    totalCell.numFmt = MONEY_FMT;
    totalCell.font = { bold: true };
    totalCell.fill = solidFill(HEADER_FILL);

    for (let col = 1; col <= totalCol; col++) {
      const cell = row.getCell(col);
      cell.border = thinBorder();
      cell.font = cell.font ?? { size: 10 };
      if (col === 1) cell.alignment = { horizontal: "center" };
    }
  });

  // Baris TOTAL (bawah)
  const lastDataRow = firstDataRow + categories.length - 1;
  const totalRow = firstDataRow + categories.length;
  const trow = ws.getRow(totalRow);

  ws.mergeCells(`A${totalRow}:B${totalRow}`);
  const totalLabelCell = ws.getCell(`A${totalRow}`);
  totalLabelCell.value = "TOTAL";
  totalLabelCell.font = { bold: true };
  totalLabelCell.alignment = { horizontal: "right" };

  for (let col = firstDateCol; col <= totalCol; col++) {
    const letter = colLetter(col);
    const cell = trow.getCell(col);
    cell.value = categories.length
      ? { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})` }
      : 0;
    cell.numFmt = MONEY_FMT;
    cell.font = { bold: true };
  }

  for (let col = 1; col <= totalCol; col++) {
    const cell = trow.getCell(col);
    cell.fill = solidFill(YELLOW);
    cell.border = thinBorder();
  }

  ws.views = [{ state: "frozen", xSplit: 2, ySplit: headerRow }];
}

export async function buildOlseraOmsetWorkbook(input: OlseraOmsetExportInput): Promise<Uint8Array> {
  const { start, end, rows } = input;
  const dates = dateRange(start, end);

  const categories = Array.from(new Set(rows.map((r) => r.category))).sort((a, b) => a.localeCompare(b, "id"));

  // Map "kategori|tanggal" -> totalAmount / laba (totalAmount - costAmount)
  const omsetAgg = new Map<string, number>();
  const labaAgg = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.category}|${r.date}`;
    omsetAgg.set(key, (omsetAgg.get(key) ?? 0) + r.totalAmount);
    labaAgg.set(key, (labaAgg.get(key) ?? 0) + (r.totalAmount - r.costAmount));
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Olsera Integration";
  wb.created = new Date();

  buildMatrixSheet(wb, {
    sheetName: "Omset Keseluruhan",
    title: "OMSET KESELURUHAN",
    start,
    end,
    categories,
    dates,
    valueFor: (category, date) => omsetAgg.get(`${category}|${date}`),
  });

  buildMatrixSheet(wb, {
    sheetName: "Laba",
    title: "LABA",
    start,
    end,
    categories,
    dates,
    valueFor: (category, date) => labaAgg.get(`${category}|${date}`),
  });

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(arrayBuffer as ArrayBuffer);
}
