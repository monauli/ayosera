import "server-only";
import { collections, type ReconciliationOmzetPeriodLockDocument } from "./mongodb.ts";
import { matchBeritaAcaraToSystemDifference, type BeritaAcaraDirection, type BeritaAcaraMatchStatus } from "./reconciliation-berita-acara-parser.ts";
import { formatRupiah } from "./reconciliation-berita-acara-ui.ts";
import { isWithinReconciliationTolerance } from "./reconciliation-tolerance.ts";

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
// V10: nominal/arah Berita Acara di preview (Simpan) OPSIONAL dan TIDAK
// PERNAH memblokir Simpan bila hilang/tidak valid — nilai sampah/hilang
// diperlakukan sebagai "tidak ada sinyal" (null), yang membuat
// matchBeritaAcaraToSystemDifference mengembalikan PERLU_REVIEW (bukan
// error) — konsisten dengan filosofi "jangan pernah blokir total" yang
// sudah dipakai di seluruh alur finalisasi ini.
function optionalPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function optionalBeritaAcaraDirection(value: unknown): BeritaAcaraDirection | null {
  return value === "PENAMBAHAN" || value === "PENGURANGAN" ? value : null;
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
    // NOTE: _id sengaja TIDAK dimasukkan ke $setOnInsert (lihat penjelasan
    // immutable-field di riwayat commit) — filter query di atas SUDAH
    // menetapkan _id, jadi MongoDB otomatis mengambilnya dari filter saat
    // insert.
    //
    // NOTE PENTING KEDUA (root cause upload gagal generik yang SEBENARNYA,
    // terverifikasi lewat reproduksi langsung terhadap MongoDB Atlas
    // sungguhan, BUKAN mock lokal): `version` dan `history` TIDAK BOLEH
    // muncul di $setOnInsert sekaligus juga jadi target $inc ($inc: version)
    // / $push ($push: history) pada update yang sama. MongoDB menolak update
    // seperti itu dengan error server code 40: "Updating the path 'version'
    // would create a conflict at 'version'" (dan sama untuk 'history') —
    // ini SELALU terjadi, baik saat upsert benar-benar insert maupun saat
    // dokumen sudah ada (MongoDB memvalidasi struktur update-nya, bukan
    // hanya efeknya), sehingga SETIAP upload — termasuk yang pertama kali
    // untuk periode baru seperti Maret 2026 — gagal dengan MongoServerError
    // yang tidak dikenali oleh regex penanganan error khusus di route.ts,
    // lalu jatuh ke fallback generik "Gagal menyimpan berita acara. Coba
    // lagi.". Fixture test lokal sebelumnya (lib/reconciliation-omzet-period-lock.test.ts)
    // tidak menangkap ini karena fake findOneAndUpdate di sana menerapkan
    // $setOnInsert/$inc/$push secara independen tanpa validasi konflik path
    // ala MongoDB asli. Perbaikan: $inc pada field yang belum ada otomatis
    // menginisialisasi field itu dari nilai increment-nya (0+1=1), dan $push
    // pada field array yang belum ada otomatis membuat array baru berisi
    // elemen yang di-push — jadi `version: 0` dan `history: []` di
    // $setOnInsert tidak diperlukan sama sekali dan harus dihapus.
    { $set: { storeId: input.storeId, year, month, periodKey: input.period, status: current?.status ?? "draft", attachment: input.attachment, updatedAt: now }, $setOnInsert: { originalAyoAmount: null, originalOlseraAmount: null, originalDifference: null, finalAgreedAmount: null, adjustmentAmount: null, adjustmentReason: null, lockedAt: null, lockedBy: null, unlockedAt: null, unlockedBy: null, verifiedMatchStatus: null, beritaAcaraNominal: null, beritaAcaraDirection: null, createdAt: now }, $inc: { version: 1 }, $push: { history: { action, actor: input.actor, timestamp: now, reason: null, before, after: { fileName: input.attachment.fileName }, hiddenAt: null, hiddenBy: null } } },
    { upsert: !current, returnDocument: "after" },
  );
  if (!document) throw new OmzetPeriodLockError("Konflik upload; muat ulang lalu coba lagi.", "CONFLICT");
  return document;
}

