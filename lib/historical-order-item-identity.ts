// Milestone 4 Bagian A/B — Historical Product Mapping (olsera_order_items yang
// kehilangan productId/variantId/sku). Logika klasifikasi ini SENGAJA
// dipindahkan langsung dari `scripts/audit-order-item-identity-2026.ts`
// (audit read-only yang sudah dijalankan terhadap production, lihat
// tmp/order-item-identity-audit-2026/summary.md) — TIDAK diubah aturan
// pemetaannya, supaya hasil klasifikasi backfill 100% konsisten dengan audit
// yang sudah direview.
//
// Prinsip Bagian B: bila kandidat lebih dari satu / bertentangan, JANGAN
// dipaksa — tetap "Butuh Adjust Manual". Hanya "Exact Match" yang dianggap
// HIGH CONFIDENCE untuk backfill otomatis (lihat historical-order-item-backfill.ts).
import "server-only";
import { normalizeName } from "./olsera-category-resolver.ts";

export type IdentityFieldState = "absent" | "null" | "empty" | "present";

export type IdentityClassification =
  | "Exact Match"
  | "Exact Product, Variant Ambiguous"
  | "Name Match Only"
  | "Historical Product"
  | "Product Missing"
  | "Duplicate Candidate"
  | "Butuh Adjust Manual";

/** Confidence dipakai ulang skala yang sama dengan modul rekonsiliasi lain (lib/reconciliation-types.ts). */
export type IdentityConfidence = "HIGH" | "MEDIUM" | "LOW";

export const CLASSIFICATION_CONFIDENCE: Record<IdentityClassification, IdentityConfidence> = {
  "Exact Match": "HIGH",
  "Historical Product": "MEDIUM",
  "Exact Product, Variant Ambiguous": "LOW",
  "Name Match Only": "LOW",
  "Butuh Adjust Manual": "LOW",
  "Product Missing": "LOW",
  "Duplicate Candidate": "LOW",
};

/** HANYA "Exact Match" yang memenuhi syarat Bagian C (identifier jelas, mapping tunggal, dari katalog aktif). */
export function canAutoBackfill(classification: IdentityClassification): boolean {
  return classification === "Exact Match";
}

export function fieldState(raw: Record<string, unknown>, key: string): IdentityFieldState {
  if (!(key in raw)) return "absent";
  const v = raw[key];
  if (v === null) return "null";
  if (typeof v === "string" && v.trim() === "") return "empty";
  return "present";
}

export function isGapped(fs: { productId: IdentityFieldState; variantId: IdentityFieldState; sku: IdentityFieldState }): boolean {
  return fs.productId !== "present" || fs.variantId !== "present" || fs.sku !== "present";
}

export type OrderItemIdentityInput = {
  _id: number;
  date: string;
  orderNo: string;
  itemName: string;
  normalizedItemName?: string;
  qty: number;
  amount: number;
  syncedAt?: Date | null;
  categoryResolutionStatus?: string | null;
  resolvedCategoryName?: string | null;
  /** Field yang justru bisa hilang (absent/null/empty) — inilah subjek audit ini. */
  productId?: number | null;
  variantId?: number | null;
  sku?: string | null;
};

export type IdentityCatalogEntry = { productId: number; variantId: number | null; sku: string | null; name: string; active: boolean };
export type IdentityAliasEntry = { newProductId: number; newVariantId: number | null; sku: string | null; source: string; confidence: string; normalizedName: string };
export type IdentityHistoricalCombo = { productId: number; variantId: number | null; sku: string | null };
export type IdentityHistoricalEntry = { combos: IdentityHistoricalCombo[]; minDate: string; maxDate: string };

export type IdentityCandidate = { source: "catalog-name-exact" | "alias" | "historical"; productId: number | null; variantId: number | null; sku: string | null; note: string };

