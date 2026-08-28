// Service Rekonsiliasi Inventori dengan Berita Acara — HANYA membaca
// `olsera_inventory_monthly_snapshots` (read-only, TIDAK PERNAH menulis/
// mengubah) dan membaca/menulis koleksi BARU terpisah
// `inventory_stock_opname_reconciliations`. TIDAK PERNAH menyentuh katalog
// produk, order item, atau data transaksi Olsera/AYO manapun.
//
// Dependency injection: parameter `context` opsional (pola sama
// lib/reconciliation-store.ts/reconciliation-sources.ts) supaya bisa diuji
// dengan koleksi tiruan tanpa MongoDB sungguhan.
import "server-only";
import {
  buildOpnameId,
  computeDifferenceQty,
  computeFormulaClosingQty,
  determineOpnameStatus,
  hasFormulaMismatch,
  isValidIsoDate,
  needsManualAdjust,
  resolveCutoffQueryRange,
  resolveSystemClosingQty,
  summarizeOpname,
  validateCutoffPlausibility,
  verifyStockOpnameBa,
  type OpnameStatus,
  type OpnameSummary,
  type StockOpnameBaEntry,
} from "./inventory-stock-opname.ts";
import { attachMovementsToProducts, type UnmatchedMovementEntry } from "./olsera-inventory-monthly-core.ts";
import { visibleMonthlyInventoryRows } from "./olsera-inventory-ui.ts";
import type { MatchingContext } from "./olsera-inventory-monthly-snapshot-core.ts";
import { fetchMatchingContext } from "./olsera-inventory-monthly-snapshot-store.ts";
import { fetchStockMovementRange, type FetchStockMovementResult } from "./olsera-inventory-stockmovement.ts";
import type { InventoryStockOpnameDocument, OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";
import { compareHistoricalInventoryRows, type HistoricalReconciliationRow } from "./inventory-historical-reconciliation.ts";
import { FEBRUARY_HISTORICAL_SOURCE_REVISION, resolveFebruaryHistoricalRows } from "./february-historical-migration.ts";
import { FEBRUARY_HISTORICAL_SOURCE } from "./february-historical-source.ts";

export class InventoryStockOpnameError extends Error {
  code: "VALIDATION" | "FORBIDDEN";
  constructor(message: string, code: "VALIDATION" | "FORBIDDEN" = "VALIDATION") {
    super(message);
    this.name = "InventoryStockOpnameError";
    this.code = code;
  }
}

const MAX_YEAR = 2100;
const MIN_YEAR = 2000;
const MAX_ENTRIES_PER_SAVE = 2000;
const MAX_NOTE_LENGTH = 500;

export function validateYear(value: unknown): number {
  const year = Number(value);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) throw new InventoryStockOpnameError("year tidak valid.");
  return year;
}

export function validateMonth(value: unknown): number {
  const month = Number(value);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new InventoryStockOpnameError("month tidak valid.");
  return month;
}

// ---------------------------------------------------------------------------
// Bentuk koleksi minimal — hanya method yang benar-benar dipakai (pola sama
// lib/reconciliation-sources.ts) supaya mudah diuji dengan koleksi tiruan.
// ---------------------------------------------------------------------------

export type MinimalReadCollection<T> = { find(filter: Record<string, unknown>): { toArray(): Promise<T[]> } };

export type MinimalOpnameCollection = MinimalReadCollection<InventoryStockOpnameDocument> & {
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options: { upsert: boolean }): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>): Promise<unknown>;
};

/**
 * Override I/O opsional (additive) untuk jalur cutoff tanggal BA (lihat
 * loadInventoryOpnameCutoff/finalizeInventoryStockOpname di bawah) — testable
 * tanpa memanggil Open API Olsera/Mongo sungguhan (pola sama context Mongo di
 * atas). TIDAK PERNAH dipakai jalur snapshot bulanan lama (loadInventoryOpnameMonth),
 * yang tetap 100% tidak berubah.
 */
export type CutoffFetchOverrides = {
  fetchStockMovementRangeImpl?: (startDate: string, endDate: string) => Promise<FetchStockMovementResult>;
  matchingContext?: MatchingContext;
};

export type InventoryStockOpnameContext = {
  snapshots: MinimalReadCollection<OlseraInventoryMonthlySnapshotDocument>;
  opname: MinimalOpnameCollection;
  approvedRows?: readonly HistoricalReconciliationRow[];
} & CutoffFetchOverrides;

export async function resolveInventoryStockOpnameContext(context?: InventoryStockOpnameContext): Promise<InventoryStockOpnameContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { olseraInventoryMonthlySnapshots, inventoryStockOpnameReconciliations } = await collections();
  return { snapshots: olseraInventoryMonthlySnapshots, opname: inventoryStockOpnameReconciliations };
}

