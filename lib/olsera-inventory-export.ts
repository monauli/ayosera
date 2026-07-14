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
  const titleRow = sheet.addRow([title]);
  titleRow.font = { name: FONT, bold: true, size: 12 };
  const subtitleRow = sheet.addRow([subtitle]);
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
    const query: Record<string, unknown> = {};
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
    "SKU", "Produk", "Variant", "Kategori", "Satuan", "Outlet",
    "Stok Saat Ini", "Stok Minimum", "Status Stok", "Harga Modal", "Nilai Persediaan", "Terakhir Diperbarui",
  ]);
  styleHeaderRow(header);
  sheet.views = [{ state: "frozen", ySplit: header.number }];
  sheet.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number, column: 12 } };

  let totalStock = 0;
  let totalValue = 0;
  for (const product of products) {
    const value = inventoryValueFor(product);
    if (product.trackInventory) {
      totalStock += product.stockQty;
      totalValue += value;
    }
    const row = sheet.addRow([
      product.sku ?? "-",
      product.name,
      product.variantName ?? "-",
      product.category,
      product.uom ?? "-",
      product.storeName ?? "-",
      product.stockQty,
      product.lowStockAlert ?? (product.trackInventory ? DEFAULT_LOW_STOCK_THRESHOLD : 0),
      stockStatusFor(product),
      product.buyPrice,
      product.trackInventory ? value : 0,
      product.modifiedTime ?? "-",
    ]);
    row.eachCell((cell) => {
      cell.font = { name: FONT, size: 10 };
      cell.border = thinBorder();
    });
    row.getCell(10).numFmt = MONEY_FMT;
    row.getCell(11).numFmt = MONEY_FMT;
  }

  const totalRow = sheet.addRow(["TOTAL", "", "", "", "", "", totalStock, "", "", "", totalValue, ""]);
  totalRow.eachCell((cell) => {
    cell.font = { name: FONT, bold: true, size: 10 };
    cell.fill = fill(TOTAL_BLUE);
    cell.border = thinBorder();
  });
  totalRow.getCell(11).numFmt = MONEY_FMT;

  const widths = [14, 34, 16, 18, 10, 18, 12, 12, 14, 14, 16, 20];
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
    const query: Record<string, unknown> = { date: { $gte: filter.startDate, $lte: filter.endDate } };
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

  const header = sheet.addRow([
    "Tanggal", "SKU", "Produk", "Jenis Mutasi", "Perubahan Qty", "Harga Modal", "Nilai Mutasi", "Referensi", "Catatan",
  ]);
  styleHeaderRow(header);
  sheet.views = [{ state: "frozen", ySplit: header.number }];
  sheet.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number, column: 9 } };

  let totalQty = 0;
  let totalValue = 0;
  for (const movement of movements) {
    totalQty += movement.qtyChange;
    totalValue += movement.value ?? 0;
    const row = sheet.addRow([
      movement.movementAt,
      movement.sku ?? "-",
      movement.productName,
      movement.type,
      movement.qtyChange,
      movement.costPrice ?? 0,
      movement.value ?? 0,
      movement.reference ?? "-",
      movement.note ?? "",
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

/** Export Konsistensi Inventori (perhitungan sistem, bukan stock opname). */
export async function buildInventoryConsistencyWorkbook(): Promise<ExcelJS.Workbook> {
  const { rows, note } = await getInventoryConsistency();

  const workbook = new ExcelJS.Workbook();
  const sheet = newSheet(workbook, "Konsistensi", "KONSISTENSI INVENTORI OLSERA (SISTEM)", note);

  const header = sheet.addRow([
    "SKU", "Produk", "Kategori", "Periode Awal", "Periode Akhir", "Stok Awal",
    "Stok Masuk", "Stok Keluar", "Stok Akhir (Hitung)", "Stok Akhir (Snapshot)", "Selisih", "Status",
  ]);
  styleHeaderRow(header);
  sheet.views = [{ state: "frozen", ySplit: header.number }];
  sheet.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number, column: 12 } };

  for (const item of rows) {
    const row = sheet.addRow([
      item.sku ?? "-",
      item.name,
      item.category,
      item.startDate ?? "-",
      item.endDate ?? "-",
      item.startQty ?? 0,
      item.stockIn,
      item.stockOut,
      item.computedEndQty ?? 0,
      item.snapshotEndQty ?? 0,
      item.difference ?? 0,
      item.status,
    ]);
    row.eachCell((cell) => {
      cell.font = { name: FONT, size: 10 };
      cell.border = thinBorder();
    });
  }

  const widths = [14, 36, 18, 13, 13, 11, 11, 11, 16, 17, 10, 20];
  widths.forEach((width, index) => (sheet.getColumn(index + 1).width = width));
  return workbook;
}
