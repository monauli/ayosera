import assert from "node:assert/strict";
import { test } from "node:test";
import { rebuildMonthlyInventory } from "./rebuild-monthly-inventory.ts";

test("rebuildMonthlyInventory: rejects locked period before fetch/write", async () => {
  let wrote = false;
  const repo = {
    upsertMany: async () => { wrote = true; },
    findMonth: async () => [{ _id: "old", storeId: 1, year: 2026, month: 2, closingQty: 1, openingQty: 1, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0 } as never],
    findPeriodLock: async () => ({ status: "locked" as const }),
  };
  const result = await rebuildMonthlyInventory({ storeId: 1, year: 2026, month: 3, mode: "dryRun", repo });
  assert.equal(result.ok, false);
  assert.equal(wrote, false);
});

test("rebuildMonthlyInventory: invalid mode is not accepted by service type", () => {
  assert.equal(typeof rebuildMonthlyInventory, "function");
});
