import { collections, type OlseraInventoryMonthlySnapshotDocument, type OlseraInventoryProductDocument } from "@/lib/mongodb";
import { currentStoreId } from "@/lib/olsera-store-id";
import { monthlySnapshotDocId } from "@/lib/olsera-inventory-monthly-snapshot-core";
import { buildHistoricalImportPlan, historicalDiagnostics, type HistoricalInventoryRow } from "@/lib/olsera-historical-inventory-import";
import { FEBRUARY_HISTORICAL_SOURCE, type FebruaryHistoricalRow } from "@/lib/february-historical-source";

const period = "2026-02";
const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
type BuiltInRow = FebruaryHistoricalRow;

function resolve(rows: readonly BuiltInRow[], products: readonly OlseraInventoryProductDocument[]): HistoricalInventoryRow[] {
  return rows.map((source) => {
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

export async function runFebruaryHistoricalMigration() {
  const c = await collections();
  const current = await c.olseraInventoryState.findOne({ _id: "olsera-inventory" });
  if (current?.februaryHistoricalImport?.status === "complete") return { status: "skipped", counts: current.februaryHistoricalImport.counts };
  const claimed = await c.olseraInventoryState.findOneAndUpdate(
    { _id: "olsera-inventory", $or: [{ "februaryHistoricalImport.status": { $exists: false } }, { "februaryHistoricalImport.status": "failed" }] },
    { $set: { februaryHistoricalImport: { status: "running", startedAt: new Date() } } },
    { upsert: true, returnDocument: "after" },
  );
  if (claimed?.februaryHistoricalImport?.status !== "running") return { status: "skipped" };
  try {
    const storeId = currentStoreId();
    const [products, existing] = await Promise.all([
      c.olseraInventoryProducts.find({ storeId: { $in: [storeId, null] } }).toArray(),
      c.olseraInventoryMonthlySnapshots.find({ storeId, year: 2026, month: 2 }).toArray(),
    ]);
    const catalog = new Map(products.map((product) => [`${product.productId}:${product.variantId ?? 0}`, product]));
    const verify = (items: HistoricalInventoryRow[]) => items.map((item) => {
      const product = catalog.get(`${item.productId}:${item.variantId ?? 0}`);
      if (!product || (item.productSku && product.sku && item.productSku !== product.sku)) throw new Error(`Identitas produk tidak cocok: ${item.productName}`);
      return item;
    });
    const plan = buildHistoricalImportPlan({ sold: verify(resolve(FEBRUARY_HISTORICAL_SOURCE.sold, products)), overall: verify(resolve(FEBRUARY_HISTORICAL_SOURCE.overall, products)), existing });
    if (plan.duplicates.length || plan.rejected.length) throw new Error(`Validasi Februari gagal: ${plan.rejected.join(",") || plan.duplicates.join(",")}`);
    const now = new Date();
    const docs: OlseraInventoryMonthlySnapshotDocument[] = plan.rows.map((item) => {
      const diagnostics = ["CRON_BUILT_IN_HISTORICAL_INVENTORY", ...historicalDiagnostics(item)];
      return { _id: monthlySnapshotDocId(storeId, 2026, 2, item.productId, item.variantId), storeId, year: 2026, month: 2, snapshotDate: "2026-02-28", productId: item.productId, variantId: item.variantId, canonicalProductId: item.productId, productName: item.productName, productSku: item.productSku, groupName: item.groupName, openingQty: item.openingQty, incomingQty: item.incomingQty, returnQty: item.returnQty, salesQty: item.salesQty, outgoingQty: item.outgoingQty, closingQty: item.closingQty, source: "baseline-file", status: diagnostics.length > 1 ? "incomplete" : "complete", diagnostics, finalizedAt: now, createdAt: now, updatedAt: now };
    });
    await c.olseraInventoryMonthlySnapshots.bulkWrite(docs.map((doc) => { const { createdAt, ...rest } = doc; return { updateOne: { filter: { _id: doc._id }, update: { $set: rest, $setOnInsert: { createdAt } }, upsert: true } }; }));
    const incomplete = docs.filter((doc) => doc.status === "incomplete").length;
    const counts = plan.counts;
    await c.olseraInventoryState.updateOne({ _id: "olsera-inventory" }, { $set: { februaryHistoricalImport: { status: "complete", completedAt: now, counts, incomplete } } });
    return { status: "complete", counts, incomplete };
  } catch (error) {
    await c.olseraInventoryState.updateOne({ _id: "olsera-inventory" }, { $set: { februaryHistoricalImport: { status: "failed", failedAt: new Date(), message: error instanceof Error ? error.message : "unknown" } } });
    throw error;
  }
}
