// Logika UI MURNI (tanpa React/DOM) untuk kartu hasil OCR Berita Acara,
// auto-fill "Nominal final disepakati"/"Alasan penyesuaian", dan gating
// tombol Simpan/Kunci Periode di app/reconciliation/page.tsx (V7).
//
// KENAPA modul terpisah ini ada: app/reconciliation/page.tsx adalah client
// component besar tanpa infrastruktur render DOM di test suite proyek ini
// (lihat lib/logout-flow.test.ts, lib/reconciliation-berita-acara-client-ocr.test.ts
// — tidak ada jsdom/@testing-library). Pola test "*-ui.test.ts" yang sudah
// ada (lib/reconciliation-omzet-period-lock-ui.test.ts) hanya menguji POLA
// TEKS source page.tsx (regex), yang TIDAK BISA menangkap bug logika
// sungguhan — persis kelas bug V7 ini (hasil analisis OCR yang sukses tidak
// pernah sampai ke UI, atau nominal final yang salah dihitung). Fungsi murni
// di modul ini bisa dites dengan input/output nyata, bukan cuma pola teks.
import type { BeritaAcaraDirection, BeritaAcaraMatchStatus } from "./reconciliation-berita-acara-parser";

// ---------------------------------------------------------------------------
// Format Rupiah — SATU-SATUNYA sumber format tampilan dipakai baik oleh
// page.tsx maupun test di sini (sebelumnya didefinisikan lokal di page.tsx
// dan tidak bisa diuji terpisah).
// ---------------------------------------------------------------------------
export function formatRupiah(value: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value).replace(/\s/g, "");
}
export function formatSignedRupiah(value: number): string {
  return `${value > 0 ? "+" : ""}${formatRupiah(value)}`;
}

export const MATCH_STATUS_LABEL: Record<BeritaAcaraMatchStatus, string> = {
  COCOK: "COCOK",
  TIDAK_COCOK: "TIDAK COCOK",
  PERLU_REVIEW: "PERLU REVIEW",
};

// Reuse SATU-SATUNYA skema warna status yang sudah ada di halaman ini
// (STATUS_TONE untuk OmzetStatus: ok/warn/danger/neutral, dirender lewat
// class CSS .recon-badge-{tone} yang sudah ada di app/globals.css) — Goal 4
// SENGAJA tidak menciptakan warna baru.
export type StatusTone = "ok" | "warn" | "danger" | "neutral";
export const MATCH_STATUS_TONE: Record<BeritaAcaraMatchStatus, StatusTone> = {
  COCOK: "ok",
  TIDAK_COCOK: "danger",
  PERLU_REVIEW: "warn",
};

// ---------------------------------------------------------------------------
// Goal 2/3: jenis preview dari mimeType lampiran tersimpan.
// ---------------------------------------------------------------------------
export type BeritaAcaraPreviewKind = "pdf" | "image" | "unsupported";

export function resolveBeritaAcaraPreviewKind(mimeType: string | null | undefined): BeritaAcaraPreviewKind {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/jpeg" || mimeType === "image/jpg" || mimeType === "image/png") return "image";
  return "unsupported";
}

// ---------------------------------------------------------------------------
// Goal 4: mapping hasil analisis -> 3 kartu ("Selisih Sistem"/"Nominal
// Berita Acara"/"Hasil Pencocokan"). INI mempresentasikan persis apa yang
// harus tampil begitu `analysis` di-set di page.tsx — kalau field ini benar
// tapi tetap tidak muncul di layar, bug-nya ada di WIRING render (bukan di
// sini); kalau field ini SUDAH salah, bug-nya di sini/upstream (parser/OCR).
// ---------------------------------------------------------------------------
export type BeritaAcaraAnalysisLike = {
  systemDifference: number;
  nominal: number | null;
  direction: BeritaAcaraDirection | null;
  matchStatus: BeritaAcaraMatchStatus;
};

export type BeritaAcaraCards = {
  selisihSistemLabel: string;
  nominalBeritaAcaraLabel: string;
  matchLabel: string;
  matchTone: StatusTone;
};

export function buildBeritaAcaraCards(analysis: BeritaAcaraAnalysisLike): BeritaAcaraCards {
  const nominalBeritaAcaraLabel =
    analysis.nominal !== null
      ? `${analysis.direction === "PENGURANGAN" ? "-" : "+"}${formatRupiah(analysis.nominal)}`
      : "Tidak terbaca";
  return {
    selisihSistemLabel: formatSignedRupiah(analysis.systemDifference),
    nominalBeritaAcaraLabel,
    matchLabel: MATCH_STATUS_LABEL[analysis.matchStatus],
    matchTone: MATCH_STATUS_TONE[analysis.matchStatus],
  };
}

