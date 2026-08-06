// Regression test untuk export Inventori canonical (satu file, dua sheet:
// "[Bulan] Terjual"/"[Bulan] Keseluruhan"). Sumber angka SELALU dari
// olsera_inventory_monthly_snapshots (via ensureMonthlySnapshotChain di
// lib/olsera-inventory-monthly-snapshot-store.ts, reuse — bukan formula
// baru); olsera_inventory_movements (mutasi penjualan saja) TIDAK dipakai di
// sini. Jalankan: node --no-warnings --experimental-strip-types --test
// lib/olsera-inventory-two-sheet-export.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  buildTwoSheetInventoryRows,
  buildTwoSheetInventoryWorkbook,
  filterTerjualRows,
  isCurrentYearMonth,
  isExcludedTwoSheetCategory,
  sortTwoSheetRows,
  type TwoSheetInventoryRow,
} from "./olsera-inventory-two-sheet-export.ts";
import type { InventoryProductInput } from "./olsera-inventory-core.ts";
import type { OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";

const STORE_ID = 324175;

function product(overrides: Partial<InventoryProductInput>): InventoryProductInput {
  return {
    _id: `${STORE_ID}:${overrides.productId ?? 1}:0`,
    productId: 1,
    variantId: null,
    sku: null,
    barcode: null,
    name: "PRODUK",
    variantName: null,
    category: "KATEGORI",
    subCategory: null,
    uom: "PCS",
    storeId: STORE_ID,
    storeName: "BC Padel",
    active: true,
    trackInventory: true,
    sellPrice: 0,
    buyPrice: 0,
    lastBuyPrice: 0,
    stockQty: 0,
    holdQty: 0,
    lowStockAlert: null,
    isOutStock: false,
    modifiedTime: null,
    stockSyncTime: null,
    ...overrides,
  };
}

function snapshotDoc(overrides: Partial<OlseraInventoryMonthlySnapshotDocument>): OlseraInventoryMonthlySnapshotDocument {
  const now = new Date("2026-06-30T00:00:00.000Z");
  return {
    _id: `${STORE_ID}:2026:06:${overrides.productId ?? 1}:0`,
    storeId: STORE_ID,
    year: 2026,
    month: 6,
    snapshotDate: "2026-06-30",
    productId: 1,
    variantId: null,
    canonicalProductId: null,
    productName: "PRODUK",
    productSku: null,
    groupName: "KATEGORI",
    openingQty: 0,
    incomingQty: 0,
    returnQty: 0,
    salesQty: 0,
    outgoingQty: 0,
    closingQty: 0,
    source: "stockmovement-forward",
    status: "complete",
    diagnostics: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---- Kategori dikecualikan (LABERS exact, LAPANGAN substring), case-insensitive ----

test("isExcludedTwoSheetCategory: LABERS exact match, case-insensitive & trim", () => {
  assert.equal(isExcludedTwoSheetCategory("LABERS"), true);
  assert.equal(isExcludedTwoSheetCategory("labers"), true);
  assert.equal(isExcludedTwoSheetCategory("  Labers  "), true);
  assert.equal(isExcludedTwoSheetCategory("LABERS PREMIUM"), false); // exact match saja, bukan substring
});

test("isExcludedTwoSheetCategory: LAPANGAN substring match (mencakup LAPANGAN PADEL/PICKLEBALL dkk)", () => {
  assert.equal(isExcludedTwoSheetCategory("LAPANGAN PADEL"), true);
  assert.equal(isExcludedTwoSheetCategory("LAPANGAN PICKLEBALL"), true);
  assert.equal(isExcludedTwoSheetCategory("lapangan padel"), true);
  assert.equal(isExcludedTwoSheetCategory("Sewa Lapangan"), true);
});

test("isExcludedTwoSheetCategory: produk tanpa kategori (kosong/null) TIDAK otomatis dibuang", () => {
  assert.equal(isExcludedTwoSheetCategory(""), false);
  assert.equal(isExcludedTwoSheetCategory("   "), false);
  assert.equal(isExcludedTwoSheetCategory(null), false);
  assert.equal(isExcludedTwoSheetCategory(undefined), false);
});

test("isExcludedTwoSheetCategory: kategori lain (GRIP, MINUMAN, dst) tidak dikecualikan", () => {
  assert.equal(isExcludedTwoSheetCategory("GRIP"), false);
  assert.equal(isExcludedTwoSheetCategory("MINUMAN"), false);
});

// ---- buildTwoSheetInventoryRows: join katalog + snapshot ----

test("buildTwoSheetInventoryRows: produk aktif dengan snapshot memakai angka snapshot canonical, bukan movements", () => {
  const catalog = [product({ productId: 1, name: "GRIP LI-NING", category: "GRIP" })];
  const docs = [snapshotDoc({ productId: 1, productName: "GRIP LI-NING", groupName: "GRIP", openingQty: 18, incomingQty: 0, returnQty: 0, salesQty: 12, outgoingQty: 0, closingQty: 5 })];
  const rows = buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: docs, storeId: STORE_ID });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { opening: rows[0].openingQty, incoming: rows[0].incomingQty, sales: rows[0].salesQty, closing: rows[0].closingQty, hasSnapshot: rows[0].hasSnapshot },
    { opening: 18, incoming: 0, sales: 12, closing: 5, hasSnapshot: true },
  );
});