export function previewOmzetPeriodLock(input: { original: OmzetOriginalAmounts; finalAgreedAmount: unknown; adjustmentReason: unknown; attachment: PeriodLockAttachment | null; beritaAcaraNominal?: unknown; beritaAcaraDirection?: unknown; beritaAcaraPeriod?: unknown; expectedPeriod?: string }) {
  const finalAgreedAmount = integer(input.finalAgreedAmount, "Nominal final");
  const adjustmentReason = text(input.adjustmentReason, "Alasan penyesuaian");
  if (!input.attachment && input.original.difference !== 0) throw new OmzetPeriodLockError("Berita acara wajib diunggah untuk menjelaskan selisih.", "NOT_FOUND");
  const beritaAcaraNominal = optionalPositiveInteger(input.beritaAcaraNominal);
  const beritaAcaraDirection = optionalBeritaAcaraDirection(input.beritaAcaraDirection);
  // V10: verifikasi SERVER-SIDE (bukan klaim client) — matchBeritaAcaraToSystemDifference
  // dijalankan terhadap input.original.difference, yaitu selisih sistem yang
  // SERVER sendiri hitung (loadOmzetLedgerMonthDetail di route), BUKAN
  // nilai yang dikirim client. Supervisor tetap bisa mengklaim
  // nominal/arah apa pun, tapi status "Cocok karena Berita Acara" di tabel
  // utama hanya benar-benar valid kalau klaim itu memang cocok dengan
  // selisih sistem sungguhan — mencegah status Cocok dipalsukan.
  const beritaAcaraPeriod = typeof input.beritaAcaraPeriod === "string" && /^\d{4}-\d{2}$/.test(input.beritaAcaraPeriod) ? input.beritaAcaraPeriod : null;
  const verifiedMatchStatus: BeritaAcaraMatchStatus = matchBeritaAcaraToSystemDifference(input.original.difference, { nominal: beritaAcaraNominal, direction: beritaAcaraDirection, period: beritaAcaraPeriod }, input.expectedPeriod);
  return { ...input.original, finalAgreedAmount, adjustmentAmount: finalAgreedAmount - input.original.olsera, adjustmentReason, attachment: input.attachment, beritaAcaraNominal, beritaAcaraDirection, beritaAcaraPeriod, verifiedMatchStatus, lockedDisplay: { ayo: finalAgreedAmount, olsera: finalAgreedAmount, difference: 0, status: "COCOK_TERKUNCI" as const } };
}

