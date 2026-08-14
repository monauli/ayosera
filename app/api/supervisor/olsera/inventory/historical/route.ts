import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSupervisor } from "@/lib/auth";
import { collections, type OlseraInventoryMonthlySnapshotDocument } from "@/lib/mongodb";
import { currentStoreId } from "@/lib/olsera-store-id";
import { monthlySnapshotDocId } from "@/lib/olsera-inventory-monthly-snapshot-core";
import { getInventoryMonthlyPeriodLock } from "@/lib/inventory-monthly-period-lock";
import { buildHistoricalImportPlan, type HistoricalInventoryRow } from "@/lib/olsera-historical-inventory-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const row = z.object({ productId: z.number().int().positive(), variantId: z.number().int().nonnegative().nullable(), productName: z.string().min(1).max(300), productSku: z.string().max(120).nullable(), groupName: z.string().min(1).max(120), openingQty: z.number().nonnegative(), incomingQty: z.number().nonnegative(), returnQty: z.number().nonnegative(), salesQty: z.number().nonnegative(), outgoingQty: z.number().nonnegative(), closingQty: z.number().nonnegative() });
const bodySchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), mode: z.enum(["dry-run", "confirm"]), sold: z.array(row), overall: z.array(row) });

export async function POST(request: Request) {
  try {
    const actor = await requireSupervisor();
    if (actor.role !== "supervisor") return NextResponse.json({ error: "Hanya supervisor yang boleh mengimpor stok historical." }, { status: 403 });
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Payload periode atau data historical tidak valid." }, { status: 400 });
    const { period, mode, sold, overall } = parsed.data;
    const [year, month] = period.split("-").map(Number);
    const storeId = currentStoreId();
    const c = await collections();
    const lock = await getInventoryMonthlyPeriodLock(storeId, year, month, { locks: c.inventoryMonthlyPeriodLocks, snapshots: c.olseraInventoryMonthlySnapshots, products: c.olseraInventoryProducts });
    if (lock?.status === "locked") return NextResponse.json({ error: "Periode inventori sudah terkunci." }, { status: 409 });
    const [existing, products] = await Promise.all([c.olseraInventoryMonthlySnapshots.find({ storeId, year, month }).toArray(), c.olseraInventoryProducts.find({ storeId: { $in: [storeId, null] } }).toArray()]);
    const catalog = new Map(products.map((product) => [`${product.productId}:${product.variantId ?? 0}`, product]));
    const verify = (items: HistoricalInventoryRow[]) => items.map((item) => {
      const product = catalog.get(`${item.productId}:${item.variantId ?? 0}`);
      if (!product || (item.productSku && product.sku && item.productSku !== product.sku)) throw new Error(`Identitas produk tidak cocok: ${item.productName}`);
      return item;
    });
    const plan = buildHistoricalImportPlan({ sold: verify(sold), overall: verify(overall), existing });
    if (plan.duplicates.length || plan.rejected.length) return NextResponse.json({ ok: false, mode, counts: plan.counts, changes: plan.changes, duplicates: plan.duplicates, rejected: plan.rejected }, { status: 422 });
    if (mode === "dry-run") return NextResponse.json({ ok: true, mode, actor: actor.email, counts: plan.counts, changes: plan.changes, duplicates: [], rejected: [] });
    const now = new Date();
    const docs: OlseraInventoryMonthlySnapshotDocument[] = plan.rows.map((item) => ({ _id: monthlySnapshotDocId(storeId, year, month, item.productId, item.variantId), storeId, year, month, snapshotDate: `${period}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`, productId: item.productId, variantId: item.variantId, canonicalProductId: item.productId, productName: item.productName, productSku: item.productSku, groupName: item.groupName, openingQty: item.openingQty, incomingQty: item.incomingQty, returnQty: item.returnQty, salesQty: item.salesQty, outgoingQty: item.outgoingQty, closingQty: item.closingQty, source: "baseline-file", status: "complete", diagnostics: ["USER_HISTORICAL_INVENTORY: supervisor-confirmed import"], finalizedAt: now, createdAt: now, updatedAt: now }));
    await c.olseraInventoryMonthlySnapshots.bulkWrite(docs.map((doc) => { const { createdAt, ...rest } = doc; return { updateOne: { filter: { _id: doc._id }, update: { $set: rest, $setOnInsert: { createdAt } }, upsert: true } }; }));
    return NextResponse.json({ ok: true, mode, actor: actor.email, counts: plan.counts, changes: plan.changes, duplicates: [], rejected: [] });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Import historical gagal." }, { status: 500 });
  }
}
