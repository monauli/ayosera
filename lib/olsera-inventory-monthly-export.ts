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
import { sanitizeExcelCellValue } from "./excel-sanitization.ts";
import { collections, withMongo, type OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";
import {
  aggregateDailySales,
  buildMovementNameIndex,
  buildSkuIndex,
  computeDisplayedBarangMasuk,
  computeDisplayedKeluar,
  computeStockAkhirSistem,
  computeUnsyncedDates,
  detectDuplicateSummaryRows,
  findRowsOutsidePeriod,
  matchSummaryRowToProduct,
  monthDateRange,
  parseSummaryRows,
  validateSummaryHeader,
  type DuplicateGroup,
  type DuplicateResolutionEntry,
  type InventoryProductInput,
  type MonthlyMatchMethod,
  type SummaryRow,
} from "./olsera-inventory-monthly-core.ts";
import { dominantStoreId, recoverNullProductIdSales, stripDuplicateSuffix } from "./olsera-inventory-monthly-snapshot-core.ts";
import { ensureMonthlySnapshotChain } from "./olsera-inventory-monthly-snapshot-store.ts";

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

// Duplikat kecil dari lib/olsera-sync.ts:todayJakarta — sengaja tidak
// mengimpor modul itu (isinya berat, banyak dependency @/lib/* yang
// mengasumsikan Next.js module alias) hanya untuk satu fungsi tanggal murni.
function todayJakarta(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

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

/**
 * Sumber angka Stok Awal/Stock Akhir baris ini:
 * - "manual-file": jalur upload manual (buildMonthlyRows) — dari file summary resmi Olsera.
 * - "baseline-file": jalur otomatis, bulan bootstrap (Juni 2026) — dari file baseline
 *   terverifikasi (scripts/bootstrap-monthly-snapshot-baseline.ts), BUKAN stockmovement API.
 * - "stockmovement-backward"/"stockmovement-forward": ledger bulanan dihitung dari
 *   rantai snapshot bulanan (opening/closing berkelanjutan) — lihat
 *   lib/olsera-inventory-monthly-snapshot-core.ts. TIDAK PERNAH memakai stockQty
 *   katalog HARI INI untuk bulan lampau (fallback itu sudah dihapus — lihat audit
 *   live 2026-07-21: terbukti salah untuk produk yang bergerak setelah bulan target).
 * - "carry-forward": produk tanpa pergerakan bulan ini — saldo dibawa sama dari bulan sebelumnya.
 * - "no-snapshot": snapshot bulanan belum/tidak bisa direkonstruksi untuk produk ini —
 *   Stok Awal/Stock Akhir TIDAK diisi (bukan 0/ditebak), selalu masuk diagnostik.
 */
export type StockDataSource = "manual-file" | "baseline-file" | "stockmovement-backward" | "stockmovement-forward" | "carry-forward" | "no-snapshot";

export type MonthlyRowModel = {
  rowIndex: number;
  group: string;
  name: string;
  sku: string | null;
  buyPrice: number;
  sellPrice: number;
  /** null bila snapshot bulanan produk ini belum/tidak bisa direkonstruksi (lihat StockDataSource "no-snapshot") — TIDAK PERNAH ditebak. */
  stokAwal: number | null;
  barangMasuk: number;
  dailySales: number[];
  totalPenjualan: number;
  /** null = tidak ada angka penjualan Olsera sendiri tersimpan di snapshot bulan ini (bukan 0). */
  totalPenjualanOlsera: number | null;
  keluar: number;
  /** null bila stokAwal null (tidak bisa dihitung tanpa Stok Awal). */
  stockAkhirSistem: number | null;
  /** null = tidak ada closingQty Olsera sendiri tersimpan di snapshot bulan ini. */
  balanceOlsera: number | null;
  matchMethod: MonthlyMatchMethod | StockDataSource;
  matchNote: string;
  stockDataSource: StockDataSource;
};

export type MonthlyImportDiagnostics = {
  headerErrors: string[];
  skippedBlankRows: number;
  duplicates: DuplicateGroup[];
  rowsOutsidePeriod: number[];
  unmatchedOrAmbiguous: {
    rowIndex: number;
    group: string;
    product: string;
    sku: string | null;
    method: MonthlyMatchMethod | StockDataSource;
    note: string;
  }[];
  salesMismatch: { rowIndex: number; product: string; totalPenjualanAyosera: number; totalPenjualanOlsera: number; diff: number }[];
  balanceMismatch: { rowIndex: number; product: string; stockAkhirSistem: number; balanceOlsera: number; diff: number }[];
  /** Produk dengan snapshot bulanan yang BELUM/TIDAK bisa direkonstruksi untuk bulan ini — WAJIB ditinjau manual, Stok Awal/Stock Akhir tidak diisi. */
  incompleteStockData?: { rowIndex: number; group: string; product: string; sku: string | null; note: string }[];
  /** Produk yang stok bulan ini berasal dari carry-forward (tidak ada pergerakan) — informasi, bukan masalah. */
  reconstructedStockData?: { rowIndex: number; group: string; product: string; source: string; value: number; note: string }[];
  /**
   * SINYAL BUG MAPPING: AYOSERA mencatat penjualan (>0) untuk produk ini,
   * tapi tidak ada angka penjualan Olsera tersimpan di snapshot bulan ini —
   * kemungkinan besar item order tidak ter-mapping ke productId/SKU/nama yang
   * benar di sync penjualan (lib/olsera-inventory-core.ts:selectMovementProduct),
   * bukan masalah rekonstruksi stok. WAJIB diaudit manual terhadap olsera_order_items.
   */
  unexplainedAyoseraSales?: { rowIndex: number; group: string; product: string; totalPenjualanAyosera: number; note: string }[];
  /** Produk katalog dengan nama mengandung "duplicate" — audit + resolusi (merge hanya jika SKU membuktikan sama), TIDAK pernah dihapus hanya karena nama. */
  duplicateNamedProducts?: DuplicateResolutionEntry[];
  /** Tanggal dalam periode yang BELUM terkonfirmasi tuntas disync (olsera_synced_days) — penjelasan non-formula untuk selisih penjualan harian. */
  unsyncedDates?: string[];
  /** Checkpoint sync penjualan Olsera terakhir yang tuntas penuh (olsera_sync_state), null bila belum pernah sync. */
  lastFullySyncedDate?: string | null;
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
      stockDataSource: "manual-file",
    });
  }

  return { rows, diagnostics: { unmatchedOrAmbiguous, salesMismatch, balanceMismatch } };
}

