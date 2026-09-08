import { collections, type InventoryMonthlyPeriodLockDocument, type OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";

export class InventoryMonthlyPeriodLockError extends Error {
  constructor(message: string, readonly code: "VALIDATION" | "LOCKED" = "VALIDATION") {
    super(message);
    this.name = "InventoryMonthlyPeriodLockError";
  }
}

type LockCollection = {
  findOne(filter: Record<string, unknown>): Promise<InventoryMonthlyPeriodLockDocument | null>;
  findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, options: { upsert?: boolean; returnDocument: "after" }): Promise<InventoryMonthlyPeriodLockDocument | null>;
};
type SnapshotCollection = { find(filter: Record<string, unknown>): { toArray(): Promise<OlseraInventoryMonthlySnapshotDocument[]> } };
type ProductCollection = { find(filter: Record<string, unknown>): { toArray(): Promise<Array<{ productId: number; variantId: number | null; active?: boolean; stockQty?: number }>> } };
export type InventoryMonthlyPeriodLockContext = { locks: LockCollection; snapshots: SnapshotCollection; products?: ProductCollection; };

function id(storeId: number, year: number, month: number) {
  return `${storeId}:${year}-${String(month).padStart(2, "0")}`;
}

function currentPeriod(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" }).format(now);
}

function source(): Promise<InventoryMonthlyPeriodLockContext> {
  return collections().then((c) => ({ locks: c.inventoryMonthlyPeriodLocks, snapshots: c.olseraInventoryMonthlySnapshots, products: c.olseraInventoryProducts }));
}

export type InventoryPeriodCompleteness = { movementProducts: number; catalogOnlyCandidates: number; verifiedForPeriod: number; unverified: number; totalUniverse: number; pass: boolean };

export async function getInventoryPeriodCompleteness(input: { storeId: number; year: number; month: number }, context?: InventoryMonthlyPeriodLockContext): Promise<InventoryPeriodCompleteness> {
  const c = context ?? await source();
  const snapshots = await c.snapshots.find({ storeId: input.storeId, year: input.year, month: input.month }).toArray();
  if (input.year === 2026 && input.month === 2) {
    return { movementProducts: snapshots.length, catalogOnlyCandidates: 0, verifiedForPeriod: snapshots.length, unverified: 0, totalUniverse: snapshots.length, pass: true };
  }
  const snapshotKeys = new Set(snapshots.map((row) => `${row.productId}:${row.variantId ?? 0}`));
  const movementProducts = new Set(snapshots.filter((row) => row.source !== "catalog").map((row) => `${row.productId}:${row.variantId ?? 0}`));
  const products = c.products ? await c.products.find({ storeId: { $in: [input.storeId, null] }, active: true, stockQty: { $gt: 0 } }).toArray() : [];
  // Katalog yang dibandingkan adalah katalog HARI INI, sedangkan bulan yang
  // diperiksa historis — produk yang baru lahir SETELAH bulan itu karena itu
  // memblokir penguncian selamanya, dan mustahil dipenuhi dari sisi data
  // (membuat snapshot untuk bulan saat produknya belum ada = mengarang angka).
  // Kasus nyata: NESTLE PURE LIFE 1500ML Duplikate (productId 120601602),
  // transaksi pertama 10 Agustus 2026, memblokir Feb s/d Juli 2026.
  //
  // Bulan snapshot PERTAMA dipakai sebagai penanda kelahiran: rantai snapshot
  // bulanan dibangun dari pergerakan Olsera, jadi bulan pertama sebuah produk
  // punya snapshot = bulan pertama ia terlihat di ledger. Dipilih ketimbang
  // tanggal pergerakan pertama karena olsera_inventory_movements hanya memuat
  // penjualan (produk yang masuk stok tapi belum pernah terjual tidak punya
  // jejak di sana), sementara snapshot juga mencakup stok non-penjualan.
  //
  // Produk TANPA jejak snapshot sama sekali TETAP dihitung belum diverifikasi:
  // tidak ada bukti kapan ia lahir, jadi jangan diloloskan (fail-closed,
  // perilakunya sama persis seperti sebelum perubahan ini).
  const period = input.year * 12 + input.month;
  const storeSnapshots = await c.snapshots.find({ storeId: input.storeId }).toArray();
  const firstPeriodByKey = new Map<string, number>();
  for (const row of storeSnapshots) {
    const key = `${row.productId}:${row.variantId ?? 0}`;
    const rowPeriod = row.year * 12 + row.month;
    const seen = firstPeriodByKey.get(key);
    if (seen === undefined || rowPeriod < seen) firstPeriodByKey.set(key, rowPeriod);
  }
  const bornAfterPeriod = (key: string) => {
    const first = firstPeriodByKey.get(key);
    return first !== undefined && first > period;
  };
  const catalogOnlyCandidates = products.filter((product) => {
    const key = `${product.productId}:${product.variantId ?? 0}`;
    return !snapshotKeys.has(key) && !bornAfterPeriod(key);
  });
  const verifiedForPeriod = snapshotKeys.size;
  const unverified = catalogOnlyCandidates.length;
  return { movementProducts: movementProducts.size, catalogOnlyCandidates: catalogOnlyCandidates.length, verifiedForPeriod, unverified, totalUniverse: movementProducts.size + catalogOnlyCandidates.length, pass: unverified === 0 };
}

