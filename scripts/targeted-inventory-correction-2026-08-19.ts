import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

for (const fileName of [".env.local", ".env"]) {
  const filePath = path.join(process.cwd(), fileName);
  if (!existsSync(filePath)) continue;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

const { collections, mongoClient } = await import("../lib/mongodb.ts");
const { currentStoreId } = await import("../lib/olsera-store-id.ts");
const { buildTargetedInventoryCorrectionPlan, TARGETED_INVENTORY_CORRECTION_MARKER, TARGETED_INVENTORY_PRODUCT_IDS } = await import("../lib/targeted-inventory-correction.ts");

const APPLY = process.argv.includes("--apply");
const storeId = currentStoreId();
const result = await (async () => {
  const c = await collections();
  const existingMarker = (await c.olseraInventoryState.findOne({ _id: "olsera-inventory" }))?.targetedInventoryCorrections?.[TARGETED_INVENTORY_CORRECTION_MARKER];
  if (existingMarker?.status === "complete") return { status: "skipped", reason: "marker-already-complete", marker: TARGETED_INVENTORY_CORRECTION_MARKER };
  const locks = await c.inventoryMonthlyPeriodLocks.find({ storeId, year: 2026, month: { $in: [2, 3] }, status: "locked" }).project({ _id: 1 }).toArray();
  if (locks.length) throw new Error("Target period locked; correction stopped without unlock.");
  const snapshots = await c.olseraInventoryMonthlySnapshots.find({ storeId, year: 2026, month: { $in: [2, 3] }, productId: { $in: [...TARGETED_INVENTORY_PRODUCT_IDS] } }).toArray();
  const products = await c.olseraInventoryProducts.find({ storeId: { $in: [storeId, null] }, productId: { $in: [...TARGETED_INVENTORY_PRODUCT_IDS] } }).project({ productId: 1, variantId: 1, name: 1, sku: 1 }).toArray();
  if (products.length !== 3 || new Set(products.map((p) => p.productId)).size !== 3) throw new Error("Exact productId catalog proof failed.");
  const plan = buildTargetedInventoryCorrectionPlan({ storeId, snapshots });
  const safe = { marker: plan.marker, status: "dry-run", storeId, changedProductIds: plan.changedProductIds, rows: plan.rows.map((r) => ({ productId: r.productId, month: r.month, before: r.before, after: r.after })) };
  if (!APPLY) return safe;
  const now = new Date();
  const claimed = await c.olseraInventoryState.findOneAndUpdate(
    { _id: "olsera-inventory", [`targetedInventoryCorrections.${TARGETED_INVENTORY_CORRECTION_MARKER}`]: { $exists: false } },
    { $set: { [`targetedInventoryCorrections.${TARGETED_INVENTORY_CORRECTION_MARKER}`]: { status: "running", marker: TARGETED_INVENTORY_CORRECTION_MARKER, reason: TARGETED_INVENTORY_CORRECTION_MARKER, backup: plan.rows.map((r) => r.before), changedProductIds: plan.changedProductIds, startedAt: now } } },
    { upsert: true, returnDocument: "after" },
  );
  if (claimed?.targetedInventoryCorrections?.[TARGETED_INVENTORY_CORRECTION_MARKER]?.status !== "running") return { status: "skipped", reason: "marker-claimed-by-another-run", marker: TARGETED_INVENTORY_CORRECTION_MARKER };
  for (const row of plan.rows) {
    const { createdAt, ...update } = row.after;
    await c.olseraInventoryMonthlySnapshots.updateOne({ _id: row.before._id, storeId, year: 2026, month: row.month, productId: row.productId, updatedAt: row.before.updatedAt }, { $set: update, $setOnInsert: { createdAt } });
  }
  await c.olseraInventoryState.updateOne({ _id: "olsera-inventory" }, { $set: { [`targetedInventoryCorrections.${TARGETED_INVENTORY_CORRECTION_MARKER}`]: { status: "complete", marker: TARGETED_INVENTORY_CORRECTION_MARKER, reason: TARGETED_INVENTORY_CORRECTION_MARKER, backup: plan.rows.map((r) => r.before), changedProductIds: plan.changedProductIds, startedAt: now, completedAt: new Date() } } });
  return { status: "applied", marker: TARGETED_INVENTORY_CORRECTION_MARKER, changedProductIds: plan.changedProductIds, rows: plan.rows.map((r) => ({ productId: r.productId, month: r.month, before: r.before, after: r.after })) };
})();
console.log(JSON.stringify(result, null, 2));
await mongoClient.close();
