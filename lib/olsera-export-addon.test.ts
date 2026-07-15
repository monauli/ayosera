// Test regresi bug perhitungan Add-on Price pada export Olsera.
// addonPrice tersimpan PER UNIT (lib/mongodb.ts, lib/olsera-sync.ts); kontribusi
// add-on satu baris ke total transaksi = addonPrice × qty. Test ini mengunci
// perilaku itu di dua builder yang sebelumnya keliru menjumlah addonPrice
// tanpa × qty: Rincian Penjualan (buildOlseraItemWorkbook) & Kategori Penjualan
// (buildOlseraCategoryWorkbook). Sekaligus memverifikasi Total Penjualan/Laba
// TIDAK berubah dan perbedaan cakupan (order penuh vs per-kategori).
//
// Jalankan: npm run test:olsera-export-addon
import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { buildOlseraItemWorkbook } from "./olsera-item-export.ts";
import { buildOlseraCategoryWorkbook } from "./olsera-category-export.ts";

// --- Fixture: 2 order pada 1 tanggal, mencakup semua kasus yang diminta ---
// ORD-1: qty=1 addon>0 (A), qty>1 addon>0 (B), addon undefined (C) — beberapa
//        item berbeda dalam satu order, campuran kategori LABERS & MINUMAN.
// ORD-2: satu item MINUMAN qty>1 addon>0 (D).
type Row = {
  date: string;
  orderNo: string;
  orderDate: string;
  customerId: string | null;
  customerName: string | null;
  tableNo: string | null;
  salesByName: string | null;
  itemName: string;
  qty: number;
  amount: number;
  costAmount: number;
  discount: number;
  addonPrice?: number;
  category: string;
};

const DATE = "2026-01-01";
const base = { date: DATE, orderDate: `${DATE} 08:00:00`, customerId: null, customerName: null, tableNo: null, salesByName: "KASIR", discount: 0 };

const ROWS: Row[] = [
  { ...base, orderNo: "ORD-1", itemName: "ES KOPI SUSU", qty: 1, amount: 38000, costAmount: 0, addonPrice: 10000, category: "LABERS" },
  { ...base, orderNo: "ORD-1", itemName: "MATCHA - Ice", qty: 2, amount: 76000, costAmount: 0, addonPrice: 8000, category: "LABERS" },
  { ...base, orderNo: "ORD-1", itemName: "NESTLE PURE LIFE 600ML", qty: 3, amount: 30000, costAmount: 10000, addonPrice: undefined, category: "MINUMAN" },
  { ...base, orderNo: "ORD-2", itemName: "POCARI ION WATER 500ML", qty: 2, amount: 20000, costAmount: 4000, addonPrice: 5000, category: "MINUMAN" },
];

// Nilai acuan diturunkan dari fixture (bukan hardcode ajaib): addon per baris = addonPrice*qty.
const ADDON = {
  A: 10000 * 1, // 10000
  B: 8000 * 2, // 16000
  C: 0 * 3, // 0 (undefined -> 0)
  D: 5000 * 2, // 10000
};
const ADDON_ORD1 = ADDON.A + ADDON.B + ADDON.C; // 26000
const ADDON_ORD2 = ADDON.D; // 10000
const ADDON_TOTAL_ALL = ADDON_ORD1 + ADDON_ORD2; // 36000
const ADDON_LABERS = ADDON.A + ADDON.B; // 26000
const ADDON_MINUMAN = ADDON.C + ADDON.D; // 10000

const AMOUNT_TOTAL_ALL = 38000 + 76000 + 30000 + 20000; // 164000
const COST_TOTAL_ALL = 0 + 0 + 10000 + 4000; // 14000
const PROFIT_TOTAL_ALL = AMOUNT_TOTAL_ALL - COST_TOTAL_ALL; // 150000

function numOf(value: ExcelJS.CellValue): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "result" in value && typeof value.result === "number") return value.result;
  return NaN;
}

function findRowByColA(ws: ExcelJS.Worksheet, label: string): number {
  for (let r = 1; r <= ws.rowCount; r++) {
    if (String(ws.getCell(r, 1).value ?? "").trim() === label) return r;
  }
  return -1;
}