test("buildTwoSheetInventoryRows: bulan berjalan — produk aktif tanpa mutasi (tidak ada dokumen snapshot) TETAP muncul dengan 0, bukan hilang", () => {
  const catalog = [
    product({ productId: 1, name: "PRODUK BERMUTASI" }),
    product({ productId: 2, name: "PRODUK TANPA MUTASI" }),
  ];
  const docs = [snapshotDoc({ productId: 1, productName: "PRODUK BERMUTASI", salesQty: 5, closingQty: 10 })];
  const rows = buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: docs, storeId: STORE_ID, isCurrentMonth: true });
  assert.equal(rows.length, 2);
  const noMutation = rows.find((r) => r.name === "PRODUK TANPA MUTASI");
  assert.ok(noMutation);
  assert.equal(noMutation!.hasSnapshot, false);
  assert.deepEqual(
    { opening: noMutation!.openingQty, incoming: noMutation!.incomingQty, sales: noMutation!.salesQty, closing: noMutation!.closingQty },
    { opening: 0, incoming: 0, sales: 0, closing: 0 },
  );
});

test("buildTwoSheetInventoryRows: bulan lampau (default) — produk aktif SEKARANG tapi TANPA data stok bulan historis TIDAK otomatis dimasukkan", () => {
  const catalog = [
    product({ productId: 1, name: "PRODUK BERMUTASI" }),
    product({ productId: 2, name: "PRODUK AKTIF TANPA DATA HISTORIS" }),
  ];
  const docs = [snapshotDoc({ productId: 1, productName: "PRODUK BERMUTASI", salesQty: 5, closingQty: 10 })];
  const rows = buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: docs, storeId: STORE_ID });
  assert.deepEqual(rows.map((r) => r.name), ["PRODUK BERMUTASI"]);
});

test("buildTwoSheetInventoryRows: bulan lampau — produk historis dengan data stok TETAP muncul walau sekarang active:false", () => {
  const catalog = [product({ productId: 1, name: "PRODUK NONAKTIF SEKARANG", active: false })];
  const docs = [snapshotDoc({ productId: 1, productName: "PRODUK NONAKTIF SEKARANG", salesQty: 5, closingQty: 10 })];
  const rows = buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: docs, storeId: STORE_ID });
  assert.deepEqual(rows.map((r) => r.name), ["PRODUK NONAKTIF SEKARANG"]);
  assert.equal(rows[0].hasSnapshot, true);
});