// ---------------------------------------------------------------------------
// Jalur OTOMATIS: sumber Stok Awal/Stock Akhir = rantai snapshot BULANAN
// tersimpan (olsera_inventory_monthly_snapshots, lihat
// lib/olsera-inventory-monthly-snapshot-*.ts) — TIDAK PERNAH memakai stockQty
// katalog HARI INI untuk bulan lampau (fallback lama itu terbukti salah pada
// audit live 2026-07-21 untuk produk yang bergerak SETELAH bulan target,
// mis. BULLPADEL INDIGA PWR 25 & YONEX SHORTS). Matching baris API ke
// katalog SUDAH terjadi saat snapshot itu dibuat (bootstrap/backfill) —
// fungsi ini murni MEMBACA dokumen snapshot yang sudah ada, bukan menarik
// stockmovement API lagi.
//
// Daftar baris = seluruh dokumen snapshot bulan target (satu per produk yang
// TERBUKTI eksis pada bulan itu — lihat computeMonthlyStepBackward/Forward).
// Produk tanpa dokumen sama sekali TIDAK ditampilkan (bukan dipaksa dengan
// angka 0/tebakan) — sesuai desain "produk yang belum eksis jangan dipaksa
// masuk". Nama tampil dibersihkan dari suffix literal "duplicate"
// (stripDuplicateSuffix) — identitas produk tidak berubah.
//
// Penjualan harian (kolom tanggal 1..akhir bulan) TETAP dari data AYOSERA
// existing (olsera_inventory_movements, source="sale") — TIDAK diambil dari
// salesQty yang tersimpan di snapshot (dipakai HANYA untuk diagnostik
// salesMismatch/balanceMismatch).
// ---------------------------------------------------------------------------

