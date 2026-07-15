// Canonical resolver kategori produk Olsera — SATU sumber kebenaran mapping
// yang dipakai bersama oleh: sync penjualan, dashboard Penjualan per Kategori
// (via agregat hasil sync/backfill), Export Kategori Penjualan, Export Omset
// Kategori, dan backfill historis.
//
// Urutan lookup (wajib, dari paling kuat):
//   0. manual override PER ITEM TRANSAKSI (olsera_category_overrides, kunci =
//      orderItemId — unique key item, BUKAN nama/product_id — sehingga tidak
//      pernah menjadi aturan global untuk item lain yang kebetulan senama);
//   1. kategori asli dari item transaksi (bila payload menyimpannya);
//   2. product_id langsung di katalog aktif;
//   3. product_variant_id di katalog aktif;
//   4. alias product ID lama → product ID baru (olsera_product_aliases);
//   5. SKU exact (unik);
//   6. barcode exact (unik);
//   7. normalized product name exact (unik);
//   8. historical identity (nama yang pernah ter-resolve konsisten sebelumnya;
//      item hasil manual_override TIDAK ikut membentuk identitas historis ini
//      — lihat loadHistoricalIdentities di lib/olsera-resolver-context.ts);
//   9. fallback audit: status "unresolved" + alasan (BUKAN langsung kategori final).
//
// Tidak ada pencocokan substring longgar: nama hanya cocok bila exact setelah
// normalisasi DAN unik di sumbernya. Modul ini murni (tanpa MongoDB/fetch)
// supaya bisa diuji unit; pemuatan context ada di pemakainya.

export const UNKNOWN_CATEGORY = "Tidak Diketahui";

/** Normalisasi nama/klasifikasi — identik dengan lib/olsera-sync.ts. */
export function normalizeKlasifikasi(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/\s*\+\s*/g, "+");
}

/** Kunci lookup nama: normalisasi + uppercase. */
export function normalizeName(value: string): string {
  return normalizeKlasifikasi(value).toUpperCase();
}

export type CatalogEntry = {
  productId: number;
  variantId: number | null;
  /** Nama lengkap (produk, atau "produk - variant") apa adanya dari katalog. */
  name: string;
  sku: string | null;
  barcode: string | null;
  /** Klasifikasi ternormalisasi. */
  category: string;
  categoryId: string | null;
};

export type AliasEntry = {
  oldProductId: number;
  oldVariantId: number | null;
  newProductId: number | null;
  newVariantId: number | null;
  sku: string | null;
  normalizedName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  confidence: "verified" | "high" | "low";
};

/** Identitas historis: nama ternormalisasi → kategori yang pernah ter-resolve KONSISTEN. */
export type HistoricalEntry = { normalizedName: string; category: string; categoryId: string | null };

export type ItemIdentity = {
  itemName: string;
  productId?: number | null;
  variantId?: number | null;
  sku?: string | null;
  barcode?: string | null;
  originalCategoryId?: string | null;
  originalCategoryName?: string | null;
  /** Unique key baris item (olsera_order_items._id) — dipakai HANYA untuk lookup manual override per item. */
  orderItemId?: number | null;
};

export type ResolutionMethod =
  | "manual_override"
  | "original-category"
  | "product-id"
  | "variant-id"
  | "alias"
  | "sku"
  | "barcode"
  | "name-exact"
  | "historical"
  | "none";

export type CategoryResolution = {
  status: "resolved" | "unresolved";
  method: ResolutionMethod;
  /** Kategori final (UNKNOWN_CATEGORY bila unresolved — untuk tampilan, bukan vonis). */
  category: string;
  categoryId: string | null;
  resolvedProductId: number | null;
  resolvedVariantId: number | null;
  reason: string | null;
};

// "ambiguous" = kunci muncul lebih dari sekali di sumbernya → dilarang dipakai otomatis.
type UniqueMap<T> = Map<string, T | "ambiguous">;

/** Override manual per item transaksi, kunci = orderItemId (bukan nama/product_id). */
export type CategoryOverrideEntry = { orderItemId: number; category: string; reason: string };

export type ResolverContext = {
  byProductId: Map<number, CatalogEntry>;
  byVariantId: Map<number, CatalogEntry>;
  bySku: UniqueMap<CatalogEntry>;
  byBarcode: UniqueMap<CatalogEntry>;
  byName: UniqueMap<CatalogEntry>;
  aliasByOldKey: Map<string, AliasEntry>;
  aliasByName: UniqueMap<AliasEntry>;
  aliasBySku: UniqueMap<AliasEntry>;
  historicalByName: UniqueMap<HistoricalEntry>;
  overridesByOrderItemId: Map<number, CategoryOverrideEntry>;
};

function setUnique<T>(map: UniqueMap<T>, key: string | null | undefined, value: T) {
  if (!key) return;
  map.set(key, map.has(key) ? "ambiguous" : value);
}

function getUnique<T>(map: UniqueMap<T>, key: string | null | undefined): T | null {
  if (!key) return null;
  const hit = map.get(key);
  return hit && hit !== "ambiguous" ? hit : null;
}

