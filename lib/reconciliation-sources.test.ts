// Test source adapter Modul Rekonsiliasi (Phase 5B) — MongoDB DIGANTI koleksi
// tiruan in-memory (DI, pola sama lib/reconciliation-store.test.ts) supaya
// TIDAK PERNAH menyentuh database sungguhan. Dijalankan via
// `tsx --conditions=react-server` karena reconciliation-sources.ts memakai
// "server-only".
import assert from "node:assert/strict";
import test from "node:test";
import {
  loadCategoryFindings,
  loadInventoryMovementFindings,
  loadProductIdentityFindings,
  loadSnapshotConsistencyFindings,
  nextPeriodLabel,
  periodToMonthRange,
  ReconciliationSourceError,
  type MinimalReadCollection,
  type ReconciliationSourceContext,
} from "./reconciliation-sources.ts";
import type {
  OlseraInventoryMonthlySnapshotDocument,
  OlseraInventoryMovementDocument,
  OlseraInventoryProductDocument,
  OlseraOrderItemDocument,
  OlseraProductAliasDocument,
} from "./mongodb.ts";

type Doc = Record<string, unknown>;

function matchesFilter(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Doc;
      const value = doc[key] as string | number | null;
      if ("$gte" in c && !((value as string | number) >= (c.$gte as string | number))) return false;
      if ("$lte" in c && !((value as string | number) <= (c.$lte as string | number))) return false;
      if ("$in" in c && !(c.$in as unknown[]).includes(value)) return false;
      return true;
    }
    return doc[key] === cond;
  });
}

/** Koleksi tiruan yang menerima objek fixture PARSIAL (bukan seluruh field dokumen asli) — cukup untuk membaca field yang benar-benar dipakai adapter. */
function fake<T>(docs: Array<Partial<T>>): MinimalReadCollection<T> {
  return {
    find(filter: Doc) {
      const filtered = (docs as Doc[]).filter((doc) => matchesFilter(doc, filter));
      return { toArray: async () => filtered as T[] };
    },
  };
}

function context(overrides: Partial<ReconciliationSourceContext> = {}): ReconciliationSourceContext {
  return {
    orderItems: fake<OlseraOrderItemDocument>([]),
    inventoryProducts: fake<OlseraInventoryProductDocument>([]),
    productAliases: fake<OlseraProductAliasDocument>([]),
    inventoryMovements: fake<OlseraInventoryMovementDocument>([]),
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([]),
    ...overrides,
  };
}

// ---- periodToMonthRange / nextPeriodLabel ------------------------------------

test("periodToMonthRange: menghitung rentang tanggal & menolak format tidak valid", () => {
  assert.deepEqual(periodToMonthRange("2026-05"), { year: 2026, month: 5, start: "2026-05-01", end: "2026-05-31" });
  assert.deepEqual(periodToMonthRange("2026-02"), { year: 2026, month: 2, start: "2026-02-01", end: "2026-02-28" });
  assert.throws(() => periodToMonthRange("2026/05"), ReconciliationSourceError);
  assert.throws(() => periodToMonthRange("2026-13"), ReconciliationSourceError);
});

test("nextPeriodLabel: menangani pergantian tahun (Desember -> Januari)", () => {
  assert.deepEqual(nextPeriodLabel(2026, 5), { year: 2026, month: 6, label: "2026-06" });
  assert.deepEqual(nextPeriodLabel(2026, 12), { year: 2027, month: 1, label: "2027-01" });
});

// ---- CATEGORY ------------------------------------------------------------------

test("category: resolved -> MATCH", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([
      { _id: 1, date: "2026-05-10", itemName: "Sewa Lapangan A", normalizedItemName: "SEWA LAPANGAN A", categoryResolutionStatus: "resolved", resolvedCategoryName: "Lapangan", categoryResolutionMethod: "product-id" },
    ]),
  });
  const { findings } = await loadCategoryFindings("2026-05", ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "MATCH");
  assert.equal(findings[0].domain, "CATEGORY");
});

test("category: distinct resolvedCategoryName pada nama sama (tanpa manual_override) -> AMBIGUOUS", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([
      { _id: 1, date: "2026-05-10", itemName: "Produk X", normalizedItemName: "PRODUK X", categoryResolutionStatus: "resolved", resolvedCategoryName: "Kategori A", categoryResolutionMethod: "name-exact" },
      { _id: 2, date: "2026-05-11", itemName: "Produk X", normalizedItemName: "PRODUK X", categoryResolutionStatus: "resolved", resolvedCategoryName: "Kategori B", categoryResolutionMethod: "name-exact" },
    ]),
  });
  const { findings } = await loadCategoryFindings("2026-05", ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "AMBIGUOUS");
});