export function buildMonthlyRowsFromMonthlySnapshots(input: {
  snapshotDocs: OlseraInventoryMonthlySnapshotDocument[];
  catalogProducts: InventoryProductInput[];
  dailySalesByProductKey: Map<string, { daily: number[]; total: number }>;
  days: number;
}): {
  rows: MonthlyRowModel[];
  diagnostics: Pick<MonthlyImportDiagnostics, "salesMismatch" | "balanceMismatch"> & {
    incompleteStockData: NonNullable<MonthlyImportDiagnostics["incompleteStockData"]>;
    reconstructedStockData: NonNullable<MonthlyImportDiagnostics["reconstructedStockData"]>;
    unexplainedAyoseraSales: NonNullable<MonthlyImportDiagnostics["unexplainedAyoseraSales"]>;
  };
} {
  const priceByKey = new Map(input.catalogProducts.map((p) => [`${p.storeId ?? 0}:${p.productId}:${p.variantId ?? 0}`, p]));

  const salesMismatch: MonthlyImportDiagnostics["salesMismatch"] = [];
  const balanceMismatch: MonthlyImportDiagnostics["balanceMismatch"] = [];
  const incompleteStockData: NonNullable<MonthlyImportDiagnostics["incompleteStockData"]> = [];
  const reconstructedStockData: NonNullable<MonthlyImportDiagnostics["reconstructedStockData"]> = [];
  const unexplainedAyoseraSales: NonNullable<MonthlyImportDiagnostics["unexplainedAyoseraSales"]> = [];

  const rows: MonthlyRowModel[] = [];
  for (const doc of input.snapshotDocs) {
    const key = `${doc.storeId}:${doc.productId}:${doc.variantId ?? 0}`;
    const agg = input.dailySalesByProductKey.get(key);
    const dailySales = agg?.daily ?? new Array(input.days).fill(0);
    const totalPenjualan = agg?.total ?? 0;

    const name = stripDuplicateSuffix(doc.productName);
    const product = priceByKey.get(key);

    const stokAwal = doc.openingQty;
    const barangMasuk = doc.incomingQty ?? 0;
    const keluar = doc.outgoingQty ?? 0;
    const stockAkhirSistem = stokAwal !== null ? computeStockAkhirSistem({ stokAwal, barangMasuk, totalPenjualan, keluar }) : null;
    const balanceOlsera = doc.closingQty;
    const matchNote = doc.diagnostics.join(" ") || "(tidak ada catatan)";

    if (stokAwal === null) {
      incompleteStockData.push({ rowIndex: rows.length, group: doc.groupName, product: name, sku: doc.productSku, note: matchNote });
      if (totalPenjualan > 0) {
        unexplainedAyoseraSales.push({
          rowIndex: rows.length,
          group: doc.groupName,
          product: name,
          totalPenjualanAyosera: totalPenjualan,
          note: `AYOSERA mencatat ${totalPenjualan} unit terjual, tapi snapshot bulanan produk ini belum tersedia — audit mapping item order (productId/variantId/SKU/nama) di olsera_order_items untuk produk ini.`,
        });
      }
    } else if (doc.source === "carry-forward") {
      reconstructedStockData.push({ rowIndex: rows.length, group: doc.groupName, product: name, source: doc.source, value: stockAkhirSistem ?? stokAwal, note: matchNote });
    }

    if (doc.salesQty !== null && totalPenjualan !== doc.salesQty) {
      salesMismatch.push({ rowIndex: rows.length, product: name, totalPenjualanAyosera: totalPenjualan, totalPenjualanOlsera: doc.salesQty, diff: totalPenjualan - doc.salesQty });
    }
    if (stockAkhirSistem !== null && balanceOlsera !== null && Math.abs(stockAkhirSistem - balanceOlsera) > 0.001) {
      balanceMismatch.push({ rowIndex: rows.length, product: name, stockAkhirSistem, balanceOlsera, diff: stockAkhirSistem - balanceOlsera });
    }

    rows.push({
      rowIndex: rows.length,
      group: doc.groupName,
      name,
      sku: doc.productSku,
      buyPrice: product?.buyPrice ?? 0,
      sellPrice: product?.sellPrice ?? 0,
      stokAwal,
      barangMasuk,
      dailySales,
      totalPenjualan,
      totalPenjualanOlsera: doc.salesQty,
      keluar,
      stockAkhirSistem,
      balanceOlsera,
      matchMethod: stokAwal === null ? "no-snapshot" : doc.source,
      matchNote,
      stockDataSource: stokAwal === null ? "no-snapshot" : doc.source,
    });
  }

  // Urutan tampil stabil mengikuti struktur laporan perusahaan: dikelompokkan
  // per Group (urutan kemunculan pertama grup), lalu nama produk alfabetis
  // di dalam grup — deterministik & dapat diuji.
  const groupOrder = new Map<string, number>();
  for (const row of rows) {
    if (!groupOrder.has(row.group)) groupOrder.set(row.group, groupOrder.size);
  }
  rows.sort((a, b) => {
    const groupDiff = (groupOrder.get(a.group) ?? 0) - (groupOrder.get(b.group) ?? 0);
    if (groupDiff !== 0) return groupDiff;
    return a.name.localeCompare(b.name, "id");
  });
  rows.forEach((row, index) => (row.rowIndex = index));

  return { rows, diagnostics: { salesMismatch, balanceMismatch, incompleteStockData, reconstructedStockData, unexplainedAyoseraSales } };
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
  /** Label sumber data pembanding di sheet Diagnostik — "Olsera (file)" (default, jalur upload manual) atau "Olsera Open API" (jalur otomatis). */
  sourceLabel?: string;
  /**
   * Ikut menuliskan sheet "Diagnostik Import" ke workbook. Default true agar
   * tooling internal/validasi tetap bisa memakainya. File yang DIUNDUH user
   * memakai false — diagnostik tetap DIHITUNG (dan boleh dicatat ke Mongo/log),
   * hanya tidak ikut sebagai sheet di file download. Sheet laporan utama
   * (format/warna/border/grouping/urutan/formula/total) tidak berubah.
   */
  includeDiagnosticsSheet?: boolean;
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
  // Baris dengan stokAwal/stockAkhirSistem null (jalur otomatis: produk tanpa
  // baris Olsera Open API) TIDAK ikut dijumlahkan ke total — total tetap
  // hanya menjumlahkan angka yang benar-benar diketahui (bukan memperlakukan
  // "tidak tersedia" sebagai 0). Dihitung supaya bisa dicatat sebagai catatan
  // di sheet Diagnostik (lihat buildDiagnosticsSheet).
  let incompleteStockRowCount = 0;

  let currentRowNumber = 4;
  for (const row of input.rows) {
    const excelRow = sheet.getRow(currentRowNumber);
    excelRow.getCell(1).value = sanitizeExcelCellValue(row.group);
    excelRow.getCell(2).value = sanitizeExcelCellValue(row.name);
    excelRow.getCell(3).value = row.buyPrice || null;
    excelRow.getCell(4).value = row.sellPrice || null;
    // stokAwal/stockAkhirSistem null → sel dibiarkan kosong (bukan 0) — lihat
    // MonthlyRowModel.stokAwal.
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
    if (row.stockAkhirSistem === null) {
      // Stock Akhir tidak tersedia (bukan 0) — Selisih tidak bisa dihitung
      // sama sekali untuk baris ini. Teks biasa (bukan formula) supaya SUM()
      // pada baris Total mengabaikannya secara alami (SUM Excel melewati teks).
      excelRow.getCell(selisihCol).value = sanitizeExcelCellValue("Data Tidak Lengkap");
    } else {
      excelRow.getCell(selisihCol).value = { formula: `IF(${aktualAddr}="","",${aktualAddr}-${stockAkhirAddr})` };
    }

    excelRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: FONT, size: 9 };
      cell.border = thinBorder();
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
    excelRow.getCell(2).alignment = { vertical: "middle", horizontal: "left" };
    excelRow.getCell(3).numFmt = MONEY_FMT;
    excelRow.getCell(4).numFmt = MONEY_FMT;
    excelRow.getCell(aktualCol).fill = fill(AKTUAL_YELLOW);

    if (row.stokAwal === null || row.stockAkhirSistem === null) {
      incompleteStockRowCount++;
    } else {
      totals.stokAwal += row.stokAwal;
      totals.stockAkhirSistem += row.stockAkhirSistem;
    }
    totals.barangMasuk += row.barangMasuk;
    row.dailySales.forEach((qty, dayIndex) => (totals.daily[dayIndex] += qty));
    totals.totalPenjualan += row.totalPenjualan;
    totals.keluar += row.keluar;

    currentRowNumber++;
  }

  const firstDataRow = 4;
  const lastDataRow = currentRowNumber - 1;
  const totalRow = sheet.getRow(currentRowNumber);
  totalRow.getCell(1).value = "Total";
  totalRow.getCell(2).value = incompleteStockRowCount
    ? `${input.rows.length} produk (${incompleteStockRowCount} tanpa data Stok Awal API)`
    : `${input.rows.length} produk`;
  totalRow.getCell(5).value = totals.stokAwal;
  totalRow.getCell(6).value = totals.barangMasuk || null;
  totals.daily.forEach((qty, dayIndex) => {
    if (qty) totalRow.getCell(dayColStart + dayIndex).value = qty;
  });
  totalRow.getCell(totalCol).value = totals.totalPenjualan;
  totalRow.getCell(keluarCol).value = totals.keluar || null;
  totalRow.getCell(stockAkhirCol).value = totals.stockAkhirSistem;
  if (lastDataRow >= firstDataRow) {
    const aktualRange = `${sheet.getCell(firstDataRow, aktualCol).address}:${sheet.getCell(lastDataRow, aktualCol).address}`;
    const selisihRange = `${sheet.getCell(firstDataRow, selisihCol).address}:${sheet.getCell(lastDataRow, selisihCol).address}`;
    // COUNT() hanya menghitung sel numerik — bila TIDAK ADA satu pun Aktual
    // yang diisi kasir (semua baris masih kosong/"Data Tidak Lengkap"),
    // COUNT()=0 dan total ditampilkan kosong ("") alih-alih SUM() yang
    // menghasilkan 0 secara menyesatkan (SUM dari range kosong = 0 di Excel).
    totalRow.getCell(aktualCol).value = { formula: `IF(COUNT(${aktualRange})=0,"",SUM(${aktualRange}))` };
    totalRow.getCell(selisihCol).value = { formula: `IF(COUNT(${selisihRange})=0,"",SUM(${selisihRange}))` };
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

  if (input.includeDiagnosticsSheet ?? true) {
    buildDiagnosticsSheet(workbook, input.diagnostics, input.sourceLabel ?? "Olsera (file)");
  }
  return workbook;
}