/** Resolusi dependency jalur cutoff — default: fetchStockMovementRange (Open API Olsera live, read-only) + fetchMatchingContext (katalog Mongo, read-only). Override lewat context untuk tes (tanpa network/Mongo sungguhan). */
async function resolveCutoffDeps(context?: CutoffFetchOverrides): Promise<{ fetchStockMovementRangeImpl: (startDate: string, endDate: string) => Promise<FetchStockMovementResult>; matchingContext: MatchingContext }> {
  const fetchStockMovementRangeImpl = context?.fetchStockMovementRangeImpl ?? fetchStockMovementRange;
  const matchingContext = context?.matchingContext ?? (await fetchMatchingContext());
  return { fetchStockMovementRangeImpl, matchingContext };
}

export type CutoffSystemRow = {
  productId: number;
  variantId: number | null;
  productName: string;
  productSku: string | null;
  groupName: string;
  openingQty: number;
  incomingQty: number;
  returnQty: number;
  salesQty: number;
  outgoingQty: number;
  /** "sisa" API Olsera PERSIS pada cutoffDate (end_date) — sudah presisi harian, TIDAK PERNAH dipotong manual di sini. */
  closingQty: number;
};

export type FetchCutoffSystemRowsResult =
  | { ok: true; rows: CutoffSystemRow[]; startDate: string; endDate: string; unmatchedOrAmbiguous: UnmatchedMovementEntry[] }
  | { ok: false; error: string };

/**
 * Tarik stok sistem PERSIS pada cutoffDate lewat GET .../inventory/stockmovement
 * (end_date=cutoffDate) — TIDAK PERNAH memakai boundary akhir bulan kalender.
 * Movement setelah cutoffDate otomatis tidak pernah ikut (dijamin parameter
 * API Olsera sendiri, lihat lib/olsera-inventory-stockmovement.ts). Pencocokan
 * baris API -> produk katalog REUSE attachMovementsToProducts (SAMA persis
 * dengan pipeline snapshot bulanan existing) — TIDAK diimplementasi ulang.
 *
 * `startDate` OPSIONAL (Tahap 1 rentang bebas): awal periode Berita Acara yang
 * TIDAK selalu tanggal 1 (mis. BA Februari 2026 = 04 Feb s/d 04 Mar). Bila
 * DIISI, diteruskan apa adanya ke resolveCutoffQueryRange sebagai
 * `desiredStartDate`. Bila KOSONG, perilaku LAMA dipertahankan PERSIS:
 * resolveCutoffQueryRange jatuh ke default awal bulan cutoff. Klem
 * CUTOFF_MAX_LOOKBACK_DAYS tetap berlaku di sana, tidak diduplikasi di sini.
 */
export async function fetchCutoffSystemRows(cutoffDate: string, deps: { fetchStockMovementRangeImpl: (startDate: string, endDate: string) => Promise<FetchStockMovementResult>; matchingContext: MatchingContext }, startDate?: string): Promise<FetchCutoffSystemRowsResult> {
  const { startDate: queryStartDate, endDate } = resolveCutoffQueryRange(cutoffDate, startDate);
  const fetched = await deps.fetchStockMovementRangeImpl(queryStartDate, endDate);
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const unmatchedOrAmbiguous: UnmatchedMovementEntry[] = [];
  const matched = attachMovementsToProducts(fetched.rows, deps.matchingContext.identityIndex, deps.matchingContext.skuIndex, deps.matchingContext.nameIndex, `cutoff ${cutoffDate}`, unmatchedOrAmbiguous);

  const rows: CutoffSystemRow[] = [];
  for (const [productKey, matchedMovement] of matched.entries()) {
    const product = deps.matchingContext.catalogById.get(productKey);
    if (!product) continue; // defensif — key persis berasal dari catalogById saat matching, seharusnya tidak pernah kosong.
    const row = matchedMovement.row;
    rows.push({
      productId: product.productId,
      variantId: product.variantId,
      productName: row.productVariantName ? `${row.productName} - ${row.productVariantName}` : row.productName,
      productSku: row.productVariantSku ?? row.productSku,
      groupName: row.productGroupName ?? product.category ?? "(Tanpa Group)",
      openingQty: row.beginningQty,
      incomingQty: row.incomingQty,
      returnQty: row.returnQty,
      salesQty: row.salesQty,
      outgoingQty: row.outgoingQty,
      closingQty: row.sisa,
    });
  }
  return { ok: true, rows, startDate: queryStartDate, endDate, unmatchedOrAmbiguous };
}

// ---------------------------------------------------------------------------
// Baca gabungan snapshot + berita acara
// ---------------------------------------------------------------------------