test("buildTwoSheetInventoryRows: bulan lampau — produk historis dengan salesQty>0 dan active:false TETAP masuk Sheet Terjual", () => {
  const catalog = [product({ productId: 1, name: "PRODUK TERJUAL NONAKTIF", active: false })];
  const docs = [snapshotDoc({ productId: 1, productName: "PRODUK TERJUAL NONAKTIF", salesQty: 7, closingQty: 2 })];
  const rows = buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: docs, storeId: STORE_ID });
  assert.deepEqual(filterTerjualRows(rows).map((r) => r.name), ["PRODUK TERJUAL NONAKTIF"]);
});

test("buildTwoSheetInventoryRows: bulan berjalan — produk nonaktif dengan data stok bulan ini tetap masuk (bersama produk aktif), tanpa duplikat", () => {
  const catalog = [
    product({ productId: 1, name: "PRODUK AKTIF" }),
    product({ productId: 2, name: "PRODUK NONAKTIF BERDATA", active: false }),
  ];
  const docs = [
    snapshotDoc({ productId: 1, productName: "PRODUK AKTIF", salesQty: 1 }),
    snapshotDoc({ productId: 2, productName: "PRODUK NONAKTIF BERDATA", salesQty: 2 }),
  ];
  const rows = buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: docs, storeId: STORE_ID, isCurrentMonth: true });
  assert.deepEqual(rows.map((r) => r.name).sort(), ["PRODUK AKTIF", "PRODUK NONAKTIF BERDATA"]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});

test("isCurrentYearMonth: cocok dengan bulan/tahun WIB saat ini, bulan lain tidak", () => {
  const now = new Date("2026-08-15T10:00:00.000Z"); // WIB = UTC+7, masih 15 Agustus
  assert.equal(isCurrentYearMonth(2026, 8, now), true);
  assert.equal(isCurrentYearMonth(2026, 6, now), false);
  assert.equal(isCurrentYearMonth(2025, 8, now), false);
});

test("buildTwoSheetInventoryRows: nilai snapshot null (belum diketahui) TIDAK diubah jadi 0 — beda dari 'tidak ada dokumen sama sekali'", () => {
  const catalog = [product({ productId: 1, name: "PRODUK TIDAK LENGKAP" })];
  const docs = [snapshotDoc({ productId: 1, productName: "PRODUK TIDAK LENGKAP", openingQty: null, closingQty: null, status: "incomplete" })];
  const rows = buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: docs, storeId: STORE_ID });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasSnapshot, true);
  assert.equal(rows[0].openingQty, null);
  assert.equal(rows[0].closingQty, null);
});

test("buildTwoSheetInventoryRows: produk nonaktif TANPA data stok bulan ini tidak dimasukkan (baik bulan lampau maupun bulan berjalan)", () => {
  const catalog = [product({ productId: 1, name: "PRODUK NONAKTIF", active: false })];
  assert.equal(buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: [], storeId: STORE_ID }).length, 0);
  assert.equal(buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: [], storeId: STORE_ID, isCurrentMonth: true }).length, 0);
});

test("buildTwoSheetInventoryRows: kategori LABERS dan LAPANGAN dikecualikan", () => {
  const catalog = [
    product({ productId: 1, name: "PRODUK LABERS", category: "LABERS" }),
    product({ productId: 2, name: "PRODUK LAPANGAN", category: "LAPANGAN PADEL" }),
    product({ productId: 3, name: "PRODUK NORMAL", category: "GRIP" }),
  ];
  const rows = buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: [], storeId: STORE_ID, isCurrentMonth: true });
  assert.deepEqual(rows.map((r) => r.name), ["PRODUK NORMAL"]);
});