async function load(buffer: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

// ---------------------------------------------------------------------------
// Rincian Penjualan (buildOlseraItemWorkbook) — satu baris per ORDER, seluruh
// kategori digabung dalam order. Kolom K = Add-on Price, kolom I = Total
// Penjualan, kolom O = Laba, baris total "Total - IDR".
// ---------------------------------------------------------------------------
test("Rincian Penjualan: add-on per order & total = SUM(addonPrice × qty), seluruh kategori", async () => {
  const buffer = await buildOlseraItemWorkbook({ start: DATE, end: DATE, rows: ROWS });
  const wb = await load(buffer);
  assert.equal(wb.worksheets.length, 1, "satu tanggal → satu sheet");
  const ws = wb.worksheets[0];

  const totalRow = findRowByColA(ws, "Total - IDR");
  assert.ok(totalRow > 0, "baris total ditemukan");
  const firstDataRow = 5;

  // Peta orderNo → baris (kolom A). Order campuran LABERS+non-LABERS harus
  // memakai SEMUA item order (bukan hanya LABERS).
  const rowByOrder = new Map<string, number>();
  for (let r = firstDataRow; r < totalRow; r++) rowByOrder.set(String(ws.getCell(r, 1).value ?? ""), r);

  const ord1 = rowByOrder.get("ORD-1")!;
  const ord2 = rowByOrder.get("ORD-2")!;
  assert.equal(numOf(ws.getCell(ord1, 11).value), ADDON_ORD1, "K ORD-1 = 26000 (10000 + 8000×2 + 0)");
  assert.equal(numOf(ws.getCell(ord2, 11).value), ADDON_ORD2, "K ORD-2 = 10000 (5000×2)");
  assert.equal(numOf(ws.getCell(totalRow, 11).value), ADDON_TOTAL_ALL, "total K = 36000 seluruh kategori");

  // Total Penjualan (I) & Laba (O) TIDAK boleh berubah oleh perbaikan add-on.
  assert.equal(numOf(ws.getCell(ord1, 9).value), 38000 + 76000 + 30000, "I ORD-1 = amount penuh order");
  assert.equal(numOf(ws.getCell(totalRow, 9).value), AMOUNT_TOTAL_ALL, "total I = 164000 (amount tak berubah)");
  assert.equal(numOf(ws.getCell(totalRow, 15).value), PROFIT_TOTAL_ALL, "total O (laba) = 150000 (tak berubah)");
});

// ---------------------------------------------------------------------------
// Kategori Penjualan (buildOlseraCategoryWorkbook) — satu sheet per kategori,
// satu baris per ITEM. Kolom K = Add-on Price per item, J = Total Pesanan,
// Q = Laba, baris total "Total - IDR".
// ---------------------------------------------------------------------------
test("Kategori Penjualan: add-on per item & total per kategori = SUM(addonPrice × qty)", async () => {
  const buffer = await buildOlseraCategoryWorkbook({ start: DATE, end: DATE, rows: ROWS });
  const wb = await load(buffer);

  const labers = wb.getWorksheet("LABERS");
  const minuman = wb.getWorksheet("MINUMAN");
  assert.ok(labers, "sheet LABERS ada");
  assert.ok(minuman, "sheet MINUMAN ada");

  // LABERS: scope hanya item LABERS (A+B), bukan seluruh order.
  const labersTotalRow = findRowByColA(labers!, "Total - IDR");
  assert.equal(numOf(labers!.getCell(labersTotalRow, 11).value), ADDON_LABERS, "total K LABERS = 26000 (hanya item LABERS)");
  assert.equal(numOf(labers!.getCell(labersTotalRow, 10).value), 38000 + 76000, "total J LABERS = 114000 (amount tak berubah)");

  // Per baris item LABERS: A (qty1) = 10000, B (qty2) = 16000.
  const perRowAddon: number[] = [];
  for (let r = 1; r < labersTotalRow; r++) {
    const name = String(labers!.getCell(r, 7).value ?? "");
    if (name === "ES KOPI SUSU") perRowAddon.push(numOf(labers!.getCell(r, 11).value));
    if (name === "MATCHA - Ice") perRowAddon.push(numOf(labers!.getCell(r, 11).value));
  }
  assert.deepEqual(perRowAddon.sort((a, b) => a - b), [ADDON.A, ADDON.B].sort((a, b) => a - b), "K per item LABERS = [10000, 16000]");

  // MINUMAN: item addon undefined (C) → 0, item D (qty2) → 10000; total = 10000.
  const minumanTotalRow = findRowByColA(minuman!, "Total - IDR");
  assert.equal(numOf(minuman!.getCell(minumanTotalRow, 11).value), ADDON_MINUMAN, "total K MINUMAN = 10000");
});

// Sanity aritmetika murni (dokumentasi hidup semantik per-unit): identitas
// amount = (price + addonPrice) × qty − discount pada item multi-qty.
test("semantik addonPrice per unit: amount = (price + addonPrice) × qty − discount", () => {
  // Nilai nyata dari payload Olsera (order/closeorder/detail), item multi-qty:
  // MATCHA - Ice: price 40000, addon_price 10000, qty 2, discount 0 → 100000.
  assert.equal((40000 + 10000) * 2 - 0, 100000);
  // ES KOPI SUSU: price 28000, addon_price 8000 (per unit), qty 2, disc 0 → 72000.
  assert.equal((28000 + 8000) * 2 - 0, 72000);
});