export type InventoryOpnameRow = {
  productId: number;
  variantId: number | null;
  productName: string;
  productSku: string | null;
  /** Nama kategori/grup (dari snapshot.groupName) — dipakai UI untuk aturan Hidden Item existing, tidak diubah di sini. */
  category: string;
  openingQty: number | null;
  incomingQty: number | null;
  returnQty: number | null;
  salesQty: number | null;
  outgoingQty: number | null;
  /** closingQty snapshot mentah (sumber utama). */
  snapshotClosingQty: number | null;
  /** Hasil rumus Stok Awal + Masuk + Retur - Jual - Keluar (validasi silang). */
  formulaClosingQty: number | null;
  /** Angka yang benar-benar dipakai sebagai "Stok Akhir Sistem" (closingQty snapshot, fallback ke rumus bila snapshot kosong). */
  systemClosingQty: number | null;
  formulaMismatch: boolean;
  snapshotStatus: "complete" | "boundary-only" | "incomplete";
  snapshotDiagnostics: string[];
  manualAdjust: boolean;
  physicalQty: number | null;
  differenceQty: number | null;
  status: OpnameStatus;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  evidenceSource?: "BA_INPUT" | "BA_OMITTED_ASSUMED_MATCH" | null;
};

export type InventoryOpnameMonthResult = {
  storeId: number;
  year: number;
  month: number;
  rows: InventoryOpnameRow[];
  summary: OpnameSummary;
  lock: { status: "LOCKED" | "UNLOCKED"; cutoff: string | null; cutoffDate: string | null; lockedBy: string | null; lockedAt: string | null; attachment: InventoryStockOpnameDocument["attachment"] } | null;
};

function opnameKey(productId: number, variantId: number | null): string {
  return `${productId}:${variantId ?? 0}`;
}

function lockState(doc: InventoryStockOpnameDocument | undefined): InventoryOpnameMonthResult["lock"] {
  if (!doc?.lockedAt) return doc?.unlockedAt ? { status: "UNLOCKED", cutoff: doc.cutoff ?? null, cutoffDate: doc.cutoffDate ?? null, lockedBy: doc.lockedBy ?? null, lockedAt: null, attachment: doc.attachment ?? null } : null;
  return { status: "LOCKED", cutoff: doc.cutoff ?? null, cutoffDate: doc.cutoffDate ?? null, lockedBy: doc.lockedBy ?? null, lockedAt: new Date(doc.lockedAt).toISOString(), attachment: doc.attachment ?? null };
}

