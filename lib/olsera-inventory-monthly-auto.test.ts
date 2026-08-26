// Test unit jalur OTOMATIS Export Inventori Bulanan. Mencakup: parsing baris
// stockmovement API, formula Barang Masuk/Keluar, prioritas matching
// (identity → SKU → nama → prefix-stripped → alias → ambigu/unmatched),
// audit produk "duplicate" (merge hanya bila SKU membuktikan sama),
// computeUnsyncedDates, pagination client (fetch di-mock), DAN
// buildMonthlyRowsFromMonthlySnapshots (sumber baris = dokumen
// olsera_inventory_monthly_snapshots, BUKAN lagi stockQty katalog hari ini —
// lihat lib/olsera-inventory-monthly-snapshot-*.ts untuk cara dokumen itu
// dihitung/backfill). Rekonsiliasi PENUH 60 produk Juni 2026 nyata ada di
// akhir file, dibangun dari dokumen snapshot fixture (bukan lagi dari baris
// stockmovement mentah), mencerminkan hasil bootstrap+backfill sesungguhnya.
// Jalankan: node --no-warnings --experimental-strip-types --test lib/olsera-inventory-monthly-auto.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateDailySales,
  buildMovementNameIndex,
  buildProductIdentityIndex,
  buildSkuIndex,
  computeBarangMasukFromStockMovement,
  computeKeluarFromStockMovement,
  computeUnsyncedDates,
  findDuplicateNamedProducts,
  matchStockMovementRowToProduct,
  parseStockMovementApiRow,
  resolveDuplicateNamedProducts,
  type StockMovementApiRow,
} from "./olsera-inventory-monthly-core.ts";
import { buildMonthlyInventoryWorkbook, buildMonthlyRowsFromMonthlySnapshots } from "./olsera-inventory-monthly-export.ts";
import type { InventoryProductInput } from "./olsera-inventory-core.ts";
import type { OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";

function product(overrides: Partial<InventoryProductInput>): InventoryProductInput {
  return {
    _id: "1:100:0",
    productId: 100,
    variantId: null,
    sku: null,
    barcode: null,
    name: "PRODUK A",
    variantName: null,
    category: "KATEGORI",
    subCategory: null,
    uom: null,
    storeId: 1,
    storeName: "Toko",
    active: true,
    trackInventory: true,
    sellPrice: 10000,
    buyPrice: 5000,
    lastBuyPrice: 5000,
    stockQty: 10,
    holdQty: 0,
    lowStockAlert: null,
    isOutStock: false,
    modifiedTime: null,
    stockSyncTime: null,
    ...overrides,
  };
}

function movementRow(overrides: Partial<StockMovementApiRow>): StockMovementApiRow {
  return {
    storeId: 1,
    storeName: "Toko",
    productId: 100,
    productGroupName: "GROUP",
    productName: "PRODUK A",
    productSku: null,
    productVariantId: null,
    productVariantName: null,
    productVariantSku: null,
    beginningQty: 0,
    incomingQty: 0,
    returnQty: 0,
    salesQty: 0,
    outgoingQty: 0,
    sisa: 0,
    ...overrides,
  };
}

function snapshotDoc(overrides: Partial<OlseraInventoryMonthlySnapshotDocument>): OlseraInventoryMonthlySnapshotDocument {
  const now = new Date("2026-07-21T00:00:00Z");
  return {
    _id: "1:2026:06:100:0",
    storeId: 1,
    year: 2026,
    month: 6,
    snapshotDate: "2026-06-30",
    productId: 100,
    variantId: null,
    canonicalProductId: null,
    productName: "PRODUK A",
    productSku: null,
    groupName: "GROUP",
    openingQty: 10,
    incomingQty: 0,
    returnQty: 0,
    salesQty: 0,
    outgoingQty: 0,
    closingQty: 10,
    source: "stockmovement-forward",
    status: "complete",
    diagnostics: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---- parseStockMovementApiRow ----

test("parseStockMovementApiRow: baris valid dipetakan lengkap", () => {
  const row = parseStockMovementApiRow({
    store_id: 324175,
    store_name: "BC PADEL CLUB",
    product_id: 106744934,
    product_group_name: "KAOS KAKI",
    product_name: "YONEX MEN SOCKS SSM-1285ID-MP6-S",
    product_sku: "",
    product_variant_id: null,
    product_variant_name: null,
    product_variant_sku: null,
    beginning_qty: 8,
    sum_incoming_qty: 0,
    sum_return_qty: 0,
    sum_sales_qty: 1,
    sum_outgoing_qty: 0,
    sisa: 7,
  });
  assert.ok(row);
  assert.equal(row?.productId, 106744934);
  assert.equal(row?.beginningQty, 8);
  assert.equal(row?.sisa, 7);
});

test("parseStockMovementApiRow: product_id hilang/tidak valid -> null (baris dilewati)", () => {
  assert.equal(parseStockMovementApiRow({ product_name: "TANPA ID" }), null);
  assert.equal(parseStockMovementApiRow({ product_id: "abc" }), null);
});

// ---- Formula Barang Masuk / Keluar (dipakai backfill ledger bulanan) ----

test("computeBarangMasukFromStockMovement: incoming + return", () => {
  assert.equal(computeBarangMasukFromStockMovement({ incomingQty: 633, returnQty: 0 }), 633);
});

test("computeKeluarFromStockMovement: outgoing API apa adanya", () => {
  assert.equal(computeKeluarFromStockMovement({ outgoingQty: 46 }), 46);
});

// ---- matchStockMovementRowToProduct: prioritas identity > SKU > nama > prefix-stripped > alias ----

test("matchStockMovementRowToProduct: identity menang meski nama beda", () => {
  const catalog = [product({ _id: "1:100:0", productId: 100, storeId: 1, name: "NAMA KATALOG BEDA" })];
  const identityIndex = buildProductIdentityIndex(catalog);
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const row = movementRow({ storeId: 1, productId: 100, productVariantId: null, productName: "NAMA API BEDA" });
  const result = matchStockMovementRowToProduct(row, identityIndex, skuIndex, nameIndex);
  assert.equal(result.method, "identity");
  assert.equal(result.product?._id, "1:100:0");
});

test("matchStockMovementRowToProduct: fallback SKU (kandidat tunggal)", () => {
  const catalog = [product({ _id: "1:999:0", productId: 999, sku: "SKU-X" })];
  const identityIndex = buildProductIdentityIndex(catalog);
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const row = movementRow({ storeId: 1, productId: 100, productSku: "sku-x" });
  const result = matchStockMovementRowToProduct(row, identityIndex, skuIndex, nameIndex);
  assert.equal(result.method, "sku");
  assert.equal(result.product?._id, "1:999:0");
});

test("matchStockMovementRowToProduct: fallback nama ternormalisasi", () => {
  const catalog = [product({ _id: "1:5:0", productId: 5, name: "BOLA PADEL ODEA" })];
  const identityIndex = buildProductIdentityIndex(catalog);
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const row = movementRow({ storeId: 9, productId: 999, productName: "  bola  padel odea " });
  const result = matchStockMovementRowToProduct(row, identityIndex, skuIndex, nameIndex);
  assert.equal(result.method, "name");
  assert.equal(result.product?._id, "1:5:0");
});

test("matchStockMovementRowToProduct: name-prefix-stripped — 'BOLA HEAD PRO ISI 3' (API) -> 'HEAD PRO ISI 3' (katalog)", () => {
  const catalog = [product({ _id: "1:6:0", productId: 6, name: "HEAD PRO ISI 3" })];
  const identityIndex = buildProductIdentityIndex(catalog);
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const row = movementRow({ storeId: 9, productId: 999, productName: "BOLA HEAD PRO ISI 3" });
  const result = matchStockMovementRowToProduct(row, identityIndex, skuIndex, nameIndex);
  assert.equal(result.method, "name-prefix-stripped");
  assert.equal(result.product?._id, "1:6:0");
});

test("matchStockMovementRowToProduct: name-prefix-stripped — 'BOLA PADEL HEAD PRO S+ ISI 3' -> 'HEAD PRO S+ ISI 3'", () => {
  const catalog = [product({ _id: "1:8:0", productId: 8, name: "HEAD PRO S+ ISI 3" })];
  const identityIndex = buildProductIdentityIndex(catalog);
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const row = movementRow({ storeId: 9, productId: 999, productName: "BOLA PADEL HEAD PRO S+ ISI 3" });
  const result = matchStockMovementRowToProduct(row, identityIndex, skuIndex, nameIndex);
  assert.equal(result.method, "name-prefix-stripped");
  assert.equal(result.product?._id, "1:8:0");
});

test("matchStockMovementRowToProduct: name-prefix-stripped — 'GRIP YONEX AC102' -> 'YONEX AC102'", () => {
  const catalog = [product({ _id: "1:9:0", productId: 9, name: "YONEX AC102" })];
  const identityIndex = buildProductIdentityIndex(catalog);
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const row = movementRow({ storeId: 9, productId: 999, productName: "GRIP YONEX AC102" });
  const result = matchStockMovementRowToProduct(row, identityIndex, skuIndex, nameIndex);
  assert.equal(result.method, "name-prefix-stripped");
  assert.equal(result.product?._id, "1:9:0");
});

// Entri alias nama ODEA dihapus 2026-08-26 (terverifikasi terhadap katalog
// produksi: tidak pernah bisa aktif — lihat STOCKMOVEMENT_NAME_ALIASES).
// Pemetaan identitas lama->baru ditangani olsera_product_aliases.
test("matchStockMovementRowToProduct: 'BOLA PADEL ODEA ROSE' (API) TIDAK lagi dipetakan ke 'BOLA PADEL ODEA' lewat alias nama", () => {
  const catalog = [product({ _id: "1:7:0", productId: 7, name: "BOLA PADEL ODEA" })];
  const identityIndex = buildProductIdentityIndex(catalog);
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const row = movementRow({ storeId: 9, productId: 999, productName: "BOLA PADEL ODEA ROSE" });
  const result = matchStockMovementRowToProduct(row, identityIndex, skuIndex, nameIndex);
  assert.equal(result.method, "unmatched");
  assert.equal(result.product, null);
});

test("matchStockMovementRowToProduct: ODEA ROSE TIDAK digabung dengan ODEA RED bila keduanya ada di katalog sebagai produk terpisah", () => {
  const catalog = [
    product({ _id: "1:7:0", productId: 7, name: "BOLA PADEL ODEA" }),
    product({ _id: "1:11:0", productId: 11, name: "BOLA PADEL ODEA RED" }),
  ];
  const identityIndex = buildProductIdentityIndex(catalog);
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  // Baris API utk ODEA RED (identity/SKU cocok tunggal) tidak boleh salah ke alias ODEA.
  const rowRed = movementRow({ storeId: 1, productId: 11, productName: "BOLA PADEL ODEA RED" });
  const resultRed = matchStockMovementRowToProduct(rowRed, identityIndex, skuIndex, nameIndex);
  assert.equal(resultRed.product?._id, "1:11:0");
  assert.notEqual(resultRed.product?._id, "1:7:0");
});

test("matchStockMovementRowToProduct: tidak ada yang cocok -> unmatched", () => {
  const catalog = [product({ _id: "1:1:0", productId: 1, name: "PRODUK LAIN" })];
  const identityIndex = buildProductIdentityIndex(catalog);
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const row = movementRow({ storeId: 9, productId: 999, productName: "TIDAK ADA DI KATALOG" });
  const result = matchStockMovementRowToProduct(row, identityIndex, skuIndex, nameIndex);
  assert.equal(result.method, "unmatched");
  assert.equal(result.product, null);
});

// ---- findDuplicateNamedProducts / resolveDuplicateNamedProducts ----

test("findDuplicateNamedProducts: nama mengandung 'duplicate' (case-insensitive) terdeteksi", () => {
  const catalog = [
    product({ _id: "1:1:0", productId: 1, name: "BOLA PADEL ODEA (duplicate)" }),
    product({ _id: "1:2:0", productId: 2, name: "Produk Duplicate Lama" }),
    product({ _id: "1:3:0", productId: 3, name: "Produk Normal" }),
  ];
  const found = findDuplicateNamedProducts(catalog);
  assert.equal(found.length, 2);
});

test("resolveDuplicateNamedProducts: SKU sama persis & tunggal dengan produk non-'duplicate' lain -> digabung (dikecualikan)", () => {
  const catalog = [
    product({ _id: "1:1:0", productId: 1, name: "PRODUK ASLI", sku: "SKU-A" }),
    product({ _id: "1:2:0", productId: 2, name: "PRODUK ASLI (duplicate)", sku: "SKU-A" }),
  ];
  const resolution = resolveDuplicateNamedProducts(catalog);
  assert.deepEqual(resolution.excludedIds, ["1:2:0"]);
  assert.equal(resolution.entries[0].resolution, "merged-into-canonical");
  assert.equal(resolution.entries[0].canonicalProductId, 1);
});

test("resolveDuplicateNamedProducts: tanpa SKU -> TIDAK digabung, perlu tinjauan manual (nama saja bukan bukti)", () => {
  const catalog = [
    product({ _id: "1:1:0", productId: 1, name: "PRODUK ASLI", sku: null }),
    product({ _id: "1:2:0", productId: 2, name: "PRODUK ASLI (duplicate)", sku: null }),
  ];
  const resolution = resolveDuplicateNamedProducts(catalog);
  assert.deepEqual(resolution.excludedIds, []);
  assert.equal(resolution.entries[0].resolution, "needs-manual-review");
});

test("resolveDuplicateNamedProducts: SKU sama tapi cocok >1 kandidat (ambigu) -> TIDAK digabung otomatis", () => {
  const catalog = [
    product({ _id: "1:1:0", productId: 1, name: "PRODUK A", sku: "SKU-A" }),
    product({ _id: "1:2:0", productId: 2, name: "PRODUK B", sku: "SKU-A" }),
    product({ _id: "1:3:0", productId: 3, name: "PRODUK (duplicate)", sku: "SKU-A" }),
  ];
  const resolution = resolveDuplicateNamedProducts(catalog);
  assert.deepEqual(resolution.excludedIds, []);
  assert.equal(resolution.entries[0].resolution, "needs-manual-review");
});

test("resolveDuplicateNamedProducts: ODEA ROSE (duplicate) vs ODEA RED — SKU BEDA -> TIDAK pernah digabung (produk warna berbeda tetap terpisah)", () => {
  const catalog = [
    product({ _id: "1:1:0", productId: 1, name: "BOLA PADEL ODEA RED", sku: "ODEA-RED" }),
    product({ _id: "1:2:0", productId: 2, name: "BOLA PADEL ODEA ROSE (duplicate)", sku: "ODEA-ROSE" }),
  ];
  const resolution = resolveDuplicateNamedProducts(catalog);
  assert.deepEqual(resolution.excludedIds, []);
  assert.equal(resolution.entries[0].resolution, "needs-manual-review");
});

// ---- computeUnsyncedDates ----

test("computeUnsyncedDates: tanggal yang tidak ada di olseraSyncedDays dilaporkan", () => {
  const result = computeUnsyncedDates("2026-07-01", "2026-07-05", "2026-07-05", ["2026-07-01", "2026-07-03"]);
  assert.deepEqual(result, ["2026-07-02", "2026-07-04", "2026-07-05"]);
});

test("computeUnsyncedDates: tanggal masa depan TIDAK dilaporkan belum sync", () => {
  const result = computeUnsyncedDates("2026-07-01", "2026-07-31", "2026-07-20", []);
  assert.equal(result.length, 20);
  assert.ok(!result.includes("2026-07-21"));
});

// ---- buildMonthlyRowsFromMonthlySnapshots: sumber baris = dokumen snapshot bulanan ----

test("buildMonthlyRowsFromMonthlySnapshots: dokumen complete (movement) -> Stok Awal/Barang Masuk/Keluar dari snapshot, Stock Akhir dari formula standar", () => {
  const doc = snapshotDoc({ openingQty: 10, incomingQty: 5, outgoingQty: 1, closingQty: 14, salesQty: 0 });
  const { rows } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [doc], catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stokAwal, 10);
  assert.equal(rows[0].barangMasuk, 5);
  assert.equal(rows[0].keluar, 1);
  assert.equal(rows[0].stockAkhirSistem, 14); // 10+5-0-1
  assert.equal(rows[0].balanceOlsera, 14);
  assert.equal(rows[0].stockDataSource, "stockmovement-forward");
});

test("buildMonthlyRowsFromMonthlySnapshots: carry-forward (tanpa movement bulan ini) -> masuk reconstructedStockData, bukan error", () => {
  const doc = snapshotDoc({ openingQty: 7, incomingQty: 0, outgoingQty: 0, closingQty: 7, salesQty: 0, source: "carry-forward" });
  const { rows, diagnostics } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [doc], catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  assert.equal(rows[0].stockDataSource, "carry-forward");
  assert.equal(rows[0].stokAwal, 7);
  assert.equal(rows[0].stockAkhirSistem, 7);
  assert.equal(diagnostics.reconstructedStockData.length, 1);
  assert.equal(diagnostics.incompleteStockData.length, 0);
});

test("buildMonthlyRowsFromMonthlySnapshots: snapshot belum tersedia (openingQty null) -> stokAwal/stockAkhir null, masuk incompleteStockData, TIDAK ditebak", () => {
  const doc = snapshotDoc({ openingQty: null, incomingQty: null, outgoingQty: null, closingQty: null, salesQty: null, status: "boundary-only" });
  const { rows, diagnostics } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [doc], catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  assert.equal(rows[0].stokAwal, null);
  assert.equal(rows[0].stockAkhirSistem, null);
  assert.equal(rows[0].stockDataSource, "no-snapshot");
  assert.equal(diagnostics.incompleteStockData.length, 1);
});

test("buildMonthlyRowsFromMonthlySnapshots: AYOSERA ada penjualan tapi snapshot belum tersedia -> unexplainedAyoseraSales (sinyal audit)", () => {
  const doc = snapshotDoc({ _id: "1:2026:06:200:0", productId: 200, openingQty: null, incomingQty: null, outgoingQty: null, closingQty: null, salesQty: null, status: "boundary-only" });
  const dailySalesByProductKey = aggregateDailySales([{ key: "1:200:0", date: "2026-06-05", qtyChange: -3 }], 2026, 6);
  const { rows, diagnostics } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [doc], catalogProducts: [], dailySalesByProductKey, days: 30 });
  assert.equal(rows[0].totalPenjualan, 3);
  assert.equal(diagnostics.unexplainedAyoseraSales.length, 1);
  assert.equal(diagnostics.unexplainedAyoseraSales[0].totalPenjualanAyosera, 3);
});