/** Records a non-locking preview in the append-only audit trail. */
export async function recordOmzetPeriodLockPreview(input: { storeId: number; period: string; actor: string; expectedVersion: unknown; original: OmzetOriginalAmounts; finalAgreedAmount: unknown; adjustmentReason: unknown; beritaAcaraNominal?: unknown; beritaAcaraDirection?: unknown; beritaAcaraPeriod?: unknown }, context?: OmzetPeriodLockContext) {
  const source = await contextOrDefault(context);
  const expectedVersion = integer(input.expectedVersion, "Versi");
  const id = `${input.storeId}:${input.period}`;
  const current = await source.locks.findOne({ _id: id });
  const preview = previewOmzetPeriodLock({ ...input, expectedPeriod: input.beritaAcaraPeriod !== undefined ? input.period : undefined, beritaAcaraPeriod: input.beritaAcaraPeriod ?? current?.beritaAcaraPeriod, attachment: current?.attachment ?? null });
  if (!current) {
    if (expectedVersion !== 0 || !isWithinReconciliationTolerance(input.original.difference)) throw new OmzetPeriodLockError("Berita acara wajib diunggah sebelum preview.", "NOT_FOUND");
    const now = new Date();
    const initial = await source.locks.findOneAndUpdate(
      { _id: id, version: { $exists: false } },
      { $set: { storeId: input.storeId, year: periodParts(input.period).year, month: periodParts(input.period).month, periodKey: input.period, status: "draft", attachment: null, originalAyoAmount: input.original.ayo, originalOlseraAmount: input.original.olsera, originalDifference: input.original.difference, finalAgreedAmount: preview.finalAgreedAmount, adjustmentAmount: preview.adjustmentAmount, adjustmentReason: preview.adjustmentReason, verifiedMatchStatus: "COCOK", beritaAcaraNominal: null, beritaAcaraDirection: null, beritaAcaraPeriod: null, lockedAt: null, lockedBy: null, unlockedAt: null, unlockedBy: null, updatedAt: now }, $setOnInsert: { createdAt: now, version: 1, history: [{ action: "preview", actor: input.actor, timestamp: now, reason: preview.adjustmentReason, before: {}, after: { finalAgreedAmount: preview.finalAgreedAmount, adjustmentAmount: preview.adjustmentAmount }, hiddenAt: null, hiddenBy: null }] } },
      { upsert: true, returnDocument: "after" },
    );
    if (!initial) throw new OmzetPeriodLockError("Konflik preview; muat ulang lalu coba lagi.", "CONFLICT");
    return { preview, lock: initial };
  }
  if (current.status === "locked") throw new OmzetPeriodLockError("Periode sudah terkunci.", "LOCKED");
  const now = new Date();
  const document = await source.locks.findOneAndUpdate(
    { _id: id, version: expectedVersion, status: { $in: ["draft", "unlocked"] } },
    {
      // V10: "Simpan" adalah SATU-SATUNYA tempat verifiedMatchStatus/
      // beritaAcaraNominal/beritaAcaraDirection ditulis — supaya status
      // "Cocok karena Berita Acara" di tabel utama (lihat
      // applyLockedOmzetPresentation) selalu mencerminkan Simpan TERAKHIR,
      // bukan analisis OCR client yang belum pernah disimpan.
      //
      // V12 FIX (masalah #2/#3/#4 V12 — "Alasan penyesuaian bisa kosong"
      // setelah reopen): SEBELUMNYA finalAgreedAmount/adjustmentAmount/
      // adjustmentReason/original* HANYA ditulis di lockOmzetPeriodFinalization
      // (saat Kunci Periode) — periode yang SUDAH Simpan tapi BELUM dikunci
      // punya field-field ini tetap null di top-level dokumen, jadi
      // restoreBeritaAcaraAnalysisFromLock (V11, lib/reconciliation-berita-acara-ui.ts)
      // yang membaca `lock.adjustmentReason` ikut merestore null walau
      // sudah pernah Simpan. Sekarang "Simpan" JUGA menulis field-field ini
      // ke top-level dokumen (persis field yang sama yang ditulis lock),
      // supaya reopen SEBELUM lock pun tetap bisa hydrate nominal
      // final/alasan terakhir dari database, bukan hanya OCR/state lokal.
      $set: {
        updatedAt: now,
        verifiedMatchStatus: preview.verifiedMatchStatus,
        beritaAcaraNominal: preview.beritaAcaraNominal,
        beritaAcaraDirection: preview.beritaAcaraDirection,
        beritaAcaraPeriod: preview.beritaAcaraPeriod,
        originalAyoAmount: input.original.ayo,
        originalOlseraAmount: input.original.olsera,
        originalDifference: input.original.difference,
        finalAgreedAmount: preview.finalAgreedAmount,
        adjustmentAmount: preview.adjustmentAmount,
        adjustmentReason: preview.adjustmentReason,
      },
      $inc: { version: 1 },
      $push: { history: { action: "preview", actor: input.actor, timestamp: now, reason: preview.adjustmentReason, before: snapshot(current), after: { finalAgreedAmount: preview.finalAgreedAmount, adjustmentAmount: preview.adjustmentAmount }, hiddenAt: null, hiddenBy: null } },
    },
    { returnDocument: "after" },
  );
  if (!document) throw new OmzetPeriodLockError("Konflik preview; muat ulang lalu coba lagi.", "CONFLICT");
  return { preview, lock: document };
}

