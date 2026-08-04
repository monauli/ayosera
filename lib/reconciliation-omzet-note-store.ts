// Fitur Lock+Berita Acara Rekonsiliasi Omzet AYOSERA — jalur tulis skema
// APPEND-ONLY `OlseraOmzetReconciliationNoteV2Document` (lib/mongodb.ts).
// Pola diadaptasi PERSIS dari lib/reconciliation-manual-resolution.ts
// (createManualResolution): setiap submit/revisi adalah dokumen baru,
// dokumen lama ditandai "superseded", tidak pernah dihapus/ditimpa.
//
// LANGKAH 1 (skema+store saja) — lihat "Desain Skema Lock+Berita Acara" dan
// "Implementasi Skema Lock+Berita Acara (Langkah 1)" di tmp/ai-handoff.md.
// File ini SENGAJA TIDAK memanggil computeOmzetOlseraLedger/classifyStatus
// (lib/reconciliation-omzet-ledger.ts) — caller WAJIB menghitung
// differenceRevenue lebih dulu dan mengopernya sebagai parameter
// (`currentDifferenceRevenue`), supaya tidak ada dependency siklik antara
// engine ledger dan store ini. Belum ada endpoint API yang memanggil fungsi
// di file ini.
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  OMZET_EVIDENCE_TYPES,
  OMZET_LOCK_WITHOUT_EXPLANATION_MARKER,
  type OmzetEvidenceType,
} from "./reconciliation-omzet-ledger.ts";
import type {
  OlseraOmzetReconciliationAuditAction,
  OlseraOmzetReconciliationAuditLogDocument,
  OlseraOmzetReconciliationNoteV2Document,
} from "./mongodb.ts";

const PERIOD = /^\d{4}-\d{2}$/;
const MAX_DESCRIPTION = 2_000;
const MAX_ATTACHMENT_FIELD = 1_000;
const MAX_RETRIES = 3;

export class OmzetNoteError extends Error {
  constructor(
    message: string,
    public readonly code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "INVALID_TRANSITION" = "VALIDATION",
  ) {
    super(message);
    this.name = "OmzetNoteError";
  }
}

type Cursor<T> = { sort(spec: Record<string, 1 | -1>): Cursor<T>; toArray(): Promise<T[]> };
type NoteCollection = {
  find(filter: Record<string, unknown>): Cursor<OlseraOmzetReconciliationNoteV2Document>;
  findOne(filter: Record<string, unknown>): Promise<OlseraOmzetReconciliationNoteV2Document | null>;
  insertOne(document: OlseraOmzetReconciliationNoteV2Document): Promise<unknown>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ matchedCount?: number } | unknown>;
};
type AuditCollection = { insertOne(document: OlseraOmzetReconciliationAuditLogDocument): Promise<unknown> };
export type OmzetNoteContext = { notes: NoteCollection; auditLog: AuditCollection };

async function resolveContext(context?: OmzetNoteContext): Promise<OmzetNoteContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { olseraOmzetReconciliationNotes, olseraOmzetReconciliationAuditLog } = await collections();
  return {
    notes: olseraOmzetReconciliationNotes as unknown as NoteCollection,
    auditLog: olseraOmzetReconciliationAuditLog as unknown as AuditCollection,
  };
}

