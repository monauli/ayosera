// Export Excel modul Inventori Olsera (ExcelJS): Stok Saat Ini, Riwayat Mutasi,
// Konsistensi Inventori. Semua angka ditulis sebagai number Excel (bukan string),
// desain sederhana konsisten dengan export lain (header abu-abu, total, freeze pane).
import ExcelJS from "exceljs";
import { collections, withMongo } from "./mongodb.ts";
import {
  inventoryValueFor,
  stockStatusFor,
  DEFAULT_LOW_STOCK_THRESHOLD,
} from "./olsera-inventory-core.ts";
import { getInventoryConsistency } from "./olsera-inventory.ts";
import { sanitizeExcelCellValue } from "./excel-sanitization.ts";
import { currentStoreId } from "./olsera-store-id.ts";
import { stripDuplicateSuffix } from "./olsera-inventory-monthly-snapshot-core.ts";

const MONEY_FMT = '"IDR" #,##0';
const HEADER_GRAY = "FFA6A6A6";
const TOTAL_BLUE = "FF9DC3E6";
const BLACK = "FF000000";
const FONT = "Aptos Narrow";

function fill(argb: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const, color: { argb: BLACK } };
  return { top: side, left: side, bottom: side, right: side };
}

function styleHeaderRow(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.font = { name: FONT, bold: true, size: 10 };
    cell.fill = fill(HEADER_GRAY);
    cell.border = thinBorder();
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
}

function newSheet(workbook: ExcelJS.Workbook, name: string, title: string, subtitle: string) {
  const sheet = workbook.addWorksheet(name);
  const titleRow = sheet.addRow([sanitizeExcelCellValue(title)]);
  titleRow.font = { name: FONT, bold: true, size: 12 };
  const subtitleRow = sheet.addRow([sanitizeExcelCellValue(subtitle)]);
  subtitleRow.font = { name: FONT, size: 10 };
  sheet.addRow([]);
  return sheet;
}

/** Export Stok Saat Ini — mengikuti filter aktif (q/kategori/status sudah diterapkan pemanggil). */
export async function buildInventoryStockWorkbook(filter: {
  q?: string;
  category?: string;
}): Promise<ExcelJS.Workbook> {
  const products = await withMongo(async () => {
    const { olseraInventoryProducts } = await collections();
    // storeId: { $in: [currentStoreId(), null] } — dokumen legacy tanpa
    // storeId (null) tetap ikut terbaca (perilaku existing tidak berubah,
    // hanya satu toko yang pernah ada di koleksi ini), tapi toko LAIN
    // (bila suatu saat ditambahkan) tidak akan ikut bocor ke sini.
    const query: Record<string, unknown> = { storeId: { $in: [currentStoreId(), null] } };
    if (filter.q) {
      const rx = new RegExp(filter.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ name: rx }, { sku: rx }, { variantName: rx }];
    }
    if (filter.category) query.category = filter.category;
    return olseraInventoryProducts.find(query).sort({ category: 1, name: 1 }).toArray();
  });

  const workbook = new ExcelJS.Workbook();
  const storeName = products.find((product) => product.storeName)?.storeName ?? "-";
  const sheet = newSheet(
    workbook,
    "Stok Inventori",
    "STOK INVENTORI OLSERA",
    `Outlet: ${storeName} · Snapshot: ${new Date().toISOString().slice(0, 10)}${filter.category ? ` · Kategori: ${filter.category}` : ""}`,
  );

  const header = sheet.addRow([
    "SKU", "Produk", "Varian", "Kategori", "Satuan", "Outlet", "Gudang",
    "Stok Saat Ini", "Stok Minimum", "Status Stok", "Harga Modal", "Nilai Persediaan", "Terakhir Diperbarui",
  ]);
  styleHeaderRow(header);
  sheet.views = [{ state: "frozen", ySplit: header.number }];
  sheet.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number, column: 13 } };

  let totalStock = 0;
  let totalValue = 0;
  for (const product of products) {
    const value = inventoryValueFor(product);
    if (product.trackInventory) {
      totalStock += product.stockQty;
      totalValue += value;
    }
    const row = sheet.addRow([
      sanitizeExcelCellValue(product.sku ?? "-"),
      // Sufiks "duplicate" katalog Olsera (produk lama dibuat ulang dengan
      // productId baru) dibersihkan untuk tampilan — generik, konsisten
      // dengan export dua-sheet (lib/olsera-inventory-two-sheet-export.ts).
      sanitizeExcelCellValue(stripDuplicateSuffix(product.name)),
      sanitizeExcelCellValue(product.variantName ?? "-"),
      sanitizeExcelCellValue(product.category),
      sanitizeExcelCellValue(product.uom ?? "-"),
      sanitizeExcelCellValue(product.storeName ?? "-"),
      // API Olsera tidak menyediakan data gudang terpisah dari outlet (endpoint
      // warehouse 404 — lihat scripts/inspect-olsera-inventory.ts): tampilkan
      // apa adanya, jangan diisi nilai reka-reka.
      "-",
      product.stockQty,
      product.lowStockAlert ?? (product.trackInventory ? DEFAULT_LOW_STOCK_THRESHOLD : 0),
      stockStatusFor(product),
      product.buyPrice,
      product.trackInventory ? value : 0,
      sanitizeExcelCellValue(product.modifiedTime ?? "-"),
    ]);
    row.eachCell((cell) => {
      cell.font = { name: FONT, size: 10 };
      cell.border = thinBorder();
    });
    row.getCell(11).numFmt = MONEY_FMT;
    row.getCell(12).numFmt = MONEY_FMT;
  }

  const totalRow = sheet.addRow([
    "TOTAL", `${products.length} produk`, "", "", "", "", "", totalStock, "", "", "", totalValue, "",
  ]);
  totalRow.eachCell((cell) => {
    cell.font = { name: FONT, bold: true, size: 10 };
    cell.fill = fill(TOTAL_BLUE);
    cell.border = thinBorder();
  });
  totalRow.getCell(12).numFmt = MONEY_FMT;

  const widths = [14, 34, 16, 18, 10, 18, 12, 12, 12, 14, 14, 16, 20];
  widths.forEach((width, index) => (sheet.getColumn(index + 1).width = width));
  return workbook;
}