export type IdentityClassificationContext = {
  catalogByName: Map<string, IdentityCatalogEntry[]>;
  catalogByBaseName: Map<string, IdentityCatalogEntry[]>;
  aliasByName: Map<string, IdentityAliasEntry[]>;
  historicalByName: Map<string, IdentityHistoricalEntry>;
  /** Kunci: `${date}|${orderNo}|${normalizedItemName}|${qty}|${amount}` -> jumlah baris gapped dgn kunci sama. */
  duplicateKeyCount: Map<string, number>;
};

export type ClassifiedOrderItem = OrderItemIdentityInput & {
  normalizedItemName: string;
  fieldStates: { productId: IdentityFieldState; variantId: IdentityFieldState; sku: IdentityFieldState };
  classification: IdentityClassification;
  confidence: IdentityConfidence;
  candidates: IdentityCandidate[];
  isDuplicateCandidate: boolean;
  manualReason: string | null;
  /** Hanya terisi bila classification === "Exact Match" — satu-satunya kombinasi aman untuk backfill. */
  backfillTarget: { productId: number; variantId: number | null; sku: string | null } | null;
};

export function duplicateKey(row: Pick<OrderItemIdentityInput, "date" | "orderNo" | "qty" | "amount">, normalizedItemName: string): string {
  return `${row.date}|${row.orderNo}|${normalizedItemName}|${row.qty}|${row.amount}`;
}

/**
 * Klasifikasi SATU baris order item yang kehilangan productId/variantId/sku.
 * Pure function (tidak membaca DB) — identik dengan logika
 * scripts/audit-order-item-identity-2026.ts baris 214-262, diekstrak agar
 * bisa diuji tanpa Mongo dan dipakai ulang oleh backfill/audit module.
 */
