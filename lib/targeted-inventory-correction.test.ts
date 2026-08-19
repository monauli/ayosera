import test from "node:test";
import assert from "node:assert/strict";
import { buildTargetedInventoryCorrectionPlan } from "./targeted-inventory-correction.ts";

const doc = (productId: number, month: number, values: Partial<Record<string, number | null>> = {}) => ({
  _id: `1:2026-${String(month).padStart(2, "0")}:${productId}`,
  storeId: 1, year: 2026, month, snapshotDate: `2026-${String(month).padStart(2, "0")}-28`, productId, variantId: null,
  canonicalProductId: productId, productName: String(productId), productSku: null, groupName: "TEST",
  openingQty: 0, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0, closingQty: 0,
  source: "baseline-file" as const, status: "complete" as const, diagnostics: [], createdAt: new Date(0), updatedAt: new Date(0), ...values,
});

test("plans exactly three product identities and recalculates February-March carry-forward", () => {
  const plan = buildTargetedInventoryCorrectionPlan({
    storeId: 1,
    snapshots: [
      doc(106771148, 2, { openingQty: 2, salesQty: 1, closingQty: 1 }), doc(106771148, 3, { openingQty: 1, closingQty: 1 }),
      doc(111350931, 2, { incomingQty: 60, closingQty: 60 }), doc(111350931, 3, { openingQty: 60, incomingQty: 60, salesQty: 13, closingQty: 107 }),
      doc(116138490, 2, { openingQty: 96, salesQty: 30, closingQty: 66 }), doc(116138490, 3, { openingQty: 66, closingQty: 66 }),
      doc(999, 2, { openingQty: 4, closingQty: 4 }),
    ],
  });
  assert.deepEqual(plan.changedProductIds, [106771148, 111350931, 116138490]);
  assert.deepEqual(plan.rows.map((r) => [r.productId, r.month, r.before.closingQty, r.after.closingQty]), [
    [106771148, 2, 1, 2], [106771148, 3, 1, 2], [111350931, 2, 60, 0], [111350931, 3, 107, 47], [116138490, 2, 66, 60], [116138490, 3, 66, 60],
  ]);
  assert.equal(plan.rows.every((r) => r.after.closingQty === (r.after.openingQty! + r.after.incomingQty! + r.after.returnQty! - r.after.salesQty! - r.after.outgoingQty!)), true);
  assert.equal(plan.untouchedProductIds.includes(999), true);
});

test("rejects missing or ambiguous target snapshot identities", () => {
  assert.throws(() => buildTargetedInventoryCorrectionPlan({ storeId: 1, snapshots: [doc(106771148, 2)] }), /target snapshot/i);
});