export async function lockOmzetPeriodFinalization(input: { storeId: number; period: string; actor: string; expectedVersion: unknown; original: OmzetOriginalAmounts; finalAgreedAmount: unknown; adjustmentReason: unknown }, context?: OmzetPeriodLockContext) {
  const source = await contextOrDefault(context); const current = await source.locks.findOne({ _id: `${input.storeId}:${input.period}` }); const expectedVersion = input.expectedVersion === undefined || input.expectedVersion === null ? 0 : integer(input.expectedVersion, "Versi"); const id = `${input.storeId}:${input.period}`;
  if (!current && expectedVersion === 0 && isWithinReconciliationTolerance(input.original.difference)) {
    const { year, month } = periodParts(input.period); const now = new Date(); const finalAgreedAmount = input.original.olsera; const reason = typeof input.adjustmentReason === "string" && input.adjustmentReason.trim() ? input.adjustmentReason.trim() : "Rekonsiliasi Cocok; tidak ada penyesuaian.";
    const document = await source.locks.findOneAndUpdate({ _id: id, version: { $exists: false } }, { $set: { storeId: input.storeId, year, month, periodKey: input.period, status: "locked", originalAyoAmount: input.original.ayo, originalOlseraAmount: input.original.olsera, originalDifference: input.original.difference, finalAgreedAmount, adjustmentAmount: 0, adjustmentReason: reason, attachment: null, verifiedMatchStatus: "COCOK", beritaAcaraNominal: null, beritaAcaraDirection: null, lockedAt: now, lockedBy: input.actor, unlockedAt: null, unlockedBy: null, updatedAt: now }, $setOnInsert: { createdAt: now, version: 1, history: [{ action: "lock", actor: input.actor, timestamp: now, reason, before: {}, after: { original: input.original, finalAgreedAmount, adjustmentAmount: 0 }, hiddenAt: null, hiddenBy: null }] } }, { upsert: true, returnDocument: "after" });
    if (!document) throw new OmzetPeriodLockError("Konflik lock; muat ulang lalu coba lagi.", "CONFLICT");
    return document;
  }
  const preview = previewOmzetPeriodLock({ ...input, expectedPeriod: current?.beritaAcaraPeriod !== undefined ? input.period : undefined, beritaAcaraPeriod: current?.beritaAcaraPeriod, attachment: current?.attachment ?? null }); const now = new Date();
  if (input.original.difference !== 0 && !current?.attachment) throw new OmzetPeriodLockError("Berita acara wajib diunggah untuk menjelaskan selisih.", "NOT_FOUND");
  if (!current) throw new OmzetPeriodLockError("Simpan finalisasi terlebih dahulu sebelum lock.");
  if (preview.verifiedMatchStatus !== "COCOK" && current.verifiedMatchStatus !== "COCOK" && !isWithinReconciliationTolerance(input.original.difference)) throw new OmzetPeriodLockError("Kunci hanya diizinkan saat status rekonsiliasi Cocok.");
  if (current.status === "locked") throw new OmzetPeriodLockError("Periode sudah terkunci.", "LOCKED");
  const lastAudit = current.history.at(-1);
  if (lastAudit?.action !== "preview" || lastAudit.reason !== preview.adjustmentReason || lastAudit.after.finalAgreedAmount !== preview.finalAgreedAmount) throw new OmzetPeriodLockError("Buat preview finalisasi terbaru sebelum lock.");
  const action = current.status === "unlocked" ? "relock" : "lock";
  const document = await source.locks.findOneAndUpdate({ _id: id, version: expectedVersion, status: { $in: ["draft", "unlocked"] } }, { $set: { status: "locked", originalAyoAmount: input.original.ayo, originalOlseraAmount: input.original.olsera, originalDifference: input.original.difference, finalAgreedAmount: preview.finalAgreedAmount, adjustmentAmount: preview.adjustmentAmount, adjustmentReason: preview.adjustmentReason, lockedAt: now, lockedBy: input.actor, unlockedAt: null, unlockedBy: null, updatedAt: now }, $inc: { version: 1 }, $push: { history: { action, actor: input.actor, timestamp: now, reason: preview.adjustmentReason, before: snapshot(current), after: { original: input.original, finalAgreedAmount: preview.finalAgreedAmount, adjustmentAmount: preview.adjustmentAmount }, hiddenAt: null, hiddenBy: null } } }, { returnDocument: "after" });
  if (!document) throw new OmzetPeriodLockError("Konflik lock; data sudah berubah atau terkunci supervisor lain.", "CONFLICT");
  return document;
}

