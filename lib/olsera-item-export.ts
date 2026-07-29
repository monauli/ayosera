import ExcelJS from "exceljs";
import type { OlseraOrderItemDocument } from "./mongodb.ts";
import { escapeExcelFormulaPrefix, safeSheetName } from "./olsera-category-export.ts";
import { sanitizeExcelCellValue } from "./excel-sanitization.ts";

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
  return escapeExcelFormulaPrefix(text);
}

type InputRow = Pick<
  OlseraOrderItemDocument,
  | "date"
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
  | "addonPrice"
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

// Satu sheet "Rincian Penjualan" untuk satu periode. Layout identik dengan
// export satu tanggal yang sudah benar: judul biru + periode, ringkasan dua
// baris (dihitung dari rows sheet ini saja), header tabel, satu baris per
// nomor pesanan, baris total biru dengan formula SUM.
function buildDailySalesSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  input: OlseraItemExportInput,
) {
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
  // Add-on: informasi saja, TIDAK ikut dijumlahkan ke totalAmount/totalProfit
  // di atas — amount sudah menyertakannya. Total add-on dihitung terpisah.
  // addonPrice tersimpan per unit (lihat lib/mongodb.ts) — kontribusi add-on
  // satu baris = addonPrice × qty.
  const totalAddon = orders.reduce((sum, rows) => sum + rows.reduce((x, row) => x + (row.addonPrice ?? 0) * row.qty, 0), 0);

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

  // A..T (20 kolom) — K "Add-on Price" disisipkan setelah I:J Total Penjualan,
  // sebelum L Pengiriman+Pajak (dulu K); semua kolom setelahnya bergeser +1.
  ws.columns = [
    { width: 22 }, { width: 12.1, hidden: true }, { width: 15.7 }, { width: 17.4 }, { width: 0.1, hidden: true },
    { width: 16 }, { width: 12 }, { width: 9 }, { width: 14 }, { width: 10 }, { width: 14 }, { width: 9 },
    { width: 9, hidden: true }, { width: 10 }, { width: 11.2 }, { width: 9 }, { width: 0.1 }, { width: 10 },
    { width: 10 }, { width: 11 },
  ];

  ws.mergeCells("A1:T1");
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
  for (let c = 1; c <= 20; c++) {
    ws.getCell(1, c).fill = fill(BLUE);
    ws.getCell(1, c).border = thinBorder();
  }

  // Kotak ringkasan atas tidak berkaitan langsung dengan kolom data di
  // bawahnya (murni banner visual) — total lebar tetap harus mengikuti lebar
  // sheet baru (20 kolom): kotak terakhir tiap baris dilebarkan 1 kolom.
  mergeAndSet(ws, "A2:B2", `Total Penjualan\nIDR ${Math.round(totalAmount).toLocaleString("id-ID")}`);
  mergeAndSet(ws, "C2:E2", "Pengiriman Pajak\nIDR 0");
  mergeAndSet(ws, "F2:I2", `Total Modal\nIDR ${Math.round(totalCost).toLocaleString("id-ID")}`);
  mergeAndSet(ws, "J2:L2", `Total Laba\nIDR ${Math.round(totalProfit).toLocaleString("id-ID")}`);
  mergeAndSet(ws, "M2:P2", "Biaya Layanan\nIDR 0");
  mergeAndSet(ws, "Q2:T2", "Tambahan Pembayaran\nIDR 0");

  mergeAndSet(ws, "A3:B3", `Diskon\nIDR ${Math.round(totalDiscount).toLocaleString("id-ID")}`);
  mergeAndSet(ws, "C3:E3", "Total Tebus Deposit\nIDR 0");
  mergeAndSet(ws, "F3:I3", `Total Pengunjung\n${orders.length}`);
  mergeAndSet(ws, "J3:L3", "Total Pembulatan\nIDR 0");
  mergeAndSet(ws, "M3:T3", "", true);
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
    { range: "K4:K4", text: "Add-on Price" },
    { range: "L4:L4", text: "Pengiriman\n+ Pajak" },
    { range: "M4:N4", text: "Modal Produk" },
    { range: "O4:O4", text: "Laba" },
    { range: "P4:P4", text: "Biaya Layanan" },
    { range: "Q4:R4", text: "Tambahan Pembayaran" },
    { range: "S4:S4", text: "Diskon" },
    { range: "T4:T4", text: "Jumlah Ditebus" },
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
  for (let c = 1; c <= 20; c++) {
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
    // Add-on satu order = jumlah addonPrice × qty seluruh item order itu
    // (addonPrice per unit, lib/mongodb.ts). Informasi saja — TIDAK dijumlahkan
    // ke `amount`, karena amount sudah menyertakannya.
    const addon = rows.reduce((sum, item) => sum + (item.addonPrice ?? 0) * item.qty, 0);
    const date = dateValue(first.orderDate, input.start);

    ws.mergeCells(`B${rowNumber}:C${rowNumber}`);
    ws.mergeCells(`I${rowNumber}:J${rowNumber}`);
    ws.mergeCells(`M${rowNumber}:N${rowNumber}`);
    ws.mergeCells(`Q${rowNumber}:R${rowNumber}`);

    const values: Record<string, ExcelJS.CellValue> = {
      A: escapeExcelFormulaPrefix(first.orderNo),
      B: /[T ]\d{1,2}:\d{2}/.test(first.orderDate) ? dateTimeText(date) : dateOnlyText(date),
      D: safeText(first.salesByName),
      E: escapeExcelFormulaPrefix(String(first.customerId ?? "")),
      F: safeText(first.customerName),
      G: escapeExcelFormulaPrefix(String(first.tableNo ?? "").trim()),
      H: qty,
      I: amount,
      K: addon,
      L: 0,
      M: cost,
      O: { formula: `I${rowNumber}-M${rowNumber}`, result: amount - cost },
      P: 0,
      Q: 0,
      S: discount,
      T: 0,
    };

    for (const [column, value] of Object.entries(values)) {
      const cell = ws.getCell(`${column}${rowNumber}`);
      cell.value = sanitizeExcelCellValue(value);
      cell.font = { name: "Calibri", size: 10, color: { argb: BLACK } };
      cell.alignment = {
        horizontal: ["H", "I", "K", "L", "M", "O", "P", "Q", "S", "T"].includes(column) ? "right" : "left",
        vertical: "middle",
        wrapText: column === "B",
      };
    }

    for (const column of ["I", "K", "L", "M", "O", "P", "Q", "S", "T"]) ws.getCell(`${column}${rowNumber}`).numFmt = MONEY_FMT;
    ws.getCell(`H${rowNumber}`).numFmt = "0";

    for (let c = 1; c <= 20; c++) ws.getCell(rowNumber, c).border = thinBorder();
    ws.getRow(rowNumber).height = 31.5;
  });

  const totalRow = firstDataRow + orders.length;
  ws.mergeCells(`A${totalRow}:G${totalRow}`);
  ws.mergeCells(`I${totalRow}:J${totalRow}`);
  ws.mergeCells(`M${totalRow}:N${totalRow}`);
  ws.mergeCells(`Q${totalRow}:R${totalRow}`);

  ws.getCell(`A${totalRow}`).value = "Total - IDR";
  ws.getCell(`H${totalRow}`).value = { formula: `SUM(H${firstDataRow}:H${totalRow - 1})`, result: orders.reduce((sum, rows) => sum + rows.reduce((x, item) => x + item.qty, 0), 0) };
  ws.getCell(`I${totalRow}`).value = { formula: `SUM(I${firstDataRow}:I${totalRow - 1})`, result: totalAmount };
  ws.getCell(`K${totalRow}`).value = { formula: `SUM(K${firstDataRow}:K${totalRow - 1})`, result: totalAddon };
  ws.getCell(`L${totalRow}`).value = 0;
  ws.getCell(`M${totalRow}`).value = { formula: `SUM(M${firstDataRow}:M${totalRow - 1})`, result: totalCost };
  ws.getCell(`O${totalRow}`).value = { formula: `SUM(O${firstDataRow}:O${totalRow - 1})`, result: totalProfit };
  ws.getCell(`P${totalRow}`).value = 0;
  ws.getCell(`Q${totalRow}`).value = 0;
  ws.getCell(`S${totalRow}`).value = { formula: `SUM(S${firstDataRow}:S${totalRow - 1})`, result: totalDiscount };
  ws.getCell(`T${totalRow}`).value = 0;

  for (let c = 1; c <= 20; c++) {
    const cell = ws.getCell(totalRow, c);
    cell.fill = fill(BLUE);
    cell.border = thinBorder();
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: BLACK } };
    cell.alignment = { horizontal: c >= 8 ? "right" : "left", vertical: "middle" };
  }
  for (const column of ["I", "K", "L", "M", "O", "P", "Q", "S", "T"]) ws.getCell(`${column}${totalRow}`).numFmt = MONEY_FMT;
  ws.getRow(totalRow).height = 18;

  ws.views = [{ showGridLines: true, zoomScale: 80 }];
  ws.autoFilter = undefined;
  ws.pageSetup.printArea = `A1:T${totalRow}`;
  ws.headerFooter.oddFooter = "&LGenerated by AYO Olsera&CPage &P of &N&R&D &T";

  // Kolom uang tidak boleh "#######": lebarkan mengikuti nilai terpanjang
  // format '"IDR" #,##0'. Kolom merge dua kolom (I:J, M:N, Q:R) dilebarkan
  // lewat kolom keduanya agar posisi kolom lain tidak bergeser.
  const moneyColumns: Array<{ value: number; widen: number; base: number[] }> = [
    { value: 9, widen: 10, base: [9, 10] },    // I:J  Total Penjualan
    { value: 11, widen: 11, base: [11] },      // K    Add-on Price
    { value: 12, widen: 12, base: [12] },      // L    Pengiriman + Pajak
    { value: 13, widen: 14, base: [13, 14] },  // M:N  Modal Produk
    { value: 15, widen: 15, base: [15] },      // O    Laba
    { value: 16, widen: 16, base: [16] },      // P    Biaya Layanan
    { value: 17, widen: 18, base: [17, 18] },  // Q:R  Tambahan Pembayaran
    { value: 19, widen: 19, base: [19] },      // S    Diskon
    { value: 20, widen: 20, base: [20] },      // T    Jumlah Ditebus
  ];
  ws.eachRow((row) => {
    for (const { value: valueCol, widen, base } of moneyColumns) {
      const raw = row.getCell(valueCol).value;
      const num =
        typeof raw === "number"
          ? raw
          : raw && typeof raw === "object" && "result" in raw && typeof raw.result === "number"
            ? raw.result
            : null;
      if (num === null) continue;
      const digits = String(Math.round(Math.abs(num))).length;
      const needed = 4 + digits + Math.floor((digits - 1) / 3) + (num < 0 ? 1 : 0) + 2;
      const current = base.reduce((sum, c) => sum + (ws.getColumn(c).width ?? 8.43), 0);
      if (current < needed) {
        const column = ws.getColumn(widen);
        column.width = (column.width ?? 8.43) + (needed - current);
      }
    }
  });
}

