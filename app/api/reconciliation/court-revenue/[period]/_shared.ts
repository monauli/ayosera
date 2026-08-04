// Helper bersama — endpoint fitur Lock+Berita Acara Rekonsiliasi Omzet
// AYOSERA (skema BARU append-only, lib/reconciliation-omzet-note-store.ts).
// Dipakai explanation/route.ts (submit/lihat penjelasan), lock/route.ts
// (kunci), DAN attachment/route.ts (upload lampiran) supaya pemetaan
// response & error konsisten di ketiganya. Lihat "Desain Skema Lock+Berita
// Acara" & "Implementasi ... (Langkah 3/4)" di tmp/ai-handoff.md.
//
// File biasa (BUKAN route.ts) — export selain HTTP method handler/config
// tidak diizinkan Next.js di route.ts, jadi konstanta seperti
// MAX_ATTACHMENT_BYTES yang perlu diimpor test HARUS tinggal di sini.
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { OMZET_EVIDENCE_TYPES, OMZET_LOCK_WITHOUT_EXPLANATION_MARKER, type OmzetEvidenceType } from "@/lib/reconciliation-omzet-ledger";
import { OmzetNoteError } from "@/lib/reconciliation-omzet-note-store";
import type { OlseraOmzetReconciliationNoteV2Document } from "@/lib/mongodb";

export const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

/**
 * Batas ukuran lampiran Berita Acara (attachment/route.ts) — 4MB, BUKAN
 * 8-10MB: Vercel Serverless Functions membatasi ukuran body request sekitar
 * 4.5MB secara default; batas lebih besar akan ditolak di level PLATFORM
 * sebelum sampai ke handler (413 dari Vercel, bukan dari kode ini), jadi
 * validasi aplikasi di atas itu tidak ada gunanya. 4MB masih cukup untuk PDF
 * hasil scan Berita Acara multi-halaman atau foto bukti.
 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export function isOmzetEvidenceTypeValue(value: unknown): value is OmzetEvidenceType {
  return typeof value === "string" && (OMZET_EVIDENCE_TYPES as readonly string[]).includes(value);
}

export type AttachmentFieldsValidation =
  | { ok: true; attachmentUrl: string | null; attachmentFileName: string | null }
  | { ok: false; error: string };

/**
 * Baca attachmentUrl/attachmentFileName MENTAH dari body POST .../explanation
 * (opsional — null/undefined bila tidak ada lampiran, hasil upload terpisah
 * dari POST .../attachment). Keduanya harus SAMA-SAMA diisi atau SAMA-SAMA
 * kosong — mencegah data setengah-jadi (URL tanpa nama file, atau sebaliknya)
 * tersimpan ke note. TIDAK memvalidasi bahwa attachmentUrl benar-benar
 * berasal dari upload sah ke Vercel Blob — di luar scope, endpoint attachment
 * sudah requireSupervisor() jadi tidak sembarang orang bisa mengisi field ini.
 */
export function validateAttachmentFields(rawAttachmentUrl: unknown, rawAttachmentFileName: unknown): AttachmentFieldsValidation {
  const attachmentUrl = typeof rawAttachmentUrl === "string" && rawAttachmentUrl.trim() ? rawAttachmentUrl.trim() : null;
  const attachmentFileName = typeof rawAttachmentFileName === "string" && rawAttachmentFileName.trim() ? rawAttachmentFileName.trim() : null;
  if ((attachmentUrl === null) !== (attachmentFileName === null)) {
    return { ok: false, error: "attachmentUrl dan attachmentFileName harus diisi bersamaan (atau keduanya dikosongkan bila tidak ada lampiran)." };
  }
  return { ok: true, attachmentUrl, attachmentFileName };
}

/**
 * Map `OmzetNoteError.code` -> status HTTP. KONSISTEN dengan konvensi yang
 * SUDAH DIPAKAI `app/api/reconciliation/findings/[findingId]/resolution/route.ts`
 * (`ManualResolutionError`): `NOT_FOUND`->404, `CONFLICT`->409,
 * `INVALID_TRANSITION`->422, default (`VALIDATION`)->400.
 */
