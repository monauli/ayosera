// Penyimpanan bukti jurnal nyata ("Selisih Terjelaskan") untuk Rekonsiliasi
// Omzet AYOSERA — SATU dokumen per periode, TIDAK PERNAH dibuat/ditimpa
// otomatis oleh engine (lib/reconciliation-omzet-ledger.ts HANYA membaca
// catatan ini, tidak pernah menulis). Menulis WAJIB lewat saveOmzetExplanation
// (dipanggil dari route yang mewajibkan otorisasi modul "rekonsiliasi").
import "server-only";
import { OMZET_EVIDENCE_TYPES, type OmzetEvidenceType, type OmzetExplanation } from "./reconciliation-omzet-ledger.ts";

function storeId(): number {
  const value = Number(process.env.OLSERA_INTERNAL_STORE_ID);
  if (!Number.isInteger(value) || value <= 0) throw new Error("Konfigurasi store laporan keuangan tidak valid.");
  return value;
}

function noteId(period: string): string {
  return `${storeId()}:${period}`;
}

export function isOmzetEvidenceType(value: unknown): value is OmzetEvidenceType {
  return typeof value === "string" && (OMZET_EVIDENCE_TYPES as readonly string[]).includes(value);
}

export async function getOmzetExplanation(period: string): Promise<OmzetExplanation | null> {
  const { collections } = await import("./mongodb.ts");
  const { olseraOmzetReconciliationNotes } = await collections();
  const doc = await olseraOmzetReconciliationNotes.findOne({ _id: noteId(period) });
  if (!doc) return null;
  return {
    evidenceType: doc.evidenceType,
    description: doc.description,
    explainedAmount: doc.explainedAmount,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    // Skema lama tidak punya konsep lock (lihat OlseraOmzetReconciliationNoteV2Document
    // di lib/mongodb.ts) — catatan lama secara definisi belum pernah dikunci.
    locked: false,
    lockedBy: null,
    lockedAt: null,
  };
}

export type SaveOmzetExplanationInput = {
  period: string;
  evidenceType: OmzetEvidenceType;
  description: string;
  explainedAmount: number;
  userId: string;
};

export async function saveOmzetExplanation(input: SaveOmzetExplanationInput): Promise<OmzetExplanation> {
  const { collections } = await import("./mongodb.ts");
  const { olseraOmzetReconciliationNotes } = await collections();
  const now = new Date();
  const _id = noteId(input.period);
  await olseraOmzetReconciliationNotes.updateOne(
    { _id },
    {
      $set: {
        _id,
        storeId: storeId(),
        period: input.period,
        evidenceType: input.evidenceType,
        description: input.description,
        explainedAmount: input.explainedAmount,
        updatedBy: input.userId,
        updatedAt: now,
      },
      $setOnInsert: { createdBy: input.userId, createdAt: now },
    },
    { upsert: true },
  );
  const saved = await olseraOmzetReconciliationNotes.findOne({ _id });
  if (!saved) throw new Error("Gagal menyimpan penjelasan selisih.");
  return { evidenceType: saved.evidenceType, description: saved.description, explainedAmount: saved.explainedAmount, createdBy: saved.createdBy, createdAt: saved.createdAt, updatedAt: saved.updatedAt, locked: false, lockedBy: null, lockedAt: null };
}

export async function deleteOmzetExplanation(period: string): Promise<void> {
  const { collections } = await import("./mongodb.ts");
  const { olseraOmzetReconciliationNotes } = await collections();
  await olseraOmzetReconciliationNotes.deleteOne({ _id: noteId(period) });
}
