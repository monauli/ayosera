import assert from "node:assert/strict";
import test from "node:test";
import { compareHistoricalInventoryRows, type HistoricalReconciliationRow } from "./inventory-historical-reconciliation.ts";

const row = (overrides: Partial<HistoricalReconciliationRow> = {}): HistoricalReconciliationRow => ({
  productId: 1, variantId: null, productSku: "SKU-1", productName: "Produk 1",
  openingQty: 10, incomingQty: 3, returnQty: 0, salesQty: 2, outgoingQty: 0, closingQty: 11,
  ...overrides,
});

test("approved source yang sama menghasilkan Cocok", () => {
  const result = compareHistoricalInventoryRows([row()], [row()]);
  assert.equal(result.summary.cocok, 1);
  assert.equal(result.rows[0].status, "COCOK");
});

test("perbedaan opening atau penjualan menghasilkan Selisih walau closing sama", () => {
  const result = compareHistoricalInventoryRows([row()], [row({ openingQty: 9, salesQty: 1 })]);
  assert.equal(result.summary.selisih, 1);
});

test("produk hilang atau identitas ganda menghasilkan Perlu Verifikasi", () => {
  assert.equal(compareHistoricalInventoryRows([row()], []).summary.perluVerifikasi, 1);
  assert.equal(compareHistoricalInventoryRows([row(), row({ productId: 1 })], [row()]).summary.perluVerifikasi, 1);
});

test("source pembanding terpisah tidak boleh kosong", () => {
  const result = compareHistoricalInventoryRows([row()], [], { sourceRevision: "2026-02-final-corrections-v3" });
  assert.equal(result.summary.perluVerifikasi, 1);
  assert.equal(result.sourceRevision, "2026-02-final-corrections-v3");
});
