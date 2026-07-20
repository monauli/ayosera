// Export Inventori Bulanan ("Laporan Stock Opname") — mengikuti format visual
// & formula laporan perusahaan (doc export/INVENTORI.xlsx), memakai data
// Pergerakan Stok dari file summary resmi Olsera yang diunggah manual (API
// Olsera tidak menyediakan endpoint ini — lihat komentar
// lib/olsera-inventory-monthly-core.ts) + penjualan harian dari data Olsera
// yang sudah tersinkron di MongoDB (olsera_inventory_movements existing).
//
// TIDAK menulis apa pun ke MongoDB — murni baca + generate workbook langsung
// ke response (sesuai instruksi: jangan simpan hasil import ke DB).
import ExcelJS from "exceljs";
import { collections, withMongo } from "./mongodb.ts";
import {
  aggregateDailySales,
  buildMovementNameIndex,
  buildSkuIndex,
  computeDisplayedBarangMasuk,
  computeDisplayedKeluar,
  computeStockAkhirSistem,
  detectDuplicateSummaryRows,
  findRowsOutsidePeriod,
  matchSummaryRowToProduct,
  monthDateRange,
  parseSummaryRows,
  validateSummaryHeader,
  type DuplicateGroup,
  type InventoryProductInput,
  type MonthlyMatchMethod,
  type SummaryRow,
} from "./olsera-inventory-monthly-core.ts";

const MONEY_FMT = '"IDR" #,##0';
const INT_FMT = "#,##0";
const HEADER_GRAY = "FFA6A6A6";
const TOTAL_BLUE = "FF9DC3E6";
const AKTUAL_YELLOW = "FFFFF2CC";
const BLACK = "FF000000";
const FONT = "Aptos Narrow";

const MONTH_NAMES = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

function fill(argb: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const, color: { argb: BLACK } };
  return { top: side, left: side, bottom: side, right: side };
}

// ---------------------------------------------------------------------------
// Parsing file upload (ExcelJS → array-of-array murni, lalu didelegasikan ke
// parseSummaryRows/validateSummaryHeader di lib/olsera-inventory-monthly-core.ts).
// ---------------------------------------------------------------------------

export type SummaryWorkbookParseResult =
  | { ok: true; rows: SummaryRow[]; skippedBlankRows: number }
  | { ok: false; errors: string[] };

export async function parseSummaryWorkbookBuffer(buffer: ArrayBuffer | Buffer): Promise<SummaryWorkbookParseResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as ExcelJS.Buffer);
  } catch {
    return { ok: false, errors: ["File yang diunggah bukan file .xlsx yang valid."] };
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return { ok: false, errors: ["File .xlsx tidak berisi sheet apa pun."] };

  const allRows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[];
    // ExcelJS row.values 1-indexed (index 0 kosong) — geser ke 0-indexed.
    allRows.push(values.slice(1));
  });
  if (!allRows.length) return { ok: false, errors: ["Sheet pertama kosong."] };

  const headerErrors = validateSummaryHeader(allRows[0]);
  if (headerErrors.length) return { ok: false, errors: headerErrors };

  const { rows, skippedBlankRows } = parseSummaryRows(allRows.slice(1));
  if (!rows.length) return { ok: false, errors: ["Tidak ada baris data produk pada file."] };

  return { ok: true, rows, skippedBlankRows };
}

// ---------------------------------------------------------------------------
// Model baris siap-render + diagnostik import
// ---------------------------------------------------------------------------

export type MonthlyRowModel = {
  rowIndex: number;
  group: string;
  name: string;
  sku: string | null;
  buyPrice: number;
  sellPrice: number;
  stokAwal: number;
  barangMasuk: number;
  dailySales: number[];
  totalPenjualan: number;
  totalPenjualanOlsera: number;
  keluar: number;
  stockAkhirSistem: number;
  balanceOlsera: number;
  matchMethod: MonthlyMatchMethod;
  matchNote: string;
};

export type MonthlyImportDiagnostics = {
  headerErrors: string[];
  skippedBlankRows: number;
  duplicates: DuplicateGroup[];
  rowsOutsidePeriod: number[];
  unmatchedOrAmbiguous: { rowIndex: number; group: string; product: string; sku: string | null; method: MonthlyMatchMethod; note: string }[];
  salesMismatch: { rowIndex: number; product: string; totalPenjualanAyosera: number; totalPenjualanOlsera: number; diff: number }[];
  balanceMismatch: { rowIndex: number; product: string; stockAkhirSistem: number; balanceOlsera: number; diff: number }[];
};