/** Nama sheet harian, mis. "01 Mei" untuk 2026-05-01. */
function dailySheetName(date: string) {
  return `${date.slice(8, 10)} ${monthName(date)}`;
}

export async function buildOlseraItemWorkbook(input: OlseraItemExportInput): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AYO Olsera";
  wb.created = new Date();
  wb.modified = new Date();
  wb.calcProperties.fullCalcOnLoad = true;

  // Satu sheet per tanggal yang punya transaksi, urut tanggal paling awal →
  // akhir; tanggal tanpa transaksi tidak dibuatkan sheet. Filter satu tanggal
  // menghasilkan tepat satu sheet dengan layout & nama yang sama seperti
  // sebelumnya. Setiap sheet menghitung ringkasan/totalnya sendiri dari
  // transaksi tanggal itu saja.
  const byDate = new Map<string, InputRow[]>();
  for (const row of input.rows) {
    const list = byDate.get(row.date) ?? [];
    list.push(row);
    byDate.set(row.date, list);
  }

  const usedNames = new Set<string>();
  for (const date of [...byDate.keys()].sort()) {
    buildDailySalesSheet(wb, safeSheetName(dailySheetName(date), usedNames), {
      start: date,
      end: date,
      rows: byDate.get(date)!,
    });
  }

  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