test("buildMonthlyRowsFromMonthlySnapshots: nama tampil dibersihkan dari suffix 'duplicate' (identitas produk tidak berubah)", () => {
  const doc = snapshotDoc({ productName: "YONEX SHORTS MEN # SM-J035-2906-RW1-S duplicate" });
  const { rows } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [doc], catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  assert.equal(rows[0].name, "YONEX SHORTS MEN # SM-J035-2906-RW1-S");
});

test("buildMonthlyRowsFromMonthlySnapshots: harga beli/jual diambil dari katalog SEKARANG via productId/variantId/storeId", () => {
  const doc = snapshotDoc({});
  const catalogProducts = [product({ _id: "1:100:0", productId: 100, storeId: 1, buyPrice: 5000, sellPrice: 9000 })];
  const { rows } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [doc], catalogProducts, dailySalesByProductKey: new Map(), days: 30 });
  assert.equal(rows[0].buyPrice, 5000);
  assert.equal(rows[0].sellPrice, 9000);
});

test("buildMonthlyRowsFromMonthlySnapshots: baris dikelompokkan per Group, nama alfabetis di dalam grup", () => {
  const docs = [
    snapshotDoc({ _id: "a", productId: 1, productName: "Z PRODUK", groupName: "GROUP B" }),
    snapshotDoc({ _id: "b", productId: 2, productName: "B PRODUK", groupName: "GROUP A" }),
    snapshotDoc({ _id: "c", productId: 3, productName: "A PRODUK", groupName: "GROUP A" }),
  ];
  const { rows } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: docs, catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  assert.deepEqual(
    rows.map((r) => `${r.group}/${r.name}`),
    ["GROUP B/Z PRODUK", "GROUP A/A PRODUK", "GROUP A/B PRODUK"],
  );
});