export async function unlockOmzetPeriodFinalization(input: { storeId: number; period: string; actor: string; expectedVersion: unknown; reason: unknown }, context?: OmzetPeriodLockContext) {
  const source = await contextOrDefault(context); const expectedVersion = integer(input.expectedVersion, "Versi"); const reason = text(input.reason, "Alasan buka kunci"); const now = new Date(); const id = `${input.storeId}:${input.period}`; const current = await source.locks.findOne({ _id: id });
  const document = await source.locks.findOneAndUpdate({ _id: id, version: expectedVersion, status: "locked" }, { $set: { status: "unlocked", unlockedAt: now, unlockedBy: input.actor, updatedAt: now }, $inc: { version: 1 }, $push: { history: { action: "unlock", actor: input.actor, timestamp: now, reason, before: snapshot(current), after: { status: "unlocked" }, hiddenAt: null, hiddenBy: null } } }, { returnDocument: "after" });
  if (!document) throw new OmzetPeriodLockError("Konflik buka kunci; muat ulang lalu coba lagi.", "CONFLICT");
  return document;
}

/** true bila Berita Acara SUDAH tervalidasi server (Simpan terakhir COCOK) TAPI periode belum dikunci — status Cocok, TANPA collapse ke Rp0 (beda dari locked). */
export function isBeritaAcaraVerifiedUnlocked(lock: ReconciliationOmzetPeriodLockDocument | null, currentDifference?: number, expectedPeriod?: string): boolean {
  if (!lock || lock.status === "locked") return false;
  if (lock.beritaAcaraNominal !== null && currentDifference !== undefined) {
    return matchBeritaAcaraToSystemDifference(currentDifference, { nominal: lock.beritaAcaraNominal, direction: lock.beritaAcaraDirection, period: lock.beritaAcaraPeriod }, expectedPeriod) === "COCOK";
  }
  return lock.verifiedMatchStatus === "COCOK";
}

export function applyLockedOmzetPresentation<T extends { ayo: { count: number; revenue: number }; olseraTotal: number; differenceRevenue: number; status: string; statusReason: string }>(result: T, lock: ReconciliationOmzetPeriodLockDocument | null) {
  if (lock?.status === "locked" && lock.finalAgreedAmount !== null) {
    return { ...result, ayo: { ...result.ayo, revenue: lock.finalAgreedAmount }, olseraTotal: lock.finalAgreedAmount, differenceRevenue: 0, status: "COCOK", statusReason: "Cocok — Terkunci berdasarkan berita acara rekonsiliasi.", periodLock: lock, beritaAcaraVerified: true };
  }
  // V10: Simpan (recordOmzetPeriodLockPreview) sudah menghasilkan pencocokan
  // COCOK server-verified, TAPI periode BELUM dikunci — status tabel utama
  // sudah boleh "Cocok" TANPA menunggu Kunci Periode, tapi selisih ASLI
  // TETAP ditampilkan apa adanya (TIDAK di-collapse ke Rp0 seperti cabang
  // locked di atas) — transparansi, sesuai instruksi V10: "Selisih asli
  // JANGAN diubah menjadi Rp0". Beda mendasar dari cabang locked: locked =
  // finalisasi penuh (collapse sengaja), ini = konfirmasi awal (angka tetap
  // apa adanya).
  if (isBeritaAcaraVerifiedUnlocked(lock, result.differenceRevenue)) {
    return { ...result, status: "COCOK", statusReason: `Selisih ${formatRupiah(result.differenceRevenue)} telah diverifikasi dengan Berita Acara.`, periodLock: lock, beritaAcaraVerified: true };
  }
  return { ...result, periodLock: lock, beritaAcaraVerified: false };
}

