import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSupervisor } from "@/lib/auth";
import { collections, type OlseraInventoryMonthlySnapshotDocument, type OlseraInventoryProductDocument } from "@/lib/mongodb";
import { currentStoreId } from "@/lib/olsera-store-id";
import { monthlySnapshotDocId } from "@/lib/olsera-inventory-monthly-snapshot-core";
import { getInventoryMonthlyPeriodLock } from "@/lib/inventory-monthly-period-lock";
import { buildHistoricalImportPlan, historicalDiagnostics, type HistoricalInventoryRow } from "@/lib/olsera-historical-inventory-import";
import { FEBRUARY_HISTORICAL_SOURCE } from "@/lib/february-historical-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const row = z.object({ productId: z.number().int().positive(), variantId: z.number().int().nonnegative().nullable(), productName: z.string().min(1).max(300), productSku: z.string().max(120).nullable(), groupName: z.string().min(1).max(120), openingQty: z.number().nonnegative(), incomingQty: z.number().nonnegative(), returnQty: z.number().nonnegative(), salesQty: z.number().nonnegative(), outgoingQty: z.number().nonnegative(), closingQty: z.number().nonnegative() });
const bodySchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), mode: z.enum(["dry-run", "confirm"]), source: z.enum(["payload", "built-in"]).default("built-in"), sold: z.array(row).optional(), overall: z.array(row).optional() });

function normalize(value: string) { return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ""); }

type BuiltInRow = { product: string; group: string; sku: string | null; opening: number; incoming: number; returnQty: number; salesQty: number; outgoingQty: number; closing: number };
function resolveBuiltIn(sourceRows: readonly BuiltInRow[], products: readonly OlseraInventoryProductDocument[]): HistoricalInventoryRow[] {
  return sourceRows.map((source) => {
    const wanted = normalize(source.product);
    const candidates = products.filter((product) => {
      const name = normalize(product.name);
      return name === wanted || (wanted === "bolapadelodea" && name.includes("odearose")) || (wanted.includes("plocomfort") && name.includes("xplocomfort"));
    });
    if (candidates.length !== 1) throw new Error(`Identitas historical tidak unik: ${source.product}`);
    const product = candidates[0];
    return { productId: product.productId, variantId: product.variantId, productName: source.product, productSku: source.sku ?? product.sku ?? null, groupName: source.group, openingQty: source.opening, incomingQty: source.incoming, returnQty: source.returnQty, salesQty: source.salesQty, outgoingQty: source.outgoingQty, closingQty: source.closing };
  });
}

export async function POST(request: Request) {
  try {
    const actor = await requireSupervisor();
    if (actor.role !== "supervisor") return NextResponse.json({ error: "Hanya supervisor yang boleh mengimpor stok historical." }, { status: 403 });
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Payload periode atau data historical tidak valid." }, { status: 400 });
    const { period, mode } = parsed.data;
    const [year, month] = period.split("-").map(Number);
    const storeId = currentStoreId();
    const c = await collections();
    const lock = await getInventoryMonthlyPeriodLock(storeId, year, month, { locks: c.inventoryMonthlyPeriodLocks, snapshots: c.olseraInventoryMonthlySnapshots, products: c.olseraInventoryProducts });
    if (lock?.status === "locked") return NextResponse.json({ error: "Periode inventori sudah terkunci." }, { status: 409 });
    const [existing, products] = await Promise.all([c.olseraInventoryMonthlySnapshots.find({ storeId, year, month }).toArray(), c.olseraInventoryProducts.find({ storeId: { $in: [storeId, null] } }).toArray()]);
    const sourceSold = parsed.data.source === "built-in" ? resolveBuiltIn(FEBRUARY_HISTORICAL_SOURCE.sold, products) : parsed.data.sold ?? [];
    const sourceOverall = parsed.data.source === "built-in" ? resolveBuiltIn(FEBRUARY_HISTORICAL_SOURCE.overall, products) : parsed.data.overall ?? [];
    const catalog = new Map(products.map((product) => [`${product.productId}:${product.variantId ?? 0}`, product]));
    const verify = (items: HistoricalInventoryRow[]) => items.map((item) => {
      const product = catalog.get(`${item.productId}:${item.variantId ?? 0}`);
      if (!product || (item.productSku && product.sku && item.productSku !== product.sku)) throw new Error(`Identitas produk tidak cocok: ${item.productName}`);
      return item;
    });
    const plan = buildHistoricalImportPlan({ sold: verify(sourceSold), overall: verify(sourceOverall), existing });
    if (plan.duplicates.length || plan.rejected.length) return NextResponse.json({ ok: false, mode, counts: plan.counts, changes: plan.changes, duplicates: plan.duplicates, rejected: plan.rejected }, { status: 422 });
    const incomplete = plan.rows.filter((item) => historicalDiagnostics(item).length).map((item) => ({ productName: item.productName, diagnostics: historicalDiagnostics(item) }));
    if (mode === "dry-run") return NextResponse.json({ ok: true, mode, actor: actor.email, counts: plan.counts, changes: plan.changes, incomplete, duplicates: [], rejected: [] });
    const now = new Date();
    const docs: OlseraInventoryMonthlySnapshotDocument[] = plan.rows.map((item) => { const diagnostics = ["USER_HISTORICAL_INVENTORY: supervisor-confirmed import", ...historicalDiagnostics(item)]; return { _id: monthlySnapshotDocId(storeId, year, month, item.productId, item.variantId), storeId, year, month, snapshotDate: `${period}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`, productId: item.productId, variantId: item.variantId, canonicalProductId: item.productId, productName: item.productName, productSku: item.productSku, groupName: item.groupName, openingQty: item.openingQty, incomingQty: item.incomingQty, returnQty: item.returnQty, salesQty: item.salesQty, outgoingQty: item.outgoingQty, closingQty: item.closingQty, source: "baseline-file", status: diagnostics.length > 1 ? "incomplete" : "complete", diagnostics, finalizedAt: now, createdAt: now, updatedAt: now }; });
    await c.olseraInventoryMonthlySnapshots.bulkWrite(docs.map((doc) => { const { createdAt, ...rest } = doc; return { updateOne: { filter: { _id: doc._id }, update: { $set: rest, $setOnInsert: { createdAt } }, upsert: true } }; }));
    return NextResponse.json({ ok: true, mode, actor: actor.email, counts: plan.counts, changes: plan.changes, duplicates: [], rejected: [] });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Import historical gagal." }, { status: 500 });
  }
}