// ---------------------------------------------------------------------------
// Validasi
// ---------------------------------------------------------------------------
function string(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new OmzetNoteError(`${field} wajib diisi dan valid.`);
  return value.trim();
}
function storeId(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new OmzetNoteError("storeId tidak valid.");
  return value as number;
}
function period(value: unknown): string {
  if (typeof value !== "string" || !PERIOD.test(value)) throw new OmzetNoteError("period tidak valid (format YYYY-MM).");
  return value;
}
function evidenceType(value: unknown): OmzetEvidenceType {
  if (typeof value !== "string" || !(OMZET_EVIDENCE_TYPES as readonly string[]).includes(value)) throw new OmzetNoteError("evidenceType tidak valid.");
  return value as OmzetEvidenceType;
}
function amount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new OmzetNoteError(`${field} tidak valid.`);
  return value;
}
function nullableString(value: unknown, field: string, max = MAX_ATTACHMENT_FIELD): string | null {
  if (value === undefined || value === null) return null;
  return string(value, field, max);
}
function isDuplicateKey(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === 11000;
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// ---------------------------------------------------------------------------
// _id deterministik — lihat "Desain Skema Lock+Berita Acara" section 1.
// ---------------------------------------------------------------------------
export function generateNoteId(input: { storeId: number; period: string; actor: string; idempotencyKey: string }): string {
  return `note:v1:${fingerprint({ storeId: input.storeId, period: input.period, actor: input.actor, idempotencyKey: input.idempotencyKey }).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Audit log — insertOne saja, tidak pernah diubah/dihapus.
// ---------------------------------------------------------------------------
export async function writeOmzetAuditLog(
  input: {
    storeId: number;
    period: string;
    action: OlseraOmzetReconciliationAuditAction;
    actor: string;
    noteId: string;
    previousNoteId: string | null;
    detail: { evidenceType?: OmzetEvidenceType | typeof OMZET_LOCK_WITHOUT_EXPLANATION_MARKER; explainedAmount?: number; hasAttachment?: boolean };
  },
  suppliedContext?: OmzetNoteContext,
): Promise<void> {
  const context = await resolveContext(suppliedContext);
  const auditId = `omzet-audit:v1:${randomUUID()}`;
  await context.auditLog.insertOne({ _id: auditId, timestamp: new Date(), ...input });
}

// ---------------------------------------------------------------------------
// Baca
// ---------------------------------------------------------------------------
export async function getCurrentOmzetNote(
  storeIdInput: number,
  periodInput: string,
  suppliedContext?: OmzetNoteContext,
): Promise<OlseraOmzetReconciliationNoteV2Document | null> {
  const context = await resolveContext(suppliedContext);
  return context.notes.findOne({ storeId: storeId(storeIdInput), period: period(periodInput), isCurrent: true });
}

export async function getOmzetNoteHistory(
  storeIdInput: number,
  periodInput: string,
  suppliedContext?: OmzetNoteContext,
): Promise<OlseraOmzetReconciliationNoteV2Document[]> {
  const context = await resolveContext(suppliedContext);
  return context.notes.find({ storeId: storeId(storeIdInput), period: period(periodInput) }).sort({ createdAt: -1 }).toArray();
}

// ---------------------------------------------------------------------------
// Submit penjelasan baru (pertama kali maupun revisi) — alur 3a.
// ---------------------------------------------------------------------------
export type SubmitOmzetExplanationInput = {
  storeId: number;
  period: string;
  evidenceType: OmzetEvidenceType;
  description: string;
  explainedAmount: number;
  /** differenceRevenue SAAT INI, dihitung caller lewat computeOmzetOlseraLedger — WAJIB sama persis dengan explainedAmount. */
  currentDifferenceRevenue: number;
  actor: string;
  idempotencyKey: string;
  attachmentUrl?: string | null;
  attachmentFileName?: string | null;
};
export type SubmitOmzetExplanationResult = { note: OlseraOmzetReconciliationNoteV2Document; idempotent: boolean };

export async function submitOmzetExplanation(
  input: SubmitOmzetExplanationInput,
  suppliedContext?: OmzetNoteContext,
): Promise<SubmitOmzetExplanationResult> {
  const context = await resolveContext(suppliedContext);
  const sId = storeId(input.storeId);
  const p = period(input.period);
  const chosenEvidenceType = evidenceType(input.evidenceType);
  const chosenDescription = string(input.description, "description", MAX_DESCRIPTION);
  const chosenExplainedAmount = amount(input.explainedAmount, "explainedAmount");
  const currentDifferenceRevenue = amount(input.currentDifferenceRevenue, "currentDifferenceRevenue");
  const actor = string(input.actor, "actor");
  const idempotencyKey = string(input.idempotencyKey, "idempotencyKey", 200);
  const attachmentUrl = nullableString(input.attachmentUrl, "attachmentUrl");
  const attachmentFileName = nullableString(input.attachmentFileName, "attachmentFileName");

  if (chosenExplainedAmount !== currentDifferenceRevenue) {
    throw new OmzetNoteError("explainedAmount harus sama persis dengan selisih (differenceRevenue) saat ini.", "VALIDATION");
  }

  const id = generateNoteId({ storeId: sId, period: p, actor, idempotencyKey });

  // Idempotensi: request dengan Idempotency-Key sama HARUS dianggap request
  // yang sama (bukan revisi baru) — bandingkan langsung isi dokumen (bukan
  // fingerprint terpisah, skema note tidak punya field metadata untuk itu).
  const existingSameId = await context.notes.findOne({ _id: id });
  if (existingSameId) {
    const sameContent =
      existingSameId.evidenceType === chosenEvidenceType &&
      existingSameId.description === chosenDescription &&
      existingSameId.explainedAmount === chosenExplainedAmount &&
      (existingSameId.attachmentUrl ?? null) === attachmentUrl &&
      (existingSameId.attachmentFileName ?? null) === attachmentFileName;
    if (!sameContent) throw new OmzetNoteError("Idempotency-Key sudah dipakai untuk request lain.", "CONFLICT");
    return { note: existingSameId, idempotent: true };
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await context.notes.findOne({ storeId: sId, period: p, isCurrent: true });
    if (current?.locked) {
      throw new OmzetNoteError("Periode ini sudah dikunci — tidak bisa mengirim penjelasan baru.", "INVALID_TRANSITION");
    }
    const now = new Date();
    const document: OlseraOmzetReconciliationNoteV2Document = {
      _id: id,
      storeId: sId,
      period: p,
      evidenceType: chosenEvidenceType,
      description: chosenDescription,
      explainedAmount: chosenExplainedAmount,
      attachmentUrl,
      attachmentFileName,
      isCurrent: true,
      supersededBy: null,
      supersededAt: null,
      previousNoteId: current?._id ?? null,
      locked: false,
      lockedBy: null,
      lockedAt: null,
      createdBy: actor,
      createdAt: now,
      updatedBy: actor,
      updatedAt: now,
    };

    if (current) {
      const result = await context.notes.updateOne(
        { _id: current._id, isCurrent: true },
        { $set: { isCurrent: false, supersededAt: now, supersededBy: id } },
      );
      if (typeof result === "object" && result && "matchedCount" in result && result.matchedCount === 0) continue;
    }

    try {
      await context.notes.insertOne(document);
    } catch (error) {
      if (isDuplicateKey(error)) {
        const already = await context.notes.findOne({ _id: id });
        if (already) return { note: already, idempotent: true };
        continue;
      }
      throw error;
    }

    await writeOmzetAuditLog(
      {
        storeId: sId,
        period: p,
        action: "SUBMIT_EXPLANATION",
        actor,
        noteId: id,
        previousNoteId: null,
        detail: { evidenceType: chosenEvidenceType, explainedAmount: chosenExplainedAmount, hasAttachment: attachmentUrl !== null },
      },
      context,
    );
    if (current) {
      await writeOmzetAuditLog(
        {
          storeId: sId,
          period: p,
          action: "SUPERSEDE_EXPLANATION",
          actor,
          noteId: id,
          previousNoteId: current._id,
          detail: { evidenceType: chosenEvidenceType, explainedAmount: chosenExplainedAmount, hasAttachment: attachmentUrl !== null },
        },
        context,
      );
    }
    return { note: document, idempotent: false };
  }
  throw new OmzetNoteError("Konflik update penjelasan; silakan coba lagi.", "CONFLICT");
}

// ---------------------------------------------------------------------------
// Lock — alur 3b. TIDAK ADA alur Unlock dalam desain ini (ditunda untuk
// sistem role developer di masa depan).
// ---------------------------------------------------------------------------
export type LockOmzetPeriodInput = {
  storeId: number;
  period: string;
  actor: string;
  /** differenceRevenue SAAT INI, dihitung caller — WAJIB masih sama dengan explainedAmount dokumen current sebelum boleh dikunci. */
  currentDifferenceRevenue: number;
};
export type LockOmzetPeriodResult = { note: OlseraOmzetReconciliationNoteV2Document };

export async function lockOmzetPeriod(input: LockOmzetPeriodInput, suppliedContext?: OmzetNoteContext): Promise<LockOmzetPeriodResult> {
  const context = await resolveContext(suppliedContext);
  const sId = storeId(input.storeId);
  const p = period(input.period);
  const actor = string(input.actor, "actor");
  const currentDifferenceRevenue = amount(input.currentDifferenceRevenue, "currentDifferenceRevenue");

  const current = await context.notes.findOne({ storeId: sId, period: p, isCurrent: true });
  if (!current) {
    // Tidak ada penjelasan aktif — TETAP boleh dikunci HANYA bila memang
    // sudah Cocok (selisih Rp0) SEKARANG: tidak ada apa pun untuk dijelaskan,
    // jadi mewajibkan penjelasan manual lebih dulu (seperti kasus Selisih
    // Terjelaskan) tidak masuk akal. Kalau selisih bukan 0, pesan/kode error
    // TETAP sama seperti sebelumnya (tidak ada regresi untuk kasus lama).
    if (currentDifferenceRevenue !== 0) {
      throw new OmzetNoteError("Belum ada penjelasan untuk periode ini — kirim penjelasan dulu sebelum mengunci.", "NOT_FOUND");
    }
    return lockCocokWithoutExplanation({ sId, p, actor }, context);
  }
  if (current.locked) {
    throw new OmzetNoteError("Periode ini sudah dikunci.", "INVALID_TRANSITION");
  }
  if (current.explainedAmount !== currentDifferenceRevenue) {
    throw new OmzetNoteError("Nominal penjelasan tidak sesuai dengan selisih saat ini; perbarui penjelasan dulu sebelum mengunci.", "VALIDATION");
  }

  const now = new Date();
  const result = await context.notes.updateOne(
    { _id: current._id, isCurrent: true, locked: false },
    { $set: { locked: true, lockedBy: actor, lockedAt: now, updatedBy: actor, updatedAt: now } },
  );
  // Tidak ada retry (beda dari submit) — Lock harus jadi tindakan tunggal
  // yang jelas siapa pelakunya di audit log, bukan di-"menang"-kan otomatis.
  if (typeof result === "object" && result && "matchedCount" in result && result.matchedCount === 0) {
    throw new OmzetNoteError("Konflik saat mengunci periode ini; silakan coba lagi.", "CONFLICT");
  }

  const locked: OlseraOmzetReconciliationNoteV2Document = {
    ...current,
    locked: true,
    lockedBy: actor,
    lockedAt: now,
    updatedBy: actor,
    updatedAt: now,
  };
  await writeOmzetAuditLog(
    {
      storeId: sId,
      period: p,
      action: "LOCK",
      actor,
      noteId: current._id,
      previousNoteId: null,
      detail: { evidenceType: current.evidenceType, explainedAmount: current.explainedAmount },
    },
    context,
  );
  return { note: locked };
}

/**
 * Kunci periode yang SUDAH Cocok (selisih Rp0) TANPA note aktif sama sekali
 * — insert LANGSUNG dokumen isCurrent:true+locked:true, memakai
 * OMZET_LOCK_WITHOUT_EXPLANATION_MARKER sebagai evidenceType (bukan salah
 * satu OMZET_EVIDENCE_TYPES sungguhan) supaya classifyStatus bisa membekukan
 * status COCOK secara jujur (bukan SELISIH_TERJELASKAN, karena memang tidak
 * ada selisih/penjelasan). `_id` memakai randomUUID (bukan generateNoteId
 * berbasis idempotencyKey) — konsisten dengan lockOmzetPeriod di atas: Lock
 * SENGAJA tidak idempotent/retry, harus jadi tindakan tunggal yang jelas
 * pelakunya di audit log.
 */
async function lockCocokWithoutExplanation(
  input: { sId: number; p: string; actor: string },
  context: OmzetNoteContext,
): Promise<LockOmzetPeriodResult> {
  const now = new Date();
  const id = `note:v1:lock:${randomUUID()}`;
  const document: OlseraOmzetReconciliationNoteV2Document = {
    _id: id,
    storeId: input.sId,
    period: input.p,
    evidenceType: OMZET_LOCK_WITHOUT_EXPLANATION_MARKER,
    description: "Dikunci langsung dari status Cocok (selisih Rp0) — tidak ada penjelasan manual.",
    explainedAmount: 0,
    attachmentUrl: null,
    attachmentFileName: null,
    isCurrent: true,
    supersededBy: null,
    supersededAt: null,
    previousNoteId: null,
    locked: true,
    lockedBy: input.actor,
    lockedAt: now,
    createdBy: input.actor,
    createdAt: now,
    updatedBy: input.actor,
    updatedAt: now,
  };

  try {
    await context.notes.insertOne(document);
  } catch (error) {
    // Race: request lain berhasil membuat isCurrent:true lebih dulu (index
    // unik partial {storeId,period,isCurrent:true}) — TIDAK retry, sama
    // seperti lockOmzetPeriod (Lock harus tindakan tunggal yang jelas).
    if (isDuplicateKey(error)) {
      throw new OmzetNoteError("Konflik saat mengunci periode ini; silakan coba lagi.", "CONFLICT");
    }
    throw error;
  }

  await writeOmzetAuditLog(
    {
      storeId: input.sId,
      period: input.p,
      action: "LOCK",
      actor: input.actor,
      noteId: id,
      previousNoteId: null,
      detail: { evidenceType: OMZET_LOCK_WITHOUT_EXPLANATION_MARKER, explainedAmount: 0 },
    },
    context,
  );
  return { note: document };
}