// ---------------------------------------------------------------------------
// V10: "Bersihkan Riwayat Upload" — supervisor boleh membersihkan entri
// `history` beraksi "upload" yang duplikat/gagal/percobaan lama, TANPA
// PERNAH menyentuh entri lain (preview/lock/relock/unlock — audit trail
// finalisasi WAJIB permanen) dan TANPA PERNAH menghapus entri upload yang
// menghasilkan attachment yang SEDANG AKTIF.
//
// Solusi PALING AMAN yang dipakai (bukan cocok-cocokan fileName/timestamp,
// yang bisa ambigu kalau nama file sama atau jam server berbeda beberapa
// ms antara `attachment.uploadedAt` yang di-set di route.ts dan `now` yang
// di-set di dalam uploadOmzetPeriodLockAttachment): SELALU pertahankan
// entri "upload" TERAKHIR (paling akhir) dalam array `history`, hapus semua
// entri "upload" SEBELUM itu. Ini benar SECARA STRUKTURAL — bukan heuristik
// — karena `history` di-$push secara berurutan (append-only, tidak pernah
// disisipkan di tengah) dan field `attachment` dokumen SELALU berasal dari
// upload PALING BARU (tidak mungkin ada upload yang terjadi "sesudah" upload
// terakhir tapi tidak tercatat sebagai entri upload terakhir), jadi entri
// upload terakhir di array PASTI entri yang menghasilkan attachment aktif
// saat ini — terlepas dari nama file/waktu.
// ---------------------------------------------------------------------------

/** Fungsi MURNI (bisa dites tanpa DB) — hapus semua entri "upload" KECUALI yang terakhir; entri lain (preview/lock/relock/unlock) TIDAK PERNAH disentuh, urutan sisanya TIDAK berubah. */
export function computeCleanedUploadHistory(history: ReconciliationOmzetPeriodLockDocument["history"]): ReconciliationOmzetPeriodLockDocument["history"] {
  const uploadIndices: number[] = [];
  history.forEach((entry, index) => {
    if (entry.action === "upload") uploadIndices.push(index);
  });
  if (uploadIndices.length <= 1) return history;
  const lastUploadIndex = uploadIndices[uploadIndices.length - 1];
  return history.filter((entry, index) => entry.action !== "upload" || index === lastUploadIndex);
}

/**
 * Bersihkan entri "upload" duplikat/lama dari riwayat SATU periode. Otorisasi
 * (supervisor-only) WAJIB diverifikasi di route.ts SEBELUM memanggil ini —
 * fungsi ini sendiri TIDAK memeriksa role, sama seperti seluruh fungsi lain
 * di modul ini (pola existing: auth selalu di layer route, bukan di lib).
 * TIDAK PERNAH menghapus seluruh dokumen/array history, TIDAK PERNAH
 * menyentuh attachment aktif — hanya memangkas entri "upload" lama lewat
 * computeCleanedUploadHistory (lihat komentar di atasnya untuk alasan
 * keamanannya).
 */
export async function cleanupOmzetPeriodUploadHistory(input: { storeId: number; period: string; actor: string; expectedVersion: unknown }, context?: OmzetPeriodLockContext) {
  const source = await contextOrDefault(context);
  const expectedVersion = integer(input.expectedVersion, "Versi");
  const id = `${input.storeId}:${input.period}`;
  const current = await source.locks.findOne({ _id: id });
  if (!current) throw new OmzetPeriodLockError("Periode tidak ditemukan.", "NOT_FOUND");
  const cleanedHistory = computeCleanedUploadHistory(current.history);
  const removedCount = current.history.length - cleanedHistory.length;
  if (removedCount === 0) return { lock: current, removedCount: 0 };
  const now = new Date();
  const document = await source.locks.findOneAndUpdate(
    { _id: id, version: expectedVersion },
    { $set: { history: cleanedHistory, updatedAt: now }, $inc: { version: 1 } },
    { returnDocument: "after" },
  );
  if (!document) throw new OmzetPeriodLockError("Konflik pembersihan riwayat; muat ulang lalu coba lagi.", "CONFLICT");
  return { lock: document, removedCount };
}