export async function loadInventoryOpnameMonth(
  input: { storeId: number; year: number; month: number },
  context?: InventoryStockOpnameContext,
): Promise<InventoryOpnameMonthResult> {
  const storeId = input.storeId;
  const year = validateYear(input.year);
  const month = validateMonth(input.month);
  const { snapshots, opname } = await resolveInventoryStockOpnameContext(context);

  const [snapshotRows, opnameRows] = await Promise.all([
    snapshots.find({ storeId, year, month }).toArray(),
    opname.find({ storeId, year, month }).toArray(),
  ]);

  const opnameByKey = new Map(opnameRows.map((doc) => [opnameKey(doc.productId, doc.variantId), doc]));
  let approvedByKey = new Map<string, HistoricalReconciliationRow>();
  let historicalStatusByKey = new Map<string, OpnameStatus>();
  if (year === 2026 && month === 2) {
    const approvedRows = context?.approvedRows ?? await (async () => {
      const { collections } = await import("./mongodb.ts");
      const { olseraInventoryProducts } = await collections();
      const products = await olseraInventoryProducts.find({ storeId: { $in: [storeId, null] } }).toArray();
      const sourceRows = resolveFebruaryHistoricalRows(FEBRUARY_HISTORICAL_SOURCE.overall, products);
      return sourceRows.map((row) => ({ ...row }));
    })();
    approvedByKey = new Map(approvedRows.map((row) => [opnameKey(row.productId, row.variantId), row]));
    const systemRows: HistoricalReconciliationRow[] = snapshotRows.map((row) => ({ productId: row.productId, variantId: row.variantId, productSku: row.productSku, productName: row.productName, openingQty: row.openingQty, incomingQty: row.incomingQty, returnQty: row.returnQty, salesQty: row.salesQty, outgoingQty: row.outgoingQty, closingQty: row.closingQty }));
    const comparison = compareHistoricalInventoryRows(systemRows, approvedRows, { sourceRevision: FEBRUARY_HISTORICAL_SOURCE_REVISION });
    historicalStatusByKey = new Map(comparison.rows.map((row) => [row.key, row.status === "COCOK" ? "COCOK" : row.status === "SELISIH" ? "PERLU_DICEK" : "BELUM_DIISI"]));
  }

  const visibleSnapshots = visibleMonthlyInventoryRows(
    snapshotRows.map((snap) => ({ ...snap, category: snap.groupName })),
    false,
  );
  const rows: InventoryOpnameRow[] = visibleSnapshots.map((snap) => {
    const flow = {
      openingQty: snap.openingQty,
      incomingQty: snap.incomingQty,
      returnQty: snap.returnQty,
      salesQty: snap.salesQty,
      outgoingQty: snap.outgoingQty,
      closingQty: snap.closingQty,
    };
    const systemClosingQty = resolveSystemClosingQty(flow);
    // Februari memakai source approved terpisah; BA tidak relevan.
    const historicalFinal = year === 2026 && month === 2;
    const approved = approvedByKey.get(opnameKey(snap.productId, snap.variantId));
    const historicalStatus = historicalFinal ? historicalStatusByKey.get(opnameKey(snap.productId, snap.variantId)) ?? "BELUM_DIISI" : null;
    const manualAdjust = historicalFinal ? false : needsManualAdjust({ status: snap.status, canonicalProductId: snap.canonicalProductId });
    const opnameDoc = opnameByKey.get(opnameKey(snap.productId, snap.variantId)) ?? null;
    const physicalQty = historicalFinal ? approved?.closingQty ?? null : opnameDoc?.physicalQty ?? null;
    const differenceQty = computeDifferenceQty(physicalQty, systemClosingQty);
    const status = historicalFinal ? historicalStatus! : physicalQty === null && snap.status === "complete" && !manualAdjust ? "COCOK" : determineOpnameStatus({ physicalQty, systemClosingQty, manualAdjust });

    return {
      productId: snap.productId,
      variantId: snap.variantId,
      productName: snap.productName,
      productSku: snap.productSku,
      category: snap.groupName,
      openingQty: snap.openingQty,
      incomingQty: snap.incomingQty,
      returnQty: snap.returnQty,
      salesQty: snap.salesQty,
      outgoingQty: snap.outgoingQty,
      snapshotClosingQty: snap.closingQty,
      formulaClosingQty: computeFormulaClosingQty(flow),
      systemClosingQty,
      formulaMismatch: hasFormulaMismatch(flow),
      snapshotStatus: snap.status,
      snapshotDiagnostics: snap.diagnostics,
      manualAdjust,
      physicalQty,
      differenceQty,
      status,
      note: opnameDoc?.note ?? null,
      updatedBy: opnameDoc?.updatedBy ?? null,
      updatedAt: opnameDoc?.updatedAt ? new Date(opnameDoc.updatedAt).toISOString() : null,
      evidenceSource: opnameDoc?.evidenceSource ?? null,
    };
  });

  rows.sort((a, b) => a.productName.localeCompare(b.productName, "id"));

  const event = opnameRows.find((doc) => doc._id === `${storeId}:${year}:${String(month).padStart(2, "0")}:event`);
  return { storeId, year, month, rows, summary: summarizeOpname(rows), lock: lockState(event) };
}

// ---------------------------------------------------------------------------
// Jalur BARU: rekonsiliasi berbasis cutoff tanggal BA (BUKAN akhir bulan
// kalender) — Stok Akhir Sistem dihitung PERSIS pada cutoffDate lewat
// fetchCutoffSystemRows (end_date=cutoffDate). TIDAK PERNAH menyentuh/
// menghitung ulang olsera_inventory_monthly_snapshots (koleksi snapshot
// bulanan existing tetap read-only & tidak dipakai sama sekali di jalur ini).
// year/month TETAP dipakai (hanya untuk mencari berita acara tersimpan by
// key storeId+year+month yang sudah ada — bukan lagi sumber boundary stok).
// ---------------------------------------------------------------------------

export type InventoryOpnameCutoffResult = InventoryOpnameMonthResult & {
  cutoffDate: string;
  startDate: string;
  endDate: string;
  unmatchedOrAmbiguous: UnmatchedMovementEntry[];
};