test("category: unresolved -> BUTUH_ADJUST_MANUAL", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([
      { _id: 1, date: "2026-05-10", itemName: "Produk Aneh", normalizedItemName: "PRODUK ANEH", categoryResolutionStatus: "unresolved", resolvedCategoryName: null, categoryResolutionReason: "tidak ditemukan" },
    ]),
  });
  const { findings } = await loadCategoryFindings("2026-05", ctx);
  assert.equal(findings[0].status, "BUTUH_ADJUST_MANUAL");
});

test("category: item 'LABERS'/'Jasa Host' tetap dihitung penuh (adapter tidak pernah membaca preferensi hidden UI)", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([
      { _id: 1, date: "2026-05-10", itemName: "LABERS Sharing", normalizedItemName: "LABERS SHARING", categoryResolutionStatus: "resolved", resolvedCategoryName: "LABERS", categoryResolutionMethod: "name-exact" },
      { _id: 2, date: "2026-05-10", itemName: "Jasa Host", normalizedItemName: "JASA HOST", categoryResolutionStatus: "resolved", resolvedCategoryName: "Jasa Host", categoryResolutionMethod: "name-exact" },
    ]),
  });
  const { findings } = await loadCategoryFindings("2026-05", ctx);
  assert.equal(findings.length, 2, "LABERS dan Jasa Host tetap muncul sebagai finding, tidak hilang");
  assert.ok(findings.every((f) => f.status === "MATCH"));
});

// ---- PRODUCT ------------------------------------------------------------------

test("product identity: item dengan identitas lengkap TIDAK menghasilkan finding (hanya gapped yang dilaporkan)", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([{ _id: 1, date: "2026-05-10", itemName: "Lengkap", normalizedItemName: "LENGKAP", productId: 1, variantId: 5, sku: "SKU1" }]),
  });
  const { findings } = await loadProductIdentityFindings("2026-05", ctx);
  assert.equal(findings.length, 0);
});

test("product identity: exact match katalog -> MATCH", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([{ _id: 1, date: "2026-05-10", itemName: "Sewa Lapangan A", normalizedItemName: "SEWA LAPANGAN A" }]),
    inventoryProducts: fake<OlseraInventoryProductDocument>([{ productId: 10, variantId: null, sku: "SKU-A", name: "Sewa Lapangan A", variantName: null, active: true }]),
  });
  const { findings } = await loadProductIdentityFindings("2026-05", ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "MATCH");
  assert.equal(findings[0].actual.productId, 10);
});

test("product identity: base name >1 varian tanpa suffix -> AMBIGUOUS (variant ambiguous), variantId tidak diisi", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([{ _id: 1, date: "2026-05-10", itemName: "Sewa Lapangan B", normalizedItemName: "SEWA LAPANGAN B" }]),
    inventoryProducts: fake<OlseraInventoryProductDocument>([
      { productId: 20, variantId: 1, sku: "SKU-B1", name: "Sewa Lapangan B", variantName: "Pagi", active: true },
      { productId: 20, variantId: 2, sku: "SKU-B2", name: "Sewa Lapangan B", variantName: "Malam", active: true },
    ]),
  });
  const { findings } = await loadProductIdentityFindings("2026-05", ctx);
  assert.equal(findings[0].status, "AMBIGUOUS");
  assert.equal(findings[0].actual.variantId, undefined);
});

test("product identity: historical product (tidak di katalog, histori konsisten) -> MISSING_IN_SNAPSHOT + confidence MEDIUM", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([
      { _id: 1, date: "2026-05-10", itemName: "Produk Lama", normalizedItemName: "PRODUK LAMA" },
      { _id: 2, date: "2026-04-01", itemName: "Produk Lama", normalizedItemName: "PRODUK LAMA", productId: 30, variantId: null, sku: "SKU-OLD" },
    ]),
  });
  const { findings } = await loadProductIdentityFindings("2026-05", ctx);
  assert.equal(findings[0].status, "MISSING_IN_SNAPSHOT");
  assert.equal(findings[0].confidence, "MEDIUM");
});