const AMBIGUOUS_OR_UNMATCHED: MonthlyMatchMethod[] = ["ambiguous-sku", "ambiguous-name", "unmatched"];

/**
 * Susun model baris + diagnostik dari data yang SUDAH diambil (summary rows
 * tervalidasi, katalog produk, dan agregat penjualan harian). Fungsi ini
 * murni (tidak menyentuh Mongo/ExcelJS I/O) — testable dengan fixture.
 */
export function buildMonthlyRows(input: {
  summaryRows: SummaryRow[];
  catalogProducts: InventoryProductInput[];
  dailySalesByProductKey: Map<string, { daily: number[]; total: number }>;
  days: number;
}): {
  rows: MonthlyRowModel[];
  diagnostics: Pick<MonthlyImportDiagnostics, "unmatchedOrAmbiguous" | "salesMismatch" | "balanceMismatch">;
} {
  const skuIndex = buildSkuIndex(input.catalogProducts);
  const nameIndex = buildMovementNameIndex(input.catalogProducts);

  const rows: MonthlyRowModel[] = [];
  const unmatchedOrAmbiguous: MonthlyImportDiagnostics["unmatchedOrAmbiguous"] = [];
  const salesMismatch: MonthlyImportDiagnostics["salesMismatch"] = [];
  const balanceMismatch: MonthlyImportDiagnostics["balanceMismatch"] = [];

  for (const summaryRow of input.summaryRows) {
    const match = matchSummaryRowToProduct(summaryRow, skuIndex, nameIndex);
    if (AMBIGUOUS_OR_UNMATCHED.includes(match.method)) {
      unmatchedOrAmbiguous.push({
        rowIndex: summaryRow.rowIndex,
        group: summaryRow.group,
        product: summaryRow.product,
        sku: summaryRow.sku,
        method: match.method,
        note: match.note,
      });
    }

    const key = match.product ? match.product._id : null;
    const agg = key ? input.dailySalesByProductKey.get(key) : undefined;
    const dailySales = agg?.daily ?? new Array(input.days).fill(0);
    const totalPenjualan = agg?.total ?? 0;

    const barangMasuk = computeDisplayedBarangMasuk(summaryRow);
    const keluar = computeDisplayedKeluar(summaryRow);
    const stockAkhirSistem = computeStockAkhirSistem({
      stokAwal: summaryRow.begining,
      barangMasuk,
      totalPenjualan,
      keluar,
    });

    if (totalPenjualan !== summaryRow.sales) {
      salesMismatch.push({
        rowIndex: summaryRow.rowIndex,
        product: summaryRow.product,
        totalPenjualanAyosera: totalPenjualan,
        totalPenjualanOlsera: summaryRow.sales,
        diff: totalPenjualan - summaryRow.sales,
      });
    }
    if (Math.abs(stockAkhirSistem - summaryRow.balance) > 0.001) {
      balanceMismatch.push({
        rowIndex: summaryRow.rowIndex,
        product: summaryRow.product,
        stockAkhirSistem,
        balanceOlsera: summaryRow.balance,
        diff: stockAkhirSistem - summaryRow.balance,
      });
    }

    rows.push({
      rowIndex: summaryRow.rowIndex,
      group: summaryRow.group,
      name: match.product?.variantName ? `${match.product.name} - ${match.product.variantName}` : summaryRow.product,
      sku: summaryRow.sku,
      buyPrice: match.product?.buyPrice ?? 0,
      sellPrice: match.product?.sellPrice ?? 0,
      stokAwal: summaryRow.begining,
      barangMasuk,
      dailySales,
      totalPenjualan,
      totalPenjualanOlsera: summaryRow.sales,
      keluar,
      stockAkhirSistem,
      balanceOlsera: summaryRow.balance,
      matchMethod: match.method,
      matchNote: match.note,
    });
  }

  return { rows, diagnostics: { unmatchedOrAmbiguous, salesMismatch, balanceMismatch } };
}

// ---------------------------------------------------------------------------
// Workbook builder (ExcelJS) — pure given already-prepared rows/diagnostics.
// ---------------------------------------------------------------------------