test("buildMonthlyRowsFromMonthlySnapshots: produk TANPA dokumen snapshot sama sekali TIDAK muncul (tidak dipaksa)", () => {
  // ODEA RED: nol aktivitas Juni (terverifikasi live) -> tidak ada dokumen
  // snapshot Juni untuknya -> daftar baris hanya berisi yang PUNYA dokumen.
  const odeaRose = snapshotDoc({ _id: "1:2026:06:116138490:0", productId: 116138490, productName: "BOLA PADEL ODEA ROSE", groupName: "BOLA PADEL", openingQty: 45, incomingQty: 24, outgoingQty: 2, closingQty: 21, salesQty: 46 });
  const { rows } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [odeaRose], catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "BOLA PADEL ODEA ROSE");
  assert.equal(rows.some((r) => r.name.includes("RED")), false);
});

test("buildMonthlyRowsFromMonthlySnapshots: Aturan Kedua Inventori — produk stok 0 TANPA aktivitas sama sekali (opening/incoming/return/sales/outgoing/closing semua 0) TIDAK masuk baris Laporan Stock Opname Bulanan", () => {
  const habis = snapshotDoc({ _id: "1:2026:08:900001:0", productId: 900001, productName: "PRODUK HABIS TANPA MUTASI", openingQty: 0, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0, closingQty: 0 });
  const aktif = snapshotDoc({ _id: "1:2026:08:900002:0", productId: 900002, productName: "PRODUK AKTIF", openingQty: 5, closingQty: 5 });
  const { rows } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [habis, aktif], catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "PRODUK AKTIF");
});