test("product identity: alias fallback -> MISSING_IN_SNAPSHOT + confidence MEDIUM", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([{ _id: 1, date: "2026-05-10", itemName: "Produk Alias", normalizedItemName: "PRODUK ALIAS" }]),
    productAliases: fake<OlseraProductAliasDocument>([{ normalizedName: "PRODUK ALIAS", newProductId: 40, newVariantId: null, sku: "SKU-ALIAS", source: "manual-verified" }]),
  });
  const { findings } = await loadProductIdentityFindings("2026-05", ctx);
  assert.equal(findings[0].status, "MISSING_IN_SNAPSHOT");
  assert.equal(findings[0].confidence, "MEDIUM");
});

test("product identity: tidak ada kandidat sama sekali -> BUTUH_ADJUST_MANUAL (missing product)", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([{ _id: 1, date: "2026-05-10", itemName: "Produk Misterius", normalizedItemName: "PRODUK MISTERIUS" }]),
  });
  const { findings } = await loadProductIdentityFindings("2026-05", ctx);
  assert.equal(findings[0].status, "BUTUH_ADJUST_MANUAL");
});

test("product identity: >1 kandidat nama lengkap berbeda -> AMBIGUOUS (multiple candidate), tidak menebak", async () => {
  const ctx = context({
    orderItems: fake<OlseraOrderItemDocument>([{ _id: 1, date: "2026-05-10", itemName: "Produk Duplikat", normalizedItemName: "PRODUK DUPLIKAT" }]),
    inventoryProducts: fake<OlseraInventoryProductDocument>([
      { productId: 50, variantId: null, sku: "SKU-50", name: "Produk Duplikat", variantName: null, active: true },
      { productId: 51, variantId: null, sku: "SKU-51", name: "Produk Duplikat", variantName: null, active: true },
    ]),
  });
  const { findings } = await loadProductIdentityFindings("2026-05", ctx);
  assert.equal(findings[0].status, "AMBIGUOUS");
});

// ---- INVENTORY ------------------------------------------------------------------

test("inventory: movement productId null WAJIB muncul sebagai finding, tidak pernah diisi otomatis", async () => {
  const ctx = context({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([{ _id: "sale:1", storeId: 1, date: "2026-05-10", productId: null, variantId: null, productName: "Tidak Diketahui", qtyChange: -2 }]),
  });
  const { findings } = await loadInventoryMovementFindings(1, "2026-05", ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "MISSING_IN_SNAPSHOT");
  assert.notEqual(findings[0].confidence, "HIGH");
  assert.equal(findings[0].actual.productId, null);
});

test("inventory: qty movement cocok dengan salesQty snapshot -> MATCH", async () => {
  const ctx = context({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([{ _id: "sale:1", storeId: 1, date: "2026-05-10", productId: 100, variantId: null, productName: "Produk A", qtyChange: -5 }]),
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([{ storeId: 1, year: 2026, month: 5, productId: 100, variantId: null, salesQty: 5, status: "complete" }]),
  });
  const { findings } = await loadInventoryMovementFindings(1, "2026-05", ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "MATCH");
});

test("inventory: qty movement mismatch dengan snapshot -> MISMATCH", async () => {
  const ctx = context({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([{ _id: "sale:1", storeId: 1, date: "2026-05-10", productId: 100, variantId: null, productName: "Produk A", qtyChange: -5 }]),
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([{ storeId: 1, year: 2026, month: 5, productId: 100, variantId: null, salesQty: 20, status: "complete" }]),
  });
  const { findings } = await loadInventoryMovementFindings(1, "2026-05", ctx);
  assert.equal(findings[0].status, "MISMATCH");
});

test("inventory: belum ada dokumen snapshot bulanan -> MISSING_IN_SNAPSHOT", async () => {
  const ctx = context({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([{ _id: "sale:1", storeId: 1, date: "2026-05-10", productId: 100, variantId: null, productName: "Produk A", qtyChange: -5 }]),
  });
  const { findings } = await loadInventoryMovementFindings(1, "2026-05", ctx);
  assert.equal(findings[0].status, "MISSING_IN_SNAPSHOT");
});

test("inventory: boundary-only pada snapshot -> selisih kecil dianggap MINOR_DIFFERENCE", async () => {
  const ctx = context({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([{ _id: "sale:1", storeId: 1, date: "2026-05-31", productId: 100, variantId: null, productName: "Produk A", qtyChange: -5 }]),
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([{ storeId: 1, year: 2026, month: 5, productId: 100, variantId: null, salesQty: 6, status: "boundary-only" }]),
  });
  const { findings } = await loadInventoryMovementFindings(1, "2026-05", ctx);
  assert.equal(findings[0].status, "MINOR_DIFFERENCE");
});