function buildDiagnosticsSheet(workbook: ExcelJS.Workbook, diagnostics: MonthlyImportDiagnostics, sourceLabel: string) {
  const sheet = workbook.addWorksheet("Diagnostik Import");
  const title = sheet.addRow(["DIAGNOSTIK IMPORT — PRODUK & ANGKA YANG PERLU DITINJAU MANUAL"]);
  title.font = { name: FONT, bold: true, size: 12 };
  sheet.addRow([
    `Produk ambigu/tidak ditemukan TIDAK dipaksakan cocok — periksa manual dan lengkapi SKU/nama di katalog atau ${sourceLabel}.`,
  ]).font = { name: FONT, italic: true, size: 9, color: { argb: "FF595959" } };
  sheet.addRow([]);

  if (diagnostics.headerErrors.length) {
    const header = sheet.addRow(["Error Struktur Header"]);
    header.font = { name: FONT, bold: true, size: 10 };
    for (const err of diagnostics.headerErrors) sheet.addRow([sanitizeExcelCellValue(err)]);
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
    const header = sheet.addRow([`Group`, "Produk", "SKU", "Metode", "Catatan"]);
    header.font = { name: FONT, bold: true, size: 10 };
    header.fill = fill(HEADER_GRAY);
    for (const item of diagnostics.unmatchedOrAmbiguous) {
      sheet.addRow([item.group, item.product, item.sku ?? "-", item.method, item.note].map(sanitizeExcelCellValue));
    }
    sheet.addRow([]);
  }

  if (diagnostics.incompleteStockData?.length) {
    const header = sheet.addRow([
      `Produk Katalog Tanpa Baris ${sourceLabel} (Stok Awal/Stock Akhir tidak tersedia, bukan 0)`,
    ]);
    header.font = { name: FONT, bold: true, size: 10 };
    header.fill = fill(HEADER_GRAY);
    const subHeader = sheet.addRow(["Group", "Produk", "SKU", "Catatan"]);
    subHeader.font = { name: FONT, bold: true, size: 9 };
    for (const item of diagnostics.incompleteStockData) {
      sheet.addRow([item.group, item.product, item.sku ?? "-", item.note].map(sanitizeExcelCellValue));
    }
    sheet.addRow([]);
  }

  if (diagnostics.reconstructedStockData?.length) {
    const header = sheet.addRow([
      `Stok Direkonstruksi dari Jendela ${sourceLabel} Sebelum/Sesudah Bulan Target (dibuktikan, bukan bulan target langsung)`,
    ]);
    header.font = { name: FONT, bold: true, size: 10 };
    header.fill = fill(HEADER_GRAY);
    const subHeader = sheet.addRow(["Group", "Produk", "Sumber", "Nilai", "Catatan"]);
    subHeader.font = { name: FONT, bold: true, size: 9 };
    for (const item of diagnostics.reconstructedStockData) {
      sheet.addRow([item.group, item.product, item.source, item.value, item.note].map(sanitizeExcelCellValue));
    }
    sheet.addRow([]);
  }

  if (diagnostics.duplicateNamedProducts?.length) {
    const header = sheet.addRow([`Produk Katalog dengan Nama Mengandung "duplicate" (audit berdasarkan productId/variantId/SKU)`]);
    header.font = { name: FONT, bold: true, size: 10 };
    header.fill = fill(HEADER_GRAY);
    const subHeader = sheet.addRow(["Nama", "SKU", "productId", "variantId", "Toko", "Resolusi", "Catatan"]);
    subHeader.font = { name: FONT, bold: true, size: 9 };
    for (const item of diagnostics.duplicateNamedProducts) {
      sheet.addRow([
        item.name,
        item.sku ?? "-",
        item.productId,
        item.variantId ?? "-",
        item.storeName ?? "-",
        item.resolution === "merged-into-canonical" ? "Digabung (SKU terbukti sama)" : "Perlu Tinjauan Manual",
        item.note,
      ].map(sanitizeExcelCellValue));
    }
    sheet.addRow([]);
  }

  if (diagnostics.unexplainedAyoseraSales?.length) {
    const header = sheet.addRow([
      `PERINGATAN: Penjualan AYOSERA Tanpa Pergerakan ${sourceLabel} Sama Sekali (kemungkinan bug mapping — audit segera)`,
    ]);
    header.font = { name: FONT, bold: true, size: 10, color: { argb: "FFC00000" } };
    header.fill = fill(HEADER_GRAY);
    const subHeader = sheet.addRow(["Group", "Produk", "Total Penjualan AYOSERA", "Catatan"]);
    subHeader.font = { name: FONT, bold: true, size: 9 };
    for (const item of diagnostics.unexplainedAyoseraSales) {
      sheet.addRow([item.group, item.product, item.totalPenjualanAyosera, item.note].map(sanitizeExcelCellValue));
    }
    sheet.addRow([]);
  }

  if (diagnostics.salesMismatch.length) {
    const header = sheet.addRow(["Produk", "Total Penjualan AYOSERA", `Total Penjualan ${sourceLabel}`, "Selisih"]);
    header.font = { name: FONT, bold: true, size: 10 };
    header.fill = fill(HEADER_GRAY);
    for (const item of diagnostics.salesMismatch) {
      sheet.addRow([item.product, item.totalPenjualanAyosera, item.totalPenjualanOlsera, item.diff].map(sanitizeExcelCellValue));
    }
    sheet.addRow([]);
  }

  if (diagnostics.balanceMismatch.length) {
    const header = sheet.addRow(["Produk", "Stock Akhir Sistem (dihitung)", `Sisa ${sourceLabel}`, "Selisih"]);
    header.font = { name: FONT, bold: true, size: 10 };
    header.fill = fill(HEADER_GRAY);
    for (const item of diagnostics.balanceMismatch) {
      sheet.addRow([item.product, item.stockAkhirSistem, item.balanceOlsera, item.diff].map(sanitizeExcelCellValue));
    }
    sheet.addRow([]);
  }

  if (diagnostics.unsyncedDates?.length || diagnostics.lastFullySyncedDate !== undefined) {
    const header = sheet.addRow(["Status Sinkronisasi Penjualan AYOSERA (bukan formula — penjelasan selisih)"]);
    header.font = { name: FONT, bold: true, size: 10 };
    header.fill = fill(HEADER_GRAY);
    sheet.addRow([
      `Checkpoint sync penjualan Olsera terakhir tuntas: ${diagnostics.lastFullySyncedDate ?? "belum pernah sync"}.`,
    ]);
    if (diagnostics.unsyncedDates?.length) {
      sheet.addRow([
        `${diagnostics.unsyncedDates.length} tanggal pada periode ini BELUM terkonfirmasi tuntas disync — Total Penjualan AYOSERA untuk tanggal berikut berpotensi belum final (bukan salah formula):`,
      ].map(sanitizeExcelCellValue));
      sheet.addRow([sanitizeExcelCellValue(diagnostics.unsyncedDates.join(", "))]);
    } else {
      sheet.addRow(["Seluruh tanggal pada periode ini sudah terkonfirmasi tuntas disync."]);
    }
    sheet.addRow([]);
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
    // File download user: hanya sheet laporan utama. Diagnostik tetap dihitung
    // di atas (buildMonthlyRows) dan boleh dipakai internal, tapi TIDAK ikut
    // sebagai sheet di file yang diunduh.
    includeDiagnosticsSheet: false,
    diagnostics: { headerErrors: [], skippedBlankRows: parsed.skippedBlankRows, rowsOutsidePeriod, duplicates, ...diagnostics },
  });

  return { ok: true, workbook };
}