test("buildMonthlyRowsFromMonthlySnapshots: produk stok 0 tanpa aktivitas TAPI status boundary-only/incomplete tetap tampil (data belum lengkap, bukan bukti nol)", () => {
  const boundary = snapshotDoc({ _id: "1:2026:08:900003:0", productId: 900003, productName: "PRODUK BATAS DATA", openingQty: 0, closingQty: 0, status: "boundary-only" });
  const { rows } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [boundary], catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "PRODUK BATAS DATA");
});

test("buildMonthlyRowsFromMonthlySnapshots: Aturan Kedua hanya menyaring baris DITAMPILKAN, dokumen snapshot input tidak diubah/dihapus (histori & produk master tetap utuh)", () => {
  const habis = snapshotDoc({ _id: "1:2026:08:900001:0", productId: 900001, productName: "PRODUK HABIS TANPA MUTASI", openingQty: 0, closingQty: 0 });
  const docs = [habis];
  buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: docs, catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  assert.equal(docs.length, 1);
  assert.deepEqual(docs[0], habis);
});

for (const days of [28, 29, 30, 31]) {
  test(`buildMonthlyRowsFromMonthlySnapshots: bulan ${days} hari -> dailySales.length sama`, () => {
    const doc = snapshotDoc({});
    const { rows } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [doc], catalogProducts: [], dailySalesByProductKey: new Map(), days });
    assert.equal(rows[0].dailySales.length, days);
  });
}

// ---- Workbook: Aktual/Selisih kosong, label sumber (jalur snapshot) ----

test("buildMonthlyInventoryWorkbook: Aktual selalu kosong, Selisih formula IF per baris snapshot", () => {
  const doc = snapshotDoc({ openingQty: 10, closingQty: 10 });
  const { rows, diagnostics } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [doc], catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  const workbook = buildMonthlyInventoryWorkbook({
    year: 2026, month: 6, days: 30, rows, sourceLabel: "Olsera Open API",
    diagnostics: { headerErrors: [], skippedBlankRows: 0, rowsOutsidePeriod: [], duplicates: [], unmatchedOrAmbiguous: [], ...diagnostics },
  });
  const sheet = workbook.worksheets[0];
  const aktualCol = sheet.columnCount - 1;
  const selisihCol = sheet.columnCount;
  assert.equal(sheet.getRow(4).getCell(aktualCol).value, null);
  const formula = (sheet.getRow(4).getCell(selisihCol).value as { formula: string }).formula;
  assert.match(formula, /^IF\(.+="","",.+-.+\)$/);
});

