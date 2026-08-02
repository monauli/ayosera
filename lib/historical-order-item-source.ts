// Source adapter — Historical Product Mapping (Milestone 4 Bagian A/B).
// Read-only: memuat olsera_order_items yang kehilangan productId/variantId/sku
// (SELURUH koleksi, tidak dibatasi rentang tanggal tetap, supaya audit
// "seluruh data historis" genuinely komprehensif — bukan hanya jendela
// 2026-05-01..2026-07-13 yang sudah diketahui) beserta katalog/alias/histori
// pendukung, lalu mengklasifikasikannya lewat historical-order-item-identity.ts.
// Pola sama dengan lib/reconciliation-court-revenue-source.ts (DI context,
// resolve default ke koleksi Mongo sungguhan bila tidak di-inject).
import "server-only";
import { normalizeName } from "./olsera-category-resolver.ts";
import {
  classifyOrderItemIdentity,
  duplicateKey,
  fieldState,
  type ClassifiedOrderItem,
  type IdentityAliasEntry,
  type IdentityCatalogEntry,
  type IdentityClassificationContext,
  type IdentityHistoricalEntry,
  type OrderItemIdentityInput,
} from "./historical-order-item-identity.ts";

export type GappedOrderItemRaw = OrderItemIdentityInput & Record<string, unknown>;

export type HistoricalOrderItemSourceContext = {
  orderItems: {
    find(filter: Record<string, unknown>): { project(p: Record<string, 1>): { toArray(): Promise<GappedOrderItemRaw[]> } };
    aggregate(pipeline: unknown[]): { toArray(): Promise<{ _id: string; combos: { productId: number; variantId: number | null; sku: string | null }[]; minDate: string; maxDate: string }[]> };
  };
  catalog: { find(): { toArray(): Promise<{ productId: number; variantId: number | null; sku: string | null; name: string; variantName?: string | null; active: boolean }[]> } };
  aliases: { find(): { toArray(): Promise<{ normalizedName: string; newProductId: number; newVariantId: number | null; sku: string | null; source: string; confidence: string }[]> } };
};

export async function resolveHistoricalOrderItemSourceContext(context?: HistoricalOrderItemSourceContext): Promise<HistoricalOrderItemSourceContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { olseraOrderItems, olseraInventoryProducts, olseraProductAliases } = await collections();
  return {
    orderItems: olseraOrderItems as unknown as HistoricalOrderItemSourceContext["orderItems"],
    catalog: olseraInventoryProducts as unknown as HistoricalOrderItemSourceContext["catalog"],
    aliases: olseraProductAliases as unknown as HistoricalOrderItemSourceContext["aliases"],
  };
}

const GAP_PROJECTION = {
  _id: 1, date: 1, orderNo: 1, itemName: 1, normalizedItemName: 1, qty: 1, amount: 1, syncedAt: 1,
  productId: 1, variantId: 1, sku: 1, categoryResolutionStatus: 1, resolvedCategoryName: 1,
} as const;

/**
 * Muat & klasifikasikan SELURUH baris olsera_order_items yang kehilangan
 * productId/variantId/sku. Read-only murni — tidak pernah menulis.
 */
export async function loadHistoricalOrderItemIdentityAudit(
  context?: HistoricalOrderItemSourceContext,
): Promise<{ rows: ClassifiedOrderItem[]; totalScanned: number }> {
  const { orderItems, catalog, aliases } = await resolveHistoricalOrderItemSourceContext(context);

  // Gap SEBENARNYA hanya ditentukan oleh productId hilang (absent/null) — BUKAN
  // variantId/sku. Dikonfirmasi lewat backfill produksi Milestone 4: banyak
  // produk katalog Olsera memang TIDAK PERNAH punya variant atau SKU
  // (variantId/sku bernilai null secara sah di katalog itu sendiri), jadi
  // setelah productId berhasil diisi dari katalog, variantId/sku boleh TETAP
  // null selamanya — itu bukan gap yang tersisa, bukan bug. Menyaring hanya
  // dari productId juga membuat isGapped()/fieldState() di
  // historical-order-item-identity.ts tetap dipakai konsisten sbg definisi
  // "belum diisi" (fieldState productId !== "present").
  const candidateRows = await orderItems
    .find({ $or: [{ productId: { $exists: false } }, { productId: null }] })
    .project(GAP_PROJECTION)
    .toArray();

  const gapped = candidateRows.filter((raw) => fieldState(raw, "productId") !== "present");

  const uniqueNames = [...new Set(gapped.map((r) => r.normalizedItemName ?? normalizeName(r.itemName)))];

  const catalogDocs = await catalog.find().toArray();
  const catalogByName = new Map<string, IdentityCatalogEntry[]>();
  const catalogByBaseName = new Map<string, IdentityCatalogEntry[]>();
  for (const p of catalogDocs) {
    const fullName = p.variantName ? `${p.name} - ${p.variantName}` : p.name;
    const entry: IdentityCatalogEntry = { productId: p.productId, variantId: p.variantId, sku: p.sku, name: fullName, active: p.active };
    const key = normalizeName(fullName);
    if (!catalogByName.has(key)) catalogByName.set(key, []);
    catalogByName.get(key)!.push(entry);
    const baseKey = normalizeName(p.name);
    if (!catalogByBaseName.has(baseKey)) catalogByBaseName.set(baseKey, []);
    catalogByBaseName.get(baseKey)!.push(entry);
  }

  const aliasDocs = await aliases.find().toArray();
  const aliasByName = new Map<string, IdentityAliasEntry[]>();
  for (const a of aliasDocs) {
    if (!a.normalizedName) continue;
    if (!aliasByName.has(a.normalizedName)) aliasByName.set(a.normalizedName, []);
    aliasByName.get(a.normalizedName)!.push(a as IdentityAliasEntry);
  }

  const historicalAgg = await orderItems
    .aggregate([
      { $match: { normalizedItemName: { $in: uniqueNames }, productId: { $type: "number" } } },
      { $group: { _id: "$normalizedItemName", combos: { $addToSet: { productId: "$productId", variantId: "$variantId", sku: "$sku" } }, minDate: { $min: "$date" }, maxDate: { $max: "$date" } } },
    ])
    .toArray();
  const historicalByName = new Map<string, IdentityHistoricalEntry>(historicalAgg.map((h) => [h._id, { combos: h.combos, minDate: h.minDate, maxDate: h.maxDate }]));

  const duplicateKeyCount = new Map<string, number>();
  for (const r of gapped) {
    const name = r.normalizedItemName ?? normalizeName(r.itemName);
    const k = duplicateKey(r, name);
    duplicateKeyCount.set(k, (duplicateKeyCount.get(k) ?? 0) + 1);
  }

  const classificationContext: IdentityClassificationContext = { catalogByName, catalogByBaseName, aliasByName, historicalByName, duplicateKeyCount };
  const rows = gapped.map((raw) => classifyOrderItemIdentity(raw, classificationContext));

  return { rows, totalScanned: candidateRows.length };
}
