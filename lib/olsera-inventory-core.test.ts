// Test unit helper Inventori Olsera. Jalankan: npm run test:olsera-inventory
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNameIndex,
  buildPendingDates,
  computeConsistency,
  dateRangeList,
  flattenOlseraProduct,
  inventoryValueFor,
  normalizeItemName,
  stockStatusFor,
  summarizeInventory,
  toInventoryNumber,
  DEFAULT_LOW_STOCK_THRESHOLD,
  INVENTORY_BASELINE_DATE,
  type InventoryProductInput,
} from "./olsera-inventory-core.ts";

function makeProduct(overrides: Partial<InventoryProductInput>): InventoryProductInput {
  return {
    _id: "324175:1:0",
    productId: 1,
    variantId: null,
    sku: "SKU-1",
    barcode: null,
    name: "PRODUK",
    variantName: null,
    category: "MINUMAN",
    subCategory: null,
    uom: "pcs",
    storeId: 324175,
    storeName: "BC PADEL CLUB",
    active: true,
    trackInventory: true,
    sellPrice: 10000,
    buyPrice: 4000,
    lastBuyPrice: 4000,
    stockQty: 10,
    holdQty: 0,
    lowStockAlert: null,
    isOutStock: false,
    modifiedTime: null,
    stockSyncTime: null,
    ...overrides,
  };
}

test("baseline tetap 1 Februari 2026", () => {
  assert.equal(INVENTORY_BASELINE_DATE, "2026-02-01");
});

test("toInventoryNumber: string desimal titik & string kosong", () => {
  assert.equal(toInventoryNumber("78585.42"), 78585.42);
  assert.equal(toInventoryNumber("0"), 0);
  assert.equal(toInventoryNumber(""), 0);
  assert.equal(toInventoryNumber(null), 0);
  assert.equal(toInventoryNumber(12), 12);
});