test("buildTwoSheetInventoryRows: varian berbeda dari produk sama tidak tergabung (key beda, dua baris terpisah)", () => {
  const catalog = [
    product({ productId: 1, variantId: 1, name: "KAOS", variantName: "M", _id: `${STORE_ID}:1:1` }),
    product({ productId: 1, variantId: 2, name: "KAOS", variantName: "L", _id: `${STORE_ID}:1:2` }),
  ];
  const rows = buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: [], storeId: STORE_ID, isCurrentMonth: true });
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.key)), new Set([`${STORE_ID}:1:1`, `${STORE_ID}:1:2`]));
});

test("buildTwoSheetInventoryRows: tidak ada produk duplikat walau katalog mentah punya key sama", () => {
  const catalog = [product({ productId: 1, name: "A" }), product({ productId: 1, name: "A DUPLIKAT" })];
  const rows = buildTwoSheetInventoryRows({ catalogProducts: catalog, snapshotDocs: [], storeId: STORE_ID, isCurrentMonth: true });
  assert.equal(rows.length, 1);
});

// ---- Sorting & filter ----

test("sortTwoSheetRows: A-Z case-insensitive, deterministik", () => {
  const rows = [{ name: "zebra" }, { name: "Apel" }, { name: "mangga" }].map((r, i) => ({ ...r, key: String(i) } as TwoSheetInventoryRow));
  assert.deepEqual(sortTwoSheetRows(rows).map((r) => r.name), ["Apel", "mangga", "zebra"]);
});

test("sortTwoSheetRows: nama identik tetap urutan stabil lewat tie-break key", () => {
  const rows = [{ name: "SAMA", key: "b" }, { name: "SAMA", key: "a" }] as TwoSheetInventoryRow[];
  assert.deepEqual(sortTwoSheetRows(rows).map((r) => r.key), ["a", "b"]);
});

test("filterTerjualRows: hanya salesQty > 0, null/0 tidak ikut", () => {
  const rows = [
    { key: "1", salesQty: 5 },
    { key: "2", salesQty: 0 },
    { key: "3", salesQty: null },
    { key: "4", salesQty: -1 },
  ] as TwoSheetInventoryRow[];
  assert.deepEqual(filterTerjualRows(rows).map((r) => r.key), ["1"]);
});

// ---- Workbook builder: 2 sheet, nama sesuai bulan, header/format, angka identik lintas sheet ----

async function loadWorkbook(rows: TwoSheetInventoryRow[], year = 2026, month = 6) {
  const workbook = buildTwoSheetInventoryWorkbook({ year, month, rows });
  const bytes = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  return loaded;
}

function sheetDataRows(ws: ExcelJS.Worksheet) {
  const out: Record<string, unknown>[] = [];
  for (let r = 4; r <= ws.rowCount; r++) {
    const category = ws.getCell(r, 1).value;
    const name = ws.getCell(r, 2).value;
    if (name === "TOTAL" || category === "TOTAL") break;
    if (!name) continue;
    out.push({
      category,
      name,
      sku: ws.getCell(r, 3).value,
      uom: ws.getCell(r, 4).value,
      opening: ws.getCell(r, 5).value,
      incoming: ws.getCell(r, 6).value,
      ret: ws.getCell(r, 7).value,
      sales: ws.getCell(r, 8).value,
      outgoing: ws.getCell(r, 9).value,
      closing: ws.getCell(r, 10).value,
    });
  }
  return out;
}

test("buildTwoSheetInventoryWorkbook: tepat 2 sheet, nama sesuai bulan yang dipilih", async () => {
  const rows: TwoSheetInventoryRow[] = [
    { key: "1", name: "PRODUK A", sku: null, category: "GRIP", uom: null, openingQty: 1, incomingQty: 0, returnQty: 0, salesQty: 1, outgoingQty: 0, closingQty: 0, hasSnapshot: true },
  ];
  const wb = await loadWorkbook(rows, 2026, 6);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["Juni Terjual", "Juni Keseluruhan"]);
});

test("buildTwoSheetInventoryWorkbook: nama sheet mengikuti bulan lain (Agustus)", async () => {
  const wb = await loadWorkbook([], 2026, 8);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["Agustus Terjual", "Agustus Keseluruhan"]);
});