test("inventory: storeId lain tidak ikut terbaca (isolasi toko)", async () => {
  const ctx = context({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([
      { _id: "sale:1", storeId: 1, date: "2026-05-10", productId: null, variantId: null, productName: "A", qtyChange: -1 },
      { _id: "sale:2", storeId: 2, date: "2026-05-10", productId: null, variantId: null, productName: "B", qtyChange: -1 },
    ]),
  });
  const { findings } = await loadInventoryMovementFindings(1, "2026-05", ctx);
  assert.equal(findings.length, 1);
});

// ---- SNAPSHOT ------------------------------------------------------------------

test("snapshot: closing bulan N == opening bulan N+1 -> MATCH", async () => {
  const ctx = context({
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([
      { storeId: 1, year: 2026, month: 5, productId: 1, variantId: null, closingQty: 10, status: "complete" },
      { storeId: 1, year: 2026, month: 6, productId: 1, variantId: null, openingQty: 10, status: "complete" },
    ]),
  });
  const { findings } = await loadSnapshotConsistencyFindings(1, "2026-05", ctx);
  assert.equal(findings[0].status, "MATCH");
});

test("snapshot: rantai terputus -> MISMATCH", async () => {
  const ctx = context({
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([
      { storeId: 1, year: 2026, month: 5, productId: 1, variantId: null, closingQty: 10, status: "complete" },
      { storeId: 1, year: 2026, month: 6, productId: 1, variantId: null, openingQty: 999, status: "complete" },
    ]),
  });
  const { findings } = await loadSnapshotConsistencyFindings(1, "2026-05", ctx);
  assert.equal(findings[0].status, "MISMATCH");
});

test("snapshot: bulan berikutnya belum ada dokumen -> MISSING_IN_SNAPSHOT (bukan error)", async () => {
  const ctx = context({
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([{ storeId: 1, year: 2026, month: 5, productId: 1, variantId: null, closingQty: 10, status: "complete" }]),
  });
  const { findings } = await loadSnapshotConsistencyFindings(1, "2026-05", ctx);
  assert.equal(findings[0].status, "MISSING_IN_SNAPSHOT");
});

test("snapshot: identitas produk berubah (productId beda) TIDAK dipaksakan disambung — dianggap MISSING_IN_SNAPSHOT", async () => {
  const ctx = context({
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([
      { storeId: 1, year: 2026, month: 5, productId: 1, variantId: null, closingQty: 10, status: "complete" },
      { storeId: 1, year: 2026, month: 6, productId: 2, variantId: null, openingQty: 10, status: "complete" },
    ]),
  });
  const { findings } = await loadSnapshotConsistencyFindings(1, "2026-05", ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "MISSING_IN_SNAPSHOT", "productId 1 tidak dicocokkan paksa ke dokumen productId 2 di bulan berikutnya");
});

test("inventory: movement dengan storeId:null (data legacy belum distempel) TETAP terbaca sebagai movement-null milik toko ini (bukan cross-store, Known Case 37)", async () => {
  const ctx = context({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([
      { _id: "sale:legacy-1", storeId: null, date: "2026-05-10", productId: null, variantId: null, productName: "Legacy A", qtyChange: -3 },
    ]),
  });
  const { findings } = await loadInventoryMovementFindings(1, "2026-05", ctx);
  assert.equal(findings.length, 1, "movement storeId:null harus tetap terbaca (single-tenant, bukan cross-store)");
  assert.equal(findings[0].entityKey, "movement-null:sale:legacy-1");
  assert.equal(findings[0].status, "MISSING_IN_SNAPSHOT");
});

test("inventory: movement dengan storeId TOKO LAIN (bukan null, bukan storeId diminta) TETAP TIDAK terbaca (bukan cross-store read)", async () => {
  const ctx = context({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([
      { _id: "sale:other-store", storeId: 999, date: "2026-05-10", productId: null, variantId: null, productName: "Toko Lain", qtyChange: -3 },
    ]),
  });
  const { findings } = await loadInventoryMovementFindings(1, "2026-05", ctx);
  assert.equal(findings.length, 0, "storeId toko lain (bukan null) tidak boleh ikut terbaca");
});
