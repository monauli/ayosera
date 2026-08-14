import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHistoricalImportPlan, type HistoricalInventoryRow } from "./olsera-historical-inventory-import.ts";

const row = (id: number, sales = 1, opening = 2, closing = opening - sales): HistoricalInventoryRow => ({ productId: id, variantId: null, productName: id === 1 ? "ODEA ROSE" : "ODEA RED", productSku: null, groupName: "BOLA PADEL", openingQty: opening, incomingQty: 0, returnQty: 0, salesQty: sales, outgoingQty: 0, closingQty: closing });

test("dry-run plan is idempotent, validates formula, and keeps distinct identities", () => {
  const plan = buildHistoricalImportPlan({ sold: [row(1), row(2)], overall: [row(1), row(2, 0, 1, 1)], existing: [], expected: { sold: 2, unsold: 0, overall: 2 } });
  assert.deepEqual(plan.counts, { sold: 2, unsold: 0, overall: 2 });
  assert.equal(plan.changes.added, 2);
  assert.equal(plan.duplicates.length, 0);
});

test("duplicate identity and arithmetic mismatch are rejected", () => {
  const plan = buildHistoricalImportPlan({ sold: [row(1)], overall: [row(1), row(1), row(2, 1, 2, 99)], existing: [], expected: { sold: 1, unsold: 1, overall: 2 } });
  assert.ok(plan.duplicates.length > 0);
  assert.ok(plan.rejected.some((item) => item.endsWith(":formula")));
});
