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
  needsManualAdjust,
  resolveSystemClosingQty,
  summarizeOpname,
  type OpnameStatus,
  type OpnameSummary,
} from "./inventory-stock-opname.ts";
import type { InventoryStockOpnameDocument, OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";

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

export type InventoryStockOpnameContext = {
  snapshots: MinimalReadCollection<OlseraInventoryMonthlySnapshotDocument>;
  opname: MinimalOpnameCollection;
};

export async function resolveInventoryStockOpnameContext(context?: InventoryStockOpnameContext): Promise<InventoryStockOpnameContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { olseraInventoryMonthlySnapshots, inventoryStockOpnameReconciliations } = await collections();
  return { snapshots: olseraInventoryMonthlySnapshots, opname: inventoryStockOpnameReconciliations };
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
};

export type InventoryOpnameMonthResult = {
  storeId: number;
  year: number;
  month: number;
  rows: InventoryOpnameRow[];
  summary: OpnameSummary;
};

function opnameKey(productId: number, variantId: number | null): string {
  return `${productId}:${variantId ?? 0}`;
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

  const rows: InventoryOpnameRow[] = snapshotRows.map((snap) => {
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
    const opnameDoc = opnameByKey.get(opnameKey(snap.productId, snap.variantId)) ?? null;
    const physicalQty = opnameDoc?.physicalQty ?? null;
    const differenceQty = computeDifferenceQty(physicalQty, systemClosingQty);
    const status = determineOpnameStatus({ physicalQty, systemClosingQty, manualAdjust });

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
    };
  });

  rows.sort((a, b) => a.productName.localeCompare(b.productName, "id"));

  return { storeId, year, month, rows, summary: summarizeOpname(rows) };
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
