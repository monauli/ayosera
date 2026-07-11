import ExcelJS from "exceljs";
import type { OlseraOrderItemDocument } from "./mongodb.ts";

/**
 * Generator workbook "Detail Transaksi" Olsera — satu baris per item terjual
 * per order, mirip laporan "Item Penjualan" Olsera Backoffice.
 * File TERPISAH dari lib/olsera-export.ts (Omset+Laba per kategori) karena
 * volume barisnya jauh lebih besar. Helper styling generik (colLetter,
 * solidFill, thinBorder, konstanta warna/format) diduplikasi dengan sengaja
 * agar tidak ada dependensi silang ke modul lain.
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

const COLUMNS: { header: string; width: number; money?: boolean; align?: "left" | "center" | "right" }[] = [
  { header: "No. Pesanan", width: 22 },
  { header: "Tanggal Jual", width: 14, align: "center" },
  { header: "Pelanggan", width: 20 },
  { header: "Nomor Meja", width: 12, align: "center" },
  { header: "Penjualan Oleh", width: 16 },
  { header: "Item", width: 28 },
  { header: "Qty", width: 8, align: "center" },
  { header: "Total Pesanan", width: 15, money: true },
  { header: "Modal Produk", width: 15, money: true },
  { header: "Laba", width: 15, money: true },
  { header: "Diskon", width: 13, money: true },
];

export type OlseraItemExportInput = {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  rows: Pick<
    OlseraOrderItemDocument,
    "orderNo" | "orderDate" | "customerName" | "tableNo" | "salesByName" | "itemName" | "qty" | "amount" | "costAmount" | "discount"
  >[];
};

export async function buildOlseraItemWorkbook(input: OlseraItemExportInput): Promise<Uint8Array> {
  const { start, end, rows } = input;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Olsera Integration";
  wb.created = new Date();

  const ws = wb.addWorksheet("Detail Transaksi");
  const lastCol = COLUMNS.length;
  const lastColLetter = colLetter(lastCol);

  ws.mergeCells(`A1:${lastColLetter}1`);
  const titleCell = ws.getCell("A1");
  titleCell.value = "DETAIL TRANSAKSI";
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };

  ws.mergeCells(`A2:${lastColLetter}2`);
  const subtitleCell = ws.getCell("A2");
  subtitleCell.value = periodLabel(start, end);
  subtitleCell.font = { italic: true, size: 10 };
  subtitleCell.alignment = { vertical: "middle", horizontal: "left" };

  const headerRow = 4;
  COLUMNS.forEach((col, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = col.header;
    ws.getColumn(i + 1).width = col.width;
    cell.font = { bold: true, size: 10 };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.fill = solidFill(HEADER_FILL);
    cell.border = thinBorder();
  });
  ws.getRow(headerRow).height = 22;

  const firstDataRow = headerRow + 1;
  rows.forEach((row, idx) => {
    const rowIdx = firstDataRow + idx;
    const laba = row.amount - row.costAmount;
    const values: (string | number)[] = [
      row.orderNo,
      row.orderDate,
      row.customerName ?? "",
      row.tableNo ?? "",
      row.salesByName ?? "",
      row.itemName,
      row.qty,
      row.amount,
      row.costAmount,
      laba,
      row.discount,
    ];

    values.forEach((value, colIdx) => {
      const col = COLUMNS[colIdx];
      const cell = ws.getCell(rowIdx, colIdx + 1);
      cell.value = value;
      cell.border = thinBorder();
      cell.font = { size: 10 };
      if (col.money) cell.numFmt = MONEY_FMT;
      if (col.align) cell.alignment = { horizontal: col.align };
    });
  });

  // Baris TOTAL (bawah) untuk kolom uang.
  const lastDataRow = firstDataRow + rows.length - 1;
  const totalRow = firstDataRow + rows.length;
  const trow = ws.getRow(totalRow);

  ws.mergeCells(`A${totalRow}:F${totalRow}`);
  const totalLabelCell = ws.getCell(`A${totalRow}`);
  totalLabelCell.value = "TOTAL";
  totalLabelCell.font = { bold: true };
  totalLabelCell.alignment = { horizontal: "right" };

  const moneyColIndexes = COLUMNS.map((col, i) => (col.money ? i + 1 : null)).filter((i): i is number => i !== null);
  for (const col of moneyColIndexes) {
    const letter = colLetter(col);
    const cell = trow.getCell(col);
    cell.value = rows.length ? { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})` } : 0;
    cell.numFmt = MONEY_FMT;
    cell.font = { bold: true };
  }
  // Qty juga dijumlah.
  const qtyCol = 7;
  const qtyLetter = colLetter(qtyCol);
  const qtyCell = trow.getCell(qtyCol);
  qtyCell.value = rows.length ? { formula: `SUM(${qtyLetter}${firstDataRow}:${qtyLetter}${lastDataRow})` } : 0;
  qtyCell.font = { bold: true };
  qtyCell.alignment = { horizontal: "center" };

  for (let col = 1; col <= lastCol; col++) {
    const cell = trow.getCell(col);
    cell.fill = solidFill(YELLOW);
    cell.border = thinBorder();
  }

  ws.views = [{ state: "frozen", xSplit: 0, ySplit: headerRow }];

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(arrayBuffer as ArrayBuffer);
}