test("buildMonthlyInventoryWorkbook: baris tanpa Stock Akhir (null) -> 'Data Tidak Lengkap' di Selisih, bukan formula", () => {
  const doc = snapshotDoc({ openingQty: null, incomingQty: null, outgoingQty: null, closingQty: null, salesQty: null, status: "boundary-only" });
  const { rows, diagnostics } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [doc], catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  const workbook = buildMonthlyInventoryWorkbook({
    year: 2026, month: 6, days: 30, rows, sourceLabel: "Olsera Open API",
    diagnostics: { headerErrors: [], skippedBlankRows: 0, rowsOutsidePeriod: [], duplicates: [], unmatchedOrAmbiguous: [], ...diagnostics },
  });
  const sheet = workbook.worksheets[0];
  const selisihCol = sheet.columnCount;
  assert.equal(sheet.getRow(4).getCell(selisihCol).value, "Data Tidak Lengkap");
});

test("buildMonthlyInventoryWorkbook: total Aktual/Selisih TIDAK PERNAH 0 saat semua Aktual kosong (IF(COUNT()=0,...))", () => {
  const docs = [
    snapshotDoc({ _id: "a", productId: 1, openingQty: 10, closingQty: 10 }),
    snapshotDoc({ _id: "b", productId: 2, openingQty: 5, closingQty: 5 }),
  ];
  const { rows, diagnostics } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: docs, catalogProducts: [], dailySalesByProductKey: new Map(), days: 30 });
  const workbook = buildMonthlyInventoryWorkbook({
    year: 2026, month: 6, days: 30, rows, sourceLabel: "Olsera Open API",
    diagnostics: { headerErrors: [], skippedBlankRows: 0, rowsOutsidePeriod: [], duplicates: [], unmatchedOrAmbiguous: [], ...diagnostics },
  });
  const sheet = workbook.worksheets[0];
  const totalRowNumber = 4 + rows.length;
  const aktualCol = sheet.columnCount - 1;
  const selisihCol = sheet.columnCount;
  const totalAktualFormula = (sheet.getRow(totalRowNumber).getCell(aktualCol).value as { formula: string }).formula;
  const totalSelisihFormula = (sheet.getRow(totalRowNumber).getCell(selisihCol).value as { formula: string }).formula;
  assert.match(totalAktualFormula, /^IF\(COUNT\(.+\)=0,"",SUM\(.+\)\)$/);
  assert.match(totalSelisihFormula, /^IF\(COUNT\(.+\)=0,"",SUM\(.+\)\)$/);
});

test("buildMonthlyInventoryWorkbook: sheet Diagnostik memakai label 'Olsera Open API', TIDAK PERNAH 'Olsera (file)', untuk jalur otomatis", () => {
  const doc = snapshotDoc({ openingQty: 10, closingQty: 10, salesQty: 5 });
  const dailySalesByProductKey = aggregateDailySales([{ key: "1:100:0", date: "2026-06-01", qtyChange: -1 }], 2026, 6);
  const { rows, diagnostics } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: [doc], catalogProducts: [], dailySalesByProductKey, days: 30 });
  assert.ok(diagnostics.salesMismatch.length > 0);
  const workbook = buildMonthlyInventoryWorkbook({
    year: 2026, month: 6, days: 30, rows, sourceLabel: "Olsera Open API",
    diagnostics: { headerErrors: [], skippedBlankRows: 0, rowsOutsidePeriod: [], duplicates: [], unmatchedOrAmbiguous: [], ...diagnostics },
  });
  const diagSheet = workbook.getWorksheet("Diagnostik Import")!;
  let foundOpenApi = false;
  let foundOldFile = false;
  diagSheet.eachRow((row) => row.eachCell((cell) => {
    const text = String(cell.value ?? "");
    if (text.includes("Olsera Open API")) foundOpenApi = true;
    if (text.includes("Olsera (file)")) foundOldFile = true;
  }));
  assert.equal(foundOpenApi, true);
  assert.equal(foundOldFile, false);
});

// ============================================================================
// Rekonsiliasi PENUH Juni 2026 nyata — dokumen snapshot fixture yang
// MENCERMINKAN hasil bootstrap+backfill sesungguhnya (bukan lagi baris
// stockmovement mentah): 60 produk, 12 grup, Stok Awal 3368, Barang Masuk
// 1916, Penjualan 1386, Keluar 46, Stock Akhir 3852 — cocok persis
// doc export/INVENTORI.xlsx sheet JUNI'26. Nama produk memakai bentuk
// KATALOG (hasil matching sudah terjadi saat backfill, bukan lagi di sini).
// ============================================================================

