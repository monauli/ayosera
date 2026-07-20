// Test unit helper murni Export Inventori Bulanan (Laporan Stock Opname).
// Jalankan: npm run test:olsera-inventory-monthly
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateDailySales,
  buildSkuIndex,
  computeDisplayedBarangMasuk,
  computeDisplayedKeluar,
  computeStockAkhirSistem,
  daysInMonth,
  detectDuplicateSummaryRows,
  findRowsOutsidePeriod,
  matchSummaryRowToProduct,
  monthDateRange,
  parseSummaryRows,
  stripGenericCategoryPrefix,
  validateSummaryHeader,
  buildMovementNameIndex,
  type InventoryProductInput,
  type SummaryRow,
} from "./olsera-inventory-monthly-core.ts";

// ---- daysInMonth: Februari, bulan 30 hari, bulan 31 hari ----

test("daysInMonth: Februari tahun kabisat = 29", () => {
  assert.equal(daysInMonth(2024, 2), 29);
});

test("daysInMonth: Februari tahun biasa = 28", () => {
  assert.equal(daysInMonth(2026, 2), 28);
});

test("daysInMonth: bulan 30 hari (Juni)", () => {
  assert.equal(daysInMonth(2026, 6), 30);
});

test("daysInMonth: bulan 31 hari (Juli)", () => {
  assert.equal(daysInMonth(2026, 7), 31);
});

test("monthDateRange: Juni 2026 menghasilkan rentang & jumlah hari benar", () => {
  assert.deepEqual(monthDateRange(2026, 6), { startDate: "2026-06-01", endDate: "2026-06-30", days: 30 });
});

// ---- Validasi struktur header ----

test("validateSummaryHeader: header persis sesuai spesifikasi Olsera tidak menghasilkan error", () => {
  const header = [
    "group", "product", "product sku", "product uom", "begining", "incoming",
    "return", "sales", "outgoing", "production_in", "production_out", "opname", "balance",
  ];
  assert.deepEqual(validateSummaryHeader(header), []);
});

test("validateSummaryHeader: kolom hilang/salah urutan dilaporkan", () => {
  const header = ["group", "product", "sales", "begining"];
  const errors = validateSummaryHeader(header);
  assert.ok(errors.length > 0);
  assert.match(errors[0], /product sku/);
});

// ---- parseSummaryRows ----

