import assert from "node:assert/strict";
import test from "node:test";
import { isValidInventoryMonthlySnapshot, lockInventoryMonthlyPeriod, unlockInventoryMonthlyPeriod, type InventoryMonthlyPeriodLockContext } from "./inventory-monthly-period-lock.ts";
import type { InventoryMonthlyPeriodLockDocument, OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";

const snapshot = (closingQty = 15): OlseraInventoryMonthlySnapshotDocument => ({ _id: "1:2026-02:1:0", storeId: 1, year: 2026, month: 2, snapshotDate: "2026-02-28", productId: 1, variantId: null, canonicalProductId: null, productName: "YONEX SHORTS MEN", productSku: "SM-J035-2906-RW1-S", groupName: "YONEX", openingQty: 24, incomingQty: 0, returnQty: 0, salesQty: 9, outgoingQty: 0, closingQty, source: "baseline-file", status: "complete", diagnostics: [], createdAt: new Date(), updatedAt: new Date() });

function fakeContext(initial: InventoryMonthlyPeriodLockDocument | null = null, products: Array<{ productId: number; variantId: number | null; active?: boolean; stockQty?: number }> = []): InventoryMonthlyPeriodLockContext {
  let lock = initial;
  return {
    snapshots: { find: () => ({ toArray: async () => [snapshot()] }) },
    products: { find: () => ({ toArray: async () => products }) },
    locks: {
      findOne: async () => lock,
      findOneAndUpdate: async (_filter, update) => {
        const set = update.$set as Record<string, unknown>;
        const pushed = (update.$push as { history: InventoryMonthlyPeriodLockDocument["history"][number] }).history;
        lock = { ...(lock ?? { _id: "1:2026-02", createdAt: new Date(), history: [] }), ...set, history: [...(lock?.history ?? []), pushed] } as InventoryMonthlyPeriodLockDocument;
        return lock;
      },
    },
  };
}

test("valid monthly snapshot arithmetic is lockable; closing 130 is rejected", () => {
  assert.equal(isValidInventoryMonthlySnapshot(snapshot(15)), true);
  assert.equal(isValidInventoryMonthlySnapshot(snapshot(130)), false);
});

test("locked monthly snapshot is immutable and unlock keeps audit history", async () => {
  const context = fakeContext();
  const locked = await lockInventoryMonthlyPeriod({ storeId: 1, year: 2026, month: 2, actor: "supervisor" }, context);
  assert.equal(locked.status, "locked");
  assert.equal(locked.snapshots[0].closingQty, 15);
  const unlocked = await unlockInventoryMonthlyPeriod({ storeId: 1, year: 2026, month: 2, actor: "supervisor", reason: "Koreksi resmi" }, context);
  assert.equal(unlocked.status, "unlocked");
  assert.deepEqual(unlocked.history.map((item) => item.action), ["lock", "unlock"]);
});

test("inventory unlock requires a reason", async () => {
  await assert.rejects(() => unlockInventoryMonthlyPeriod({ storeId: 1, year: 2026, month: 2, actor: "supervisor", reason: " " }, fakeContext()), /Reason unlock wajib/);
});

test("lock rejects unresolved catalog-only candidates", async () => {
  await assert.rejects(
    () => lockInventoryMonthlyPeriod({ storeId: 1, year: 2026, month: 2, actor: "supervisor" }, fakeContext(null, [{ productId: 99, variantId: null, active: true, stockQty: 2 }])),
    /produk katalog yang belum diverifikasi/,
  );
});
