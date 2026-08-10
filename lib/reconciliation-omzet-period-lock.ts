import "server-only";
import { collections, type ReconciliationOmzetPeriodLockDocument } from "./mongodb.ts";

export class OmzetPeriodLockError extends Error {
  constructor(message: string, readonly code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "LOCKED" = "VALIDATION") { super(message); this.name = "OmzetPeriodLockError"; }
}

export type OmzetOriginalAmounts = { ayo: number; olsera: number; difference: number };
export type PeriodLockAttachment = NonNullable<ReconciliationOmzetPeriodLockDocument["attachment"]>;
export const OMZET_PERIOD_LOCK_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES: Record<string, readonly string[]> = {
  pdf: ["application/pdf"], jpg: ["image/jpeg", "image/jpg"], jpeg: ["image/jpeg", "image/jpg"], png: ["image/png"],
};
type LockCollection = {
  findOne(filter: Record<string, unknown>): Promise<ReconciliationOmzetPeriodLockDocument | null>;
  findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, options: { upsert?: boolean; returnDocument: "after" }): Promise<ReconciliationOmzetPeriodLockDocument | null>;
};
export type OmzetPeriodLockContext = { locks: LockCollection };

function periodParts(period: string) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new OmzetPeriodLockError("Format periode tidak valid.");
  const [year, month] = period.split("-").map(Number);
  if (month < 1 || month > 12) throw new OmzetPeriodLockError("Format periode tidak valid.");
  return { year, month };
}
function integer(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new OmzetPeriodLockError(`${field} wajib berupa integer Rupiah.`);
  return value;
}
export function validateOmzetPeriodLockAttachment(file: { name: string; type: string; size: number }) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_ATTACHMENT_TYPES[extension]?.includes(file.type)) throw new OmzetPeriodLockError("Hanya PDF, JPG, JPEG, atau PNG yang diterima.");
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new OmzetPeriodLockError("File berita acara wajib diunggah.");
  if (file.size > OMZET_PERIOD_LOCK_MAX_ATTACHMENT_BYTES) throw new OmzetPeriodLockError("Ukuran file maksimal 10MB.");
}
function text(value: unknown, field: string, max = 2_000) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new OmzetPeriodLockError(`${field} wajib diisi.`);
  return value.trim();
}
function snapshot(doc: ReconciliationOmzetPeriodLockDocument | null) {
  return doc ? { status: doc.status, version: doc.version, finalAgreedAmount: doc.finalAgreedAmount, adjustmentAmount: doc.adjustmentAmount, adjustmentReason: doc.adjustmentReason } : {};
}
function contextOrDefault(context?: OmzetPeriodLockContext): Promise<OmzetPeriodLockContext> | OmzetPeriodLockContext {
  if (context) return context;
  return collections().then((c) => ({ locks: c.reconciliationOmzetPeriodLocks as unknown as LockCollection }));
}

export async function getOmzetPeriodLock(storeId: number, period: string, context?: OmzetPeriodLockContext) {
  const source = await contextOrDefault(context);
  return source.locks.findOne({ _id: `${storeId}:${period}` });
}

