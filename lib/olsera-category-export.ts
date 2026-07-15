// Export "Kategori Penjualan": satu workbook, satu sheet per kategori yang
// punya transaksi pada periode. Layout mengikuti file referensi
// "MINUMAN OLSERA.xlsx" (16 kolom A–P: No. Pesanan .. Laba, header abu-abu,
// baris total biru dengan formula SUM).
import ExcelJS from "exceljs";
import type { OlseraOrderItemDocument } from "./mongodb.ts";
import { getAccessToken } from "./olsera.ts";

const MONEY_FMT = '"IDR" #,##0';
const HEADER_GRAY = "FFA6A6A6";
const TOTAL_BLUE = "FF9DC3E6";
const BLACK = "FF000000";
const FONT = "Aptos Narrow";

const BASE_URL = "https://api-open.olsera.co.id";
const API_PREFIX = "/api/open-api/v1/id";
const UNKNOWN_CATEGORY = "Tidak Diketahui";
const NAME_MAP_TTL_MS = 10 * 60 * 1000;

function fill(argb: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const, color: { argb: BLACK } };
  return { top: side, left: side, bottom: side, right: side };
}

// Normalisasi nama/klasifikasi — identik dengan lib/olsera-sync.ts.
function normalizeKlasifikasi(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/\s*\+\s*/g, "+");
}

// ---------------------------------------------------------------------------
// Mapping kategori: olsera_order_items tidak menyimpan klasifikasi/product_id,
// jadi kategori di-resolve dari katalog produk Olsera (nama produk →
// klasifikasi). Divalidasi 1:1 terhadap agregat olsera_sales_by_category
// (scripts/test-export-categories.ts).
// ---------------------------------------------------------------------------

let nameMapCache: { map: Map<string, string>; fetchedAt: number } | null = null;