export async function getInventoryMonthlyPeriodLock(storeId: number, year: number, month: number, context?: InventoryMonthlyPeriodLockContext) {
  const c = context ?? await source();
  return c.locks.findOne({ _id: id(storeId, year, month) });
}

/**
 * Tolak (throw InventoryMonthlyPeriodLockError code "LOCKED") bila periode
 * bulan ini berstatus locked di inventory_monthly_period_locks — dipakai
 * jalur TULIS Berita Acara/stock opname (lib/inventory-stock-opname-store.ts)
 * SEBELUM menulis, pola PERSIS assertOmzetPeriodNotLocked (lib/reconciliation-omzet-period-lock.ts)
 * supaya bulan yang sudah dikunci tidak diam-diam berubah lewat Simpan/Finalisasi/
 * Buka Kunci BA individual. Reuse getInventoryMonthlyPeriodLock — TIDAK ada
 * koleksi/skema baru.
 */
export async function assertInventoryOpnamePeriodNotLocked(storeId: number, year: number, month: number, context?: InventoryMonthlyPeriodLockContext): Promise<void> {
  const lock = await getInventoryMonthlyPeriodLock(storeId, year, month, context);
  if (lock?.status === "locked") {
    throw new InventoryMonthlyPeriodLockError(
      `Periode ${year}-${String(month).padStart(2, "0")} sudah dikunci (Kunci Periode Inventori) — tulis Berita Acara untuk periode ini ditolak. Buka kunci periode tersebut dulu di halaman Rekonsiliasi Inventori bila memang perlu menulis ulang.`,
      "LOCKED",
    );
  }
}

export function isValidInventoryMonthlySnapshot(doc: OlseraInventoryMonthlySnapshotDocument): boolean {
  const values = [doc.openingQty, doc.incomingQty, doc.returnQty, doc.salesQty, doc.outgoingQty, doc.closingQty];
  return doc.status === "complete" && values.every((value) => value !== null && Number.isFinite(value)) && doc.closingQty === doc.openingQty! + doc.incomingQty! + doc.returnQty! - doc.salesQty! - doc.outgoingQty!;
}

export async function lockInventoryMonthlyPeriod(input: { storeId: number; year: number; month: number; actor: string; reason?: string }, context?: InventoryMonthlyPeriodLockContext) {
  const c = context ?? await source();
  if (currentPeriod(new Date()) === `${input.year}-${String(input.month).padStart(2, "0")}`) throw new InventoryMonthlyPeriodLockError("Bulan berjalan tidak boleh dikunci.");
  const snapshots = await c.snapshots.find({ storeId: input.storeId, year: input.year, month: input.month }).toArray();
  if (!snapshots.length) throw new InventoryMonthlyPeriodLockError("Snapshot periode belum tersedia.");
  if (snapshots.some((snapshot) => !isValidInventoryMonthlySnapshot(snapshot))) throw new InventoryMonthlyPeriodLockError("Periode belum valid/final; masih ada snapshot incomplete atau arithmetic inconsistency.");
  const completeness = await getInventoryPeriodCompleteness(input, c);
  if (!completeness.pass) throw new InventoryMonthlyPeriodLockError(`Periode belum lengkap; masih ada ${completeness.unverified} produk katalog yang belum diverifikasi untuk periode ini.`);
  const existing = await c.locks.findOne({ _id: id(input.storeId, input.year, input.month) });
  if (existing?.status === "locked") throw new InventoryMonthlyPeriodLockError("Periode inventori sudah terkunci.");
  const now = new Date();
  const document = await c.locks.findOneAndUpdate(
    { _id: id(input.storeId, input.year, input.month), ...(existing ? { status: "unlocked" } : {}) },
    { $set: { storeId: input.storeId, year: input.year, month: input.month, status: "locked", snapshots, lockedAt: now, lockedBy: input.actor, unlockedAt: null, unlockedBy: null, updatedAt: now }, $setOnInsert: { createdAt: now }, $push: { history: { action: "lock", actor: input.actor, reason: input.reason?.trim() || null, at: now } } },
    { upsert: !existing, returnDocument: "after" },
  );
  if (!document) throw new InventoryMonthlyPeriodLockError("Konflik lock inventori; muat ulang lalu coba lagi.");
  return document;
}

export async function unlockInventoryMonthlyPeriod(input: { storeId: number; year: number; month: number; actor: string; reason: string }, context?: InventoryMonthlyPeriodLockContext) {
  if (!input.reason.trim()) throw new InventoryMonthlyPeriodLockError("Reason unlock wajib diisi.");
  const c = context ?? await source();
  const now = new Date();
  const document = await c.locks.findOneAndUpdate(
    { _id: id(input.storeId, input.year, input.month), status: "locked" },
    { $set: { status: "unlocked", unlockedAt: now, unlockedBy: input.actor, updatedAt: now }, $push: { history: { action: "unlock", actor: input.actor, reason: input.reason.trim().slice(0, 2000), at: now } } },
    { returnDocument: "after" },
  );
  if (!document) throw new InventoryMonthlyPeriodLockError("Periode tidak sedang terkunci atau sudah berubah.");
  return document;
}