export function omzetNoteErrorResponse(error: OmzetNoteError) {
  const status = error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : error.code === "INVALID_TRANSITION" ? 422 : 400;
  return NextResponse.json({ error: error.message }, { status, headers: NO_CACHE_HEADERS });
}

export type OmzetNoteResponseData = {
  /** OmzetEvidenceType sungguhan, ATAU OMZET_LOCK_WITHOUT_EXPLANATION_MARKER bila note ini hasil lock langsung dari status Cocok (lihat lockOmzetPeriod). */
  evidenceType: OmzetEvidenceType | typeof OMZET_LOCK_WITHOUT_EXPLANATION_MARKER;
  description: string;
  explainedAmount: number;
  attachmentUrl: string | null;
  attachmentFileName: string | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
  locked: boolean;
  lockedBy: string | null;
  lockedAt: Date | null;
};

/**
 * Bentuk response KOMPATIBEL dengan `Explanation` yang sudah dikonsumsi
 * `app/reconciliation/page.tsx` (`evidenceType`/`description`/
 * `explainedAmount`/`createdBy`/`createdAt`/`updatedAt`), plus field BARU
 * `locked`/`lockedBy`/`lockedAt` untuk UI Phase 4 nanti. `_id`/`storeId`/
 * `period`/`isCurrent`/`supersededBy`/`supersededAt`/`previousNoteId` SENGAJA
 * TIDAK diekspos — detail internal skema append-only, bukan kontrak API.
 */
export function toOmzetNoteResponse(note: OlseraOmzetReconciliationNoteV2Document): OmzetNoteResponseData {
  return {
    evidenceType: note.evidenceType,
    description: note.description,
    explainedAmount: note.explainedAmount,
    attachmentUrl: note.attachmentUrl,
    attachmentFileName: note.attachmentFileName,
    createdBy: note.createdBy,
    createdAt: note.createdAt,
    updatedBy: note.updatedBy,
    updatedAt: note.updatedAt,
    locked: note.locked,
    lockedBy: note.lockedBy,
    lockedAt: note.lockedAt,
  };
}

/**
 * Idempotency-Key untuk `submitOmzetExplanation`. UI SAAT INI
 * (`app/reconciliation/page.tsx`) TIDAK mengirim header `Idempotency-Key`
 * sama sekali (belum diperbarui — itu Phase 4 terpisah), jadi MEWAJIBKAN
 * header seperti route manual-resolution akan langsung merusak alur submit
 * yang sedang berjalan sekarang. Solusi: kalau client mengirim header
 * `Idempotency-Key`, PAKAI itu (forward-compatible dengan UI masa depan).
 * Kalau tidak ada, turunkan SECARA DETERMINISTIK dari isi request
 * (storeId+period+actor+evidenceType+description+explainedAmount+
 * attachmentUrl) — klik ganda/retry jaringan dengan payload identik otomatis
 * collapse jadi SATU dokumen (idempotent) TANPA perlu kerja sama client sama
 * sekali; payload yang benar-benar berbeda (termasuk HANYA beda lampiran)
 * otomatis dapat idempotencyKey baru (bukan dianggap request yang sama —
 * submitOmzetExplanation membandingkan attachmentUrl juga saat cek
 * idempotensi, jadi attachmentUrl WAJIB ikut di sini supaya dua submit
 * dengan lampiran berbeda tidak jatuh ke _id yang sama lalu ditolak CONFLICT).
 */
export function resolveIdempotencyKey(
  headerValue: string | null,
  content: { storeId: number; period: string; actor: string; evidenceType: string; description: string; explainedAmount: number; attachmentUrl: string | null },
): string {
  const trimmed = headerValue?.trim();
  if (trimmed) return trimmed;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 32);
}
