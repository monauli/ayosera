import { collections, type OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";
import { currentStoreId } from "./olsera-store-id.ts";

export const TARGETED_INVENTORY_CORRECTION_MARKER = "USER_CONFIRMED_2026_08_19";
export const TARGETED_INVENTORY_PRODUCT_IDS = [106771148, 111350931, 116138490] as const;

type Snapshot = OlseraInventoryMonthlySnapshotDocument;
type Change = { productId: number; month: number; before: Snapshot; after: Snapshot };

const key = (d: Snapshot) => `${d.storeId}:${d.year}-${String(d.month).padStart(2, "0")}:${d.productId}:${d.variantId ?? 0}`;
const formula = (d: Snapshot) => [d.openingQty, d.incomingQty, d.returnQty, d.salesQty, d.outgoingQty].every((v) => v !== null)
  ? d.openingQty! + d.incomingQty! + d.returnQty! - d.salesQty! - d.outgoingQty!
  : null;

export function buildTargetedInventoryCorrectionPlan(input: { storeId: number; snapshots: readonly Snapshot[] }) {
  const target = new Map(input.snapshots.filter((d) => d.storeId === input.storeId && d.year === 2026 && d.month >= 2 && d.month <= 3).map((d) => [key(d), d]));
  const rows: Change[] = [];
  const update = (productId: number, month: number, values: Partial<Snapshot>) => {
    const before = target.get(`${input.storeId}:2026-${String(month).padStart(2, "0")}:${productId}:0`);
    if (!before) throw new Error(`Target snapshot tidak ditemukan: ${productId}/2026-${String(month).padStart(2, "0")}`);
    const after = { ...before, ...values, updatedAt: new Date() };
    after.closingQty = formula(after);
    rows.push({ productId, month, before, after });
  };
  update(106771148, 2, { salesQty: 0 });
  update(106771148, 3, { openingQty: 2 });
  update(111350931, 2, { incomingQty: 0 });
  update(111350931, 3, { openingQty: 0, incomingQty: 60 });
  update(116138490, 2, { salesQty: 36 });
  update(116138490, 3, { openingQty: 60 });
  return {
    marker: TARGETED_INVENTORY_CORRECTION_MARKER,
    changedProductIds: [...TARGETED_INVENTORY_PRODUCT_IDS],
    rows,
    untouchedProductIds: [...new Set(input.snapshots.map((d) => d.productId))].filter((id) => !TARGETED_INVENTORY_PRODUCT_IDS.includes(id as never)),
  };
}

export async function runTargetedInventoryCorrection(input: { dryRun: boolean; confirm: boolean; actor: string }) {
  const c = await collections();
  const storeId = currentStoreId();
  const marker = TARGETED_INVENTORY_CORRECTION_MARKER;
  const existing = (await c.olseraInventoryState.findOne({ _id: "olsera-inventory" }))?.targetedInventoryCorrections?.[marker];
  if (existing?.status === "complete") return { status: "skipped", reason: "marker-already-complete", marker } as const;
  const locks = await c.inventoryMonthlyPeriodLocks.find({ storeId, year: 2026, month: { $in: [2, 3] }, status: "locked" }).project({ _id: 1 }).toArray();
  if (locks.length) throw new Error("Target period locked; correction stopped without unlock.");
  const snapshots = await c.olseraInventoryMonthlySnapshots.find({ storeId, year: 2026, month: { $in: [2, 3] }, productId: { $in: [...TARGETED_INVENTORY_PRODUCT_IDS] } }).toArray();
  const products = await c.olseraInventoryProducts.find({ storeId: { $in: [storeId, null] }, productId: { $in: [...TARGETED_INVENTORY_PRODUCT_IDS] } }).project({ productId: 1, variantId: 1 }).toArray();
  if (products.length !== 3 || new Set(products.map((p) => p.productId)).size !== 3) throw new Error("Exact productId catalog proof failed.");
  const plan = buildTargetedInventoryCorrectionPlan({ storeId, snapshots });
  const result = { marker, actor: input.actor, dryRun: input.dryRun, changedProductIds: plan.changedProductIds, rows: plan.rows.map((r) => ({ productId: r.productId, month: r.month, before: r.before, after: r.after })) };
  if (input.dryRun) return { ...result, status: "dry-run" } as const;
  if (!input.confirm) throw new Error("Explicit confirmation required for write.");
  const now = new Date();
  const claimed = await c.olseraInventoryState.findOneAndUpdate(
    { _id: "olsera-inventory", [`targetedInventoryCorrections.${marker}`]: { $exists: false } },
    { $set: { [`targetedInventoryCorrections.${marker}`]: { status: "running", marker, reason: marker, backup: plan.rows.map((r) => r.before), changedProductIds: plan.changedProductIds, startedAt: now } } },
    { upsert: true, returnDocument: "after" },
  );
  if (claimed?.targetedInventoryCorrections?.[marker]?.status !== "running") return { status: "skipped", reason: "marker-claimed-by-another-run", marker } as const;
  for (const row of plan.rows) {
    const { createdAt, ...update } = row.after;
    await c.olseraInventoryMonthlySnapshots.updateOne({ _id: row.before._id, storeId, year: 2026, month: row.month, productId: row.productId, updatedAt: row.before.updatedAt }, { $set: update, $setOnInsert: { createdAt } });
  }
  await c.olseraInventoryState.updateOne({ _id: "olsera-inventory" }, { $set: { [`targetedInventoryCorrections.${marker}`]: { status: "complete", marker, reason: marker, backup: plan.rows.map((r) => r.before), changedProductIds: plan.changedProductIds, startedAt: now, completedAt: new Date() } } });
  return { ...result, status: "applied" } as const;
}