export function buildMonthlyInventoryWorkbook(input: {
  year: number;
  month: number;
  days: number;
  rows: MonthlyRowModel[];
  diagnostics: MonthlyImportDiagnostics;
}): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheetName = `${MONTH_NAMES[input.month - 1].slice(0, 3).toUpperCase()}'${String(input.year).slice(2)}`;
  const sheet = workbook.addWorksheet(sheetName);

  const FIXED_COLS = 6; // Group, Nama Barang, Harga Beli, Harga Jual, Stok Awal, Barang Masuk
  const dayColStart = FIXED_COLS + 1;
  const dayColEnd = FIXED_COLS + input.days;
  const totalCol = dayColEnd + 1;
  const keluarCol = totalCol + 1;
  const stockAkhirCol = keluarCol + 1;
  const aktualCol = stockAkhirCol + 1;
  const selisihCol = aktualCol + 1;
  const lastCol = selisihCol;

  const titleRow = sheet.addRow(["Laporan Stock Opname"]);
  titleRow.font = { name: FONT, bold: true, size: 14 };
  sheet.mergeCells(titleRow.number, 1, titleRow.number, lastCol);

  const headerRow1 = sheet.getRow(2);
  const headerRow2 = sheet.getRow(3);
  const headerLabels: [number, string][] = [
    [1, "Group"],
    [2, "Nama Barang"],
    [3, "Harga Beli"],
    [4, "Harga Jual"],
    [5, "Stok Awal"],
    [6, "Barang Masuk"],
    [totalCol, "Penjualan"],
    [keluarCol, "Keluar"],
    [stockAkhirCol, "Stock Akhir"],
    [aktualCol, "Aktual"],
    [selisihCol, "Selisih"],
  ];
  for (const [col, label] of headerLabels) {
    sheet.mergeCells(headerRow1.number, col, headerRow2.number, col);
    headerRow1.getCell(col).value = label;
  }
  headerRow1.getCell(dayColStart).value = `Bulan ${MONTH_NAMES[input.month - 1]}`;
  sheet.mergeCells(headerRow1.number, dayColStart, headerRow1.number, dayColEnd);
  for (let day = 1; day <= input.days; day++) {
    headerRow2.getCell(dayColStart + day - 1).value = day;
  }
  [headerRow1, headerRow2].forEach((row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: FONT, bold: true, size: 9 };
      cell.fill = fill(HEADER_GRAY);
      cell.border = thinBorder();
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    });
  });

  sheet.views = [{ state: "frozen", xSplit: 2, ySplit: 3 }];

  const totals = {
    stokAwal: 0,
    barangMasuk: 0,
    daily: new Array(input.days).fill(0) as number[],
    totalPenjualan: 0,
    keluar: 0,
    stockAkhirSistem: 0,
  };

  let currentRowNumber = 4;
  for (const row of input.rows) {
    const excelRow = sheet.getRow(currentRowNumber);
    excelRow.getCell(1).value = row.group;
    excelRow.getCell(2).value = row.name;
    excelRow.getCell(3).value = row.buyPrice || null;
    excelRow.getCell(4).value = row.sellPrice || null;
    excelRow.getCell(5).value = row.stokAwal;
    excelRow.getCell(6).value = row.barangMasuk || null;
    row.dailySales.forEach((qty, dayIndex) => {
      if (qty) excelRow.getCell(dayColStart + dayIndex).value = qty;
    });
    excelRow.getCell(totalCol).value = row.totalPenjualan;
    excelRow.getCell(keluarCol).value = row.keluar || null;
    excelRow.getCell(stockAkhirCol).value = row.stockAkhirSistem;
    // Aktual: SELALU kosong (diisi manual kasir saat stock opname) — jangan
    // pernah diisi 0 atau nilai apa pun secara otomatis untuk export ini.
    excelRow.getCell(aktualCol).value = null;
    const aktualAddr = excelRow.getCell(aktualCol).address;
    const stockAkhirAddr = excelRow.getCell(stockAkhirCol).address;
    excelRow.getCell(selisihCol).value = { formula: `IF(${aktualAddr}="","",${aktualAddr}-${stockAkhirAddr})` };

    excelRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: FONT, size: 9 };
      cell.border = thinBorder();
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
    excelRow.getCell(2).alignment = { vertical: "middle", horizontal: "left" };
    excelRow.getCell(3).numFmt = MONEY_FMT;
    excelRow.getCell(4).numFmt = MONEY_FMT;
    excelRow.getCell(aktualCol).fill = fill(AKTUAL_YELLOW);

    totals.stokAwal += row.stokAwal;
    totals.barangMasuk += row.barangMasuk;
    row.dailySales.forEach((qty, dayIndex) => (totals.daily[dayIndex] += qty));
    totals.totalPenjualan += row.totalPenjualan;
    totals.keluar += row.keluar;
    totals.stockAkhirSistem += row.stockAkhirSistem;

    currentRowNumber++;
  }

  const firstDataRow = 4;
  const lastDataRow = currentRowNumber - 1;
  const totalRow = sheet.getRow(currentRowNumber);
  totalRow.getCell(1).value = "Total";
  totalRow.getCell(2).value = `${input.rows.length} produk`;
  totalRow.getCell(5).value = totals.stokAwal;
  totalRow.getCell(6).value = totals.barangMasuk || null;
  totals.daily.forEach((qty, dayIndex) => {
    if (qty) totalRow.getCell(dayColStart + dayIndex).value = qty;
  });
  totalRow.getCell(totalCol).value = totals.totalPenjualan;
  totalRow.getCell(keluarCol).value = totals.keluar || null;
  totalRow.getCell(stockAkhirCol).value = totals.stockAkhirSistem;
  if (lastDataRow >= firstDataRow) {
    totalRow.getCell(aktualCol).value = { formula: `SUM(${sheet.getCell(firstDataRow, aktualCol).address}:${sheet.getCell(lastDataRow, aktualCol).address})` };
    totalRow.getCell(selisihCol).value = { formula: `SUM(${sheet.getCell(firstDataRow, selisihCol).address}:${sheet.getCell(lastDataRow, selisihCol).address})` };
  }
  totalRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { name: FONT, bold: true, size: 9 };
    cell.fill = fill(TOTAL_BLUE);
    cell.border = thinBorder();
  });

  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 38;
  sheet.getColumn(3).width = 13;
  sheet.getColumn(4).width = 13;
  sheet.getColumn(5).width = 11;
  sheet.getColumn(6).width = 12;
  for (let day = 1; day <= input.days; day++) sheet.getColumn(dayColStart + day - 1).width = 5;
  sheet.getColumn(totalCol).width = 12;
  sheet.getColumn(keluarCol).width = 10;
  sheet.getColumn(stockAkhirCol).width = 12;
  sheet.getColumn(aktualCol).width = 10;
  sheet.getColumn(selisihCol).width = 10;

  buildDiagnosticsSheet(workbook, input.diagnostics);
  return workbook;
}