export function classifyOrderItemIdentity(
  raw: Record<string, unknown> & OrderItemIdentityInput,
  context: IdentityClassificationContext,
): ClassifiedOrderItem {
  const fs = {
    productId: fieldState(raw, "productId"),
    variantId: fieldState(raw, "variantId"),
    sku: fieldState(raw, "sku"),
  };
  const normalizedItemName = raw.normalizedItemName ?? normalizeName(raw.itemName);
  const key = normalizedItemName;
  const baseKey = normalizeName(raw.itemName.split(" - ")[0]);

  const fullNameHits = context.catalogByName.get(key) ?? [];
  const baseProductHits = context.catalogByBaseName.get(key === baseKey ? key : baseKey) ?? [];
  const aliasHits = context.aliasByName.get(key) ?? [];
  const hist = context.historicalByName.get(key);

  const candidates: IdentityCandidate[] = [];
  for (const h of fullNameHits) candidates.push({ source: "catalog-name-exact", productId: h.productId, variantId: h.variantId, sku: h.sku, note: `katalog: ${h.name} (${h.active ? "aktif" : "nonaktif"})` });
  for (const h of aliasHits) candidates.push({ source: "alias", productId: h.newProductId, variantId: h.newVariantId, sku: h.sku, note: `alias: ${h.source} (${h.confidence})` });
  if (hist) for (const c of hist.combos) candidates.push({ source: "historical", productId: c.productId, variantId: c.variantId, sku: c.sku, note: `histori ${hist.minDate}..${hist.maxDate}` });

  const distinctFullNameProductVariant = new Set(fullNameHits.map((h) => `${h.productId}:${h.variantId ?? "null"}`));
  const distinctHistCombos = hist ? new Set(hist.combos.map((c) => `${c.productId}:${c.variantId ?? "null"}`)) : new Set<string>();
  const distinctBaseProducts = new Set(baseProductHits.map((h) => h.productId));

  const isDup = (context.duplicateKeyCount.get(duplicateKey(raw, normalizedItemName)) ?? 0) > 1;

  let classification: IdentityClassification;
  let manualReason: string | null = null;

  if (fullNameHits.length > 0 && distinctFullNameProductVariant.size === 1 && (!hist || distinctHistCombos.size === 0 || (distinctHistCombos.size === 1 && distinctHistCombos.has([...distinctFullNameProductVariant][0])))) {
    classification = "Exact Match";
  } else if (fullNameHits.length > 0 && distinctFullNameProductVariant.size > 1) {
    classification = "Butuh Adjust Manual";
    manualReason = "Nama lengkap cocok lebih dari satu kombinasi produk+varian di katalog (ambigu).";
  } else if (distinctBaseProducts.size === 1 && baseProductHits.length > 1 && fullNameHits.length === 0) {
    classification = "Exact Product, Variant Ambiguous";
    manualReason = "Produk teridentifikasi via nama dasar, tetapi produk memiliki beberapa varian aktif dan histori tidak cukup untuk memastikan variant mana — TIDAK diisi otomatis berdasarkan nama produk induk saja.";
  } else if (distinctBaseProducts.size > 1) {
    classification = "Butuh Adjust Manual";
    manualReason = "Nama dasar cocok dengan lebih dari satu productId berbeda di katalog.";
  } else if (fullNameHits.length === 0 && distinctBaseProducts.size === 0 && hist && distinctHistCombos.size === 1) {
    classification = "Historical Product";
  } else if (fullNameHits.length === 0 && distinctBaseProducts.size === 0 && hist && distinctHistCombos.size > 1) {
    classification = "Butuh Adjust Manual";
    manualReason = "Histori nama yang sama menunjukkan lebih dari satu kombinasi productId/variantId/sku berbeda — tidak konsisten.";
  } else if (fullNameHits.length === 0 && distinctBaseProducts.size === 0 && (!hist || distinctHistCombos.size === 0) && aliasHits.length === 0) {
    classification = "Product Missing";
    manualReason = "Tidak ditemukan di katalog aktif/nonaktif, tidak ada alias, dan tidak ada histori order_items lain dengan productId untuk nama ini.";
  } else if (aliasHits.length > 0 && fullNameHits.length === 0 && distinctBaseProducts.size === 0 && (!hist || distinctHistCombos.size === 0)) {
    const distinctAlias = new Set(aliasHits.map((a) => `${a.newProductId}:${a.newVariantId ?? "null"}`));
    classification = distinctAlias.size === 1 ? "Historical Product" : "Butuh Adjust Manual";
    if (distinctAlias.size !== 1) manualReason = "Lebih dari satu alias produk untuk nama yang sama.";
  } else {
    classification = "Name Match Only";
  }

  if (isDup && (classification === "Product Missing" || classification === "Butuh Adjust Manual")) {
    classification = "Duplicate Candidate";
    manualReason = (manualReason ? manualReason + " " : "") + "Baris ini juga terindikasi duplikat (date+orderNo+itemName+qty+amount identik dengan baris gapped lain).";
  }

  const backfillTarget = classification === "Exact Match" ? { productId: fullNameHits[0].productId, variantId: fullNameHits[0].variantId, sku: fullNameHits[0].sku } : null;

  return {
    ...raw,
    normalizedItemName,
    fieldStates: fs,
    classification,
    confidence: CLASSIFICATION_CONFIDENCE[classification],
    candidates,
    isDuplicateCandidate: isDup,
    manualReason,
    backfillTarget,
  };
}

export type IdentityClassificationSummary = {
  totalGapped: number;
  byClassification: Record<IdentityClassification, number>;
  exactMatchCount: number;
  ambiguousCount: number;
  historicalProductCount: number;
  unresolvedCount: number;
};

export function summarizeClassifications(rows: ClassifiedOrderItem[]): IdentityClassificationSummary {
  const byClassification = {
    "Exact Match": 0,
    "Exact Product, Variant Ambiguous": 0,
    "Name Match Only": 0,
    "Historical Product": 0,
    "Product Missing": 0,
    "Duplicate Candidate": 0,
    "Butuh Adjust Manual": 0,
  } as Record<IdentityClassification, number>;
  for (const r of rows) byClassification[r.classification]++;
  return {
    totalGapped: rows.length,
    byClassification,
    exactMatchCount: byClassification["Exact Match"],
    ambiguousCount: byClassification["Exact Product, Variant Ambiguous"] + byClassification["Butuh Adjust Manual"],
    historicalProductCount: byClassification["Historical Product"],
    unresolvedCount: byClassification["Product Missing"] + byClassification["Duplicate Candidate"],
  };
}
