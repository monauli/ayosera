// Source adapter Modul Rekonsiliasi (Phase 5B) — membaca collection Olsera
// yang SUDAH TERSIMPAN (olsera_order_items, olsera_inventory_products,
// olsera_product_aliases, olsera_inventory_movements,
// olsera_inventory_monthly_snapshots) dan mengubahnya menjadi input untuk
// rule engine murni (lib/reconciliation-rules.ts). TIDAK PERNAH menulis ke
// collection sumber, TIDAK PERNAH memanggil API Olsera/AYO live, TIDAK
// PERNAH sync. Read-only.
//
// PENTING: adapter di file ini TIDAK PERNAH membaca lib/olsera-inventory-ui.ts
// (toggle "hidden" di UI) — kategori/produk yang disembunyikan tampilannya
// TETAP dihitung penuh secara internal (lihat docs/reconciliation-design.md
// "Penegasan Scope"), karena rule hanya melihat data tersimpan di
// olsera_order_items, bukan preferensi tampilan.
import "server-only";
import { normalizeName } from "./olsera-category-resolver.ts";
import {
  evaluateCategory,
  evaluateInventoryMovement,
  evaluateProductIdentity,
  evaluateSnapshotConsistency,
  type CategoryRuleInput,
  type InventoryMovementRuleInput,
  type ProductIdentityCandidate,
  type ProductIdentityInput,
  type RuleEvaluation,
  type SnapshotConsistencyRuleInput,
} from "./reconciliation-rules.ts";
import type {
  OlseraInventoryMonthlySnapshotDocument,
  OlseraInventoryMovementDocument,
  OlseraInventoryProductDocument,
  OlseraOrderItemDocument,
  OlseraProductAliasDocument,
} from "./mongodb.ts";
import type { ReconciliationDomain } from "./reconciliation-types.ts";

export class ReconciliationSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationSourceError";
  }
}

/** Hasil satu evaluasi rule + metadata identitas finding — belum ditulis ke Mongo apa pun di sini. */
export type SourceFinding = RuleEvaluation & {
  domain: ReconciliationDomain;
  entityKey: string;
  /** Referensi id/collection sumber SAJA (bukan payload mentah) — lihat batasan "tidak menyimpan payload mentah berlebihan". */
  sourceRefs: Record<string, unknown>;
};

export type SourceLoadResult = { findings: SourceFinding[]; docsRead: number };

// ---------------------------------------------------------------------------
// Bentuk koleksi minimal (pola sama lib/reconciliation-store.ts) — HANYA
// find(filter).toArray(), TIDAK ADA operator Mongo kompleks ($type/$in) yang
// dipakai di file ini; pengelompokan/pencocokan nama dilakukan di JS supaya
// mudah diuji dengan koleksi tiruan sederhana.
// ---------------------------------------------------------------------------

export type MinimalReadCollection<T> = {
  find(filter: Record<string, unknown>): { toArray(): Promise<T[]> };
};

export type ReconciliationSourceContext = {
  orderItems: MinimalReadCollection<OlseraOrderItemDocument>;
  inventoryProducts: MinimalReadCollection<OlseraInventoryProductDocument>;
  productAliases: MinimalReadCollection<OlseraProductAliasDocument>;
  inventoryMovements: MinimalReadCollection<OlseraInventoryMovementDocument>;
  inventoryMonthlySnapshots: MinimalReadCollection<OlseraInventoryMonthlySnapshotDocument>;
};

export async function resolveSourceContext(context?: ReconciliationSourceContext): Promise<ReconciliationSourceContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { olseraOrderItems, olseraInventoryProducts, olseraProductAliases, olseraInventoryMovements, olseraInventoryMonthlySnapshots } = await collections();
  return {
    orderItems: olseraOrderItems,
    inventoryProducts: olseraInventoryProducts,
    productAliases: olseraProductAliases,
    inventoryMovements: olseraInventoryMovements,
    inventoryMonthlySnapshots: olseraInventoryMonthlySnapshots,
  };
}

// ---------------------------------------------------------------------------
// Periode (YYYY-MM) -> rentang tanggal & bulan berikutnya
// ---------------------------------------------------------------------------

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

export type MonthRange = { year: number; month: number; start: string; end: string };

export function periodToMonthRange(period: string): MonthRange {
  if (!PERIOD_PATTERN.test(period)) throw new ReconciliationSourceError(`period tidak valid (wajib format YYYY-MM): ${String(period)}`);
  const [yearStr, monthStr] = period.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (month < 1 || month > 12) throw new ReconciliationSourceError(`period tidak valid (bulan di luar 1-12): ${period}`);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, start: `${period}-01`, end: `${period}-${String(lastDay).padStart(2, "0")}` };
}

