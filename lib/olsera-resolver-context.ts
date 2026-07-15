// Pemuat ResolverContext untuk canonical category resolver: katalog aktif
// (API Olsera), alias produk historis (MongoDB), dan identitas historis
// (nama item yang pernah ter-resolve konsisten). Dipakai oleh sync penjualan,
// kedua export kategori, dan backfill — semua lewat satu jalur ini.

import { collections, withMongo, type OlseraOrderItemDocument } from "@/lib/mongodb";
import { getAccessToken } from "@/lib/olsera";
import {
  buildResolverContext,
  catalogEntriesFromOlseraProduct,
  normalizeName,
  resolveItemCategory,
  type AliasEntry,
  type CatalogEntry,
  type CategoryOverrideEntry,
  type CategoryResolution,
  type HistoricalEntry,
  type ItemIdentity,
  type ResolverContext,
} from "@/lib/olsera-category-resolver";

const BASE_URL = "https://api-open.olsera.co.id";
const API_PREFIX = "/api/open-api/v1/id";
const CONTEXT_TTL_MS = 10 * 60 * 1000;

let contextCache: { ctx: ResolverContext; fetchedAt: number } | null = null;

async function fetchCatalogEntries(token: string): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  let page = 1;
  for (;;) {
    const url = new URL(`${BASE_URL}${API_PREFIX}/product`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} saat menarik katalog produk Olsera.`);
    const body = (await response.json()) as { data?: Record<string, unknown>[]; meta?: { last_page?: number } };
    for (const product of body.data ?? []) entries.push(...catalogEntriesFromOlseraProduct(product));
    if (!body.meta?.last_page || page >= body.meta.last_page) break;
    page++;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return entries;
}

async function loadAliases(): Promise<AliasEntry[]> {
  return withMongo(async () => {
    const { olseraProductAliases } = await collections();
    const docs = await olseraProductAliases.find().toArray();
    return docs.map((doc) => ({
      oldProductId: doc.oldProductId,
      oldVariantId: doc.oldVariantId,
      newProductId: doc.newProductId,
      newVariantId: doc.newVariantId,
      sku: doc.sku,
      normalizedName: doc.normalizedName,
      categoryId: doc.categoryId,
      categoryName: doc.categoryName,
      confidence: doc.confidence,
    }));
  });
}

/** Override manual per item (olsera_category_overrides) — kunci orderItemId, tidak pernah global. */
async function loadCategoryOverrides(): Promise<CategoryOverrideEntry[]> {
  return withMongo(async () => {
    const { olseraCategoryOverrides } = await collections();
    const docs = await olseraCategoryOverrides.find().toArray();
    return docs.map((doc) => ({ orderItemId: doc._id, category: doc.category, reason: doc.reason }));
  });
}

/** Nama → kategori yang pernah ter-resolve KONSISTEN (satu kategori saja) di histori item. */
async function loadHistoricalIdentities(): Promise<HistoricalEntry[]> {
  return withMongo(async () => {
    const { olseraOrderItems } = await collections();
    const rows = await olseraOrderItems
      .aggregate<{ _id: string; categories: string[]; categoryIds: (string | null)[] }>([
        {
          $match: {
            categoryResolutionStatus: "resolved",
            normalizedItemName: { $type: "string" },
            resolvedCategoryName: { $type: "string" },
            // manual_override adalah koreksi PER ITEM (konfirmasi kasus spesifik) —
            // tidak boleh ikut membentuk identitas historis global, karena itu akan
            // membuat item LAIN dengan nama sama otomatis ikut ter-resolve juga.
            categoryResolutionMethod: { $ne: "manual_override" },
          },
        },
        {
          $group: {
            _id: "$normalizedItemName",
            categories: { $addToSet: "$resolvedCategoryName" },
            categoryIds: { $addToSet: "$resolvedCategoryId" },
          },
        },
      ])
      .toArray();
    return rows
      .filter((row) => row.categories.length === 1)
      .map((row) => ({
        normalizedName: row._id,
        category: row.categories[0],
        categoryId: row.categoryIds.find((id) => id !== null) ?? null,
      }));
  });
}

export type LoadedResolverContext = { ctx: ResolverContext; cacheHit: boolean };

export async function loadResolverContext(options: { forceRefresh?: boolean } = {}): Promise<LoadedResolverContext> {
  if (!options.forceRefresh && contextCache && Date.now() - contextCache.fetchedAt < CONTEXT_TTL_MS) {
    return { ctx: contextCache.ctx, cacheHit: true };
  }
  const auth = await getAccessToken();
  if ("error" in auth) throw new Error(auth.error);
  const [catalog, aliases, historical, overrides] = await Promise.all([
    fetchCatalogEntries(auth.token),
    loadAliases(),
    loadHistoricalIdentities(),
    loadCategoryOverrides(),
  ]);
  const ctx = buildResolverContext({ catalog, aliases, historical, overrides });
  contextCache = { ctx, fetchedAt: Date.now() };
  return { ctx, cacheHit: false };
}

/**
 * Identitas resolver dari dokumen olsera_order_items (lama maupun baru).
 * `_id` opsional: sebagian query proyeksi (export) sengaja tidak menariknya
 * (`_id: 0`) — tanpanya, lookup manual override (per orderItemId) dilewati,
 * tetapi item yang SUDAH resolved tetap terbaca via resolveStoredItemCategory
 * (mempercayai resolvedCategoryName tersimpan lebih dulu).
 */
export function identityFromStoredItem(
  item: Pick<
    OlseraOrderItemDocument,
    "itemName" | "productId" | "variantId" | "sku" | "barcode" | "originalCategoryId" | "originalCategoryName"
  > & { _id?: number },
): ItemIdentity {
  return {
    itemName: item.itemName,
    productId: item.productId ?? null,
    variantId: item.variantId ?? null,
    sku: item.sku ?? null,
    barcode: item.barcode ?? null,
    originalCategoryId: item.originalCategoryId ?? null,
    originalCategoryName: item.originalCategoryName ?? null,
    orderItemId: item._id ?? null,
  };
}

/**
 * Kategori canonical untuk item yang tersimpan: hasil resolusi tersimpan
 * dipakai lebih dulu (identitas historis yang sudah diaudit), lalu resolver.
 */
export function resolveStoredItemCategory(
  item: Pick<
    OlseraOrderItemDocument,
    | "itemName"
    | "productId"
    | "variantId"
    | "sku"
    | "barcode"
    | "originalCategoryId"
    | "originalCategoryName"
    | "resolvedCategoryName"
    | "categoryResolutionStatus"
  > & { _id?: number },
  ctx: ResolverContext,
): string {
  if (item.categoryResolutionStatus === "resolved" && item.resolvedCategoryName) return item.resolvedCategoryName;
  return resolveItemCategory(identityFromStoredItem(item), ctx).category;
}

export { normalizeName, resolveItemCategory };
export type { CategoryResolution, ItemIdentity, ResolverContext };