// [group, name, opening, incoming, sales, outgoing, closing]
const MOVED_ROWS: [string, string, number, number, number, number, number][] = [
  ["MINUMAN", "NESTLE PURE LIFE 1500ML", 59, 633, 426, 12, 254],
  ["BOLA PADEL", "BOLA AMA PINK ISI 2", 15, 0, 3, 0, 12],
  ["MINUMAN", "NESTLE PURE LIFE 600ML", 402, 48, 298, 9, 143],
  ["GRIP", "OVERGRIPS WILSON", 93, 2, 43, 0, 52],
  ["BOLA PADEL", "BOLA PADEL ODEA ROSE", 45, 24, 46, 2, 21], // laporan resmi menyebutnya "BOLA PADEL ODEA"
  ["MINUMAN", "POCARI SWEAT PET 900ML", 118, 150, 92, 16, 160],
  ["MINUMAN", "POCARI SWEAT PET 500 ML", 27, 617, 172, 1, 471],
  ["MINUMAN", "POCARI ION WATER 500ML", 207, 240, 162, 5, 280],
  ["GRIP", "GRIP LI-NING", 18, 0, 12, 1, 5],
  ["SNACK", "SOY JOY MULTI VARIANT", 25, 90, 53, 0, 62],
  ["SNACK", "PERMEN HACKER", 8, 36, 19, 0, 25],
  ["KAOS KAKI", "YONEX LADIES SOCKS # SSL-2859R-S", 8, 0, 2, 0, 6],
  ["BAJU PRIA", "YONEX MEN POLO T-SHIRT # PM-P064-2626-EASY3-S", 15, 0, 3, 0, 12],
  ["BOLA PADEL", "BOLA BULLPADEL PREMIUM PRO ISI 3", 43, 0, 2, 0, 41],
  ["SKORT WANITA", "YONEX LADIES SKORT #SKL-P061-2846-SOLID-S", 23, 0, 4, 0, 19],
  ["BOLA PADEL", "HEAD PRO ISI 3", 2, 2, 1, 0, 3],
  ["BOLA PADEL", "HEAD PRO S+ ISI 3", 4, 26, 4, 0, 26],
  ["GRIP", "YONEX AC102", 19, 0, 5, 0, 14],
  ["KAOS KAKI", "YONEX MEN SOCKS SSM-1086ID-MP6-S", 10, 0, 3, 0, 7],
  ["TOPI", "YONEX  WOMEN CAP SILICON", 53, 0, 2, 0, 51],
  ["CELANA PRIA", "YONEX MENS SHORTS # SM-P061-3085-RW2-S", 3, 0, 3, 0, 0],
  ["BAJU PRIA", "YONEX POLO MEN # PM-P064-2736-EASY4-S", 13, 0, 3, 0, 10],
  ["KAOS KAKI", "YONEX LADIES SOCKS # SSL-2860R-S", 4, 0, 3, 0, 1],
  ["KAOS KAKI", "YONEX SOCKS SSM-1055ID-MP6-SR", 20, 0, 3, 0, 17],
  ["BOLA PADEL", "BOLA ADIDAS SPEED RX ISI 3", 8, 24, 7, 0, 25],
  ["KAOS KAKI", "YONEX MEN SOCKS SSM-1255ID-MP6-SR", 1, 0, 1, 0, 0],
  ["KAOS KAKI", "KAOS KAKI NOX SOCKS SHORT", 0, 2, 0, 0, 2],
  ["KAOS KAKI", "KAOS KAKI NOX SOCKS LONG", 0, 10, 2, 0, 8],
  ["KAOS KAKI", "YONEX MEN SOCKS SSM-1284ID-MP6-S", 29, 0, 2, 0, 27],
  ["SKORT WANITA", "SKORT PADEL VARIASI", 0, 12, 2, 0, 10],
  ["KAOS KAKI", "YONEX MEN SOCKS SSM-1855ID-MP6-SR", 25, 0, 1, 0, 24],
  ["KAOS KAKI", "YONEX MEN SOCKS SSM-1285ID-MP6-S", 13, 0, 3, 0, 10],
  ["RAKET PADEL", "Bullpadel Indiga Mundial Argentina LTD 1988", 2, 0, 1, 0, 1],
];

// [group, name, begin, akhir] — flat (carry-forward, tidak bergerak Juni)
const FLAT_ROWS: [string, string, number, number][] = [
  ["RAKET PADEL", "BULLPADEL INDIGA W 25-350-360G WHITE", 0, 0],
  ["RAKET PADEL", "RAKET BULLPADEL VERTEX 05 JR GIRL 2026", 0, 0],
  ["THERMOFLASK", "YONEX MALAYSIA OPEN THERMO FLASK # TF-Y037-850-004-25-S", 28, 28],
  ["RAKET PADEL", "Bullpadel Sniper 2.0 Power Black 2026", 0, 0],
  ["RAKET PADEL", "Bullpadel Sniper 2.0 Power Light Blue 2026", 2, 2],
  ["RAKET PADEL", "Bullpadel Sniper 2.0 Oil Petroleo 2026", 1, 1],
  ["RAKET PADEL", "Bullpadel Indiga Discover PWR 2025", 0, 0],
  ["RAKET PADEL", "Nox X ONE Black", 1, 1],
  ["RAKET PADEL", "Siux Beat Hybrid 2", 0, 0],
  ["RAKET PADEL", "Siux Beat Hybrid Air 2", 0, 0],
  ["RAKET PADEL", "BULLPADEL IONIC CONTROL 25-365-375G NAVY", 1, 1],
  ["RAKET PADEL", "BULLPADEL K2 POWER 25-360-370G NAVY", 1, 1],
  ["RAKET PADEL", "BULLPADEL BP10 EVO 25-360-370G GREY", 1, 1],
  ["RAKET PADEL", "BULLPADEL FLOW LIGHT 25-350-360G RED", 1, 1],
  ["RAKET PADEL", "BULLPADEL INDIGA PWR 25-360-370G WHITE", 1, 1],
  ["RAKET PADEL", "BULLPADEL INDIGA CTR 25-360-370G GREEN", 1, 1],
  ["RAKET PADEL", "BULLPADEL HACK JR 25-335-345G GREEN", 1, 1],
  ["RAKET PADEL", "BULLPADEL VERTEX JR 25-335-345G BLACK", 1, 1],
  ["RAKET PADEL", "BULLPADEL HACK 04 COMFORT 2026-355-360 GREY/GREEN", 1, 1],
  ["RAKET PADEL", "BULLPADEL VERTEX 05 COMFORT 2026-360-370 BLACK/BLUE", 0, 0],
  ["RAKET PADEL", "BULLPADEL XPLO COMFORT 2026-360-370 BLACK/GREY", 1, 1],
  ["RAKET PADEL", "BULLPADEL FLOW LEGEND 2026-345-350 GREY/WHITE", 1, 1],
  ["RAKET PADEL", "RAKET PADEL ADIDAS 2026 MATCH", 4, 4],
  ["RAKET PADEL", "RAKET BULLPADEL HACK 04 JR 2026", 5, 5],
  ["GELAS/CUP", "CUP 22OZ", 1000, 1000],
  ["GELAS/CUP", "HOT CUP KRAFT 12OZ", 1000, 1000],
];

// Kasus khusus: absen dari SEMUA jendela stockmovement Juni (terverifikasi
// live), tapi TERBUKTI eksis sebelum Juni (order_items) -> carry-forward
// dengan nilai dari sumber lain yang valid (bukan current-snapshot hari ini).
const SHORTS_SPECIAL = { group: "CELANA PRIA", name: "YONEX SHORTS MEN # SM-J035-2906-RW1-S", opening: 4, closing: 1, sold: 3 };