// ---------------------------------------------------------------------------
// Glue OTOMATIS: bulan+tahun → pastikan rantai snapshot bulanan sampai bulan
// ini ada (ensureMonthlySnapshotChain — backfill on-demand bila belum) →
// katalog + penjualan harian AYOSERA existing (Mongo) → build workbook.
// TIDAK ada upload file. Struktur & formula Excel sama persis dengan
// generateMonthlyInventoryExport di atas (buildMonthlyInventoryWorkbook
// dipakai ulang tanpa perubahan) — hanya sumber Stok Awal/Barang Masuk/
// Keluar/Sisa yang berbeda (snapshot bulanan tersimpan, bukan file/stockQty
// katalog hari ini).
// ---------------------------------------------------------------------------

export async function generateMonthlyInventoryExportAuto(input: {
  year: number;
  month: number;
}): Promise<GenerateMonthlyExportResult> {
  const { startDate, endDate, days } = monthDateRange(input.year, input.month);
  const today = todayJakarta();

  const chain = await ensureMonthlySnapshotChain({ year: input.year, month: input.month });
  if (!chain.ok) {
    return { ok: false, errors: [`Gagal menyiapkan snapshot bulanan (${input.year}-${String(input.month).padStart(2, "0")}): ${chain.error}`] };
  }

  const { catalogProducts, salesMovements, unresolvedNullProductSales, syncedDayIds, syncState } = await withMongo(async () => {
    const { olseraInventoryProducts, olseraInventoryMovements, olseraOrderItems, olseraSyncedDays, olseraSyncState } = await collections();
    const [products, movements, nullMovements, syncedDays, state] = await Promise.all([
      olseraInventoryProducts.find().toArray(),
      olseraInventoryMovements.find({ source: "sale", date: { $gte: startDate, $lte: endDate }, productId: { $ne: null } }).toArray(),
      // Movement penjualan yang productId-nya null saat sync — terverifikasi
      // live 2026-07-21 (kasus YONEX SHORTS): olsera_order_items.resolvedProductId
      // untuk item yang SAMA berhasil diresolusi via olsera_product_aliases,
      // tapi dokumen olsera_inventory_movements-nya sendiri gagal ikut
      // ter-resolve (resolver movement tidak konsisten dengan resolver order
      // item). Dipulihkan HANYA saat baca di sini — TIDAK menulis apa pun ke
      // olsera_inventory_movements (pipeline sync tidak disentuh).
      olseraInventoryMovements.find({ source: "sale", date: { $gte: startDate, $lte: endDate }, productId: null }).toArray(),
      olseraSyncedDays.find({ _id: { $gte: startDate, $lte: endDate } }, { projection: { _id: 1 } }).toArray(),
      olseraSyncState.findOne({ _id: "olsera" }),
    ]);

    let recovered: typeof movements = [];
    if (nullMovements.length) {
      const orderItemIds = nullMovements.map((m) => Number(String(m._id).split(":")[1])).filter((id) => Number.isFinite(id));
      const orderItems = orderItemIds.length
        ? await olseraOrderItems.find({ _id: { $in: orderItemIds } }).project({ resolvedProductId: 1, variantId: 1 }).toArray()
        : [];
      const resolvedByOrderItemId = new Map(orderItems.map((o) => [o._id, { resolvedProductId: o.resolvedProductId ?? null, variantId: o.variantId ?? null }]));
      recovered = recoverNullProductIdSales(nullMovements, resolvedByOrderItemId);
    }

    return {
      catalogProducts: products as InventoryProductInput[],
      salesMovements: [...movements, ...recovered],
      unresolvedNullProductSales: nullMovements.length - recovered.length,
      syncedDayIds: new Set(syncedDays.map((doc) => doc._id)),
      syncState: state,
    };
  });

  if (!catalogProducts.length) {
    return {
      ok: false,
      errors: ["Katalog produk inventori (olsera_inventory_products) kosong — jalankan Sync Inventori terlebih dahulu."],
    };
  }

  // storeId movement penjualan null utk kasus tepi yang SAMA dengan
  // productId:null (terverifikasi live 2026-07-21, 2 dari 2534 movement Juni
  // — YONEX SHORTS) — 0 BUKAN storeId nyata manapun di katalog, jadi
  // fallback ke storeId dominan katalog (bukan 0) supaya key-nya cocok
  // dengan key snapshot bulanan (storeId asli, 324175 pada data nyata).
  const fallbackStoreId = dominantStoreId(catalogProducts);
  const movementInputs = salesMovements.map((movement) => ({
    key: `${movement.storeId ?? fallbackStoreId}:${movement.productId}:${movement.variantId ?? 0}`,
    date: movement.date,
    qtyChange: movement.qtyChange,
  }));
  const dailySalesByProductKey = aggregateDailySales(movementInputs, input.year, input.month);

  const { rows, diagnostics } = buildMonthlyRowsFromMonthlySnapshots({
    snapshotDocs: chain.docs,
    catalogProducts,
    dailySalesByProductKey,
    days,
  });

  // Tanggal pada periode yang BELUM terkonfirmasi tuntas disync (olsera_synced_days)
  // — penjelasan non-formula untuk selisih Total Penjualan AYOSERA vs Olsera
  // Open API.
  const unsyncedDates = computeUnsyncedDates(startDate, endDate, today, syncedDayIds);

  const workbook = buildMonthlyInventoryWorkbook({
    year: input.year,
    month: input.month,
    days,
    rows,
    sourceLabel: "Olsera Open API",
    // File download user: hanya sheet laporan utama (JUN'26 dst.). Seluruh
    // diagnostik tetap DIHITUNG di bawah (dan boleh dicatat ke Mongo/log untuk
    // validasi internal), hanya tidak ikut sebagai sheet "Diagnostik Import".
    includeDiagnosticsSheet: false,
    diagnostics: {
      headerErrors: [],
      skippedBlankRows: unresolvedNullProductSales,
      rowsOutsidePeriod: [],
      duplicates: [],
      unmatchedOrAmbiguous: [],
      unsyncedDates,
      lastFullySyncedDate: syncState?.lastFullySyncedDate ?? null,
      ...diagnostics,
    },
  });

  return { ok: true, workbook };
}