export function aliasKey(productId: number, variantId: number | null): string {
  return `${productId}:${variantId ?? 0}`;
}

export function buildResolverContext(input: {
  catalog: CatalogEntry[];
  aliases?: AliasEntry[];
  historical?: HistoricalEntry[];
  overrides?: CategoryOverrideEntry[];
}): ResolverContext {
  const ctx: ResolverContext = {
    byProductId: new Map(),
    byVariantId: new Map(),
    bySku: new Map(),
    byBarcode: new Map(),
    byName: new Map(),
    aliasByOldKey: new Map(),
    aliasByName: new Map(),
    aliasBySku: new Map(),
    historicalByName: new Map(),
    overridesByOrderItemId: new Map(),
  };
  for (const override of input.overrides ?? []) {
    ctx.overridesByOrderItemId.set(override.orderItemId, override);
  }
  for (const entry of input.catalog) {
    // byProductId: level produk — baris tanpa variant menang; kalau hanya ada
    // baris variant, baris pertama mewakili (kategori sama untuk semua variant produk).
    const existing = ctx.byProductId.get(entry.productId);
    if (!existing || (existing.variantId !== null && entry.variantId === null)) {
      ctx.byProductId.set(entry.productId, entry);
    }
    if (entry.variantId !== null) ctx.byVariantId.set(entry.variantId, entry);
    setUnique(ctx.bySku, entry.sku?.trim() || null, entry);
    setUnique(ctx.byBarcode, entry.barcode?.trim() || null, entry);
    setUnique(ctx.byName, normalizeName(entry.name), entry);
  }
  for (const alias of input.aliases ?? []) {
    ctx.aliasByOldKey.set(aliasKey(alias.oldProductId, alias.oldVariantId), alias);
    // Alias by-variant-null juga bisa dicari dengan key produk saja.
    if (alias.oldVariantId !== null && !ctx.aliasByOldKey.has(aliasKey(alias.oldProductId, null))) {
      ctx.aliasByOldKey.set(aliasKey(alias.oldProductId, null), alias);
    }
    setUnique(ctx.aliasByName, alias.normalizedName, alias);
    setUnique(ctx.aliasBySku, alias.sku?.trim() || null, alias);
  }
  for (const hist of input.historical ?? []) {
    setUnique(ctx.historicalByName, hist.normalizedName, hist);
  }
  return ctx;
}

function fromCatalog(entry: CatalogEntry, method: ResolutionMethod): CategoryResolution {
  return {
    status: "resolved",
    method,
    category: entry.category,
    categoryId: entry.categoryId,
    resolvedProductId: entry.productId,
    resolvedVariantId: entry.variantId,
    reason: null,
  };
}

/** Resolusi alias: pakai katalog produk baru bila ada; kalau tidak, kategori historis alias. */
function fromAlias(alias: AliasEntry, ctx: ResolverContext): CategoryResolution | null {
  if (alias.newProductId !== null) {
    const target =
      (alias.newVariantId !== null ? ctx.byVariantId.get(alias.newVariantId) : undefined) ??
      ctx.byProductId.get(alias.newProductId);
    if (target) return { ...fromCatalog(target, "alias") };
  }
  if (alias.categoryName) {
    return {
      status: "resolved",
      method: "alias",
      category: normalizeKlasifikasi(alias.categoryName),
      categoryId: alias.categoryId,
      resolvedProductId: alias.newProductId,
      resolvedVariantId: alias.newVariantId,
      reason: null,
    };
  }
  return null;
}