// ---------------------------------------------------------------------------
// Goal 7: "Nominal final disepakati" HARUS berasal dari logika finalisasi
// yang sudah ada (previewOmzetPeriodLock di
// lib/reconciliation-omzet-period-lock.ts: adjustmentAmount = finalAgreedAmount
// - original.olsera), BUKAN rumus baru. previewOmzetPeriodLock menghitung
// adjustment DARI finalAgreedAmount yang dikirim client — jadi client yang
// harus mengirim finalAgreedAmount = olseraTotal ± nominal BA supaya
// adjustment yang dihasilkan server persis sama dengan nominal Berita Acara.
// Fungsi ini HANYA menurunkan angka input itu; server tetap satu-satunya
// yang menghitung/menyimpan adjustmentAmount sungguhan.
//
// Hanya mengisi otomatis saat status COCOK (Langkah 8: field lain dikunci
// read-only di UI saat COCOK, lihat page.tsx) — TIDAK PERNAH menebak nominal
// final saat TIDAK_COCOK/PERLU_REVIEW (null -> UI tidak mengubah nilai yang
// sudah ada, biarkan user isi manual).
// ---------------------------------------------------------------------------
export function computeAutoFinalAgreedAmount(input: {
  originalOlseraAmount: number;
  analysis: { matchStatus: BeritaAcaraMatchStatus; nominal: number | null; direction: BeritaAcaraDirection | null } | null;
}): number | null {
  const { analysis } = input;
  if (!analysis || analysis.matchStatus !== "COCOK" || analysis.nominal === null || analysis.direction === null) return null;
  const signedAdjustment = analysis.direction === "PENAMBAHAN" ? analysis.nominal : -analysis.nominal;
  return input.originalOlseraAmount + signedAdjustment;
}

// ---------------------------------------------------------------------------
// Goal 6/CRITICAL: alasan auto-fill TIDAK PERNAH menimpa edit manual user.
// `userEdited` dilacak di page.tsx: true begitu user mengetik sendiri di
// textarea Alasan penyesuaian (di-reset ke false saat upload attachment baru
// / buka periode baru — dokumen baru = siklus analisis baru).
// ---------------------------------------------------------------------------
export function nextReasonAfterAnalysis(input: { current: string; userEdited: boolean; parsedReason: string | null }): string {
  if (input.userEdited) return input.current;
  if (input.parsedReason) return input.parsedReason;
  return input.current;
}

// ---------------------------------------------------------------------------
// Goal 8: "Simpan" (recordOmzetPeriodLockPreview) hanya boleh aktif kalau
// precondition dasarnya lengkap. SENGAJA TIDAK memeriksa matchStatus di sini
// (COCOK/TIDAK_COCOK/PERLU_REVIEW semua boleh Simpan — hanya Kunci Periode
// yang ditahan oleh matchStatus, lihat canLockAfterSave/canLockFinalization
// di page.tsx) supaya user tidak pernah diblokir total dari mengoreksi data
// secara manual (Goal 10), konsisten dengan komentar existing di page.tsx:
// "TIDAK PERNAH otomatis blokir total — hanya mismatch YANG DIKETAHUI yang
// menahan tombol lock."
// ---------------------------------------------------------------------------
export function canSaveBeritaAcaraFinalization(input: {
  hasAttachment: boolean;
  busy: boolean;
  analysisLoading: boolean;
  reason: string;
  finalAmount: string;
}): boolean {
  if (!input.hasAttachment || input.busy || input.analysisLoading) return false;
  if (!input.reason.trim()) return false;
  const trimmedAmount = input.finalAmount.trim();
  if (!trimmedAmount) return false;
  const parsed = Number(trimmedAmount);
  return Number.isSafeInteger(parsed);
}

// ---------------------------------------------------------------------------
// Goal 9: "Kunci Periode" hanya aktif SETELAH Simpan berhasil (hasPreview
// datang dari state finalPreview di page.tsx, yang cuma di-set oleh
// previewFinalization() sukses dan direset di setiap perubahan input) DAN
// hasil pencocokan bukan TIDAK_COCOK yang diketahui (aturan lama, tidak
// diubah).
// ---------------------------------------------------------------------------
export function canLockAfterSave(input: { hasPreview: boolean; busy: boolean; matchStatus: BeritaAcaraMatchStatus | null | undefined }): boolean {
  return input.hasPreview && !input.busy && input.matchStatus !== "TIDAK_COCOK";
}
