// Export Inventori canonical — SATU file Excel, DUA sheet ("[Bulan] Terjual"
// dan "[Bulan] Keseluruhan"), menggantikan tombol export terpisah lama
// (Export Stok Saat Ini / Export Riwayat Mutasi / Export Konsistensi
// Inventori / Export Laporan Stock Opname Bulanan lama). TIDAK ada formula
// inventori baru — angka SELALU berasal dari rantai snapshot bulanan
// (olsera_inventory_monthly_snapshots via ensureMonthlySnapshotChain, lihat
// lib/olsera-inventory-monthly-snapshot-store.ts), sama seperti yang sudah
// dipakai jalur otomatis lama. `olsera_inventory_movements` TIDAK dipakai di
// sini — koleksi itu hanya mutasi penjualan (lihat audit tmp/ai-handoff.md:
// "Audit Inventory Source and New Two-Sheet Export"), bukan ledger stok
// penuh (incoming/return/outgoing).
//
// Keputusan kolom (didokumentasikan, bukan ditebak — lihat audit yang sama):
// - TIDAK ada kolom Opname/Penyesuaian: rantai snapshot bulanan otomatis
//   (computeMonthlyStepBackward/Forward di
//   lib/olsera-inventory-monthly-snapshot-core.ts) tidak memodelkan komponen
//   "opname" terpisah dari incoming/return/sales/outgoing — field itu hanya
//   ada di jalur upload manual lama (SummaryRow.opname), yang BUKAN sumber
//   canonical untuk export ini.
// - TIDAK ada kolom created_by/created_time: dokumen
//   OlseraInventoryMonthlySnapshotDocument tidak menyimpan siapa/kapan tiap
//   baris pergerakan dicatat di sisi Olsera (hanya createdAt/updatedAt milik
//   proses build snapshot AYOSERA sendiri) — menampilkannya akan mengarang
//   data yang tidak ada sumbernya.
import ExcelJS from "exceljs";
import { collections, withMongo, type OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";
import type { InventoryProductInput } from "./olsera-inventory-core.ts";
import { hasInventoryActivity } from "./olsera-inventory-ui.ts";
import { stripDuplicateSuffix } from "./olsera-inventory-monthly-snapshot-core.ts";
import { ensureMonthlySnapshotChain } from "./olsera-inventory-monthly-snapshot-store.ts";
import { currentStoreId } from "./olsera-store-id.ts";

const INT_FMT = "#,##0";
const HEADER_GRAY = "FFA6A6A6";
const TOTAL_BLUE = "FF9DC3E6";
const BLACK = "FF000000";
const FONT = "Aptos Narrow";

export const MONTH_NAMES = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
] as const;

function fill(argb: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const, color: { argb: BLACK } };
  return { top: side, left: side, bottom: side, right: side };
}

// ---------------------------------------------------------------------------
// Kategori dikecualikan — normalisasi trim+uppercase, LABERS exact match,
// LAPANGAN substring match (mencakup "LAPANGAN PADEL"/"LAPANGAN PICKLEBALL"
// dkk tanpa perlu mendaftar setiap variasi nama persis). Produk tanpa
// kategori (string kosong) TIDAK dikecualikan oleh fungsi ini.
// ---------------------------------------------------------------------------

export function isExcludedTwoSheetCategory(category: unknown): boolean {
  const normalized = String(category ?? "").trim().toLocaleUpperCase("id-ID");
  if (!normalized) return false;
  return normalized === "LABERS" || normalized.includes("LAPANGAN");
}

// ---------------------------------------------------------------------------
// Baris gabungan (murni) — master produk JOIN snapshot bulanan
// ---------------------------------------------------------------------------