export async function loadInventoryOpnameCutoff(
  input: { storeId: number; year: number; month: number; cutoffDate: string; startDate?: string | null },
  context?: InventoryStockOpnameContext,
): Promise<InventoryOpnameCutoffResult> {
  const storeId = input.storeId;
  const year = validateYear(input.year);
  const month = validateMonth(input.month);
  if (!isValidIsoDate(input.cutoffDate)) throw new InventoryStockOpnameError("cutoffDate tidak valid — format wajib YYYY-MM-DD.");
  // startDate OPSIONAL (Tahap 1). Divalidasi DI SINI, bukan hanya di route,
  // supaya pemanggil lib mana pun ikut terlindungi. Rentang terbalik DITOLAK
  // eksplisit — resolveCutoffQueryRange akan diam-diam melebarkannya ke
  // CUTOFF_MAX_LOOKBACK_DAYS, dan pelebaran diam-diam pada rekonsiliasi BA
  // jauh lebih berbahaya daripada error yang terbaca.
  const startDate = input.startDate ?? undefined;
  if (startDate !== undefined) {
    if (!isValidIsoDate(startDate)) throw new InventoryStockOpnameError("startDate tidak valid — format wajib YYYY-MM-DD.");
    if (startDate > input.cutoffDate) throw new InventoryStockOpnameError(`startDate (${startDate}) tidak boleh melewati cutoffDate (${input.cutoffDate}).`);
  }

  const { opname } = await resolveInventoryStockOpnameContext(context);
  const deps = await resolveCutoffDeps(context);

  const [fetched, opnameRows] = await Promise.all([
    fetchCutoffSystemRows(input.cutoffDate, deps, startDate),
    opname.find({ storeId, year, month }).toArray(),
  ]);
  if (!fetched.ok) throw new InventoryStockOpnameError(`Gagal menarik stok sistem Olsera pada cutoff ${input.cutoffDate}: ${fetched.error}`);

  const opnameByKey = new Map(opnameRows.map((doc) => [opnameKey(doc.productId, doc.variantId), doc]));

  const rows: InventoryOpnameRow[] = fetched.rows.map((sys) => {
    const flow = { openingQty: sys.openingQty, incomingQty: sys.incomingQty, returnQty: sys.returnQty, salesQty: sys.salesQty, outgoingQty: sys.outgoingQty, closingQty: sys.closingQty };
    // sys.closingQty ("sisa") datang LANGSUNG dari API tepat pada cutoffDate — sumber utama, tidak perlu fallback rumus (beda dari jalur snapshot bulanan yang closingQty-nya bisa null pada carry-forward tertentu).
    const systemClosingQty = sys.closingQty;
    const opnameDoc = opnameByKey.get(opnameKey(sys.productId, sys.variantId)) ?? null;
    const physicalQty = opnameDoc?.physicalQty ?? null;
    const differenceQty = computeDifferenceQty(physicalQty, systemClosingQty);
    // Jalur cutoff langsung TIDAK punya konsep carry-forward "incomplete"/canonicalProductId
    // (itu murni artefak rantai bulanan berkelanjutan) — setiap panggilan berdiri sendiri,
    // langsung dari API pada cutoffDate, jadi manualAdjust selalu false di sini.
    const manualAdjust = false;
    const status = determineOpnameStatus({ physicalQty, systemClosingQty, manualAdjust });

    return {
      productId: sys.productId,
      variantId: sys.variantId,
      productName: sys.productName,
      productSku: sys.productSku,
      category: sys.groupName,
      openingQty: sys.openingQty,
      incomingQty: sys.incomingQty,
      returnQty: sys.returnQty,
      salesQty: sys.salesQty,
      outgoingQty: sys.outgoingQty,
      snapshotClosingQty: systemClosingQty,
      formulaClosingQty: computeFormulaClosingQty(flow),
      systemClosingQty,
      formulaMismatch: hasFormulaMismatch(flow),
      snapshotStatus: "complete",
      snapshotDiagnostics: [],
      manualAdjust,
      physicalQty,
      differenceQty,
      status,
      note: opnameDoc?.note ?? null,
      updatedBy: opnameDoc?.updatedBy ?? null,
      updatedAt: opnameDoc?.updatedAt ? new Date(opnameDoc.updatedAt).toISOString() : null,
      evidenceSource: opnameDoc?.evidenceSource ?? null,
    };
  });

  rows.sort((a, b) => a.productName.localeCompare(b.productName, "id"));

  const event = opnameRows.find((doc) => doc._id === `${storeId}:${year}:${String(month).padStart(2, "0")}:event`);
  return { storeId, year, month, cutoffDate: input.cutoffDate, startDate: fetched.startDate, endDate: fetched.endDate, rows, summary: summarizeOpname(rows), unmatchedOrAmbiguous: fetched.unmatchedOrAmbiguous, lock: lockState(event) };
}

// ---------------------------------------------------------------------------
// Simpan berita acara (batch satu bulan) — idempotent, upsert/hapus per produk.
// ---------------------------------------------------------------------------

export type InventoryOpnameEntryInput = {
  productId: number;
  variantId: number | null;
  /** null = hapus nilai (kembali ke "Belum Diisi"). */
  physicalQty: number | null;
  note?: string | null;
};