export function nextPeriodLabel(year: number, month: number): { year: number; month: number; label: string } {
  if (month >= 12) return { year: year + 1, month: 1, label: `${year + 1}-01` };
  return { year, month: month + 1, label: `${year}-${String(month + 1).padStart(2, "0")}` };
}

// ---------------------------------------------------------------------------
// Helper umum
// ---------------------------------------------------------------------------

type GapField = "absent" | "null" | "empty" | "present";

function fieldState(doc: Record<string, unknown>, key: string): GapField {
  if (!(key in doc)) return "absent";
  const v = doc[key];
  if (v === null || v === undefined) return "null";
  if (typeof v === "string" && v.trim() === "") return "empty";
  return "present";
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ---------------------------------------------------------------------------
// A. CATEGORY — validasi silang status resolusi kategori yang SUDAH tersimpan
// saat sync (categoryResolutionStatus/Method/Reason/resolvedCategoryName).
// Digrup per normalizedItemName (bukan per baris) — satu nama produk biasanya
// menghasilkan status resolusi yang sama di seluruh barisnya; bila TIDAK sama
// (distinct resolvedCategoryName > 1 tanpa manual_override), ditandai
// AMBIGUOUS lewat isAmbiguousCandidate (bukan diam-diam dipilih salah satu).
// ---------------------------------------------------------------------------

export async function loadCategoryFindings(period: string, context?: ReconciliationSourceContext): Promise<SourceLoadResult> {
  const { start, end } = periodToMonthRange(period);
  const { orderItems } = await resolveSourceContext(context);
  const rows = await orderItems.find({ date: { $gte: start, $lte: end } }).toArray();

  const byName = new Map<string, OlseraOrderItemDocument[]>();
  for (const row of rows) {
    const key = row.normalizedItemName ?? normalizeName(row.itemName);
    pushTo(byName, key, row);
  }

  const findings: SourceFinding[] = [];
  for (const [name, group] of byName) {
    const representative = group[0];
    const distinctCategories = new Set(group.map((r) => r.resolvedCategoryName ?? null));
    const hasManualOverride = group.some((r) => r.categoryResolutionMethod === "manual_override");
    const input: CategoryRuleInput = {
      itemName: representative.itemName,
      categoryResolutionStatus: representative.categoryResolutionStatus ?? undefined,
      categoryResolutionMethod: representative.categoryResolutionMethod ?? undefined,
      categoryResolutionReason: representative.categoryResolutionReason ?? undefined,
      resolvedCategoryName: representative.resolvedCategoryName ?? undefined,
      isAmbiguousCandidate: distinctCategories.size > 1 && !hasManualOverride,
    };
    const result = evaluateCategory(input);
    findings.push({
      ...result,
      domain: "CATEGORY",
      entityKey: name,
      sourceRefs: { normalizedItemName: name, sampleOrderItemId: representative._id, rowCount: group.length },
    });
  }
  return { findings, docsRead: rows.length };
}

// ---------------------------------------------------------------------------
// B. PRODUCT — identitas produk untuk baris yang KEHILANGAN productId/
// variantId/sku ("gapped") pada periode ini. Item yang identitasnya SUDAH
// lengkap sengaja TIDAK menghasilkan finding (lihat Known Limitations,
// docs/reconciliation-design.md) — laporan berfokus pada yang butuh
// perhatian, bukan mengonfirmasi ulang jutaan baris yang sudah benar.
// Port logika klasifikasi dari scripts/audit-order-item-identity-2026.ts,
// tapi keputusan status/impact/confidence SEPENUHNYA ada di
// lib/reconciliation-rules.ts evaluateProductIdentity (bukan di sini).
// ---------------------------------------------------------------------------

export async function loadProductIdentityFindings(period: string, context?: ReconciliationSourceContext): Promise<SourceLoadResult> {
  const { start, end } = periodToMonthRange(period);
  const { orderItems, inventoryProducts, productAliases } = await resolveSourceContext(context);

  const periodRows = await orderItems.find({ date: { $gte: start, $lte: end } }).toArray();
  let docsRead = periodRows.length;

  const gappedByName = new Map<string, OlseraOrderItemDocument[]>();
  for (const row of periodRows) {
    const hasIdentity =
      fieldState(row as unknown as Record<string, unknown>, "productId") === "present" &&
      fieldState(row as unknown as Record<string, unknown>, "variantId") === "present" &&
      fieldState(row as unknown as Record<string, unknown>, "sku") === "present";
    if (hasIdentity) continue;
    const key = row.normalizedItemName ?? normalizeName(row.itemName);
    pushTo(gappedByName, key, row);
  }
  if (gappedByName.size === 0) return { findings: [], docsRead };

  const catalogDocs = await inventoryProducts.find({}).toArray();
  docsRead += catalogDocs.length;
  const catalogByName = new Map<string, ProductIdentityCandidate[]>();
  const catalogByBaseName = new Map<string, ProductIdentityCandidate[]>();
  for (const p of catalogDocs) {
    const fullName = p.variantName ? `${p.name} - ${p.variantName}` : p.name;
    const entry: ProductIdentityCandidate = { productId: p.productId, variantId: p.variantId, sku: p.sku, label: `${fullName} (${p.active ? "aktif" : "nonaktif"})` };
    pushTo(catalogByName, normalizeName(fullName), entry);
    pushTo(catalogByBaseName, normalizeName(p.name), entry);
  }

  const aliasDocs = await productAliases.find({}).toArray();
  docsRead += aliasDocs.length;
  const aliasByName = new Map<string, ProductIdentityCandidate[]>();
  for (const a of aliasDocs) {
    if (!a.normalizedName || a.newProductId === null) continue;
    pushTo(aliasByName, a.normalizedName, { productId: a.newProductId, variantId: a.newVariantId, sku: a.sku, label: `alias:${a.source}` });
  }

  // Histori: SELURUH order_items (lintas periode) dengan productId terisi — hanya
  // dikumpulkan untuk nama yang gapped di periode ini (bukan backfill, murni evidence baca).
  const allRows = await orderItems.find({}).toArray();
  docsRead += allRows.length;
  const historicalByName = new Map<string, ProductIdentityCandidate[]>();
  for (const row of allRows) {
    if (typeof row.productId !== "number") continue;
    const key = row.normalizedItemName ?? normalizeName(row.itemName);
    if (!gappedByName.has(key)) continue;
    pushTo(historicalByName, key, { productId: row.productId, variantId: row.variantId ?? null, sku: row.sku ?? null });
  }

  const findings: SourceFinding[] = [];
  for (const [name, group] of gappedByName) {
    const representative = group[0];
    const baseKey = normalizeName(representative.itemName.split(" - ")[0]);
    const input: ProductIdentityInput = {
      itemName: representative.itemName,
      hasIdentity: false,
      catalogFullNameMatches: catalogByName.get(name) ?? [],
      catalogBaseNameMatches: catalogByBaseName.get(baseKey) ?? [],
      historicalMatches: historicalByName.get(name) ?? [],
      aliasMatches: aliasByName.get(name) ?? [],
    };
    const result = evaluateProductIdentity(input);
    findings.push({
      ...result,
      domain: "PRODUCT",
      entityKey: name,
      sourceRefs: { normalizedItemName: name, sampleOrderItemId: representative._id, gappedRowCount: group.length },
    });
  }
  return { findings, docsRead };
}

// ---------------------------------------------------------------------------
// C. INVENTORY MOVEMENT — (1) movement productId null WAJIB muncul sebagai
// finding tanpa pernah diisi otomatis (Known Case 37); (2) qty pergerakan
// (per productId+variantId) dibandingkan terhadap salesQty snapshot bulanan.
// ---------------------------------------------------------------------------

export async function loadInventoryMovementFindings(storeId: number, period: string, context?: ReconciliationSourceContext): Promise<SourceLoadResult> {
  const { year, month, start, end } = periodToMonthRange(period);
  const { inventoryMovements, inventoryMonthlySnapshots } = await resolveSourceContext(context);

  // storeId juga menerima `null` — dikonfirmasi via scripts/audit-reconciliation-inventory-null-product.ts
  // bahwa 37 movement Known Case (2026-05-01..07-13, total 360 sepanjang Feb-Jul 2026) SEMUANYA
  // punya storeId:null (data legacy sebelum storeId distempel saat sync), BUKAN storeId toko lain —
  // AYOSERA single-tenant, jadi storeId:null di sini berarti "belum distempel", bukan "milik toko lain".
  // Filter storeId EKSAK (tanpa null) sebelumnya membuat adapter TIDAK PERNAH melihat 37 movement ini
  // sama sekali. Tetap TERBATAS: hanya {storeId, null} yang diterima, BUKAN storeId toko lain mana pun.
  const movements = await inventoryMovements.find({ storeId: { $in: [storeId, null] }, date: { $gte: start, $lte: end } }).toArray();
  let docsRead = movements.length;
  const findings: SourceFinding[] = [];

  // (1) productId null — TIDAK PERNAH diisi/dipindah ke produk lain di sini.
  for (const m of movements) {
    if (m.productId !== null) continue;
    const result = evaluateInventoryMovement({ productId: null, hasSnapshotDoc: false, expectedQty: Math.abs(m.qtyChange), actualQty: 0 });
    findings.push({
      ...result,
      domain: "INVENTORY",
      entityKey: `movement-null:${m._id}`,
      sourceRefs: { movementId: m._id, date: m.date, productName: m.productName },
    });
  }

  // (2) qty pergerakan vs snapshot bulanan, per productId+variantId yang tertaut.
  const byProduct = new Map<string, OlseraInventoryMovementDocument[]>();
  for (const m of movements) {
    if (m.productId === null) continue;
    pushTo(byProduct, `${m.productId}:${m.variantId ?? 0}`, m);
  }

  if (byProduct.size > 0) {
    const snapshots = await inventoryMonthlySnapshots.find({ storeId, year, month }).toArray();
    docsRead += snapshots.length;
    const snapshotByKey = new Map(snapshots.map((s) => [`${s.productId}:${s.variantId ?? 0}`, s]));

    for (const [key, group] of byProduct) {
      const [productIdStr, variantIdStr] = key.split(":");
      const expectedQty = group.reduce((sum, m) => sum + Math.abs(m.qtyChange), 0);
      const snapshot = snapshotByKey.get(key);
      const input: InventoryMovementRuleInput = {
        productId: Number(productIdStr),
        hasSnapshotDoc: !!snapshot,
        expectedQty,
        actualQty: snapshot?.salesQty ?? 0,
        isBoundaryPeriod: snapshot?.status === "boundary-only",
      };
      const result = evaluateInventoryMovement(input);
      findings.push({
        ...result,
        // Pengayaan diagnostics oleh ADAPTER (bukan rule) — hasSnapshotDoc/snapshotStatus TIDAK memengaruhi
        // status/impact/confidence dari rule (murni informasi), dipakai runner untuk keputusan cap impact
        // periode draft (lib/reconciliation-runner.ts determineDraftCapReason) tanpa mengubah rule murni.
        diagnostics: { ...result.diagnostics, hasSnapshotDoc: !!snapshot, snapshotStatus: snapshot?.status ?? null },
        domain: "INVENTORY",
        entityKey: `movement-qty:${key}`,
        sourceRefs: { productId: Number(productIdStr), variantId: variantIdStr === "0" ? null : Number(variantIdStr), movementCount: group.length },
      });
    }
  }

  return { findings, docsRead };
}

// ---------------------------------------------------------------------------
// D. SNAPSHOT CONSISTENCY — rantai closingQty bulan N == openingQty bulan N+1,
// per produk+varian tersimpan di olsera_inventory_monthly_snapshots.
// ---------------------------------------------------------------------------

export async function loadSnapshotConsistencyFindings(storeId: number, period: string, context?: ReconciliationSourceContext): Promise<SourceLoadResult> {
  const { year, month } = periodToMonthRange(period);
  const next = nextPeriodLabel(year, month);
  const { inventoryMonthlySnapshots } = await resolveSourceContext(context);

  const [currentDocs, nextDocs] = await Promise.all([
    inventoryMonthlySnapshots.find({ storeId, year, month }).toArray(),
    inventoryMonthlySnapshots.find({ storeId, year: next.year, month: next.month }).toArray(),
  ]);
  const docsRead = currentDocs.length + nextDocs.length;
  const nextByKey = new Map(nextDocs.map((d) => [`${d.productId}:${d.variantId ?? 0}`, d]));

  const findings: SourceFinding[] = [];
  for (const doc of currentDocs) {
    const key = `${doc.productId}:${doc.variantId ?? 0}`;
    const nextDoc = nextByKey.get(key);
    const input: SnapshotConsistencyRuleInput = {
      productId: doc.productId,
      variantId: doc.variantId,
      closingPrev: doc.closingQty,
      openingNext: nextDoc?.openingQty ?? null,
      isBoundaryPeriod: doc.status === "boundary-only" || nextDoc?.status === "boundary-only",
    };
    const result = evaluateSnapshotConsistency(input);
    findings.push({
      ...result,
      domain: "SNAPSHOT",
      entityKey: `${key}:${period}->${next.label}`,
      sourceRefs: { productId: doc.productId, variantId: doc.variantId, period, nextPeriod: next.label },
    });
  }
  return { findings, docsRead };
}