export type TwoSheetInventoryRow = {
  key: string;
  name: string;
  sku: string | null;
  category: string;
  uom: string | null;
  /** null = ada dokumen snapshot bulan ini TAPI field ini sendiri belum diketahui (TIDAK PERNAH ditebak jadi 0). */
  openingQty: number | null;
  incomingQty: number | null;
  returnQty: number | null;
  salesQty: number | null;
  outgoingQty: number | null;
  closingQty: number | null;
  /** false = produk TIDAK PERNAH punya dokumen snapshot bulanan apa pun (tidak ada jejak mutasi historis sama sekali) — seluruh angka di atas diisi 0 sebagai nilai paling konservatif yang tidak mengarang, bukan carry-forward dari data yang tidak ada. */
  hasSnapshot: boolean;
};

/**
 * Gabungkan katalog produk dengan dokumen snapshot bulanan bulan target.
 *
 * Status `active` katalog produk mencerminkan kondisi SAAT INI, bukan kondisi
 * pada bulan historis yang diekspor — karena itu status itu TIDAK PERNAH
 * dipakai untuk membuang produk yang terbukti punya data stok (`hasSnapshot`)
 * pada bulan tersebut:
 * - Produk dengan dokumen snapshot bulan ini SELALU masuk, baik aktif maupun
 *   sudah `active:false` sekarang (produk historis yang belakangan dihentikan).
 * - Produk TANPA dokumen snapshot bulan ini hanya masuk (dengan angka 0) bila
 *   `isCurrentMonth` true DAN produk masih aktif saat ini — untuk bulan
 *   berjalan, katalog aktif saat ini adalah bukti yang sah bahwa produk itu
 *   ada. Untuk bulan lampau, "aktif saat ini" bukan bukti keberadaan produk
 *   pada bulan itu, jadi produk seperti itu TIDAK dimasukkan.
 */
