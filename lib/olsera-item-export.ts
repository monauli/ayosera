import ExcelJS from "exceljs";
import type { OlseraOrderItemDocument } from "./mongodb.ts";

const MONEY_FMT = '"IDR" #,##0';
const DATE_TIME_FMT = "dd-mmm-yyyy\nhh:mm:ss";
const BLUE = "FF9DC3E6";
const GRAY = "FFA6A6A6";
const DARK_GRAY = "FF8F8F8F";
const WHITE = "FFFFFFFF";
const BLACK = "FF000000";

function fill(argb: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const, color: { argb: BLACK } };
  return { top: side, left: side, bottom: side, right: side };
}

function monthName(date: string) {
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  return months[Math.max(0, Number(date.slice(5, 7)) - 1)] ?? "";
}

function prettyDate(date: string) {
  const [year, month, day] = date.split("-");
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${day} ${monthNames[Number(month) - 1] ?? month} ${year}`;
}

function dateValue(raw: string, fallback: string): Date {
  const text = raw.trim();
  const match = text.match(/(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):?(\d{2})?(?::?(\d{2}))?)?/);
  const fallbackMatch = fallback.match(/(\d{4})-(\d{2})-(\d{2})/);
  const parts = match ?? fallbackMatch;
  if (!parts) return new Date(0);
  return new Date(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    Number(parts[4] ?? 0),
    Number(parts[5] ?? 0),
    Number(parts[6] ?? 0),
  );
}


function dateTimeText(date: Date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}-${months[date.getMonth()]}-${date.getFullYear()}\n${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function dateOnlyText(date: Date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(date.getDate()).padStart(2, "0")}-${months[date.getMonth()]}-${date.getFullYear()}`;
}

function exportDateText() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date()).replace(/ /g, "-");
}

function safeText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text || /^\d+$/.test(text) || text === "[object Object]") return "";
  return text;
}

type InputRow = Pick<
  OlseraOrderItemDocument,
  | "orderNo"
  | "orderDate"
  | "customerId"
  | "customerName"
  | "tableNo"
  | "salesByName"
  | "itemName"
  | "qty"
  | "amount"
  | "costAmount"
  | "discount"
>;

export type OlseraItemExportInput = { start: string; end: string; rows: InputRow[] };

function styleSummary(cell: ExcelJS.Cell) {
  cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: BLACK } };
  cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  cell.border = thinBorder();
  cell.fill = fill(WHITE);
}

function mergeAndSet(ws: ExcelJS.Worksheet, range: string, value: ExcelJS.CellValue, gray = false) {
  ws.mergeCells(range);
  const cell = ws.getCell(range.split(":")[0]);
  cell.value = value;
  styleSummary(cell);
  if (gray) cell.fill = fill(GRAY);
}