// ---------------------------------------------------------------------------
// V11: "×" per-item pada Riwayat Aktivitas — supervisor boleh menyembunyikan
// SATU entri riwayat apa pun (upload/preview/lock/relock/unlock) dari
// tampilan tanpa PERNAH menghapusnya secara fisik. Beda dari
// cleanupOmzetPeriodUploadHistory (V10, HARD remove entri "upload" lama
// duplikat) — ini SOFT DELETE: entri tetap ada di `history` apa adanya
// (action/actor/timestamp/reason/before/after utuh), hanya menambahkan
// hiddenAt/hiddenBy. UI normal (lib/reconciliation-berita-acara-ui.ts:
// isHistoryEntryVisible) menyaring entri ber-hiddenAt keluar dari render,
// tapi datanya tetap bisa dipertanggungjawabkan lewat DB/API mentah.
// ---------------------------------------------------------------------------

/** Fungsi MURNI — set hiddenAt/hiddenBy pada SATU entri di index tertentu; entri lain (termasuk urutan) sama sekali tidak disentuh. */
export function computeHiddenHistory(
  history: ReconciliationOmzetPeriodLockDocument["history"],
  entryIndex: number,
  actor: string,
  now: Date,
): ReconciliationOmzetPeriodLockDocument["history"] {
  return history.map((entry, index) => (index === entryIndex ? { ...entry, hiddenAt: now, hiddenBy: actor } : entry));
}

/**
 * Sembunyikan SATU entri riwayat (index dalam array `history` mentah, SAMA
 * seperti urutan tersimpan — bukan index tampilan yang sudah difilter/
 * dibalik di UI, lihat page.tsx). Otorisasi (supervisor-only) WAJIB
 * diverifikasi di route.ts SEBELUM memanggil ini — pola sama seperti
 * cleanupOmzetPeriodUploadHistory di atas, fungsi ini sendiri tidak
 * memeriksa role.
 */
export async function hideOmzetPeriodHistoryEntry(input: { storeId: number; period: string; actor: string; expectedVersion: unknown; entryIndex: unknown }, context?: OmzetPeriodLockContext) {
  const source = await contextOrDefault(context);
  const expectedVersion = integer(input.expectedVersion, "Versi");
  if (typeof input.entryIndex !== "number" || !Number.isInteger(input.entryIndex) || input.entryIndex < 0) throw new OmzetPeriodLockError("Indeks entri riwayat tidak valid.");
  const id = `${input.storeId}:${input.period}`;
  const current = await source.locks.findOne({ _id: id });
  if (!current) throw new OmzetPeriodLockError("Periode tidak ditemukan.", "NOT_FOUND");
  if (input.entryIndex >= current.history.length) throw new OmzetPeriodLockError("Entri riwayat tidak ditemukan.", "NOT_FOUND");
  const now = new Date();
  const updatedHistory = computeHiddenHistory(current.history, input.entryIndex, input.actor, now);
  const document = await source.locks.findOneAndUpdate(
    { _id: id, version: expectedVersion },
    { $set: { history: updatedHistory, updatedAt: now }, $inc: { version: 1 } },
    { returnDocument: "after" },
  );
  if (!document) throw new OmzetPeriodLockError("Konflik menyembunyikan riwayat; muat ulang lalu coba lagi.", "CONFLICT");
  return document;
}