export type SaveInventoryOpnameBatchInput = {
  storeId: number;
  year: number;
  month: number;
  actor: { role: "supervisor" | "user"; email: string };
  entries: InventoryOpnameEntryInput[];
  baOnlyDifferencesConfirmed?: boolean;
  cutoff?: string;
};

function validateEntries(entries: unknown): InventoryOpnameEntryInput[] {
  if (!Array.isArray(entries)) throw new InventoryStockOpnameError("entries harus berupa array.");
  if (entries.length > MAX_ENTRIES_PER_SAVE) throw new InventoryStockOpnameError("entries terlalu banyak dalam satu kali simpan.");
  return entries.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new InventoryStockOpnameError(`entries[${index}] tidak valid.`);
    const entry = raw as Record<string, unknown>;
    if (!Number.isInteger(entry.productId)) throw new InventoryStockOpnameError(`entries[${index}].productId tidak valid.`);
    const variantId = entry.variantId === null || entry.variantId === undefined ? null : Number(entry.variantId);
    if (variantId !== null && !Number.isInteger(variantId)) throw new InventoryStockOpnameError(`entries[${index}].variantId tidak valid.`);
    let physicalQty: number | null = null;
    if (entry.physicalQty !== null && entry.physicalQty !== undefined) {
      physicalQty = Number(entry.physicalQty);
      if (!Number.isFinite(physicalQty) || physicalQty < 0) throw new InventoryStockOpnameError(`entries[${index}].physicalQty tidak valid.`);
    }
    let note: string | null = null;
    if (entry.note !== null && entry.note !== undefined) {
      note = String(entry.note).trim().slice(0, MAX_NOTE_LENGTH);
      if (!note) note = null;
    }
    return { productId: entry.productId as number, variantId, physicalQty, note };
  });
}

export async function saveInventoryOpnameBatch(
  input: SaveInventoryOpnameBatchInput,
  context?: InventoryStockOpnameContext,
): Promise<InventoryOpnameMonthResult> {
  if (input.actor.role !== "supervisor") throw new InventoryStockOpnameError("Hanya supervisor yang dapat menyimpan berita acara.", "FORBIDDEN");

  const storeId = input.storeId;
  const year = validateYear(input.year);
  const month = validateMonth(input.month);
  const entries = validateEntries(input.entries);

  const { snapshots, opname } = await resolveInventoryStockOpnameContext(context);
  const snapshotRows = await snapshots.find({ storeId, year, month }).toArray();
  const snapshotByKey = new Map(snapshotRows.map((snap) => [opnameKey(snap.productId, snap.variantId), snap]));

  if (input.baOnlyDifferencesConfirmed !== undefined) {
    const cutoff = input.cutoff ?? `${year}-${String(month).padStart(2, "0")}`;
    const verification = verifyStockOpnameBa({
      systemRows: snapshotRows.map((snap) => ({ productId: snap.productId, variantId: snap.variantId, systemClosingQty: resolveSystemClosingQty({ openingQty: snap.openingQty, incomingQty: snap.incomingQty, returnQty: snap.returnQty, salesQty: snap.salesQty, outgoingQty: snap.outgoingQty, closingQty: snap.closingQty }) })),
      baEntries: entries.map((entry) => ({ productId: entry.productId, variantId: entry.variantId, physicalQty: entry.physicalQty, differenceQty: entry.physicalQty === null ? null : (snapshotByKey.get(opnameKey(entry.productId, entry.variantId))?.closingQty ?? null) === null ? null : entry.physicalQty - (snapshotByKey.get(opnameKey(entry.productId, entry.variantId))?.closingQty ?? 0), note: entry.note ?? null, cutoff })),
      expectedCutoff: cutoff,
      baOnlyDifferencesConfirmed: input.baOnlyDifferencesConfirmed,
    });
    if (!verification.canFinalize && input.baOnlyDifferencesConfirmed) throw new InventoryStockOpnameError(verification.reason ?? "BA belum lolos verifikasi.");
  }

  const now = new Date();
  for (const entry of entries) {
    const snap = snapshotByKey.get(opnameKey(entry.productId, entry.variantId));
    // Produk yang tidak ada di snapshot bulan ini dilewati (bukan error keras) —
    // input hanya boleh datang dari daftar yang memang dimuat dari snapshot bulan tsb.
    if (!snap) continue;

    const id = buildOpnameId({ storeId, year, month, productId: entry.productId, variantId: entry.variantId });

    if (entry.physicalQty === null) {
      await opname.deleteOne({ _id: id });
      continue;
    }

    const flow = {
      openingQty: snap.openingQty,
      incomingQty: snap.incomingQty,
      returnQty: snap.returnQty,
      salesQty: snap.salesQty,
      outgoingQty: snap.outgoingQty,
      closingQty: snap.closingQty,
    };
    const systemClosingQty = resolveSystemClosingQty(flow);
    const manualAdjust = needsManualAdjust({ status: snap.status, canonicalProductId: snap.canonicalProductId });
    const differenceQty = computeDifferenceQty(entry.physicalQty, systemClosingQty);
    // physicalQty selalu terisi di sini (null ditangani via deleteOne di atas) —
    // determineOpnameStatus tidak pernah mengembalikan BELUM_DIISI pada kondisi ini.
    const status = determineOpnameStatus({ physicalQty: entry.physicalQty, systemClosingQty, manualAdjust }) as "COCOK" | "PERLU_DICEK" | "BUTUH_ADJUST_MANUAL";

    await opname.updateOne(
      { _id: id },
      {
        $set: {
          storeId,
          year,
          month,
          productId: entry.productId,
          variantId: entry.variantId,
          physicalQty: entry.physicalQty,
          systemClosingQty,
          differenceQty,
          status,
          note: entry.note,
          updatedBy: input.actor.email,
          updatedAt: now,
        },
        $setOnInsert: { _id: id, createdAt: now },
      },
      { upsert: true },
    );
  }

  return loadInventoryOpnameMonth({ storeId, year, month }, context);
}