export async function uploadOmzetPeriodLockAttachment(input: { storeId: number; period: string; actor: string; attachment: PeriodLockAttachment; expectedVersion?: number | null }, context?: OmzetPeriodLockContext) {
  const source = await contextOrDefault(context); const { year, month } = periodParts(input.period); const now = new Date(); const id = `${input.storeId}:${input.period}`;
  const current = await source.locks.findOne({ _id: id });
  if (current?.status === "locked") throw new OmzetPeriodLockError("Periode terkunci; buka kunci terlebih dahulu.", "LOCKED");
  if (input.expectedVersion !== undefined && input.expectedVersion !== null && current && current.version !== input.expectedVersion) throw new OmzetPeriodLockError("Data periode berubah; muat ulang sebelum upload.", "CONFLICT");
  const before = snapshot(current); const action = "upload" as const;
  const document = await source.locks.findOneAndUpdate(
    current ? { _id: id, version: current.version, status: { $ne: "locked" } } : { _id: id, version: { $exists: false } },
    // NOTE: _id sengaja TIDAK dimasukkan ke $setOnInsert — filter query di
    // atas SUDAH menetapkan _id (baik lewat equality langsung maupun via
    // { _id: id, version: ... }). Menyertakan _id di $setOnInsert SEKALIGUS
    // di filter memicu MongoDB error "Performing an update on the path
    // '_id' would modify the immutable field '_id'" pada sebagian versi
    // driver/server saat upsert benar-benar melakukan insert baru — inilah
    // root cause upload berita acara gagal dengan pesan generik. _id insert
    // otomatis diambil dari filter oleh MongoDB, jadi aman dihilangkan di sini.
    { $set: { storeId: input.storeId, year, month, periodKey: input.period, status: current?.status ?? "draft", attachment: input.attachment, updatedAt: now }, $setOnInsert: { originalAyoAmount: null, originalOlseraAmount: null, originalDifference: null, finalAgreedAmount: null, adjustmentAmount: null, adjustmentReason: null, lockedAt: null, lockedBy: null, unlockedAt: null, unlockedBy: null, history: [], createdAt: now, version: 0 }, $inc: { version: 1 }, $push: { history: { action, actor: input.actor, timestamp: now, reason: null, before, after: { fileName: input.attachment.fileName } } } },
    { upsert: !current, returnDocument: "after" },
  );
  if (!document) throw new OmzetPeriodLockError("Konflik upload; muat ulang lalu coba lagi.", "CONFLICT");
  return document;
}

export function previewOmzetPeriodLock(input: { original: OmzetOriginalAmounts; finalAgreedAmount: unknown; adjustmentReason: unknown; attachment: PeriodLockAttachment | null }) {
  const finalAgreedAmount = integer(input.finalAgreedAmount, "Nominal final");
  const adjustmentReason = text(input.adjustmentReason, "Alasan penyesuaian");
  if (!input.attachment) throw new OmzetPeriodLockError("Berita acara wajib diunggah sebelum preview.", "NOT_FOUND");
  return { ...input.original, finalAgreedAmount, adjustmentAmount: finalAgreedAmount - input.original.olsera, adjustmentReason, attachment: input.attachment, lockedDisplay: { ayo: finalAgreedAmount, olsera: finalAgreedAmount, difference: 0, status: "COCOK_TERKUNCI" as const } };
}

/** Records a non-locking preview in the append-only audit trail. */
export async function recordOmzetPeriodLockPreview(input: { storeId: number; period: string; actor: string; expectedVersion: unknown; original: OmzetOriginalAmounts; finalAgreedAmount: unknown; adjustmentReason: unknown }, context?: OmzetPeriodLockContext) {
  const source = await contextOrDefault(context);
  const expectedVersion = integer(input.expectedVersion, "Versi");
  const id = `${input.storeId}:${input.period}`;
  const current = await source.locks.findOne({ _id: id });
  const preview = previewOmzetPeriodLock({ ...input, attachment: current?.attachment ?? null });
  if (!current) throw new OmzetPeriodLockError("Berita acara wajib diunggah sebelum preview.", "NOT_FOUND");
  if (current.status === "locked") throw new OmzetPeriodLockError("Periode sudah terkunci.", "LOCKED");
  const now = new Date();
  const document = await source.locks.findOneAndUpdate(
    { _id: id, version: expectedVersion, status: { $in: ["draft", "unlocked"] } },
    {
      $set: { updatedAt: now },
      $inc: { version: 1 },
      $push: { history: { action: "preview", actor: input.actor, timestamp: now, reason: preview.adjustmentReason, before: snapshot(current), after: { finalAgreedAmount: preview.finalAgreedAmount, adjustmentAmount: preview.adjustmentAmount } } },
    },
    { returnDocument: "after" },
  );
  if (!document) throw new OmzetPeriodLockError("Konflik preview; muat ulang lalu coba lagi.", "CONFLICT");
  return { preview, lock: document };
}

