// Test unit canonical category resolver. Jalankan: npm run test:olsera-resolver
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildResolverContext,
  catalogEntriesFromOlseraProduct,
  normalizeName,
  resolveItemCategory,
  emptyResolutionStats,
  tallyResolution,
  UNKNOWN_CATEGORY,
  type AliasEntry,
  type CatalogEntry,
} from "./olsera-category-resolver.ts";

const CATALOG: CatalogEntry[] = [
  { productId: 118420650, variantId: null, name: "YONEX SHORTS MEN # SM-J035-2906-RW1-S duplicate", sku: null, barcode: null, category: "CELANA PRIA", categoryId: "4790000" },
  { productId: 106743802, variantId: null, name: "YONEX MENS SHORTS # SM-P061-3085-RW2-S", sku: null, barcode: "7793651254108", category: "CELANA PRIA", categoryId: "4790000" },
  { productId: 200, variantId: null, name: "POCARI SWEAT", sku: "POC-1", barcode: null, category: "MINUMAN", categoryId: "111" },
  { productId: 300, variantId: 301, name: "SEWA RAKET - 1 Jam,", sku: "RKT-1", barcode: null, category: "LABERS", categoryId: "222" },
  // Dua produk dengan SKU sama → ambiguous, dilarang dipetakan via SKU.
  { productId: 400, variantId: null, name: "KAOS A", sku: "DUP-SKU", barcode: null, category: "BAJU PRIA", categoryId: "333" },
  { productId: 401, variantId: null, name: "KAOS B", sku: "DUP-SKU", barcode: null, category: "SKORT WANITA", categoryId: "444" },
  // Dua produk dengan nama sama → ambiguous by name.
  { productId: 500, variantId: null, name: "GRIP UNIVERSAL", sku: null, barcode: null, category: "GRIP", categoryId: "555" },
  { productId: 501, variantId: null, name: "GRIP UNIVERSAL", sku: null, barcode: null, category: "SNACK", categoryId: "666" },
];

const ALIASES: AliasEntry[] = [
  {
    oldProductId: 106743815,
    oldVariantId: null,
    newProductId: 118420650,
    newVariantId: null,
    sku: null,
    normalizedName: normalizeName("YONEX SHORTS MEN # SM-J035-2906-RW1-S"),
    categoryId: "4790000",
    categoryName: "CELANA PRIA",
    confidence: "verified",
  },
  // Alias kategori historis tanpa ID pengganti.
  {
    oldProductId: 999111,
    oldVariantId: null,
    newProductId: null,
    newVariantId: null,
    sku: "OLD-SKU-1",
    normalizedName: normalizeName("PRODUK LAMA TANPA PENGGANTI"),
    categoryId: "777",
    categoryName: "THERMOFLASK",
    confidence: "high",
  },
];

const ctx = buildResolverContext({
  catalog: CATALOG,
  aliases: ALIASES,
  historical: [{ normalizedName: normalizeName("ITEM HISTORIS LAMA"), category: "SALON", categoryId: "888" }],
});

test("1. product_id aktif ditemukan langsung", () => {
  const r = resolveItemCategory({ itemName: "APA SAJA", productId: 200 }, ctx);
  assert.equal(r.status, "resolved");
  assert.equal(r.method, "product-id");
  assert.equal(r.category, "MINUMAN");
  assert.equal(r.resolvedProductId, 200);
});

test("2. product_id lama ditemukan melalui alias (kasus 106743815 → 118420650)", () => {
  const r = resolveItemCategory({ itemName: "YONEX SHORTS MEN # SM-J035-2906-RW1-S", productId: 106743815 }, ctx);
  assert.equal(r.status, "resolved");
  assert.equal(r.method, "alias");
  assert.equal(r.category, "CELANA PRIA");
  assert.equal(r.resolvedProductId, 118420650);
});

test("2b. item lama TANPA product_id tetap ter-resolve via alias by-name", () => {
  const r = resolveItemCategory({ itemName: "YONEX SHORTS MEN # SM-J035-2906-RW1-S" }, ctx);
  assert.equal(r.status, "resolved");
  assert.equal(r.method, "alias");
  assert.equal(r.category, "CELANA PRIA");
});

test("2c. alias kategori historis tanpa ID pengganti", () => {
  const r = resolveItemCategory({ itemName: "PRODUK LAMA TANPA PENGGANTI", productId: 999111 }, ctx);
  assert.equal(r.status, "resolved");
  assert.equal(r.method, "alias");
  assert.equal(r.category, "THERMOFLASK");
  assert.equal(r.resolvedProductId, null);
});

