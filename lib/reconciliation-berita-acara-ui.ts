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
  SALAH_PERIODE: "SALAH PERIODE",
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
  SALAH_PERIODE: "danger",
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

// V9: "Selisih Sistem" TETAP bertanda (formatSignedRupiah — arah selisih di
// sistem, mis. "+Rp740.000"/"-Rp739.999"). "Nominal Berita Acara" SEKARANG
// SELALU nilai absolut TANPA tanda (mis. "Rp740.000" untuk PENAMBAHAN maupun
// PENGURANGAN) — dokumen BA menyatakan nominal, bukan selisih; arah
// (PENAMBAHAN/PENGURANGAN) TETAP dipakai INTERNAL untuk pencocokan
// (matchBeritaAcaraToSystemDifference) dan nominal final auto
// (computeAutoFinalAgreedAmount) — logika arah TIDAK dihapus, hanya tidak
// lagi dipakai untuk memilih tanda di label kartu ini.
export function buildBeritaAcaraCards(analysis: BeritaAcaraAnalysisLike): BeritaAcaraCards {
  const nominalBeritaAcaraLabel = analysis.nominal !== null ? formatRupiah(analysis.nominal) : "Tidak terbaca";
  return {
    selisihSistemLabel: formatSignedRupiah(analysis.systemDifference),
    nominalBeritaAcaraLabel,
    matchLabel: MATCH_STATUS_LABEL[analysis.matchStatus],
    matchTone: MATCH_STATUS_TONE[analysis.matchStatus],
  };
}

// ---------------------------------------------------------------------------
// V12 CRITICAL FIX (root cause produksi Rp199.335.000, Maret): versi LAMA
// fungsi ini menghitung `originalOlseraAmount + signedAdjustment` (mis.
// 198.595.000 + 740.000 = 199.335.000). Itu SALAH — `originalOlseraAmount`
// (Olsera setelah ledger/reklasifikasi) SUDAH mengandung selisih yang
// dijelaskan Berita Acara; BA di sini berfungsi sebagai BUKTI bahwa selisih
// itu memang valid (dicocokkan lewat matchBeritaAcaraToSystemDifference di
// server), BUKAN penyesuaian KEDUA yang harus ditambah/dikurang lagi di atas
// angka yang sudah benar. Nominal final yang disepakati untuk status COCOK
// SELALU = originalOlseraAmount apa adanya — TIDAK ADA aritmetika tambahan.
// `nominal`/`direction` di parameter tetap WAJIB non-null (di-cek di bawah)
// murni sebagai GATE "benar-benar ada bukti BA yang valid", bukan lagi
// dipakai untuk menghitung apa pun (lihat Maret/April di
// reconciliation-berita-acara-ui.test.ts test wajib #16 V12 dan
// lib/reconciliation-omzet-period-lock.test.ts untuk regresi end-to-end).
//
// Goal 7 (V7, MASIH BERLAKU): "Nominal final disepakati" HARUS berasal dari
// logika finalisasi yang sudah ada (previewOmzetPeriodLock di
// lib/reconciliation-omzet-period-lock.ts: adjustmentAmount = finalAgreedAmount
// - original.olsera) — server tetap satu-satunya yang menghitung/menyimpan
// adjustmentAmount sungguhan (yang sekarang, dengan fix ini, akan bernilai
// 0 untuk kasus COCOK biasa — itu BENAR: tidak ada penyesuaian numerik yang
// diperlukan, BA hanya mengonfirmasi angka yang sudah ada).
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
  return input.originalOlseraAmount;
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

// ---------------------------------------------------------------------------
// V8 Goal 3: "Riwayat Aktivitas" — ubah action mentah (upload/preview/lock/
// relock/unlock) + actorName (SUDAH diresolve server, lihat
// lib/reconciliation-actor-display.ts — TIDAK PERNAH raw ID di sini) jadi
// kalimat manusiawi. "preview" secara internal MEMANG action yang sama dipakai
// tombol "Simpan" (lihat komentar previewFinalization di page.tsx) — makanya
// labelnya "Finalisasi disimpan", bukan "Preview".
// ---------------------------------------------------------------------------
// V12: "reset" — Reset Finalisasi (lihat resetOmzetPeriodFinalization di
// lib/reconciliation-omzet-period-lock.ts).
export type PeriodLockHistoryAction = "upload" | "preview" | "lock" | "relock" | "unlock" | "reset";

const HISTORY_ACTION_LABEL: Record<PeriodLockHistoryAction, string> = {
  upload: "Berita Acara diunggah",
  preview: "Finalisasi disimpan",
  lock: "Periode dikunci",
  relock: "Periode dikunci kembali",
  unlock: "Periode dibuka kembali",
  reset: "Finalisasi direset",
};

export type PeriodLockHistoryEntryLike = { action: string; actorName: string; reason: string | null };
export type PeriodLockHistoryLine = { summary: string; reason: string | null };

/** `reason` HANYA ditampilkan untuk action "unlock" (Goal 3: "Untuk unlock tampilkan juga: Alasan: ...") — action lain punya reason juga di data (mis. preview/lock menyimpan adjustmentReason) tapi itu sudah tampil di tempat lain di UI, bukan di baris riwayat ini. */
export function formatPeriodLockHistoryLine(entry: PeriodLockHistoryEntryLike): PeriodLockHistoryLine {
  const label = HISTORY_ACTION_LABEL[entry.action as PeriodLockHistoryAction] ?? entry.action;
  return {
    summary: `${label} oleh ${entry.actorName}`,
    reason: entry.action === "unlock" ? entry.reason : null,
  };
}