test("flatten: produk tanpa variant → satu baris dengan field lengkap", () => {
  const rows = flattenOlseraProduct({
    id: 118420650,
    name: "YONEX SHORTS",
    sku: "",
    klasifikasi: "CELANA PRIA",
    category_name: "Others",
    store_id: 324175,
    store_name: "BC PADEL CLUB",
    track_inventory: 1,
    has_variant: 0,
    published: 1,
    stock_qty: "3",
    hold_qty: "0",
    low_stock_alert: "0",
    buy_price: "78585.42",
    last_buy_price: "0.00",
    sell_price: "150000.00",
    sell_price_pos: "150000.00",
    is_out_stock: 0,
    barcode: null,
    uom: "",
    modified_time: "2026-07-03 09:47:51",
    stock_sync_time: "2026-07-03 09:47:51",
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row._id, "324175:118420650:0");
  assert.equal(row.variantId, null);
  assert.equal(row.sku, null); // sku kosong → null
  assert.equal(row.category, "CELANA PRIA");
  assert.equal(row.subCategory, "Others");
  assert.equal(row.stockQty, 3);
  assert.equal(row.buyPrice, 78585.42);
  assert.equal(row.sellPrice, 150000);
  assert.equal(row.lowStockAlert, null); // 0 → null (threshold default)
  assert.equal(row.trackInventory, true);
  assert.equal(row.active, true);
});

test("flatten: produk ber-variant → satu baris per variant dengan stok/harga variant", () => {
  const rows = flattenOlseraProduct({
    id: 113421321,
    name: "SEWA RAKET",
    sku: "RAKET",
    klasifikasi: "LABERS",
    store_id: 324175,
    track_inventory: 1,
    has_variant: 1,
    published: 1,
    low_stock_alert: "2",
    variants: [
      { id: 62562829, sku: "", name: "1 Jam,", stock_qty: 4, hold_qty: 0, buy_price: "1000.00", last_buy_price: "0.00", sell_price: "50000.00", sell_price_pos: "50000.00", status: "A", is_out_stock: 0, variant_barcode: null },
      { id: 62562830, sku: "RAKET-2", name: "2 Jam", stock_qty: 0, hold_qty: 0, buy_price: "0.00", sell_price: "90000.00", status: "A", is_out_stock: 1 },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]._id, "324175:113421321:62562829");
  assert.equal(rows[0].variantName, "1 Jam,");
  assert.equal(rows[0].sku, "RAKET"); // fallback ke sku produk
  assert.equal(rows[0].stockQty, 4);
  assert.equal(rows[0].buyPrice, 1000);
  assert.equal(rows[0].lowStockAlert, 2);
  assert.equal(rows[1].sku, "RAKET-2");
  assert.equal(rows[1].isOutStock, true);
});

test("flatten: produk tanpa kategori & tanpa harga modal tetap valid", () => {
  const rows = flattenOlseraProduct({ id: 5, name: "X", has_variant: 0, published: 0, klasifikasi: "" });
  assert.equal(rows[0].category, "(tanpa klasifikasi)");
  assert.equal(rows[0].buyPrice, 0);
  assert.equal(rows[0].active, false);
});

test("status stok: aman / hampir habis / habis / data tidak lengkap", () => {
  assert.equal(stockStatusFor(makeProduct({ stockQty: 10 })), "Aman");
  assert.equal(stockStatusFor(makeProduct({ stockQty: DEFAULT_LOW_STOCK_THRESHOLD })), "Hampir Habis");
  assert.equal(stockStatusFor(makeProduct({ stockQty: 0 })), "Habis");
  assert.equal(stockStatusFor(makeProduct({ stockQty: -2 })), "Habis"); // stok negatif = habis
  assert.equal(stockStatusFor(makeProduct({ trackInventory: false })), "Data Tidak Lengkap");
  // minimum stock Olsera dipakai bila tersedia
  assert.equal(stockStatusFor(makeProduct({ stockQty: 8, lowStockAlert: 10 })), "Hampir Habis");
  assert.equal(stockStatusFor(makeProduct({ stockQty: 8, lowStockAlert: 3 })), "Aman");
});

test("nilai persediaan = stok × harga modal", () => {
  assert.equal(inventoryValueFor(makeProduct({ stockQty: 7, buyPrice: 4000 })), 28000);
  assert.equal(inventoryValueFor(makeProduct({ stockQty: 0, buyPrice: 4000 })), 0);
});

test("summary: agregat dari data produk", () => {
  const summary = summarizeInventory([
    makeProduct({ _id: "a", stockQty: 10, buyPrice: 1000 }),
    makeProduct({ _id: "b", stockQty: 0, buyPrice: 500 }),
    makeProduct({ _id: "c", stockQty: 3, buyPrice: 200, lowStockAlert: 5 }),
    makeProduct({ _id: "d", trackInventory: false, active: false }),
  ]);
  assert.equal(summary.totalProducts, 4);
  assert.equal(summary.activeProducts, 3);
  assert.equal(summary.outOfStock, 1);
  assert.equal(summary.lowStock, 1);
  assert.equal(summary.totalStock, 13);
  assert.equal(summary.totalValue, 10 * 1000 + 0 + 3 * 200);
  assert.equal(summary.usesDefaultThreshold, true);
});

test("name index: produk polos dan ber-variant cocok dengan itemName order", () => {
  const index = buildNameIndex([
    makeProduct({ _id: "a", name: "POCARI SWEAT" }),
    makeProduct({ _id: "b", name: "SEWA RAKET", variantName: "1 Jam," }),
  ]);
  assert.equal(index.get(normalizeItemName("Pocari Sweat"))?._id, "a");
  assert.equal(index.get(normalizeItemName("SEWA RAKET - 1 Jam,"))?._id, "b");
  assert.equal(index.get(normalizeItemName("TIDAK ADA")), undefined);
});

test("konsistensi: cocok saat mutasi menjelaskan perubahan snapshot", () => {
  const row = computeConsistency({
    key: "a",
    sku: null,
    name: "POCARI",
    category: "MINUMAN",
    trackInventory: true,
    snapshots: [
      { date: "2026-07-10", stockQty: 20 },
      { date: "2026-07-14", stockQty: 15 },
    ],
    movements: [
      { date: "2026-07-12", qtyChange: -3 },
      { date: "2026-07-13", qtyChange: -2 },
    ],
  });
  assert.equal(row.startQty, 20);
  assert.equal(row.stockOut, 5);
  assert.equal(row.computedEndQty, 15);
  assert.equal(row.difference, 0);
  assert.equal(row.status, "Cocok");
});

test("konsistensi: selisih saat ada perubahan tak terekam", () => {
  const row = computeConsistency({
    key: "a",
    sku: null,
    name: "POCARI",
    category: "MINUMAN",
    trackInventory: true,
    snapshots: [
      { date: "2026-07-10", stockQty: 20 },
      { date: "2026-07-14", stockQty: 30 },
    ],
    movements: [{ date: "2026-07-12", qtyChange: -3 }],
  });
  assert.equal(row.computedEndQty, 17);
  assert.equal(row.difference, 13); // pembelian/adjustment tak terekam API
  assert.equal(row.status, "Selisih");
});

test("konsistensi: satu snapshot = histori tidak lengkap; tanpa snapshot = belum ada snapshot", () => {
  const single = computeConsistency({
    key: "a", sku: null, name: "X", category: "Y", trackInventory: true,
    snapshots: [{ date: "2026-07-14", stockQty: 5 }],
    movements: [],
  });
  assert.equal(single.status, "Histori Tidak Lengkap");
  const none = computeConsistency({
    key: "a", sku: null, name: "X", category: "Y", trackInventory: true,
    snapshots: [],
    movements: [],
  });
  assert.equal(none.status, "Belum Ada Snapshot");
});

test("dateRangeList & buildPendingDates: incremental + prioritas tanggal gagal, tanpa duplikat", () => {
  assert.deepEqual(dateRangeList("2026-07-12", "2026-07-14"), ["2026-07-12", "2026-07-13", "2026-07-14"]);
  const queue = buildPendingDates(["2026-06-20", "2026-07-13"], "2026-07-12", "2026-07-14");
  assert.deepEqual(queue, ["2026-06-20", "2026-07-13", "2026-07-12", "2026-07-14"]);
  // klik dua kali: antrian deterministik yang sama — upsert menjamin tanpa duplikat data.
  assert.deepEqual(queue, buildPendingDates(["2026-07-13", "2026-06-20"], "2026-07-12", "2026-07-14"));
});