function buildJuneSnapshotFixture(): OlseraInventoryMonthlySnapshotDocument[] {
  const now = new Date("2026-07-21T00:00:00Z");
  let productId = 4000;
  const docs: OlseraInventoryMonthlySnapshotDocument[] = [];

  for (const [group, name, opening, incoming, sales, outgoing, closing] of MOVED_ROWS) {
    productId += 1;
    docs.push(
      snapshotDoc({
        _id: `1:2026:06:${productId}:0`,
        productId,
        productName: name,
        groupName: group,
        openingQty: opening,
        incomingQty: incoming,
        returnQty: 0,
        salesQty: sales,
        outgoingQty: outgoing,
        closingQty: closing,
        source: "stockmovement-forward",
        status: "complete",
      }),
    );
  }

  for (const [group, name, opening, closing] of FLAT_ROWS) {
    productId += 1;
    docs.push(
      snapshotDoc({
        _id: `1:2026:06:${productId}:0`,
        productId,
        productName: name,
        groupName: group,
        openingQty: opening,
        incomingQty: 0,
        returnQty: 0,
        salesQty: 0,
        outgoingQty: 0,
        closingQty: closing,
        source: "carry-forward",
        status: "complete",
      }),
    );
  }

  productId += 1;
  docs.push(
    snapshotDoc({
      _id: `1:2026:06:${productId}:0`,
      productId,
      productName: SHORTS_SPECIAL.name,
      groupName: SHORTS_SPECIAL.group,
      openingQty: SHORTS_SPECIAL.opening,
      incomingQty: 0,
      returnQty: 0,
      salesQty: SHORTS_SPECIAL.sold,
      outgoingQty: 0,
      closingQty: SHORTS_SPECIAL.closing,
      source: "carry-forward",
      status: "complete",
      diagnostics: ["Absen dari seluruh jendela stockmovement Juni — direkonstruksi dari sumber tervalidasi lain (bukan stockQty katalog hari ini)."],
    }),
  );

  void now;
  return docs;
}

function buildJuneDailySales(docs: OlseraInventoryMonthlySnapshotDocument[]) {
  const byName = new Map(docs.map((d) => [d.productName, d]));
  const movements: { key: string; date: string; qtyChange: number }[] = [];
  const DAILY_SALES: Record<string, number[]> = {
    "NESTLE PURE LIFE 1500ML": [10,20,10,17,11,19,17,16,10,15,8,9,9,25,20,14,10,26,8,11,17,10,10,7,15,11,21,26,16,8],
    "NESTLE PURE LIFE 600ML": [12,6,5,8,14,10,15,9,2,16,15,7,7,16,10,11,7,12,13,8,23,4,2,9,2,11,11,16,11,6],
    "POCARI SWEAT PET 500 ML": [10,6,5,4,5,9,6,3,9,8,3,4,4,3,7,11,3,7,4,5,14,5,5,3,5,4,8,3,8,1],
    "POCARI SWEAT PET 900ML": [4,3,6,4,4,5,4,2,4,2,4,1,2,3,2,2,1,4,5,2,8,3,3,2,0,3,2,4,3,0],
    "POCARI ION WATER 500ML": [12,7,4,11,5,11,10,5,9,4,4,0,6,5,4,4,1,3,1,7,13,1,6,3,4,6,9,4,3,0],
    "OVERGRIPS WILSON": [6,0,4,0,1,2,0,0,0,2,1,1,0,0,0,2,3,0,2,3,4,2,1,1,0,0,2,2,2,2],
    "GRIP LI-NING": [2,0,1,0,1,2,0,0,0,0,0,0,0,0,0,0,0,3,0,0,0,2,0,0,1,0,0,0,0,0],
    "BOLA PADEL ODEA ROSE": [1,1,3,2,0,2,5,2,0,3,1,4,2,3,0,0,0,1,0,2,3,1,1,2,2,1,2,2,0,0],
    "BOLA AMA PINK ISI 2": [1,0,0,0,0,0,0,1,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "SOY JOY MULTI VARIANT": [1,0,0,2,1,2,5,1,3,2,5,1,0,0,1,8,0,4,1,0,1,2,2,3,1,1,1,3,1,1],
    "PERMEN HACKER": [0,1,0,2,0,0,0,0,0,1,0,0,0,0,0,0,1,0,1,0,1,1,0,1,1,7,0,1,1,0],
    "YONEX AC102": [0,0,2,0,0,0,0,1,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0],
    "YONEX  WOMEN CAP SILICON": [0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "BOLA BULLPADEL PREMIUM PRO ISI 3": [0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0],
    "BOLA ADIDAS SPEED RX ISI 3": [0,0,0,0,0,0,0,0,1,0,1,0,1,1,0,0,2,0,0,1,0,0,0,0,0,0,0,0,0,0],
    "HEAD PRO ISI 3": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0],
    "HEAD PRO S+ ISI 3": [0,0,0,0,0,0,1,0,0,0,0,0,0,1,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0],
    "YONEX LADIES SOCKS # SSL-2859R-S": [0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "YONEX LADIES SOCKS # SSL-2860R-S": [0,0,0,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "YONEX MEN POLO T-SHIRT # PM-P064-2626-EASY3-S": [0,1,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "YONEX POLO MEN # PM-P064-2736-EASY4-S": [0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0],
    "YONEX LADIES SKORT #SKL-P061-2846-SOLID-S": [0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0],
    "SKORT PADEL VARIASI": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0],
    "YONEX MENS SHORTS # SM-P061-3085-RW2-S": [0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,1,0,0,0,0,0,0],
    "YONEX MEN SOCKS SSM-1086ID-MP6-S": [0,0,0,1,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "YONEX SOCKS SSM-1055ID-MP6-SR": [0,0,0,0,0,0,0,0,2,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "YONEX MEN SOCKS SSM-1255ID-MP6-SR": [0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "KAOS KAKI NOX SOCKS LONG": [0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0],
    "KAOS KAKI NOX SOCKS SHORT": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "YONEX MEN SOCKS SSM-1284ID-MP6-S": [0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0],
    "YONEX MEN SOCKS SSM-1855ID-MP6-SR": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0],
    "YONEX MEN SOCKS SSM-1285ID-MP6-S": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,1,1,0,0],
    "Bullpadel Indiga Mundial Argentina LTD 1988": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0],
    "YONEX SHORTS MEN # SM-J035-2906-RW1-S": [0,0,1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0],
  };
  for (const [name, days] of Object.entries(DAILY_SALES)) {
    const doc = byName.get(name);
    if (!doc) continue;
    const key = `${doc.storeId}:${doc.productId}:${doc.variantId ?? 0}`;
    days.forEach((qty, dayIndex) => {
      if (!qty) return;
      movements.push({ key, date: `2026-06-${String(dayIndex + 1).padStart(2, "0")}`, qtyChange: -qty });
    });
  }
  return aggregateDailySales(movements, 2026, 6);
}

test("Rekonsiliasi Juni 2026 PENUH: 53 produk aktif (7 dari 60 produk fixture tanpa aktivitas sama sekali disembunyikan oleh Aturan Kedua), total tetap cocok dengan doc export/INVENTORI.xlsx JUNI'26 (via dokumen snapshot bulanan)", () => {
  const docs = buildJuneSnapshotFixture();
  const dailySalesByProductKey = buildJuneDailySales(docs);
  const { rows } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: docs, catalogProducts: [], dailySalesByProductKey, days: 30 });

  // Aturan Kedua Inventori (docs/inventory.md) sekarang JUGA berlaku di
  // Laporan Stock Opname Bulanan: produk fixture yang opening/incoming/
  // return/sales/outgoing/closing-nya semua 0 tidak ikut baris — tapi karena
  // nilainya nol, total (di bawah) tidak berubah dari total 60-produk semula.
  assert.equal(rows.length, 53, `jumlah produk: ${rows.length} != 53`);
  const groups = new Set(rows.map((r) => r.group));
  assert.equal(groups.size, 12, `jumlah grup: ${groups.size} != 12`);

  const sumStokAwal = rows.reduce((s, r) => s + (r.stokAwal ?? 0), 0);
  const sumBarangMasuk = rows.reduce((s, r) => s + r.barangMasuk, 0);
  const sumPenjualan = rows.reduce((s, r) => s + r.totalPenjualan, 0);
  const sumKeluar = rows.reduce((s, r) => s + r.keluar, 0);
  const sumStockAkhir = rows.reduce((s, r) => s + (r.stockAkhirSistem ?? 0), 0);

  assert.equal(sumStokAwal, 3368, `Stok Awal: ${sumStokAwal} != 3368`);
  assert.equal(sumBarangMasuk, 1916, `Barang Masuk: ${sumBarangMasuk} != 1916`);
  assert.equal(sumPenjualan, 1386, `Penjualan: ${sumPenjualan} != 1386`);
  assert.equal(sumKeluar, 46, `Keluar: ${sumKeluar} != 46`);
  assert.equal(sumStockAkhir, 3852, `Stock Akhir: ${sumStockAkhir} != 3852`);
});

test("Rekonsiliasi Juni 2026: YONEX SHORTS MEN (kasus khusus) — Total Penjualan AYOSERA = 3, Stock Akhir = 1", () => {
  const docs = buildJuneSnapshotFixture();
  const dailySalesByProductKey = buildJuneDailySales(docs);
  const { rows } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: docs, catalogProducts: [], dailySalesByProductKey, days: 30 });
  const shorts = rows.find((r) => r.name === SHORTS_SPECIAL.name)!;
  assert.equal(shorts.totalPenjualan, 3);
  assert.equal(shorts.stokAwal, 4);
  assert.equal(shorts.stockAkhirSistem, 1);
});