// ---------------------------------------------------------------------------
// V11 Goal 8-11: "×" per-item di Riwayat Aktivitas — SOFT DELETE (lihat
// hideOmzetPeriodHistoryEntry/computeHiddenHistory di
// lib/reconciliation-omzet-period-lock.ts). Entri asli TIDAK PERNAH hilang
// dari database, hanya disaring dari RENDER di sini.
// ---------------------------------------------------------------------------
export type PeriodLockHistoryVisibilityLike = { hiddenAt: string | Date | null };

export function isHistoryEntryVisible(entry: PeriodLockHistoryVisibilityLike): boolean {
  return !entry.hiddenAt;
}

// ---------------------------------------------------------------------------
// V11 Goal 1/2: begitu TOTAL periode ter-verifikasi Berita Acara (Simpan
// sukses + server-verified COCOK, lihat isBeritaAcaraVerifiedUnlocked di
// lib/reconciliation-omzet-period-lock.ts), tandai HANYA component
// (COURT/PICKLEBALL) yang sebelumnya jadi SATU-SATUNYA penyebab
// PERLU_DICEK — supaya mis. kartu PICKLEBALL (Maret, selisih Rp740.000)
// juga tampil "Cocok + Berita Acara", bukan hanya TOTAL GABUNGAN.
//
// GUARD AMBIGUITAS (aturan eksplisit V11, section 2): kalau KEDUA component
// sama-sama PERLU_DICEK pada saat bersamaan, BA TIDAK ditempelkan ke salah
// satu — tidak ada cara aman menebak BA itu punya component yang mana,
// keduanya tetap Perlu Dicek sampai scope-nya jelas. Simetris juga berlaku
// kalau TIDAK ADA yang PERLU_DICEK (keduanya sudah Cocok sendiri lewat
// toleransi ±Rp1 biasa) — tidak ada apa pun untuk ditempelkan BA-nya.
// ---------------------------------------------------------------------------
export type SportComponentStatusLike = "COCOK" | "PERLU_DICEK";
export type SportReconciliationComponentsLike = {
  court: { status: SportComponentStatusLike };
  pickleball: { status: SportComponentStatusLike };
};

export function resolveBeritaAcaraVerifiedComponent(
  sportReconciliation: SportReconciliationComponentsLike,
  beritaAcaraVerified: boolean,
): { court: boolean; pickleball: boolean } {
  if (!beritaAcaraVerified) return { court: false, pickleball: false };
  const courtUnresolved = sportReconciliation.court.status === "PERLU_DICEK";
  const pickleballUnresolved = sportReconciliation.pickleball.status === "PERLU_DICEK";
  if (courtUnresolved === pickleballUnresolved) return { court: false, pickleball: false };
  return { court: courtUnresolved, pickleball: pickleballUnresolved };
}

// ---------------------------------------------------------------------------
// V11 Goal 3/4/5: "RESTORE LAST SAVED STATE" — begitu periode punya hasil
// Simpan tersimpan (verifiedMatchStatus/beritaAcaraNominal/beritaAcaraDirection
// bukan null), reopen detail HARUS hydrate langsung dari database, TIDAK
// PERNAH menjalankan OCR ulang (server tidak bisa merasterisasi PDF hasil
// scan — lihat komentar analyzeAttachment di app/reconciliation/page.tsx —
// jadi re-analyze otomatis saat reopen justru MENIMPA hasil COCOK yang
// sudah tersimpan dengan PERLU_REVIEW/"Tidak terbaca" palsu, itulah root
// cause masalah #2 V11).
// ---------------------------------------------------------------------------
export type SavedBeritaAcaraLockLike = {
  verifiedMatchStatus: BeritaAcaraMatchStatus | null;
  beritaAcaraNominal: number | null;
  beritaAcaraDirection: BeritaAcaraDirection | null;
  adjustmentReason: string | null;
};

/** true bila periode ini SUDAH pernah Simpan dengan hasil analisis BA tersimpan — reopen TIDAK BOLEH memicu analyzeAttachment (OCR ulang) bila ini true. */
export function hasSavedBeritaAcaraAnalysis(lock: SavedBeritaAcaraLockLike | null | undefined): boolean {
  return Boolean(lock && (lock.verifiedMatchStatus !== null || lock.beritaAcaraNominal !== null || lock.beritaAcaraDirection !== null));
}

export type RestoredBeritaAcaraAnalysis = {
  systemDifference: number;
  nominal: number | null;
  direction: BeritaAcaraDirection | null;
  reason: string | null;
  parseStatus: "OK";
  matchStatus: BeritaAcaraMatchStatus;
  ocrSource: "restored-from-database";
};

/** Bentuk ulang BeritaAcaraAnalysis langsung dari lock TERSIMPAN (bukan dari OCR ulang) — dipakai reopen detail supaya nominal/arah/status/alasan yang tampil persis hasil Simpan TERAKHIR. */
export function restoreBeritaAcaraAnalysisFromLock(lock: SavedBeritaAcaraLockLike, systemDifference: number): RestoredBeritaAcaraAnalysis {
  return {
    systemDifference,
    nominal: lock.beritaAcaraNominal,
    direction: lock.beritaAcaraDirection,
    reason: lock.adjustmentReason,
    parseStatus: "OK",
    matchStatus: lock.verifiedMatchStatus ?? "PERLU_REVIEW",
    ocrSource: "restored-from-database",
  };
}
