import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOrderItemIdentity,
  canAutoBackfill,
  summarizeClassifications,
  fieldState,
  isGapped,
  type IdentityClassificationContext,
  type ClassifiedOrderItem,
} from "./historical-order-item-identity.ts";

function emptyContext(): IdentityClassificationContext {
  return {
    catalogByName: new Map(),
    catalogByBaseName: new Map(),
    aliasByName: new Map(),
    historicalByName: new Map(),
    duplicateKeyCount: new Map(),
  };
}

function baseRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: 1,
    date: "2026-05-01",
    orderNo: "ORD-1",
    itemName: "COURT FEES - 1",
    qty: 1,
    amount: 150000,
    ...overrides,
  } as Record<string, unknown> & { _id: number; date: string; orderNo: string; itemName: string; qty: number; amount: number };
}

test("fieldState: membedakan absent/null/empty/present", () => {
  assert.equal(fieldState({}, "productId"), "absent");
  assert.equal(fieldState({ productId: null }, "productId"), "null");
  assert.equal(fieldState({ sku: "  " }, "sku"), "empty");
  assert.equal(fieldState({ productId: 5 }, "productId"), "present");
});

test("isGapped: true bila salah satu dari productId/variantId/sku tidak present", () => {
  assert.equal(isGapped({ productId: "present", variantId: "present", sku: "present" }), false);
  assert.equal(isGapped({ productId: "absent", variantId: "present", sku: "present" }), true);
});

test("classifyOrderItemIdentity: Exact Match bila nama lengkap cocok TEPAT satu produk+varian di katalog", () => {
  const context = emptyContext();
  context.catalogByName.set("COURT FEES - 1", [{ productId: 100, variantId: 200, sku: "SKU-1", name: "COURT FEES - 1", active: true }]);
  const row = classifyOrderItemIdentity(baseRow(), context);
  assert.equal(row.classification, "Exact Match");
  assert.equal(row.confidence, "HIGH");
  assert.deepEqual(row.backfillTarget, { productId: 100, variantId: 200, sku: "SKU-1" });
  assert.equal(canAutoBackfill(row.classification), true);
});

test("classifyOrderItemIdentity: Butuh Adjust Manual bila nama lengkap cocok LEBIH dari satu kombinasi produk+varian (ambigu) — TIDAK dipaksa", () => {
  const context = emptyContext();
  context.catalogByName.set("COURT FEES - 1", [
    { productId: 100, variantId: 200, sku: "SKU-1", name: "COURT FEES - 1", active: true },
    { productId: 101, variantId: 201, sku: "SKU-2", name: "COURT FEES - 1", active: true },
  ]);
  const row = classifyOrderItemIdentity(baseRow(), context);
  assert.equal(row.classification, "Butuh Adjust Manual");
  assert.equal(row.confidence, "LOW");
  assert.equal(row.backfillTarget, null);
  assert.equal(canAutoBackfill(row.classification), false);
  assert.match(row.manualReason ?? "", /lebih dari satu kombinasi/i);
});

test("classifyOrderItemIdentity: Exact Product Variant Ambiguous bila nama dasar cocok satu produk dengan >1 varian — variant TIDAK ditebak", () => {
  const context = emptyContext();
  context.catalogByBaseName.set("PAKET LATIHAN", [
    { productId: 300, variantId: 1, sku: "A", name: "PAKET LATIHAN - Pemula", active: true },
    { productId: 300, variantId: 2, sku: "B", name: "PAKET LATIHAN - Lanjutan", active: true },
  ]);
  const row = classifyOrderItemIdentity(baseRow({ itemName: "PAKET LATIHAN" }), context);
  assert.equal(row.classification, "Exact Product, Variant Ambiguous");
  assert.equal(row.backfillTarget, null);
  assert.equal(canAutoBackfill(row.classification), false);
});

test("classifyOrderItemIdentity: Historical Product bila produk tidak ada di katalog TAPI histori nama sama selalu konsisten satu kombinasi — tetap TIDAK auto-backfill (perlu konfirmasi admin katalog)", () => {
  const context = emptyContext();
  context.historicalByName.set("PRODUK LAMA", { combos: [{ productId: 900, variantId: null, sku: "OLD-1" }], minDate: "2026-01-01", maxDate: "2026-02-01" });
  const row = classifyOrderItemIdentity(baseRow({ itemName: "PRODUK LAMA" }), context);
  assert.equal(row.classification, "Historical Product");
  assert.equal(row.confidence, "MEDIUM");
  assert.equal(row.backfillTarget, null, "Historical Product tidak pernah auto-backfill meski histori konsisten — perlu konfirmasi manual admin katalog");
  assert.equal(canAutoBackfill(row.classification), false);
});

test("classifyOrderItemIdentity: Product Missing bila tidak ada kandidat sama sekali", () => {
  const row = classifyOrderItemIdentity(baseRow({ itemName: "TIDAK DIKENAL" }), emptyContext());
  assert.equal(row.classification, "Product Missing");
  assert.equal(canAutoBackfill(row.classification), false);
});

test("classifyOrderItemIdentity: Duplicate Candidate menggantikan Product Missing/Butuh Adjust Manual bila (date,orderNo,nama,qty,amount) identik dengan baris gapped lain", () => {
  const context = emptyContext();
  context.duplicateKeyCount.set("2026-05-01|ORD-1|TIDAK DIKENAL|1|150000", 2);
  const row = classifyOrderItemIdentity(baseRow({ itemName: "TIDAK DIKENAL" }), context);
  assert.equal(row.classification, "Duplicate Candidate");
  assert.equal(row.isDuplicateCandidate, true);
  assert.equal(canAutoBackfill(row.classification), false);
});

test("classifyOrderItemIdentity: Duplicate Candidate TIDAK menggantikan Exact Match (match yang sudah baik tidak ditutupi)", () => {
  const context = emptyContext();
  context.catalogByName.set("COURT FEES - 1", [{ productId: 100, variantId: 200, sku: "SKU-1", name: "COURT FEES - 1", active: true }]);
  context.duplicateKeyCount.set("2026-05-01|ORD-1|COURT FEES - 1|1|150000", 2);
  const row = classifyOrderItemIdentity(baseRow(), context);
  assert.equal(row.classification, "Exact Match");
});

test("summarizeClassifications: menghitung agregat per klasifikasi dengan benar", () => {
  const context = emptyContext();
  context.catalogByName.set("A", [{ productId: 1, variantId: null, sku: null, name: "A", active: true }]);
  const rows: ClassifiedOrderItem[] = [
    classifyOrderItemIdentity(baseRow({ itemName: "A" }), context),
    classifyOrderItemIdentity(baseRow({ itemName: "TIDAK DIKENAL 1" }), emptyContext()),
    classifyOrderItemIdentity(baseRow({ itemName: "TIDAK DIKENAL 2" }), emptyContext()),
  ];
  const summary = summarizeClassifications(rows);
  assert.equal(summary.totalGapped, 3);
  assert.equal(summary.exactMatchCount, 1);
  assert.equal(summary.unresolvedCount, 2);
  assert.equal(summary.byClassification["Product Missing"], 2);
});