export async function lockOmzetPeriodFinalization(input: { storeId: number; period: string; actor: string; expectedVersion: unknown; original: OmzetOriginalAmounts; finalAgreedAmount: unknown; adjustmentReason: unknown }, context?: OmzetPeriodLockContext) {
  const source = await contextOrDefault(context); const expectedVersion = integer(input.expectedVersion, "Versi"); const preview = previewOmzetPeriodLock({ ...input, attachment: (await source.locks.findOne({ _id: `${input.storeId}:${input.period}` }))?.attachment ?? null }); const now = new Date(); const id = `${input.storeId}:${input.period}`; const current = await source.locks.findOne({ _id: id });
  if (!current?.attachment) throw new OmzetPeriodLockError("Berita acara wajib diunggah sebelum lock.", "NOT_FOUND");
  if (current.status === "locked") throw new OmzetPeriodLockError("Periode sudah terkunci.", "LOCKED");
  const lastAudit = current.history.at(-1);
  if (lastAudit?.action !== "preview" || lastAudit.reason !== preview.adjustmentReason || lastAudit.after.finalAgreedAmount !== preview.finalAgreedAmount) throw new OmzetPeriodLockError("Buat preview finalisasi terbaru sebelum lock.");
  const action = current.status === "unlocked" ? "relock" : "lock";
  const document = await source.locks.findOneAndUpdate({ _id: id, version: expectedVersion, status: { $in: ["draft", "unlocked"] } }, { $set: { status: "locked", originalAyoAmount: input.original.ayo, originalOlseraAmount: input.original.olsera, originalDifference: input.original.difference, finalAgreedAmount: preview.finalAgreedAmount, adjustmentAmount: preview.adjustmentAmount, adjustmentReason: preview.adjustmentReason, lockedAt: now, lockedBy: input.actor, unlockedAt: null, unlockedBy: null, updatedAt: now }, $inc: { version: 1 }, $push: { history: { action, actor: input.actor, timestamp: now, reason: preview.adjustmentReason, before: snapshot(current), after: { original: input.original, finalAgreedAmount: preview.finalAgreedAmount, adjustmentAmount: preview.adjustmentAmount } } } }, { returnDocument: "after" });
  if (!document) throw new OmzetPeriodLockError("Konflik lock; data sudah berubah atau terkunci supervisor lain.", "CONFLICT");
  return document;
}

export async function unlockOmzetPeriodFinalization(input: { storeId: number; period: string; actor: string; expectedVersion: unknown; reason: unknown }, context?: OmzetPeriodLockContext) {
  const source = await contextOrDefault(context); const expectedVersion = integer(input.expectedVersion, "Versi"); const reason = text(input.reason, "Alasan buka kunci"); const now = new Date(); const id = `${input.storeId}:${input.period}`; const current = await source.locks.findOne({ _id: id });
  const document = await source.locks.findOneAndUpdate({ _id: id, version: expectedVersion, status: "locked" }, { $set: { status: "unlocked", unlockedAt: now, unlockedBy: input.actor, updatedAt: now }, $inc: { version: 1 }, $push: { history: { action: "unlock", actor: input.actor, timestamp: now, reason, before: snapshot(current), after: { status: "unlocked" } } } }, { returnDocument: "after" });
  if (!document) throw new OmzetPeriodLockError("Konflik buka kunci; muat ulang lalu coba lagi.", "CONFLICT");
  return document;
}

export function applyLockedOmzetPresentation<T extends { ayo: { count: number; revenue: number }; olseraTotal: number; differenceRevenue: number; status: string; statusReason: string }>(result: T, lock: ReconciliationOmzetPeriodLockDocument | null) {
  if (lock?.status !== "locked" || lock.finalAgreedAmount === null) return { ...result, periodLock: lock };
  return { ...result, ayo: { ...result.ayo, revenue: lock.finalAgreedAmount }, olseraTotal: lock.finalAgreedAmount, differenceRevenue: 0, status: "COCOK", statusReason: "Cocok — Terkunci berdasarkan berita acara rekonsiliasi.", periodLock: lock };
}