export function buildTwoSheetInventoryRows(input: {
  catalogProducts: InventoryProductInput[];
  snapshotDocs: OlseraInventoryMonthlySnapshotDocument[];
  storeId: number;
  /** true = bulan yang diekspor adalah bulan berjalan (memengaruhi apakah produk aktif tanpa snapshot tetap dimasukkan). Default false (bulan lampau). */
  isCurrentMonth?: boolean;
}): TwoSheetInventoryRow[] {
  const isCurrentMonth = input.isCurrentMonth ?? false;
  const productByKey = new Map(
    input.catalogProducts.map((product) => [`${input.storeId}:${product.productId}:${product.variantId ?? 0}`, product]),
  );
  const docByKey = new Map(input.snapshotDocs.map((doc) => [`${doc.storeId}:${doc.productId}:${doc.variantId ?? 0}`, doc]));

  const keys: string[] = [];
  const seenKeys = new Set<string>();

  for (const doc of input.snapshotDocs) {
    const key = `${doc.storeId}:${doc.productId}:${doc.variantId ?? 0}`;
    const product = productByKey.get(key);
    const category = doc.groupName ?? "";
    if (isExcludedTwoSheetCategory(category)) continue;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    keys.push(key);
  }

  if (isCurrentMonth) {
    for (const product of input.catalogProducts) {
      if (!product.active) continue;
      if (isExcludedTwoSheetCategory(product.category)) continue;
      const key = `${input.storeId}:${product.productId}:${product.variantId ?? 0}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      keys.push(key);
    }
  }

  return keys.map((key) => {
    const product = productByKey.get(key);
    const doc = docByKey.get(key);
    const catalogName = product ? (product.variantName ? `${product.name} - ${product.variantName}` : product.name) : null;
    return {
      key,
      name: doc ? stripDuplicateSuffix(doc.productName) : (catalogName ?? ""),
      sku: product?.sku ?? doc?.productSku ?? null,
      category: doc?.groupName ?? "",
      uom: product?.uom ?? null,
      openingQty: doc ? doc.openingQty : (isCurrentMonth ? product?.stockQty ?? 0 : 0),
      incomingQty: doc ? doc.incomingQty : 0,
      returnQty: doc ? doc.returnQty : 0,
      salesQty: doc ? doc.salesQty : 0,
      outgoingQty: doc ? doc.outgoingQty : 0,
      closingQty: doc ? doc.closingQty : (isCurrentMonth ? product?.stockQty ?? 0 : 0),
      hasSnapshot: Boolean(doc),
    };
  });
}

/** A-Z case-insensitive (locale id), tie-break by key supaya hasil selalu deterministik walau ada nama identik. */
export function sortTwoSheetRows(rows: readonly TwoSheetInventoryRow[]): TwoSheetInventoryRow[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name, "id", { sensitivity: "base" }) || a.key.localeCompare(b.key));
}

/** Sheet Terjual: hanya salesQty > 0 (null/0/negatif tidak masuk). */
export function filterTerjualRows(rows: readonly TwoSheetInventoryRow[]): TwoSheetInventoryRow[] {
  return rows.filter((row) => (row.salesQty ?? 0) > 0);
}

/**
 * Barang Habis: closingQty PERSIS 0 (bukan null/belum diketahui) DAN produk
 * memang punya bukti aktivitas bulan ini (opening/incoming/return/sales/
 * outgoing > 0) — beda dari baris zero-activity murni (yang sudah dibuang
 * lebih dulu oleh hasInventoryActivity/Aturan Kedua Inventori sebelum fungsi
 * ini dipanggil). Produk closing 0 TANPA aktivitas apa pun (mis. belum pernah
 * ada data bulan ini) TIDAK masuk sini — itu bukan "kejadian barang habis"
 * bulan ini, hanya baris kosong.
 */
export function filterBarangHabisRows(rows: readonly TwoSheetInventoryRow[]): TwoSheetInventoryRow[] {
  return rows.filter((row) => {
    if (row.closingQty !== 0) return false;
    return (row.openingQty ?? 0) > 0 || (row.incomingQty ?? 0) > 0 || (row.returnQty ?? 0) > 0 || (row.salesQty ?? 0) > 0 || (row.outgoingQty ?? 0) > 0;
  });
}

// ---------------------------------------------------------------------------
// Workbook builder (ExcelJS) — pure, given rows yang sudah difilter+sorted.
// Tidak ada formula Excel yang bisa berubah setelah dibuka — total ditulis
// sebagai angka statis yang sudah dihitung di sini.
// ---------------------------------------------------------------------------

type ColumnDef = { header: string; key: keyof TwoSheetInventoryRow; width: number; numeric?: boolean };

// SKU/Satuan sengaja TIDAK dirender (Phase 2F — dihapus dari export atas
// permintaan; field sku/uom TETAP ada di TwoSheetInventoryRow/database, hanya
// tidak dijadikan kolom Excel di sini).
const COLUMNS: readonly ColumnDef[] = [
  { header: "Kategori", key: "category", width: 18 },
  { header: "Produk", key: "name", width: 42 },
  { header: "Stok Awal", key: "openingQty", width: 12, numeric: true },
  { header: "Barang Masuk", key: "incomingQty", width: 13, numeric: true },
  { header: "Retur", key: "returnQty", width: 10, numeric: true },
  { header: "Penjualan", key: "salesQty", width: 12, numeric: true },
  { header: "Barang Keluar", key: "outgoingQty", width: 13, numeric: true },
  { header: "Sisa Stok", key: "closingQty", width: 12, numeric: true },
];

function writeSheet(workbook: ExcelJS.Workbook, sheetName: string, title: string, rows: readonly TwoSheetInventoryRow[]) {
  const ws = workbook.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 3 }] });

  ws.mergeCells(1, 1, 1, COLUMNS.length);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { name: FONT, bold: true, size: 12 };
  titleCell.alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(1).height = 22;

  ws.mergeCells(2, 1, 2, COLUMNS.length);
  const subtitleCell = ws.getCell(2, 1);
  subtitleCell.value = `${rows.length} produk`;
  subtitleCell.font = { name: FONT, italic: true, size: 9, color: { argb: "FF595959" } };

  const headerRow = ws.getRow(3);
  COLUMNS.forEach((col, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = col.header;
    cell.font = { name: FONT, bold: true };
    cell.fill = fill(HEADER_GRAY);
    cell.border = thinBorder();
    cell.alignment = { horizontal: col.numeric ? "right" : "left", vertical: "middle", wrapText: true };
  });
  headerRow.height = 26;

  let rowIndex = 4;
  for (const row of rows) {
    const excelRow = ws.getRow(rowIndex);
    COLUMNS.forEach((col, index) => {
      const cell = excelRow.getCell(index + 1);
      const value = row[col.key as keyof TwoSheetInventoryRow];
      cell.value = value === null || value === undefined ? null : (value as string | number);
      cell.font = { name: FONT };
      cell.border = thinBorder();
      cell.alignment = { horizontal: col.numeric ? "right" : "left", vertical: "middle" };
      if (col.numeric) cell.numFmt = INT_FMT;
    });
    rowIndex++;
  }

  const totalRow = ws.getRow(rowIndex);
  totalRow.getCell(1).value = "TOTAL";
  totalRow.getCell(1).font = { name: FONT, bold: true };
  COLUMNS.forEach((col, index) => {
    const cell = totalRow.getCell(index + 1);
    cell.fill = fill(TOTAL_BLUE);
    cell.border = thinBorder();
    cell.font = { name: FONT, bold: true };
    if (col.numeric) {
      const sum = rows.reduce((acc, row) => acc + (Number(row[col.key as keyof TwoSheetInventoryRow]) || 0), 0);
      cell.value = sum;
      cell.numFmt = INT_FMT;
      cell.alignment = { horizontal: "right" };
    }
  });

  COLUMNS.forEach((col, index) => {
    ws.getColumn(index + 1).width = col.width;
  });
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: COLUMNS.length } };
}

export function buildTwoSheetInventoryWorkbook(input: {
  year: number;
  month: number;
  rows: readonly TwoSheetInventoryRow[];
}): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AYOSERA";
  workbook.created = new Date();

  const monthName = MONTH_NAMES[input.month - 1] ?? String(input.month);
  // Aturan Kedua Inventori: baris tanpa aktivitas SAMA SEKALI bulan ini
  // (opening 0, tanpa incoming/return/sales/outgoing, closing 0) tidak perlu
  // masuk export — helper SAMA dipakai dashboard Stok Bulanan (murni
  // tampilan, histori/produk master TIDAK dihapus dari database).
  const activeRows = input.rows.filter(hasInventoryActivity);
  const terjual = sortTwoSheetRows(filterTerjualRows(activeRows));
  const keseluruhan = sortTwoSheetRows(activeRows);

  writeSheet(workbook, `${monthName} Terjual`, `Laporan Inventori Terjual — ${monthName} ${input.year}`, terjual);
  writeSheet(workbook, `${monthName} Keseluruhan`, `Laporan Inventori Keseluruhan — ${monthName} ${input.year}`, keseluruhan);

  return workbook;
}

/**
 * Barang Habis — SATU sheet ("[Bulan] Barang Habis"), export terpisah dari
 * Export Pergerakan Stok. Kolom & sumber angka SAMA (reuse writeSheet, tidak
 * ada formula baru) — hanya baris yang difilter beda (lihat
 * filterBarangHabisRows). Nama SENGAJA "Barang Habis" (BUKAN "Barang Habis
 * Terjual") — audit data nyata Phase 2F/2G membuktikan closing 0 bisa terjadi
 * murni lewat outgoing (transfer/adjustment) tanpa penjualan sama sekali
 * (kasus nyata: BOLA HEAD PRO ISI 3, Agustus 2026 — opening 1, outgoing 1,
 * sales 0, closing 0), jadi istilah "Terjual" akan menyiratkan penjualan yang
 * sebenarnya tidak terjadi untuk sebagian baris.
 */
export function buildBarangHabisWorkbook(input: {
  year: number;
  month: number;
  rows: readonly TwoSheetInventoryRow[];
}): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AYOSERA";
  workbook.created = new Date();

  const monthName = MONTH_NAMES[input.month - 1] ?? String(input.month);
  const activeRows = input.rows.filter(hasInventoryActivity);
  const habis = sortTwoSheetRows(filterBarangHabisRows(activeRows));

  writeSheet(workbook, `${monthName} Barang Habis`, `Laporan Barang Habis — ${monthName} ${input.year}`, habis);
  return workbook;
}

// ---------------------------------------------------------------------------
// Glue OTOMATIS: bulan+tahun -> pastikan rantai snapshot bulanan sampai bulan
// ini ada (ensureMonthlySnapshotChain — self-healing, idempotent, TIDAK
// pernah membuat data ganda karena upsert by _id deterministik, TIDAK PERNAH
// menyentuh bulan lain) -> katalog produk aktif -> gabungkan -> workbook.
// ---------------------------------------------------------------------------

export type GenerateTwoSheetExportResult =
  | { ok: true; workbook: ExcelJS.Workbook }
  | { ok: false; errors: string[] };

/** Bulan berjalan ditentukan dari tanggal saat ini di zona waktu WIB (Asia/Jakarta), konsisten dengan konvensi tanggal lain di codebase ini. */
export function isCurrentYearMonth(year: number, month: number, now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "numeric" }).formatToParts(now);
  const nowYear = Number(parts.find((p) => p.type === "year")?.value);
  const nowMonth = Number(parts.find((p) => p.type === "month")?.value);
  return year === nowYear && month === nowMonth;
}

type LoadInventoryRowsResult =
  | { ok: true; rows: TwoSheetInventoryRow[] }
  | { ok: false; errors: string[] };

/** Reuse bersama antara generateTwoSheetInventoryExport dan generateBarangHabisExport — SATU jalur ambil data, dua workbook builder beda di atasnya. */
async function loadInventoryRowsForExport(input: { year: number; month: number }): Promise<LoadInventoryRowsResult> {
  const chain = await ensureMonthlySnapshotChain({ year: input.year, month: input.month });
  if (!chain.ok) {
    return { ok: false, errors: [`Gagal menyiapkan snapshot bulanan (${input.year}-${String(input.month).padStart(2, "0")}): ${chain.error}`] };
  }

  const catalogProducts = await withMongo(async () => {
    const { olseraInventoryProducts } = await collections();
    const products = await olseraInventoryProducts.find({ storeId: { $in: [currentStoreId(), null] } }).toArray();
    return products as InventoryProductInput[];
  });

  if (!catalogProducts.length) {
    return { ok: false, errors: ["Katalog produk inventori (olsera_inventory_products) kosong — jalankan Sync Inventori terlebih dahulu."] };
  }

  const rows = buildTwoSheetInventoryRows({
    catalogProducts,
    snapshotDocs: chain.docs,
    storeId: chain.storeId,
    isCurrentMonth: isCurrentYearMonth(input.year, input.month),
  });
  return { ok: true, rows };
}

export async function generateTwoSheetInventoryExport(input: { year: number; month: number }): Promise<GenerateTwoSheetExportResult> {
  const loaded = await loadInventoryRowsForExport(input);
  if (!loaded.ok) return loaded;
  const workbook = buildTwoSheetInventoryWorkbook({ year: input.year, month: input.month, rows: loaded.rows });
  return { ok: true, workbook };
}

export async function generateBarangHabisExport(input: { year: number; month: number }): Promise<GenerateTwoSheetExportResult> {
  const loaded = await loadInventoryRowsForExport(input);
  if (!loaded.ok) return loaded;
  const workbook = buildBarangHabisWorkbook({ year: input.year, month: input.month, rows: loaded.rows });
  return { ok: true, workbook };
}