// ---------------------------------------------------------------------------
// V12: "Reset Finalisasi" — supervisor boleh mengosongkan SELURUH active
// finalization state (attachment/verifiedMatchStatus/beritaAcaraNominal/
// beritaAcaraDirection/finalAgreedAmount/adjustmentAmount/adjustmentReason/
// original*) kembali ke "belum difinalisasi" (status "draft"), untuk
// memulai ulang siklus Upload -> OCR -> Simpan dari nol (mis. setelah data
// Berita Acara/nominal yang tersimpan ternyata salah). TIDAK PERNAH
// menyentuh data sumber AYO/Olsera/ledger (fungsi ini hanya menulis field
// di dokumen ReconciliationOmzetPeriodLockDocument, sama sekali tidak
// membaca/menulis collection lain).
//
// Periode yang SEDANG locked TIDAK BOLEH langsung di-reset — harus dibuka
// kunci (unlock) dulu secara eksplisit (alasan wajib diisi, lihat
// unlockOmzetPeriodFinalization) supaya jejak "kenapa periode yang sudah
// terkunci dibongkar" tetap tercatat lewat mekanisme yang sudah ada,
// bukan langsung dilewati oleh reset.
// ---------------------------------------------------------------------------

/**
 * Fungsi MURNI — soft-hide SEMUA entri history yang masih terlihat (entri
 * yang sudah hiddenAt sebelumnya dibiarkan apa adanya, tidak ditimpa ulang),
 * lalu tambahkan SATU entri baru beraksi "reset" yang TETAP terlihat. Hasil:
 * UI Riwayat Aktivitas jadi bersih (hanya menampilkan event reset terbaru)
 * TANPA menghapus satu pun entri lama secara fisik — desain ini SENGAJA
 * reuse mekanisme soft-delete hiddenAt/hiddenBy yang sama seperti V11
 * (computeHiddenHistory), bukan mekanisme baru, supaya audit safety-nya
 * konsisten dengan yang sudah ada.
 */
export function computeHistoryAfterReset(
  history: ReconciliationOmzetPeriodLockDocument["history"],
  actor: string,
  now: Date,
): ReconciliationOmzetPeriodLockDocument["history"] {
  const hiddenPrior = history.map((entry) => (entry.hiddenAt ? entry : { ...entry, hiddenAt: now, hiddenBy: actor }));
  const resetEntry: ReconciliationOmzetPeriodLockDocument["history"][number] = {
    action: "reset",
    actor,
    timestamp: now,
    reason: null,
    before: {},
    after: {},
    hiddenAt: null,
    hiddenBy: null,
  };
  return [...hiddenPrior, resetEntry];
}

/**
 * Kosongkan active finalization state SATU periode kembali ke "belum
 * difinalisasi". Otorisasi (supervisor-only) WAJIB diverifikasi di route.ts
 * SEBELUM memanggil ini — pola sama seperti seluruh fungsi lain di modul
 * ini (auth selalu di layer route, bukan di lib).
 */
export async function resetOmzetPeriodFinalization(input: { storeId: number; period: string; actor: string; expectedVersion: unknown }, context?: OmzetPeriodLockContext) {
  const source = await contextOrDefault(context);
  const expectedVersion = integer(input.expectedVersion, "Versi");
  const id = `${input.storeId}:${input.period}`;
  const current = await source.locks.findOne({ _id: id });
  if (!current) throw new OmzetPeriodLockError("Periode tidak ditemukan.", "NOT_FOUND");
  if (current.status === "locked") throw new OmzetPeriodLockError("Periode terkunci; buka kunci terlebih dahulu sebelum reset.", "LOCKED");
  const now = new Date();
  const updatedHistory = computeHistoryAfterReset(current.history, input.actor, now);
  const document = await source.locks.findOneAndUpdate(
    { _id: id, version: expectedVersion, status: { $ne: "locked" } },
    {
      $set: {
        status: "draft",
        attachment: null,
        verifiedMatchStatus: null,
        beritaAcaraNominal: null,
        beritaAcaraDirection: null,
        finalAgreedAmount: null,
        adjustmentAmount: null,
        adjustmentReason: null,
        originalAyoAmount: null,
        originalOlseraAmount: null,
        originalDifference: null,
        history: updatedHistory,
        updatedAt: now,
      },
      $inc: { version: 1 },
    },
    { returnDocument: "after" },
  );
  if (!document) throw new OmzetPeriodLockError("Konflik reset finalisasi; muat ulang lalu coba lagi.", "CONFLICT");
  return document;
}