/**
 * Timezone Asia/Jakarta, format YYYY-MM-DD — SATU-SATUNYA sumber "hari ini"
 * dipakai validateCutoffPlausibility di sini (pola sama app/reconciliation/inventory/page.tsx:currentJakartaYearMonth,
 * hanya ditambah komponen tanggal).
 */
function todayJakartaIso(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export async function finalizeInventoryStockOpname(
  input: {
    storeId: number;
    year: number;
    month: number;
    actor: string;
    cutoff: string;
    /**
     * Tanggal cutoff BA eksplisit (ISO, mis. "2026-07-16" = akhir periode BA
     * "01 Juli 2026 s/d 16 Juli 2026") — BILA DIISI, Stok Akhir Sistem
     * dihitung PERSIS pada tanggal ini (lewat loadInventoryOpnameCutoff, end_date
     * API = cutoffDate) menggantikan snapshot akhir bulan kalender untuk
     * verifikasi finalisasi. BILA KOSONG/undefined (dokumen lama/BA tanpa
     * cutoff tanggal eksplisit), perilaku LAMA dipertahankan penuh — verifikasi
     * tetap memakai loadInventoryOpnameMonth (snapshot bulanan), TIDAK ADA
     * migrasi paksa/backfill otomatis.
     */
    cutoffDate?: string | null;
    /**
     * Awal periode BA (ISO) — OPSIONAL, hanya bermakna bersama `cutoffDate`.
     * BILA DIISI, validasi plausibilitas beralih ke mode rentang bebas
     * (lihat validateCutoffPlausibility): periode BA boleh melintasi batas
     * bulan (BA Februari 2026 = 04 Feb s/d 04 Mar) asalkan startDate sendiri
     * berada di periode yang dipilih. BILA KOSONG, gate LAMA dipertahankan
     * penuh — cutoff wajib sebulan dengan periode.
     */
    startDate?: string | null;
    /** WAJIB true bila cutoffDate diisi (pola sama baOnlyDifferencesConfirmed) — user harus mengonfirmasi cutoff tanggal spesifik, bukan otomatis tanpa konfirmasi. */
    cutoffConfirmed?: boolean;
    baOnlyDifferencesConfirmed: boolean;
    attachment: { fileName: string; mimeType: string; size: number; url: string; uploadedAt: Date; uploadedBy: string };
    /** Opsional — injeksi waktu "sekarang" untuk tes deterministik (lockedAt & perhitungan "hari ini" cutoff). Default: new Date(). */
    now?: Date;
  },
  context?: InventoryStockOpnameContext,
) {
  if (!input.baOnlyDifferencesConfirmed) throw new InventoryStockOpnameError("Konfirmasi BA hanya memuat item yang selisih wajib dicentang.");

  const now = input.now ?? new Date();
  const cutoffDate = input.cutoffDate ?? null;

  let result: InventoryOpnameMonthResult;
  if (cutoffDate !== null) {
    // Basis BARU: cutoff tanggal BA (bukan akhir bulan kalender) — WAJIB
    // dikonfirmasi eksplisit & WAJIB lolos validasi plausibilitas ("BA salah
    // periode diblok") sebelum dipakai untuk finalisasi.
    if (!input.cutoffConfirmed) throw new InventoryStockOpnameError("Konfirmasi cutoff tanggal BA wajib dicentang sebelum finalisasi.");
    const startDate = input.startDate ?? null;
    const validation = validateCutoffPlausibility({ cutoffDate, year: input.year, month: input.month, today: todayJakartaIso(now), startDate });
    if (!validation.ok) throw new InventoryStockOpnameError(validation.reason ?? "Cutoff BA tidak valid — perlu ditinjau manual.");
    result = await loadInventoryOpnameCutoff({ storeId: input.storeId, year: input.year, month: input.month, cutoffDate, startDate }, context);
  } else {
    // Perilaku LAMA dipertahankan (backward compatible) — BA tanpa cutoff tanggal eksplisit.
    result = await loadInventoryOpnameMonth({ storeId: input.storeId, year: input.year, month: input.month }, context);
  }

  const submitted = result.rows.filter((row) => row.physicalQty !== null || input.baOnlyDifferencesConfirmed);
  if (!submitted.length || submitted.some((row) => row.manualAdjust || row.systemClosingQty === null || (!input.baOnlyDifferencesConfirmed && (row.differenceQty === null || row.differenceQty === 0)))) throw new InventoryStockOpnameError("Finalisasi diblokir: masih ada mismatch, mapping tidak pasti, atau item tanpa selisih.");
  const { opname } = await resolveInventoryStockOpnameContext(context);
  for (const row of result.rows) {
    if (row.manualAdjust || row.systemClosingQty === null) continue;
    const omitted = row.physicalQty === null;
    if (omitted && !input.baOnlyDifferencesConfirmed) continue;
    const physicalQty = omitted ? row.systemClosingQty : row.physicalQty;
    const id = buildOpnameId({ storeId: input.storeId, year: input.year, month: input.month, productId: row.productId, variantId: row.variantId });
    await opname.updateOne({ _id: id }, { $set: { _id: id, storeId: input.storeId, year: input.year, month: input.month, productId: row.productId, variantId: row.variantId, physicalQty, systemClosingQty: row.systemClosingQty, differenceQty: omitted ? 0 : row.differenceQty, status: "COCOK", note: omitted ? "Tidak tercantum di BA; dianggap Cocok sesuai konfirmasi BA-only-differences." : row.note, evidenceSource: omitted ? "BA_OMITTED_ASSUMED_MATCH" : "BA_INPUT", updatedBy: input.actor, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
  }
  const eventId = `${input.storeId}:${input.year}:${String(input.month).padStart(2, "0")}:event`;
  // NOTE (Rule 5 — lock TIDAK memfreeze inventory): dokumen event ini HANYA
  // ditulis ke koleksi terpisah `inventory_stock_opname_reconciliations`
  // (lihat lib/mongodb.ts) — cron/sync inventori (lib/cron-olsera-inventory.ts,
  // lib/olsera-inventory.ts) TIDAK PERNAH membaca koleksi ini (lihat komentar
  // + regresi di lib/inventory-stock-opname-store.test.ts "lock tidak
  // memfreeze cron/sync inventory"). Lock ini murni snapshot hasil
  // rekonsiliasi + status, bukan gate operasional.
  await opname.updateOne({ _id: eventId }, { $set: { _id: eventId, storeId: input.storeId, year: input.year, month: input.month, productId: 0, variantId: null, physicalQty: 0, systemClosingQty: null, differenceQty: null, status: "COCOK", note: null, updatedBy: input.actor, cutoff: input.cutoff, cutoffDate, baOnlyDifferencesConfirmed: true, attachment: input.attachment, verificationResult: "PASS", lockedAt: now, lockedBy: input.actor, unlockedAt: null, unlockedBy: null, updatedAt: now }, $setOnInsert: { createdAt: now }, $push: { history: { action: "lock", actor: input.actor, reason: null, at: now } } }, { upsert: true });
  return { status: "LOCKED" as const, cutoff: input.cutoff, cutoffDate, verificationResult: "PASS" as const, lockedAt: now, lockedBy: input.actor, adjustmentApplied: false };
}

export async function unlockInventoryStockOpname(input: { storeId: number; year: number; month: number; actor: string; reason: string }, context?: InventoryStockOpnameContext) {
  if (!input.reason.trim()) throw new InventoryStockOpnameError("Reason unlock wajib diisi.");
  const { opname } = await resolveInventoryStockOpnameContext(context); const now = new Date();
  const eventId = `${input.storeId}:${input.year}:${String(input.month).padStart(2, "0")}:event`;
  await opname.updateOne({ _id: eventId }, { $set: { lockedAt: null, lockedBy: null, unlockedAt: now, unlockedBy: input.actor, updatedAt: now }, $push: { history: { action: "unlock", actor: input.actor, reason: input.reason.trim().slice(0, MAX_NOTE_LENGTH), at: now } } }, { upsert: false });
  return { status: "UNLOCKED" as const, unlockedAt: now, unlockedBy: input.actor };
}