export async function buildOlseraItemWorkbook(input: OlseraItemExportInput): Promise<Uint8Array> {
  const grouped = new Map<string, InputRow[]>();
  for (const row of input.rows) {
    const key = row.orderNo || `UNKNOWN-${grouped.size + 1}`;
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }

  const orders = [...grouped.values()].sort((a, b) => {
    const dateDiff = dateValue(a[0].orderDate, input.start).getTime() - dateValue(b[0].orderDate, input.start).getTime();
    return dateDiff || a[0].orderNo.localeCompare(b[0].orderNo);
  });

  const totalAmount = orders.reduce((sum, rows) => sum + rows.reduce((x, row) => x + row.amount, 0), 0);
  const totalCost = orders.reduce((sum, rows) => sum + rows.reduce((x, row) => x + row.costAmount, 0), 0);
  const totalDiscount = orders.reduce((sum, rows) => sum + rows.reduce((x, row) => x + row.discount, 0), 0);
  const totalProfit = totalAmount - totalCost;

  const wb = new ExcelJS.Workbook();
  wb.creator = "AYO Olsera";
  wb.created = new Date();
  wb.modified = new Date();
  wb.calcProperties.fullCalcOnLoad = true;

  const sheetName = input.start === input.end ? `${input.start.slice(8, 10)} ${monthName(input.start)}` : "Detail Transaksi";
  const ws = wb.addWorksheet(sheetName, {
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
      margins: { left: 0.2, right: 0.2, top: 0.3, bottom: 0.3, header: 0.1, footer: 0.1 },
    },
    properties: { defaultRowHeight: 15.75 },
  });

  ws.columns = [
    { width: 22 }, { width: 12.1, hidden: true }, { width: 15.7 }, { width: 17.4 }, { width: 0.1, hidden: true },
    { width: 16 }, { width: 12 }, { width: 9 }, { width: 14 }, { width: 10 }, { width: 9 }, { width: 9, hidden: true },
    { width: 10 }, { width: 11.2 }, { width: 9 }, { width: 0.1 }, { width: 10 }, { width: 10 }, { width: 11 },
  ];

  ws.mergeCells("A1:S1");
  const title = ws.getCell("A1");
  const period = `Periode ${prettyDate(input.start)} - ${prettyDate(input.end)}`;
  title.value = {
    richText: [
      { text: "Rincian Penjualan", font: { name: "Calibri", size: 11, bold: false, color: { argb: BLACK } } },
      { text: "                                                        BC PADEL CLUB", font: { name: "Calibri", size: 15, bold: true, color: { argb: BLACK } } },
      { text: `\n${period}\nDibuat pada ${exportDateText()}`, font: { name: "Calibri", size: 11, bold: false, color: { argb: BLACK } } },
    ],
  };
  title.fill = fill(BLUE);
  title.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  title.border = thinBorder();
  title.font = { name: "Calibri" };
  ws.getRow(1).height = 52.5;
  for (let c = 1; c <= 19; c++) {
    ws.getCell(1, c).fill = fill(BLUE);
    ws.getCell(1, c).border = thinBorder();
  }

  mergeAndSet(ws, "A2:B2", `Total Penjualan\nIDR ${Math.round(totalAmount).toLocaleString("id-ID")}`);
  mergeAndSet(ws, "C2:E2", "Pengiriman Pajak\nIDR 0");
  mergeAndSet(ws, "F2:I2", `Total Modal\nIDR ${Math.round(totalCost).toLocaleString("id-ID")}`);
  mergeAndSet(ws, "J2:L2", `Total Laba\nIDR ${Math.round(totalProfit).toLocaleString("id-ID")}`);
  mergeAndSet(ws, "M2:P2", "Biaya Layanan\nIDR 0");
  mergeAndSet(ws, "Q2:S2", "Tambahan Pembayaran\nIDR 0");

  mergeAndSet(ws, "A3:B3", `Diskon\nIDR ${Math.round(totalDiscount).toLocaleString("id-ID")}`);
  mergeAndSet(ws, "C3:E3", "Total Tebus Deposit\nIDR 0");
  mergeAndSet(ws, "F3:I3", `Total Pengunjung\n${orders.length}`);
  mergeAndSet(ws, "J3:L3", "Total Pembulatan\nIDR 0");
  mergeAndSet(ws, "M3:S3", "", true);
  ws.getRow(2).height = 28.5;
  ws.getRow(3).height = 31.5;

  const headers: Array<{ range: string; text: string }> = [
    { range: "A4:A4", text: "No. Pesanan" },
    { range: "B4:C4", text: "Tanggal Jual" },
    { range: "D4:D4", text: "Penjualan Oleh" },
    { range: "E4:E4", text: "Pelanggan ID" },
    { range: "F4:F4", text: "Pelanggan" },
    { range: "G4:G4", text: "Nomor Meja" },
    { range: "H4:H4", text: "Qty" },
    { range: "I4:J4", text: "Total Penjualan" },
    { range: "K4:K4", text: "Pengiriman\n+ Pajak" },
    { range: "L4:M4", text: "Modal Produk" },
    { range: "N4:N4", text: "Laba" },
    { range: "O4:O4", text: "Biaya Layanan" },
    { range: "P4:Q4", text: "Tambahan Pembayaran" },
    { range: "R4:R4", text: "Diskon" },
    { range: "S4:S4", text: "Jumlah Ditebus" },
  ];
  for (const header of headers) {
    if (header.range.includes(":")) ws.mergeCells(header.range);
    const cell = ws.getCell(header.range.split(":")[0]);
    cell.value = header.text;
    cell.fill = fill(DARK_GRAY);
    cell.font = { name: "Calibri", size: 10, bold: false, color: { argb: BLACK } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = thinBorder();
  }
  for (let c = 1; c <= 19; c++) {
    ws.getCell(4, c).fill = fill(DARK_GRAY);
    ws.getCell(4, c).border = thinBorder();
  }
  ws.getRow(4).height = 25.5;

  const firstDataRow = 5;
  orders.forEach((rows, index) => {
    const rowNumber = firstDataRow + index;
    const first = rows[0];
    const amount = rows.reduce((sum, item) => sum + item.amount, 0);
    const cost = rows.reduce((sum, item) => sum + item.costAmount, 0);
    const discount = rows.reduce((sum, item) => sum + item.discount, 0);
    const qty = rows.reduce((sum, item) => sum + item.qty, 0);
    const date = dateValue(first.orderDate, input.start);

    ws.mergeCells(`B${rowNumber}:C${rowNumber}`);
    ws.mergeCells(`I${rowNumber}:J${rowNumber}`);
    ws.mergeCells(`L${rowNumber}:M${rowNumber}`);
    ws.mergeCells(`P${rowNumber}:Q${rowNumber}`);

    const values: Record<string, ExcelJS.CellValue> = {
      A: first.orderNo,
      B: /[T ]\d{1,2}:\d{2}/.test(first.orderDate) ? dateTimeText(date) : dateOnlyText(date),
      D: safeText(first.salesByName),
      E: first.customerId ?? "",
      F: safeText(first.customerName),
      G: String(first.tableNo ?? "").trim(),
      H: qty,
      I: amount,
      K: 0,
      L: cost,
      N: { formula: `I${rowNumber}-L${rowNumber}`, result: amount - cost },
      O: 0,
      P: 0,
      R: discount,
      S: 0,
    };

    for (const [column, value] of Object.entries(values)) {
      const cell = ws.getCell(`${column}${rowNumber}`);
      cell.value = value;
      cell.font = { name: "Calibri", size: 10, color: { argb: BLACK } };
      cell.alignment = {
        horizontal: ["H", "I", "K", "L", "N", "O", "P", "R", "S"].includes(column) ? "right" : "left",
        vertical: "middle",
        wrapText: column === "B",
      };
    }

    for (const column of ["I", "K", "L", "N", "O", "P", "R", "S"]) ws.getCell(`${column}${rowNumber}`).numFmt = MONEY_FMT;
    ws.getCell(`H${rowNumber}`).numFmt = "0";

    for (let c = 1; c <= 19; c++) ws.getCell(rowNumber, c).border = thinBorder();
    ws.getRow(rowNumber).height = 31.5;
  });

  const totalRow = firstDataRow + orders.length;
  ws.mergeCells(`A${totalRow}:G${totalRow}`);
  ws.mergeCells(`I${totalRow}:J${totalRow}`);
  ws.mergeCells(`L${totalRow}:M${totalRow}`);
  ws.mergeCells(`P${totalRow}:Q${totalRow}`);

  ws.getCell(`A${totalRow}`).value = "Total - IDR";
  ws.getCell(`H${totalRow}`).value = { formula: `SUM(H${firstDataRow}:H${totalRow - 1})`, result: orders.reduce((sum, rows) => sum + rows.reduce((x, item) => x + item.qty, 0), 0) };
  ws.getCell(`I${totalRow}`).value = { formula: `SUM(I${firstDataRow}:I${totalRow - 1})`, result: totalAmount };
  ws.getCell(`K${totalRow}`).value = 0;
  ws.getCell(`L${totalRow}`).value = { formula: `SUM(L${firstDataRow}:L${totalRow - 1})`, result: totalCost };
  ws.getCell(`N${totalRow}`).value = { formula: `SUM(N${firstDataRow}:N${totalRow - 1})`, result: totalProfit };
  ws.getCell(`O${totalRow}`).value = 0;
  ws.getCell(`P${totalRow}`).value = 0;
  ws.getCell(`R${totalRow}`).value = { formula: `SUM(R${firstDataRow}:R${totalRow - 1})`, result: totalDiscount };
  ws.getCell(`S${totalRow}`).value = 0;

  for (let c = 1; c <= 19; c++) {
    const cell = ws.getCell(totalRow, c);
    cell.fill = fill(BLUE);
    cell.border = thinBorder();
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: BLACK } };
    cell.alignment = { horizontal: c >= 8 ? "right" : "left", vertical: "middle" };
  }
  for (const column of ["I", "K", "L", "N", "O", "P", "R", "S"]) ws.getCell(`${column}${totalRow}`).numFmt = MONEY_FMT;
  ws.getRow(totalRow).height = 18;

  ws.views = [{ showGridLines: true, zoomScale: 80 }];
  ws.autoFilter = undefined;
  ws.pageSetup.printArea = `A1:S${totalRow}`;
  ws.headerFooter.oddFooter = "&LGenerated by AYO Olsera&CPage &P of &N&R&D &T";

  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