function buildDiagnosticsSheet(workbook: ExcelJS.Workbook, diagnostics: MonthlyImportDiagnostics) {
  const sheet = workbook.addWorksheet("Diagnostik Import");
  const title = sheet.addRow(["DIAGNOSTIK IMPORT — PRODUK & ANGKA YANG PERLU DITINJAU MANUAL"]);
  title.font = { name: FONT, bold: true, size: 12 };
  sheet.addRow([
    "Produk ambigu/tidak ditemukan TIDAK dipaksakan cocok — periksa manual dan lengkapi SKU/nama di katalog atau file summary.",
  ]).font = { name: FONT, italic: true, size: 9, color: { argb: "FF595959" } };
  sheet.addRow([]);

  if (diagnostics.headerErrors.length) {
    const header = sheet.addRow(["Error Struktur Header"]);
    header.font = { name: FONT, bold: true, size: 10 };
    for (const err of diagnostics.headerErrors) sheet.addRow([err]);
    sheet.addRow([]);
  }

  if (diagnostics.rowsOutsidePeriod.length) {
    const header = sheet.addRow(["Baris di luar periode (created_time)"]);
    header.font = { name: FONT, bold: true, size: 10 };
    for (const idx of diagnostics.rowsOutsidePeriod) sheet.addRow([`Baris data ke-${idx + 1}`]);
    sheet.addRow([]);
  }

  if (diagnostics.duplicates.length) {
    const header = sheet.addRow(["Baris Duplikat (group+produk+SKU sama)"]);
    header.font = { name: FONT, bold: true, size: 10 };
    for (const dup of diagnostics.duplicates) sheet.addRow([`Baris data ke-${dup.rowIndexes.map((i) => i + 1).join(", ")}`]);
    sheet.addRow([]);
  }

  if (diagnostics.unmatchedOrAmbiguous.length) {
    const header = sheet.addRow(["Group", "Produk", "SKU", "Metode", "Catatan"]);
    header.font = { name: FONT, bold: true, size: 10 };
    header.fill = fill(HEADER_GRAY);
    for (const item of diagnostics.unmatchedOrAmbiguous) {
      sheet.addRow([item.group, item.product, item.sku ?? "-", item.method, item.note]);
    }
    sheet.addRow([]);
  }

  if (diagnostics.salesMismatch.length) {
    const header = sheet.addRow(["Produk", "Total Penjualan AYOSERA", "Total Penjualan Olsera (file)", "Selisih"]);
    header.font = { name: FONT, bold: true, size: 10 };
    header.fill = fill(HEADER_GRAY);
    for (const item of diagnostics.salesMismatch) {
      sheet.addRow([item.product, item.totalPenjualanAyosera, item.totalPenjualanOlsera, item.diff]);
    }
    sheet.addRow([]);
  }

  if (diagnostics.balanceMismatch.length) {
    const header = sheet.addRow(["Produk", "Stock Akhir Sistem (dihitung)", "Sisa Olsera (file)", "Selisih"]);
    header.font = { name: FONT, bold: true, size: 10 };
    header.fill = fill(HEADER_GRAY);
    for (const item of diagnostics.balanceMismatch) {
      sheet.addRow([item.product, item.stockAkhirSistem, item.balanceOlsera, item.diff]);
    }
  }

  sheet.getColumn(1).width = 22;
  sheet.getColumn(2).width = 36;
  sheet.getColumn(3).width = 30;
  sheet.getColumn(4).width = 20;
  sheet.getColumn(5).width = 40;
}