export function resolveItemCategory(item: ItemIdentity, ctx: ResolverContext): CategoryResolution {
  // 0. Manual override PER ITEM (kunci = orderItemId, bukan nama/product_id) —
  //    prioritas tertinggi karena hasil konfirmasi langsung/manusia, dan HANYA
  //    berlaku untuk baris item ini (item lain dengan nama/product_id sama
  //    TIDAK ikut berubah).
  if (item.orderItemId != null) {
    const override = ctx.overridesByOrderItemId.get(item.orderItemId);
    if (override) {
      return {
        status: "resolved",
        method: "manual_override",
        category: override.category,
        categoryId: null,
        resolvedProductId: item.productId ?? null,
        resolvedVariantId: item.variantId ?? null,
        reason: override.reason,
      };
    }
  }

  // 1. Kategori asli dari transaksi (bila payload menyediakannya dan valid).
  const original = item.originalCategoryName?.trim();
  if (original && normalizeKlasifikasi(original) !== UNKNOWN_CATEGORY) {
    return {
      status: "resolved",
      method: "original-category",
      category: normalizeKlasifikasi(original),
      categoryId: item.originalCategoryId ?? null,
      resolvedProductId: item.productId ?? null,
      resolvedVariantId: item.variantId ?? null,
      reason: null,
    };
  }

  // 2. product_id langsung di katalog aktif.
  if (item.productId != null) {
    const hit = ctx.byProductId.get(item.productId);
    if (hit) return fromCatalog(hit, "product-id");
  }

  // 3. variant_id di katalog aktif.
  if (item.variantId != null) {
    const hit = ctx.byVariantId.get(item.variantId);
    if (hit) return fromCatalog(hit, "variant-id");
  }

  // 4. Alias ID lama → baru (by old id, lalu by nama/sku alias untuk item lama
  //    yang tidak menyimpan product_id).
  const aliasHit =
    (item.productId != null
      ? ctx.aliasByOldKey.get(aliasKey(item.productId, item.variantId ?? null)) ??
        ctx.aliasByOldKey.get(aliasKey(item.productId, null))
      : undefined) ??
    getUnique(ctx.aliasByName, normalizeName(item.itemName)) ??
    getUnique(ctx.aliasBySku, item.sku?.trim() || null) ??
    undefined;
  if (aliasHit) {
    const resolved = fromAlias(aliasHit, ctx);
    if (resolved) return resolved;
  }

  // 5. SKU exact (unik).
  const skuHit = getUnique(ctx.bySku, item.sku?.trim() || null);
  if (skuHit) return fromCatalog(skuHit, "sku");

  // 6. Barcode exact (unik).
  const barcodeHit = getUnique(ctx.byBarcode, item.barcode?.trim() || null);
  if (barcodeHit) return fromCatalog(barcodeHit, "barcode");

  // 7. Normalized name exact (unik). Coba nama lengkap, lalu nama tanpa suffix
  //    varian (" - ..."), tetap harus exact & unik — bukan substring.
  const fullName = normalizeName(item.itemName);
  const baseName = normalizeName(item.itemName.split(" - ")[0]);
  const nameHit = getUnique(ctx.byName, fullName) ?? (baseName !== fullName ? getUnique(ctx.byName, baseName) : null);
  if (nameHit) return fromCatalog(nameHit, "name-exact");

  // 8. Historical identity: nama yang pernah ter-resolve konsisten sebelumnya.
  const histHit = getUnique(ctx.historicalByName, fullName);
  if (histHit) {
    return {
      status: "resolved",
      method: "historical",
      category: histHit.category,
      categoryId: histHit.categoryId,
      resolvedProductId: item.productId ?? null,
      resolvedVariantId: item.variantId ?? null,
      reason: null,
    };
  }

  // 9. Fallback audit — TIDAK memvonis kategori; tampilan boleh "Tidak
  //    Diketahui" tetapi item harus tercatat unresolved beserta alasannya.
  const reasons: string[] = [];
  if (item.productId != null) reasons.push(`product_id ${item.productId} tidak ada di katalog aktif maupun alias`);
  else reasons.push("item tidak menyimpan product_id");
  if (item.sku) reasons.push(`SKU "${item.sku}" tidak cocok unik`);
  reasons.push(`nama "${item.itemName}" tidak cocok exact/unik di katalog, alias, maupun histori`);
  return {
    status: "unresolved",
    method: "none",
    category: UNKNOWN_CATEGORY,
    categoryId: null,
    resolvedProductId: null,
    resolvedVariantId: null,
    reason: reasons.join("; "),
  };
}

/**
 * Ratakan payload Product List Olsera (dengan variants embedded) menjadi
 * CatalogEntry[]: satu entri level produk + satu entri per variant.
 */
export function catalogEntriesFromOlseraProduct(raw: Record<string, unknown>): CatalogEntry[] {
  const productId = Number(raw.id);
  if (!Number.isFinite(productId)) return [];
  const text = (value: unknown) => {
    const t = value === null || value === undefined ? "" : String(value).trim();
    return t || null;
  };
  const category = normalizeKlasifikasi(
    typeof raw.klasifikasi === "string" && raw.klasifikasi ? raw.klasifikasi : "(tanpa klasifikasi)",
  );
  const categoryId = text(raw.klasifikasi_id);
  const name = String(raw.name ?? "").trim();
  const entries: CatalogEntry[] = [
    {
      productId,
      variantId: null,
      name,
      sku: text(raw.sku),
      barcode: text(raw.barcode),
      category,
      categoryId,
    },
  ];
  const variants = Array.isArray(raw.variants) ? (raw.variants as Record<string, unknown>[]) : [];
  for (const variant of variants) {
    const variantId = Number(variant.id);
    if (!Number.isFinite(variantId)) continue;
    const variantName = text(variant.name);
    entries.push({
      productId,
      variantId,
      name: variantName ? `${name} - ${variantName}` : name,
      sku: text(variant.sku) ?? text(raw.sku),
      barcode: text(variant.variant_barcode) ?? text(raw.barcode),
      category,
      categoryId,
    });
  }
  return entries;
}

export type ResolutionStats = {
  mapped: number;
  viaAlias: number;
  viaSkuOrName: number;
  unresolved: number;
};

export function emptyResolutionStats(): ResolutionStats {
  return { mapped: 0, viaAlias: 0, viaSkuOrName: 0, unresolved: 0 };
}

export function tallyResolution(stats: ResolutionStats, resolution: CategoryResolution) {
  if (resolution.status === "unresolved") {
    stats.unresolved++;
    return;
  }
  stats.mapped++;
  if (resolution.method === "alias") stats.viaAlias++;
  if (resolution.method === "sku" || resolution.method === "barcode" || resolution.method === "name-exact") {
    stats.viaSkuOrName++;
  }
}