async function fetchCategoryByNameMap(token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let page = 1;
  for (;;) {
    const url = new URL(`${BASE_URL}${API_PREFIX}/product`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} saat menarik katalog produk Olsera.`);
    const body = (await response.json()) as { data?: Record<string, unknown>[]; meta?: { last_page?: number } };
    for (const product of body.data ?? []) {
      const name = normalizeKlasifikasi(String(product.name ?? "")).toUpperCase();
      if (!name) continue;
      map.set(
        name,
        normalizeKlasifikasi(
          typeof product.klasifikasi === "string" && product.klasifikasi ? product.klasifikasi : "(tanpa klasifikasi)",
        ),
      );
    }
    if (!body.meta?.last_page || page >= body.meta.last_page) break;
    page++;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return map;
}

/** Peta nama produk (UPPERCASE, ternormalisasi) → klasifikasi, cache in-memory 10 menit. */
export async function getCategoryByNameMap(): Promise<Map<string, string>> {
  if (nameMapCache && Date.now() - nameMapCache.fetchedAt < NAME_MAP_TTL_MS) return nameMapCache.map;
  const auth = await getAccessToken();
  if ("error" in auth) throw new Error(auth.error);
  const map = await fetchCategoryByNameMap(auth.token);
  nameMapCache = { map, fetchedAt: Date.now() };
  return map;
}

/** Kategori satu baris item: cocokkan nama lengkap, lalu nama tanpa suffix varian (" - ..."). */
export function categoryForItem(itemName: string, nameMap: Map<string, string>): string {
  const full = normalizeKlasifikasi(itemName).toUpperCase();
  const base = normalizeKlasifikasi(itemName.split(" - ")[0]).toUpperCase();
  return nameMap.get(full) ?? nameMap.get(base) ?? UNKNOWN_CATEGORY;
}

// ---------------------------------------------------------------------------
// Workbook builder
// ---------------------------------------------------------------------------

type InputRow = Pick<
  OlseraOrderItemDocument,
  | "date"
  | "orderNo"
  | "orderDate"
  | "customerName"
  | "tableNo"
  | "salesByName"
  | "itemName"
  | "qty"
  | "amount"
  | "costAmount"
  | "discount"
  | "addonPrice"
> & { category: string };

export type OlseraCategoryExportInput = { start: string; end: string; rows: InputRow[] };

// Sanitasi kolom teks (Pelanggan, Nomor Meja, dst): hanya teks bermakna yang
// lolos. ID numerik murni (mis. "19"), null/undefined, "[object Object]",
// dan object mentah dari DB tidak boleh menjadi isi cell — kembalikan kosong.
function safeText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["name", "full_name", "display_name", "no", "number"]) {
      const nested = record[key];
      if (typeof nested === "string" || typeof nested === "number") return safeText(nested);
    }
    return "";
  }
  const text = String(value).trim();
  if (!text || /^\d+([.,]\d+)?$/.test(text) || ["[object Object]", "undefined", "null", "-"].includes(text)) return "";
  return text;
}

function dateValue(raw: string, fallback: string): Date {
  const match = raw.trim().match(/(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):?(\d{2})?(?::?(\d{2}))?)?/);
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

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dateTimeText(date: Date, withClock: boolean) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${pad(date.getDate())}-${EN_MONTHS[date.getMonth()]}-${date.getFullYear()}`;
  if (!withClock) return day;
  return `${day}\n${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function prettyDate(date: string) {
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const [year, month, day] = date.split("-");
  return `${monthNames[Number(month) - 1] ?? month} ${day}, ${year}`;
}

/** Nama sheet aman Excel: buang karakter terlarang, maks 31 char, anti-duplikat. */
export function safeSheetName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "");
  if (!base) base = "Sheet";
  base = base.slice(0, 31).trim();
  let name = base;
  for (let n = 2; used.has(name.toUpperCase()); n++) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
  }
  used.add(name.toUpperCase());
  return name;
}

// Lebar minimum tiap kolom (A–P). Kolom uang bisa melebar lagi mengikuti
// nilai terpanjang (lihat applyColumnWidths) agar tidak muncul "#######".
// A..Q (17 kolom) — "Add-on Price" disisipkan setelah J Total Pesanan,
// sebelum K Komisi (dulu); semua kolom setelahnya bergeser +1.
const MIN_COLUMN_WIDTHS = [23, 20, 16, 12, 20, 14, 28, 8, 16, 17, 14, 14, 17, 17, 16, 14, 17];
const HEADERS = [
  "No. Pesanan",
  "Tanggal Jual",
  "Pelanggan",
  "Nomor Meja",
  "Penjualan Oleh",
  "No. Seri",
  "Item",
  "Qty",
  "Unit Pengukuran",
  "Total Pesanan",
  "Add-on Price",
  "Komisi",
  "Modal Produk",
  "Sudah termasuk\nPajak",
  "Nama Diskon",
  "Diskon",
  "Laba",
];
// Kolom uang (1-based): J Total Pesanan, K Add-on Price, L Komisi, M Modal
// Produk, N Sudah termasuk Pajak, P Diskon, Q Laba (O "Nama Diskon" teks).
const MONEY_COLUMNS = [10, 11, 12, 13, 14, 16, 17];

// Panjang tampilan format '"IDR" #,##0' untuk sebuah angka, mis. 3150000 →
// "IDR 3.150.000" = 13 karakter.
function moneyDisplayLength(value: number): number {
  const digits = String(Math.round(Math.abs(value))).length;
  const separators = Math.floor((digits - 1) / 3);
  return 4 + digits + separators + (value < 0 ? 1 : 0);
}

// Dipanggil setelah seluruh blok selesai ditulis: terapkan lebar minimum, lalu
// untuk kolom uang lebarkan mengikuti nilai terpanjang (+2 padding).
function applyColumnWidths(ws: ExcelJS.Worksheet) {
  const widths = [...MIN_COLUMN_WIDTHS];
  ws.eachRow((row) => {
    for (const column of MONEY_COLUMNS) {
      const value = row.getCell(column).value;
      const num =
        typeof value === "number"
          ? value
          : value && typeof value === "object" && "result" in value && typeof value.result === "number"
            ? value.result
            : null;
      if (num === null) continue;
      widths[column - 1] = Math.max(widths[column - 1], moneyDisplayLength(num) + 2);
    }
  });
  widths.forEach((width, index) => {
    ws.getColumn(index + 1).width = width;
  });
}

// Satu blok tanggal (mengikuti LABERS.xlsx): judul "Item Penjualan : <tgl> - <tgl>",
// header 16 kolom, baris item tanggal itu, satu baris total biru. Mengembalikan
// nomor baris setelah baris total.
function writeDateBlock(
  ws: ExcelJS.Worksheet,
  startRowNumber: number,
  blockDate: string,
  rows: InputRow[],
): number {
  // Judul blok — merge penuh, polos (tanpa fill), seperti referensi.
  const titleRowNumber = startRowNumber;
  ws.mergeCells(`A${titleRowNumber}:Q${titleRowNumber}`);
  const title = ws.getCell(`A${titleRowNumber}`);
  title.value = `Item Penjualan : ${prettyDate(blockDate)} - ${prettyDate(blockDate)}`;
  title.font = { name: FONT, size: 10, color: { argb: BLACK } };
  title.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  ws.getRow(titleRowNumber).height = 15.75;

  // Header tabel — abu-abu, center, wrap, border (tinggi 39.4 seperti referensi).
  const headerRowNumber = titleRowNumber + 1;
  HEADERS.forEach((text, index) => {
    const cell = ws.getCell(headerRowNumber, index + 1);
    cell.value = text;
    cell.fill = fill(HEADER_GRAY);
    cell.font = { name: FONT, size: 10, color: { argb: BLACK } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = thinBorder();
  });
  ws.getRow(headerRowNumber).height = 39.4;

  const firstDataRow = headerRowNumber + 1;
  rows.forEach((row, index) => {
    const rowNumber = firstDataRow + index;
    const date = dateValue(row.orderDate, blockDate);
    const withClock = /[T ]\d{1,2}:\d{2}/.test(row.orderDate);
    const profit = row.amount - row.costAmount;

    const values: ExcelJS.CellValue[] = [
      row.orderNo,
      dateTimeText(date, withClock),
      safeText(row.customerName),
      safeText(row.tableNo),
      safeText(row.salesByName),
      "", // No. Seri — tidak tersedia di data Olsera
      row.itemName,
      row.qty,
      "", // Unit Pengukuran — tidak tersedia
      row.amount,
      // Add-on: informasi saja — row.amount SUDAH menyertakannya, jangan
      // dijumlahkan lagi (lihat komentar rumus di lib/olsera-sync.ts).
      // addonPrice per unit (lib/mongodb.ts) — total add-on baris = × qty.
      (row.addonPrice ?? 0) * row.qty,
      0, // Komisi
      row.costAmount,
      0, // Sudah termasuk Pajak
      "", // Nama Diskon — tidak tersedia
      row.discount,
      { formula: `J${rowNumber}-M${rowNumber}`, result: profit },
    ];
    values.forEach((value, columnIndex) => {
      const column = columnIndex + 1;
      const cell = ws.getCell(rowNumber, column);
      cell.value = value;
      cell.font = { name: FONT, size: 10, color: { argb: BLACK } };
      cell.border = thinBorder();
      if (column === 8) {
        cell.numFmt = "0";
        cell.alignment = { horizontal: "center", vertical: "middle", shrinkToFit: true };
      } else if (MONEY_COLUMNS.includes(column)) {
        cell.numFmt = MONEY_FMT;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      } else {
        cell.alignment = { horizontal: "left", vertical: "top", wrapText: column === 2 };
      }
    });
  });

  // Baris total harian — biru, "Total - IDR" merge A:G, SUM otomatis.
  const totalRow = firstDataRow + rows.length;
  const lastDataRow = totalRow - 1;
  ws.mergeCells(`A${totalRow}:G${totalRow}`);
  ws.getCell(`A${totalRow}`).value = "Total - IDR";
  const sum = (col: string) => ({ formula: `SUM(${col}${firstDataRow}:${col}${lastDataRow})` });
  ws.getCell(`H${totalRow}`).value = { ...sum("H"), result: rows.reduce((x, r) => x + r.qty, 0) };
  ws.getCell(`J${totalRow}`).value = { ...sum("J"), result: rows.reduce((x, r) => x + r.amount, 0) };
  // Add-on: total sesungguhnya (informasi saja) — tidak ikut dijumlahkan ke J.
  // addonPrice per unit (lib/mongodb.ts) — kontribusi tiap baris = × qty.
  ws.getCell(`K${totalRow}`).value = { ...sum("K"), result: rows.reduce((x, r) => x + (r.addonPrice ?? 0) * r.qty, 0) };
  ws.getCell(`L${totalRow}`).value = { ...sum("L"), result: 0 };
  ws.getCell(`M${totalRow}`).value = { ...sum("M"), result: rows.reduce((x, r) => x + r.costAmount, 0) };
  ws.getCell(`N${totalRow}`).value = { ...sum("N"), result: 0 };
  ws.getCell(`P${totalRow}`).value = { ...sum("P"), result: rows.reduce((x, r) => x + r.discount, 0) };
  ws.getCell(`Q${totalRow}`).value = { ...sum("Q"), result: rows.reduce((x, r) => x + (r.amount - r.costAmount), 0) };
  for (let column = 1; column <= 17; column++) {
    const cell = ws.getCell(totalRow, column);
    cell.fill = fill(TOTAL_BLUE);
    cell.border = thinBorder();
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: BLACK } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    if (MONEY_COLUMNS.includes(column)) cell.numFmt = MONEY_FMT;
    if (column === 8) cell.numFmt = "0";
  }
  ws.getRow(totalRow).height = 18;

  return totalRow + 1;
}

function addCategorySheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  rows: InputRow[],
) {
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
  ws.columns = MIN_COLUMN_WIDTHS.map((width) => ({ width }));

  // Satu blok per tanggal transaksi, urut tanggal paling awal → akhir; tanggal
  // tanpa transaksi kategori ini tidak dibuatkan blok. Antarblok 3 baris kosong.
  const byDate = new Map<string, InputRow[]>();
  for (const row of rows) {
    const list = byDate.get(row.date) ?? [];
    list.push(row);
    byDate.set(row.date, list);
  }
  const dates = [...byDate.keys()].sort();

  let cursor = 1;
  dates.forEach((blockDate, index) => {
    if (index > 0) cursor += 3; // tiga baris kosong pemisah blok
    cursor = writeDateBlock(ws, cursor, blockDate, byDate.get(blockDate)!);
  });

  applyColumnWidths(ws);

  ws.views = [{ showGridLines: true, zoomScale: 90 }];
  ws.pageSetup.printArea = `A1:Q${cursor - 1}`;
}

export async function buildOlseraCategoryWorkbook(input: OlseraCategoryExportInput): Promise<Uint8Array> {
  // Kelompokkan per kategori; sheet diurutkan berdasarkan total penjualan
  // terbesar (konsisten dengan urutan tabel dashboard).
  const byCategory = new Map<string, InputRow[]>();
  for (const row of input.rows) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }
  const categories = [...byCategory.entries()]
    .filter(([, rows]) => rows.length > 0)
    .sort((a, b) => {
      const amountDiff =
        b[1].reduce((x, r) => x + r.amount, 0) - a[1].reduce((x, r) => x + r.amount, 0);
      return amountDiff || a[0].localeCompare(b[0], "id");
    });

  const wb = new ExcelJS.Workbook();
  wb.creator = "AYO Olsera";
  wb.created = new Date();
  wb.modified = new Date();
  wb.calcProperties.fullCalcOnLoad = true;

  const usedNames = new Set<string>();
  for (const [category, rows] of categories) {
    rows.sort((a, b) => {
      const dateDiff = dateValue(a.orderDate, input.start).getTime() - dateValue(b.orderDate, input.start).getTime();
      return dateDiff || a.orderNo.localeCompare(b.orderNo);
    });
    addCategorySheet(wb, safeSheetName(category, usedNames), rows);
  }

  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