// ---------------------------------------------------------------------------
// Glue: upload → validasi → query Mongo (katalog + movement penjualan
// existing) → build workbook. Tidak menulis apa pun ke MongoDB.
// ---------------------------------------------------------------------------

export type GenerateMonthlyExportResult =
  | { ok: true; workbook: ExcelJS.Workbook }
  | { ok: false; errors: string[] };

export async function generateMonthlyInventoryExport(input: {
  fileBuffer: ArrayBuffer | Buffer;
  year: number;
  month: number;
}): Promise<GenerateMonthlyExportResult> {
  const parsed = await parseSummaryWorkbookBuffer(input.fileBuffer);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const duplicates = detectDuplicateSummaryRows(parsed.rows);
  if (duplicates.length) {
    return {
      ok: false,
      errors: duplicates.map(
        (dup) => `Baris duplikat (group+produk+SKU sama): baris data ke-${dup.rowIndexes.map((i) => i + 1).join(", ")}.`,
      ),
    };
  }

  const { startDate, endDate, days } = monthDateRange(input.year, input.month);
  const rowsOutsidePeriod = findRowsOutsidePeriod(parsed.rows, startDate, endDate);

  const { catalogProducts, salesMovements } = await withMongo(async () => {
    const { olseraInventoryProducts, olseraInventoryMovements } = await collections();
    const [products, movements] = await Promise.all([
      olseraInventoryProducts.find().toArray(),
      olseraInventoryMovements
        .find({ source: "sale", date: { $gte: startDate, $lte: endDate }, productId: { $ne: null } })
        .toArray(),
    ]);
    return { catalogProducts: products as InventoryProductInput[], salesMovements: movements };
  });

  const movementInputs = salesMovements.map((movement) => ({
    key: `${movement.storeId ?? 0}:${movement.productId}:${movement.variantId ?? 0}`,
    date: movement.date,
    qtyChange: movement.qtyChange,
  }));
  const dailySalesByProductKey = aggregateDailySales(movementInputs, input.year, input.month);

  const { rows, diagnostics } = buildMonthlyRows({
    summaryRows: parsed.rows,
    catalogProducts,
    dailySalesByProductKey,
    days,
  });

  const workbook = buildMonthlyInventoryWorkbook({
    year: input.year,
    month: input.month,
    days,
    rows,
    diagnostics: { headerErrors: [], skippedBlankRows: parsed.skippedBlankRows, rowsOutsidePeriod, duplicates, ...diagnostics },
  });

  return { ok: true, workbook };
}