test("buildTwoSheetInventoryWorkbook: Sheet Terjual hanya salesQty>0, Sheet Keseluruhan seluruh produk (termasuk salesQty=0)", async () => {
  const rows: TwoSheetInventoryRow[] = [
    { key: "1", name: "TERJUAL", sku: null, category: "GRIP", uom: null, openingQty: 10, incomingQty: 0, returnQty: 0, salesQty: 3, outgoingQty: 0, closingQty: 7, hasSnapshot: true },
    { key: "2", name: "TANPA MUTASI", sku: null, category: "GRIP", uom: null, openingQty: 0, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0, closingQty: 0, hasSnapshot: false },
  ];
  const wb = await loadWorkbook(rows);
  const terjual = sheetDataRows(wb.getWorksheet("Juni Terjual")!);
  const keseluruhan = sheetDataRows(wb.getWorksheet("Juni Keseluruhan")!);
  assert.deepEqual(terjual.map((r) => r.name), ["TERJUAL"]);
  assert.deepEqual(keseluruhan.map((r) => r.name).sort(), ["TANPA MUTASI", "TERJUAL"]);
  // Angka 0 tetap tampil sebagai 0 (bukan blank/dash).
  const tanpaMutasi = keseluruhan.find((r) => r.name === "TANPA MUTASI")!;
  assert.equal(tanpaMutasi.opening, 0);
  assert.equal(tanpaMutasi.sales, 0);
  assert.equal(tanpaMutasi.closing, 0);
});

test("buildTwoSheetInventoryWorkbook: produk yang tampil di kedua sheet punya angka identik (beda hanya karena filter salesQty>0)", async () => {
  const rows: TwoSheetInventoryRow[] = [
    { key: "1", name: "GRIP LI-NING", sku: "SKU1", category: "GRIP", uom: "PCS", openingQty: 18, incomingQty: 0, returnQty: 0, salesQty: 12, outgoingQty: 0, closingQty: 5, hasSnapshot: true },
  ];
  const wb = await loadWorkbook(rows);
  const terjual = sheetDataRows(wb.getWorksheet("Juni Terjual")!)[0];
  const keseluruhan = sheetDataRows(wb.getWorksheet("Juni Keseluruhan")!)[0];
  assert.deepEqual(terjual, keseluruhan);
});

test("buildTwoSheetInventoryWorkbook: produk terurut A-Z (case-insensitive) di kedua sheet", async () => {
  const rows: TwoSheetInventoryRow[] = [
    { key: "1", name: "zebra", sku: null, category: "GRIP", uom: null, openingQty: 1, incomingQty: 0, returnQty: 0, salesQty: 1, outgoingQty: 0, closingQty: 0, hasSnapshot: true },
    { key: "2", name: "Apel", sku: null, category: "GRIP", uom: null, openingQty: 1, incomingQty: 0, returnQty: 0, salesQty: 1, outgoingQty: 0, closingQty: 0, hasSnapshot: true },
    { key: "3", name: "mangga", sku: null, category: "GRIP", uom: null, openingQty: 1, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0, closingQty: 1, hasSnapshot: true },
  ];
  const wb = await loadWorkbook(rows);
  assert.deepEqual(sheetDataRows(wb.getWorksheet("Juni Keseluruhan")!).map((r) => r.name), ["Apel", "mangga", "zebra"]);
  assert.deepEqual(sheetDataRows(wb.getWorksheet("Juni Terjual")!).map((r) => r.name), ["Apel", "zebra"]);
});