test("Rekonsiliasi Juni 2026: baris tampil bernama 'BOLA PADEL ODEA ROSE' (bukan 'ODEA RED'), Penjualan = 46", () => {
  const docs = buildJuneSnapshotFixture();
  const dailySalesByProductKey = buildJuneDailySales(docs);
  const { rows } = buildMonthlyRowsFromMonthlySnapshots({ snapshotDocs: docs, catalogProducts: [], dailySalesByProductKey, days: 30 });
  const odea = rows.find((r) => r.name === "BOLA PADEL ODEA ROSE")!;
  assert.ok(odea);
  assert.equal(odea.totalPenjualan, 46);
  assert.equal(rows.some((r) => r.name.includes("ODEA RED")), false);
});

// ---- Pagination client (fetchStockMovementRange) — fetch di-mock ----

test("fetchStockMovementRange: menarik seluruh halaman sampai meta.last_page", async (t) => {
  process.env.OLSERA_APP_ID = "test-app-id";
  process.env.OLSERA_SECRET_KEY = "test-secret";
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/token")) {
      return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
    }
    const page = new URL(url).searchParams.get("page");
    if (page === "1") {
      return new Response(
        JSON.stringify({
          data: [
            { product_id: 1, product_name: "A", beginning_qty: 1, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 0, sum_outgoing_qty: 0, sisa: 1 },
            { product_id: 2, product_name: "B", beginning_qty: 2, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 0, sum_outgoing_qty: 0, sisa: 2 },
          ],
          meta: { current_page: 1, last_page: 2 },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        data: [{ product_id: 3, product_name: "C", beginning_qty: 3, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 0, sum_outgoing_qty: 0, sisa: 3 }],
        meta: { current_page: 2, last_page: 2 },
      }),
      { status: 200 },
    );
  });
  const { fetchStockMovementRange } = await import("./olsera-inventory-stockmovement.ts");
  const result = await fetchStockMovementRange("2026-06-01", "2026-06-30");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.rows.length, 3);
  assert.equal(calls.filter((u) => u.includes("stockmovement")).length, 2);
});

test("fetchStockMovementRange: 404 dianggap tidak ada data (bukan error)", async (t) => {
  process.env.OLSERA_APP_ID = "test-app-id";
  process.env.OLSERA_SECRET_KEY = "test-secret";
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/token")) return new Response(JSON.stringify({ access_token: "fake-token-2", expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
  const { fetchStockMovementRange } = await import("./olsera-inventory-stockmovement.ts");
  const result = await fetchStockMovementRange("2026-01-01", "2026-01-31");
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.rows, []);
});

test("fetchStockMovementRange: HTTP error non-recoverable (400) -> error, bukan dilempar", async (t) => {
  process.env.OLSERA_APP_ID = "test-app-id";
  process.env.OLSERA_SECRET_KEY = "test-secret";
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/token")) return new Response(JSON.stringify({ access_token: "fake-token-3", expires_in: 3600 }), { status: 200 });
    return new Response("bad request", { status: 400 });
  });
  const { fetchStockMovementRange } = await import("./olsera-inventory-stockmovement.ts");
  const result = await fetchStockMovementRange("2026-01-01", "2026-01-31");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /400/);
});