test("parseSummaryRows: baris kosong (tanpa nama produk) dilewati, bukan error", () => {
  const { rows, skippedBlankRows } = parseSummaryRows([
    ["MINUMAN", "NESTLE PURE LIFE 1500ML", "", "", 59, 633, 0, 426, 0, 0, 0, 12, 254, "ASYFA", "2026-06-01 07:02:52"],
    ["", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ]);
  assert.equal(rows.length, 1);
  assert.equal(skippedBlankRows, 1);
  assert.equal(rows[0].begining, 59);
  assert.equal(rows[0].opname, 12);
  assert.equal(rows[0].balance, 254);
});

// ---- Duplikasi & periode ----

test("detectDuplicateSummaryRows: baris group+produk+SKU sama terdeteksi", () => {
  const rows = [
    { rowIndex: 0, group: "MINUMAN", product: "AQUA 600ML", sku: "AQ600" } as SummaryRow,
    { rowIndex: 1, group: "MINUMAN", product: "AQUA 600ML", sku: "AQ600" } as SummaryRow,
    { rowIndex: 2, group: "MINUMAN", product: "AQUA 1500ML", sku: "AQ1500" } as SummaryRow,
  ];
  const dups = detectDuplicateSummaryRows(rows);
  assert.equal(dups.length, 1);
  assert.deepEqual(dups[0].rowIndexes, [0, 1]);
});

test("findRowsOutsidePeriod: created_time di luar rentang periode terdeteksi", () => {
  const rows = [
    { rowIndex: 0, createdTime: "2026-06-15 10:00:00" } as SummaryRow,
    { rowIndex: 1, createdTime: "2026-07-01 10:00:00" } as SummaryRow,
    { rowIndex: 2, createdTime: null } as SummaryRow,
  ];
  assert.deepEqual(findRowsOutsidePeriod(rows, "2026-06-01", "2026-06-30"), [1]);
});

// ---- Mapping product identity (SKU → nama, ambigu tidak dipaksakan) ----

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

test("matchSummaryRowToProduct: SKU cocok tunggal dipetakan via SKU", () => {
  const catalog = [product({ _id: "1:100:0", sku: "SKU-A" })];
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const result = matchSummaryRowToProduct({ product: "NAMA APAPUN", sku: "sku-a" }, skuIndex, nameIndex);
  assert.equal(result.method, "sku");
  assert.equal(result.product?._id, "1:100:0");
});

test("matchSummaryRowToProduct: SKU sama di >1 produk katalog → ambigu, tidak dipaksakan", () => {
  const catalog = [
    product({ _id: "1:100:0", sku: "DUP" }),
    product({ _id: "1:101:0", sku: "DUP", name: "PRODUK B" }),
  ];
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const result = matchSummaryRowToProduct({ product: "PRODUK A", sku: "DUP" }, skuIndex, nameIndex);
  assert.equal(result.method, "ambiguous-sku");
  assert.equal(result.product, null);
});

test("matchSummaryRowToProduct: tanpa SKU, fallback ke nama ternormalisasi unik", () => {
  const catalog = [product({ _id: "1:100:0", name: "Bola Padel Odea" })];
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const result = matchSummaryRowToProduct({ product: "  bola   padel odea  ", sku: null }, skuIndex, nameIndex);
  assert.equal(result.method, "name");
  assert.equal(result.product?._id, "1:100:0");
});

test("matchSummaryRowToProduct: variant berbeda tidak tertukar (nama polos ambigu antar variant)", () => {
  const catalog = [
    product({ _id: "1:100:1", name: "Kaos Kaki", variantName: "Merah" }),
    product({ _id: "1:100:2", name: "Kaos Kaki", variantName: "Biru" }),
  ];
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  // Nama polos (tanpa suffix varian) di file summary — ambigu antara 2 variant, jangan ditebak.
  const result = matchSummaryRowToProduct({ product: "Kaos Kaki", sku: null }, skuIndex, nameIndex);
  assert.equal(result.method, "ambiguous-name");

  const resultExact = matchSummaryRowToProduct({ product: "Kaos Kaki - Merah", sku: null }, skuIndex, nameIndex);
  assert.equal(resultExact.method, "name");
  assert.equal(resultExact.product?._id, "1:100:1");
});

test("matchSummaryRowToProduct: tidak ditemukan sama sekali → unmatched, bukan dipaksakan", () => {
  const catalog = [product({ _id: "1:100:0", name: "Produk Lain" })];
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const result = matchSummaryRowToProduct({ product: "Tidak Ada Di Katalog", sku: null }, skuIndex, nameIndex);
  assert.equal(result.method, "unmatched");
  assert.equal(result.product, null);
});

// ---- Formula Stok Akhir Sistem (komponen Pergerakan Stok Olsera) ----

test("computeDisplayedBarangMasuk & Keluar: menggabungkan return/production ke Masuk/Keluar", () => {
  const row = { incoming: 10, return: 2, productionIn: 1, outgoing: 3, productionOut: 1, opname: 4 };
  assert.equal(computeDisplayedBarangMasuk(row), 13);
  assert.equal(computeDisplayedKeluar(row), 8);
});

test("computeStockAkhirSistem: cocok dengan data Juni terverifikasi (Nestle Pure Life 1500ml)", () => {
  // begining=59, incoming=633, sales=426, opname=12, balance Olsera=254 (terverifikasi manual).
  const stockAkhir = computeStockAkhirSistem({ stokAwal: 59, barangMasuk: 633, totalPenjualan: 426, keluar: 12 });
  assert.equal(stockAkhir, 254);
});

test("computeStockAkhirSistem: Keluar company report = opname Olsera (bukan outgoing) — Grip Li-Ning", () => {
  // begining=18, incoming=0, sales=12, opname=1, balance=5.
  const keluar = computeDisplayedKeluar({ outgoing: 0, productionOut: 0, opname: 1 });
  assert.equal(keluar, 1);
  const stockAkhir = computeStockAkhirSistem({ stokAwal: 18, barangMasuk: 0, totalPenjualan: 12, keluar });
  assert.equal(stockAkhir, 5);
});

test("computeStockAkhirSistem: produk dengan koreksi stock opname positif besar (Pocari Sweat 900ml)", () => {
  // begining=118, incoming=150, sales=92, opname=16, balance=160.
  const stockAkhir = computeStockAkhirSistem({ stokAwal: 118, barangMasuk: 150, totalPenjualan: 92, keluar: 16 });
  assert.equal(stockAkhir, 160);
});

test("computeStockAkhirSistem: produk tanpa pergerakan apa pun tetap stabil", () => {
  const stockAkhir = computeStockAkhirSistem({ stokAwal: 5, barangMasuk: 0, totalPenjualan: 0, keluar: 0 });
  assert.equal(stockAkhir, 5);
});

// ---- Agregasi penjualan harian: cancelled/refunded sudah dikecualikan di sumbernya ----

test("aggregateDailySales: qtyChange negatif (penjualan) diagregasi jadi qty positif per tanggal", () => {
  const result = aggregateDailySales(
    [
      { key: "1:100:0", date: "2026-06-01", qtyChange: -2 },
      { key: "1:100:0", date: "2026-06-01", qtyChange: -1 },
      { key: "1:100:0", date: "2026-06-15", qtyChange: -5 },
    ],
    2026,
    6,
  );
  const agg = result.get("1:100:0")!;
  assert.equal(agg.daily[0], 3);
  assert.equal(agg.daily[14], 5);
  assert.equal(agg.total, 8);
});

test("aggregateDailySales: movement di luar rentang bulan diabaikan", () => {
  const result = aggregateDailySales([{ key: "1:100:0", date: "2026-07-01", qtyChange: -1 }], 2026, 6);
  assert.equal(result.has("1:100:0"), false);
});

test("aggregateDailySales: variant berbeda (key berbeda) tidak tercampur", () => {
  const result = aggregateDailySales(
    [
      { key: "1:100:1", date: "2026-06-01", qtyChange: -3 },
      { key: "1:100:2", date: "2026-06-01", qtyChange: -7 },
    ],
    2026,
    6,
  );
  assert.equal(result.get("1:100:1")!.total, 3);
  assert.equal(result.get("1:100:2")!.total, 7);
});

test("aggregateDailySales: produk tanpa movement sama sekali tidak muncul di hasil (caller default ke 0)", () => {
  const result = aggregateDailySales([], 2026, 6);
  assert.equal(result.size, 0);
});

// ---- 4 variasi nama nyata Juni 2026 (file summary Olsera vs katalog) ------

test("stripGenericCategoryPrefix: BOLA PADEL dicoba sebelum BOLA (prefix lebih panjang menang)", () => {
  assert.equal(stripGenericCategoryPrefix("BOLA PADEL HEAD PRO S+ ISI 3"), "HEAD PRO S+ ISI 3");
});

test("stripGenericCategoryPrefix: BOLA saja", () => {
  assert.equal(stripGenericCategoryPrefix("BOLA HEAD PRO ISI 3"), "HEAD PRO ISI 3");
});

test("stripGenericCategoryPrefix: GRIP", () => {
  assert.equal(stripGenericCategoryPrefix("GRIP YONEX AC102"), "YONEX AC102");
});

test("stripGenericCategoryPrefix: nama tanpa prefix generik → null (tidak diubah)", () => {
  assert.equal(stripGenericCategoryPrefix("NESTLE PURE LIFE 1500ML"), null);
});

test("stripGenericCategoryPrefix: prefix generik TIDAK menghapus substring di tengah/akhir nama", () => {
  // "BOLABOLA PADEL X" tidak diawali "BOLA " (spasi) persis — tidak boleh terpotong asal-asalan.
  assert.equal(stripGenericCategoryPrefix("BOLABOLA PADEL X"), null);
});

test("matchSummaryRowToProduct: 'BOLA HEAD PRO ISI 3' (file) → 'HEAD PRO ISI 3' (katalog) via prefix-stripped", () => {
  const catalog = [product({ _id: "1:200:0", name: "HEAD PRO ISI 3" })];
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const result = matchSummaryRowToProduct({ product: "BOLA HEAD PRO ISI 3", sku: null }, skuIndex, nameIndex);
  assert.equal(result.method, "name-prefix-stripped");
  assert.equal(result.product?._id, "1:200:0");
});

test("matchSummaryRowToProduct: 'BOLA PADEL HEAD PRO S+ ISI 3' (file) → 'HEAD PRO S+ ISI 3' (katalog)", () => {
  const catalog = [product({ _id: "1:201:0", name: "HEAD PRO S+ ISI 3" })];
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const result = matchSummaryRowToProduct({ product: "BOLA PADEL HEAD PRO S+ ISI 3", sku: null }, skuIndex, nameIndex);
  assert.equal(result.method, "name-prefix-stripped");
  assert.equal(result.product?._id, "1:201:0");
});

test("matchSummaryRowToProduct: 'GRIP YONEX AC102' (file) → 'YONEX AC102' (katalog)", () => {
  const catalog = [product({ _id: "1:202:0", name: "YONEX AC102" })];
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const result = matchSummaryRowToProduct({ product: "GRIP YONEX AC102", sku: null }, skuIndex, nameIndex);
  assert.equal(result.method, "name-prefix-stripped");
  assert.equal(result.product?._id, "1:202:0");
});

test("matchSummaryRowToProduct: 'BOLA PADEL ODEA ROSE' (file) TIDAK dipaksakan cocok ke 'BOLA PADEL ODEA' (produk beda, bukan sekadar prefix)", () => {
  const catalog = [product({ _id: "1:203:0", name: "BOLA PADEL ODEA" })];
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const result = matchSummaryRowToProduct({ product: "BOLA PADEL ODEA ROSE", sku: null }, skuIndex, nameIndex);
  // Strip "BOLA PADEL" -> "ODEA ROSE", bukan "ODEA" — tidak ada di katalog fixture ini -> unmatched.
  assert.equal(result.method, "unmatched");
  assert.equal(result.product, null);
});

test("matchSummaryRowToProduct: 'BOLA PADEL ODEA ROSE' tetap dipetakan benar bila memang ada sebagai produk katalog terpisah", () => {
  const catalog = [
    product({ _id: "1:203:0", name: "BOLA PADEL ODEA" }),
    product({ _id: "1:204:0", name: "ODEA ROSE" }),
  ];
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const result = matchSummaryRowToProduct({ product: "BOLA PADEL ODEA ROSE", sku: null }, skuIndex, nameIndex);
  assert.equal(result.method, "name-prefix-stripped");
  assert.equal(result.product?._id, "1:204:0");
});

test("matchSummaryRowToProduct: prefix-stripped hasil ambigu (>1 kandidat) tidak dipaksakan", () => {
  const catalog = [
    product({ _id: "1:205:0", name: "HEAD PRO ISI 3", storeId: 1 }),
    product({ _id: "1:206:0", name: "HEAD PRO ISI 3", storeId: 2 }),
  ];
  const skuIndex = buildSkuIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const result = matchSummaryRowToProduct({ product: "BOLA HEAD PRO ISI 3", sku: null }, skuIndex, nameIndex);
  assert.equal(result.method, "ambiguous-name");
  assert.equal(result.product, null);
});