/** Export Riwayat Mutasi pada rentang tanggal (mengikuti filter aktif). */
export async function buildInventoryMovementWorkbook(filter: {
  startDate: string;
  endDate: string;
  type?: string;
  q?: string;
}): Promise<ExcelJS.Workbook> {
  const movements = await withMongo(async () => {
    const { olseraInventoryMovements } = await collections();
    const query: Record<string, unknown> = {
      date: { $gte: filter.startDate, $lte: filter.endDate },
      storeId: { $in: [currentStoreId(), null] },
    };
    if (filter.type) query.type = filter.type;
    if (filter.q) {
      const rx = new RegExp(filter.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ productName: rx }, { sku: rx }, { reference: rx }];
    }
    return olseraInventoryMovements.find(query).sort({ movementAt: 1 }).toArray();
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = newSheet(
    workbook,
    "Mutasi Inventori",
    "RIWAYAT MUTASI INVENTORI OLSERA",
    `Periode: ${filter.startDate} s/d ${filter.endDate}${filter.type ? ` · Jenis: ${filter.type}` : ""}`,
  );
  const noteRow = sheet.addRow([
    "Data mutasi berasal dari transaksi penjualan Olsera. Histori stok masuk, adjustment, transfer, retur, " +
      "serta saldo sebelum dan sesudah tidak tersedia dari API.",
  ].map(sanitizeExcelCellValue));
  noteRow.font = { name: FONT, size: 9, italic: true, color: { argb: "FF595959" } };
  sheet.addRow([]);

  const header = sheet.addRow(["Tanggal", "SKU", "Produk", "Jenis Mutasi", "Perubahan", "Harga Modal", "Nilai", "Referensi", "Catatan"]);
  styleHeaderRow(header);
  sheet.views = [{ state: "frozen", ySplit: header.number }];
  sheet.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number, column: 9 } };

  let totalQty = 0;
  let totalValue = 0;
  for (const movement of movements) {
    totalQty += movement.qtyChange;
    totalValue += movement.value ?? 0;
    const row = sheet.addRow([
      sanitizeExcelCellValue(movement.movementAt),
      sanitizeExcelCellValue(movement.sku ?? "-"),
      sanitizeExcelCellValue(movement.productName),
      sanitizeExcelCellValue(movement.type),
      movement.qtyChange,
      movement.costPrice ?? 0,
      movement.value ?? 0,
      sanitizeExcelCellValue(movement.reference ?? "-"),
      sanitizeExcelCellValue(movement.note ?? ""),
    ]);
    row.eachCell((cell) => {
      cell.font = { name: FONT, size: 10 };
      cell.border = thinBorder();
    });
    row.getCell(6).numFmt = MONEY_FMT;
    row.getCell(7).numFmt = MONEY_FMT;
  }

  const totalRow = sheet.addRow(["TOTAL", "", "", "", totalQty, "", totalValue, "", ""]);
  totalRow.eachCell((cell) => {
    cell.font = { name: FONT, bold: true, size: 10 };
    cell.fill = fill(TOTAL_BLUE);
    cell.border = thinBorder();
  });
  totalRow.getCell(7).numFmt = MONEY_FMT;

  const widths = [20, 14, 36, 14, 14, 14, 14, 16, 30];
  widths.forEach((width, index) => (sheet.getColumn(index + 1).width = width));
  return workbook;
}

/**
 * Export Konsistensi Inventori — cakupan data snapshot & penjualan tercatat.
 * BUKAN rekonsiliasi stok fisik: tidak ada kolom stok masuk/adjustment/transfer
 * palsu, dan status tidak pernah menyatakan stok fisik "Cocok"/benar.
 */
export async function buildInventoryConsistencyWorkbook(): Promise<ExcelJS.Workbook> {
  const { rows, note } = await getInventoryConsistency();

  const workbook = new ExcelJS.Workbook();
  const sheet = newSheet(workbook, "Konsistensi", "KONSISTENSI INVENTORI OLSERA (CAKUPAN DATA)", note);

  const header = sheet.addRow([
    "SKU", "Produk", "Kategori", "Snapshot Stok Awal", "Penjualan Tercatat", "Snapshot Stok Terakhir",
    "Perubahan Snapshot", "Status Cakupan Data",
  ]);
  styleHeaderRow(header);
  sheet.views = [{ state: "frozen", ySplit: header.number }];
  sheet.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number, column: 8 } };

  const NA = "Tidak tersedia";
  for (const item of rows) {
    const row = sheet.addRow([
      sanitizeExcelCellValue(item.sku ?? "-"),
      sanitizeExcelCellValue(stripDuplicateSuffix(item.name)),
      sanitizeExcelCellValue(item.category),
      item.startSnapshotQty ?? NA,
      item.recordedSales ?? NA,
      item.endSnapshotQty ?? NA,
      item.snapshotChange ?? NA,
      item.status,
    ]);
    row.eachCell((cell) => {
      cell.font = { name: FONT, size: 10 };
      cell.border = thinBorder();
    });
  }

  const widths = [14, 36, 18, 18, 18, 20, 18, 20];
  widths.forEach((width, index) => (sheet.getColumn(index + 1).width = width));
  return workbook;
}