test("buildTwoSheetInventoryWorkbook: header, freeze pane, autofilter, dan total statis (bukan formula Excel)", async () => {
  const rows: TwoSheetInventoryRow[] = [
    { key: "1", name: "A", sku: null, category: "GRIP", uom: null, openingQty: 10, incomingQty: 5, returnQty: 0, salesQty: 3, outgoingQty: 0, closingQty: 12, hasSnapshot: true },
    { key: "2", name: "B", sku: null, category: "GRIP", uom: null, openingQty: 4, incomingQty: 0, returnQty: 0, salesQty: 1, outgoingQty: 0, closingQty: 3, hasSnapshot: true },
  ];
  const wb = await loadWorkbook(rows);
  const ws = wb.getWorksheet("Juni Keseluruhan")!;
  assert.deepEqual(
    ["Kategori", "Produk", "SKU", "Satuan", "Stok Awal", "Barang Masuk", "Retur", "Penjualan", "Barang Keluar", "Sisa Stok"],
    Array.from({ length: 10 }, (_, i) => String(ws.getCell(3, i + 1).value)),
  );
  assert.ok(ws.getCell(3, 1).font?.bold);
  assert.equal(ws.views[0]?.state, "frozen");
  assert.ok(ws.autoFilter);
  // Total kolom "Stok Awal" ditulis sebagai angka statis (10+4=14), bukan formula.
  const totalRow = ws.rowCount;
  const totalCell = ws.getCell(totalRow, 5);
  assert.equal(totalCell.value, 14);
  assert.equal(typeof totalCell.value, "number"); // bukan {formula: "SUM(...)"}
});

test("buildTwoSheetInventoryWorkbook: TIDAK ada kolom Opname/created_by/created_time (tidak ada sumber canonical untuk itu)", async () => {
  const wb = await loadWorkbook([{ key: "1", name: "A", sku: null, category: "GRIP", uom: null, openingQty: 1, incomingQty: 0, returnQty: 0, salesQty: 1, outgoingQty: 0, closingQty: 0, hasSnapshot: true }]);
  const ws = wb.getWorksheet("Juni Keseluruhan")!;
  const headers = Array.from({ length: ws.columnCount }, (_, i) => String(ws.getCell(3, i + 1).value ?? ""));
  for (const banned of ["Opname", "Penyesuaian", "created_by", "created_time", "Dibuat Oleh", "Waktu Dibuat"]) {
    assert.equal(headers.some((h) => h.toLowerCase().includes(banned.toLowerCase())), false, `header "${banned}" seharusnya tidak ada`);
  }
});

// ---- Reuse: route & glue memakai ensureMonthlySnapshotChain (self-healing,
// idempotent) — bukan formula/backfill baru. Ini membuktikan item 13-15 dari
// checklist (bulan berjalan bisa dibuat lalu diekspor, export 2x tidak
// duplikat, bulan lain tidak berubah) diwarisi dari perilaku
// ensureMonthlySnapshotChain yang SUDAH diuji terpisah di
// lib/olsera-inventory-monthly-snapshot-store.test.ts — tidak ada logika
// idempotency/backfill baru ditulis di file ini.

test("generateTwoSheetInventoryExport memakai ensureMonthlySnapshotChain (self-healing on-demand, reuse, bukan logic baru)", async () => {
  const source = readFileSync(new URL("./olsera-inventory-two-sheet-export.ts", import.meta.url), "utf8");
  assert.ok(source.includes("import { ensureMonthlySnapshotChain } from \"./olsera-inventory-monthly-snapshot-store.ts\";"));
  assert.ok(source.includes("const chain = await ensureMonthlySnapshotChain({ year: input.year, month: input.month });"));
  // Tidak ada pemanggilan olsera_inventory_movements sebagai sumber angka stok bulanan.
  assert.equal(source.includes("olseraInventoryMovements"), false);
});

test("route export/monthly-auto memakai generateTwoSheetInventoryExport dan nama file Inventori-YYYY-MM.xlsx", () => {
  const source = readFileSync(new URL("../app/api/olsera/inventory/export/monthly-auto/route.ts", import.meta.url), "utf8");
  assert.ok(source.includes("generateTwoSheetInventoryExport"));
  assert.ok(source.includes("`Inventori-${params.data.year}-${String(params.data.month).padStart(2, \"0\")}.xlsx`"));
});