test("3. variant_id ditemukan", () => {
  const r = resolveItemCategory({ itemName: "X", variantId: 301 }, ctx);
  assert.equal(r.method, "variant-id");
  assert.equal(r.category, "LABERS");
});

test("4. SKU exact ditemukan", () => {
  const r = resolveItemCategory({ itemName: "TIDAK ADA DI KATALOG", sku: "POC-1" }, ctx);
  assert.equal(r.method, "sku");
  assert.equal(r.category, "MINUMAN");
});

test("5. barcode exact ditemukan", () => {
  const r = resolveItemCategory({ itemName: "TIDAK ADA", barcode: "7793651254108" }, ctx);
  assert.equal(r.method, "barcode");
  assert.equal(r.category, "CELANA PRIA");
});

test("6. normalized name exact dan unik", () => {
  const r = resolveItemCategory({ itemName: "  pocari   sweat " }, ctx);
  assert.equal(r.method, "name-exact");
  assert.equal(r.category, "MINUMAN");
});

test("6b. nama dengan suffix varian dicoba nama dasarnya (exact, bukan substring)", () => {
  const r = resolveItemCategory({ itemName: "POCARI SWEAT - DINGIN" }, ctx);
  assert.equal(r.method, "name-exact");
  assert.equal(r.category, "MINUMAN");
});

test("7. nama ambigu TIDAK dipetakan otomatis; SKU ambigu juga tidak", () => {
  const byName = resolveItemCategory({ itemName: "GRIP UNIVERSAL" }, ctx);
  assert.equal(byName.status, "unresolved");
  const bySku = resolveItemCategory({ itemName: "TIDAK ADA", sku: "DUP-SKU" }, ctx);
  assert.equal(bySku.status, "unresolved");
});

test("7b. substring nama TIDAK memetakan (bukan pencocokan longgar)", () => {
  const r = resolveItemCategory({ itemName: "CELANA KEREN BARU" }, ctx);
  assert.equal(r.status, "unresolved");
});

test("8. category asli transaksi dipertahankan (prioritas tertinggi)", () => {
  const r = resolveItemCategory(
    { itemName: "POCARI SWEAT", productId: 200, originalCategoryName: "MINUMAN DINGIN", originalCategoryId: "999" },
    ctx,
  );
  assert.equal(r.method, "original-category");
  assert.equal(r.category, "MINUMAN DINGIN");
  assert.equal(r.categoryId, "999");
});

test("8b. identitas historis dipakai bila katalog & alias gagal", () => {
  const r = resolveItemCategory({ itemName: "ITEM HISTORIS LAMA" }, ctx);
  assert.equal(r.method, "historical");
  assert.equal(r.category, "SALON");
});

test("9. unresolved tercatat dengan alasan, kategori tampilan Tidak Diketahui", () => {
  const r = resolveItemCategory({ itemName: "PRODUK MISTERIUS", productId: 123456 }, ctx);
  assert.equal(r.status, "unresolved");
  assert.equal(r.method, "none");
  assert.equal(r.category, UNKNOWN_CATEGORY);
  assert.ok(r.reason && r.reason.includes("123456"));
});

test("statistik resolusi terhitung benar", () => {
  const stats = emptyResolutionStats();
  tallyResolution(stats, resolveItemCategory({ itemName: "X", productId: 200 }, ctx));
  tallyResolution(stats, resolveItemCategory({ itemName: "YONEX SHORTS MEN # SM-J035-2906-RW1-S", productId: 106743815 }, ctx));
  tallyResolution(stats, resolveItemCategory({ itemName: "POCARI SWEAT" }, ctx));
  tallyResolution(stats, resolveItemCategory({ itemName: "PRODUK MISTERIUS" }, ctx));
  assert.deepEqual(stats, { mapped: 3, viaAlias: 1, viaSkuOrName: 1, unresolved: 1 });
});

test("catalogEntriesFromOlseraProduct: produk + variant diratakan dengan identitas lengkap", () => {
  const entries = catalogEntriesFromOlseraProduct({
    id: 300,
    name: "SEWA RAKET",
    sku: "RKT",
    barcode: null,
    klasifikasi: "LABERS",
    klasifikasi_id: 222,
    variants: [{ id: 301, name: "1 Jam,", sku: "RKT-1", variant_barcode: "888" }],
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].variantId, null);
  assert.equal(entries[1].variantId, 301);
  assert.equal(entries[1].name, "SEWA RAKET - 1 Jam,");
  assert.equal(entries[1].sku, "RKT-1");
  assert.equal(entries[1].barcode, "888");
  assert.equal(entries[1].category, "LABERS");
});
