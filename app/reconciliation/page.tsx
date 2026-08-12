"use client";

import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp, ExternalLink, FileCheck, FileSearch, Lock, Moon, Paperclip, RefreshCw, Sun, X } from "lucide-react";
import { reconciliationOmzetUiStatus } from "@/lib/reconciliation-omzet-ui";
import { readInitialThemeMode, THEME_MODE_STORAGE_KEY, type ThemeMode } from "@/lib/theme-mode";
import { analyzeBeritaAcaraFileClient, STATUS_READING } from "@/lib/reconciliation-berita-acara-client-ocr";
import {
  formatRupiah,
  resolveBeritaAcaraPreviewKind,
  buildBeritaAcaraCards,
  computeAutoFinalAgreedAmount,
  nextReasonAfterAnalysis,
  canSaveBeritaAcaraFinalization,
  canLockAfterSave,
  formatPeriodLockHistoryLine,
  isHistoryEntryVisible,
  resolveBeritaAcaraVerifiedComponent,
  hasSavedBeritaAcaraAnalysis,
  restoreBeritaAcaraAnalysisFromLock,
} from "@/lib/reconciliation-berita-acara-ui";

type LedgerEntry = { transactionNo: string | null; transactionDate: string | null; description: string | null; debit: number; credit: number };
type AccountBreakdown = {
  accountCode: string;
  rawEntryCount: number;
  duplicatesRemoved: number;
  creditTotal: number;
  closingEntry: LedgerEntry | null;
  ambiguousCandidates: LedgerEntry[];
  otherDebitEntries: LedgerEntry[];
  otherDebitTotal: number;
  net: number;
};
type PickleballVerification = { applicable: boolean; verified: boolean | null; matchedEntry: LedgerEntry | null; reason: string };
type OmzetStatus = "COCOK" | "SELISIH_TERJELASKAN" | "PERLU_DICEK" | "BULAN_BERJALAN";
type SportReconciliationStatus = "COCOK" | "PERLU_DICEK";
type SportSide = { count: number; revenue: number };
type SportComparison = { ayo: SportSide; olsera: number; difference: number; status: SportReconciliationStatus };
type SportReconciliation = { court: SportComparison; pickleball: SportComparison; unmapped: SportSide; total: SportSide };
// uploadedByName/lockedByName/unlockedByName/history[].actorName SUDAH
// diresolve server (lib/reconciliation-actor-display.ts) dari actor id mentah
// -> nama/email/fallback "User" — UI TIDAK PERNAH menampilkan
// uploadedBy/lockedBy/unlockedBy/history[].actor (raw id) langsung (Goal 3 V8).
// verifiedMatchStatus/beritaAcaraNominal/beritaAcaraDirection (V10): hasil
// pencocokan Berita Acara TERAKHIR yang di-server-verify saat Simpan — lihat
// lib/reconciliation-omzet-period-lock.ts previewOmzetPeriodLock.
// history[].hiddenAt/hiddenBy (V11): soft-delete per-item ("×" di Riwayat
// Aktivitas, lihat isHistoryEntryVisible) — hiddenAt bukan null berarti entri
// ini disembunyikan dari render, TAPI datanya TETAP ada apa adanya untuk
// audit (TIDAK PERNAH hard-delete, lihat hideOmzetPeriodHistoryEntry di
// lib/reconciliation-omzet-period-lock.ts).
type PeriodLock = { status: "draft" | "locked" | "unlocked"; version: number; originalAyoAmount: number | null; originalOlseraAmount: number | null; originalDifference: number | null; finalAgreedAmount: number | null; adjustmentAmount: number | null; adjustmentReason: string | null; verifiedMatchStatus: "COCOK" | "TIDAK_COCOK" | "PERLU_REVIEW" | "SALAH_PERIODE" | null; beritaAcaraNominal: number | null; beritaAcaraDirection: "PENAMBAHAN" | "PENGURANGAN" | null; attachment: { fileName: string; mimeType: string; size: number; url: string; uploadedAt: string; uploadedBy: string; uploadedByName: string } | null; lockedAt: string | null; lockedBy: string | null; lockedByName: string; unlockedAt: string | null; unlockedBy: string | null; unlockedByName: string; history: Array<{ action: string; actor: string; actorName: string; timestamp: string; reason: string | null; hiddenAt: string | null }> };
type EvidenceType = "shifted-period" | "wrong-amount" | "duplicate" | "reversal" | "correction" | "wrong-account";
/** Penanda note yang dikunci LANGSUNG dari status Cocok (selisih Rp0), TANPA penjelasan manual — lihat lib/reconciliation-omzet-ledger.ts OMZET_LOCK_WITHOUT_EXPLANATION_MARKER. TIDAK muncul di dropdown "Jenis bukti" (bukan kategori bukti sungguhan). */
const LOCK_WITHOUT_EXPLANATION_MARKER = "matched-no-explanation" as const;
type Explanation = {
  evidenceType: EvidenceType | typeof LOCK_WITHOUT_EXPLANATION_MARKER;
  description: string;
  explainedAmount: number;
  attachmentUrl: string | null;
  attachmentFileName: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  locked: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
};
type OmzetResult = {
  period: string;
  ayo: { count: number; revenue: number };
  courtFees: AccountBreakdown;
  pickleball: AccountBreakdown;
  pickleballVerification: PickleballVerification;
  sportReconciliation: SportReconciliation;
  olseraTotal: number;
  differenceRevenue: number;
  dataAvailable: boolean;
  status: OmzetStatus;
  statusReason: string;
  explanation: Explanation | null;
  periodLock?: PeriodLock | null;
  /** V10: true bila Berita Acara sudah di-Simpan dan server-verified COCOK (lihat isBeritaAcaraVerifiedUnlocked) — dipakai list & detail untuk status/icon "Cocok" TANPA mengubah differenceRevenue. */
  beritaAcaraVerified?: boolean;
};
type User = { id: string; role: "supervisor" | "user"; allowedModules: string[] };
type BeritaAcaraAnalysis = {
  systemDifference: number;
  nominal: number | null;
  direction: "PENAMBAHAN" | "PENGURANGAN" | null;
  reason: string | null;
  period?: string | null;
  parseStatus: "OK" | "PERLU_REVIEW";
  matchStatus: "COCOK" | "TIDAK_COCOK" | "PERLU_REVIEW" | "SALAH_PERIODE";
  ocrSource: string;
};

const STATUS_LABEL: Record<OmzetStatus, string> = {
  COCOK: "Cocok",
  SELISIH_TERJELASKAN: "Selisih Terjelaskan",
  PERLU_DICEK: "Perlu Dicek",
  BULAN_BERJALAN: "Bulan Berjalan",
};
const STATUS_TONE: Record<OmzetStatus, "ok" | "warn" | "danger" | "neutral"> = {
  COCOK: "ok",
  SELISIH_TERJELASKAN: "warn",
  PERLU_DICEK: "danger",
  BULAN_BERJALAN: "neutral",
};
const EVIDENCE_LABEL: Record<EvidenceType, string> = {
  "shifted-period": "Transaksi bergeser bulan",
  "wrong-amount": "Salah nominal",
  duplicate: "Duplikat",
  reversal: "Reversal",
  correction: "Koreksi",
  "wrong-account": "Salah akun",
};

// formatRupiah/formatSignedRupiah SEKARANG diimpor dari
// lib/reconciliation-berita-acara-ui.ts (satu-satunya sumber, dipakai juga
// oleh test murni di sana) — sebelumnya didefinisikan lokal di sini dan
// tidak bisa dites terpisah dari React.
function monthLabel(period: string) {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(new Date(Date.UTC(year, month - 1, 1)));
}
function dateLabel(date: string | null) {
  if (!date) return "-";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Jakarta" }).format(d);
}
function dateTimeLabel(date: string | null) {
  if (!date) return "-";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return `${new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }).format(d)} WIB`;
}

function StatusBadge({ status }: { status: OmzetStatus }) {
  return <span className={`recon-badge recon-badge-${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

function LockBadge() {
  return (
    <span className="recon-badge recon-badge-warn">
      <Lock size={12} /> Dikunci
    </span>
  );
}

// V10 Goal 2: indikator "Cocok karena Berita Acara" untuk periode yang SUDAH
// Simpan + server-verified COCOK tapi BELUM dikunci — beda dari badge
// "Cocok — Terkunci" (locked) yang sudah ada; selisih ASLI TETAP tampil di
// kolom lain (tabel/kartu), badge ini murni indikator, tidak mengubah angka.
// V11 Goal 6: `onClick` OPSIONAL — hanya badge di TABEL UTAMA (desktop+mobile)
// yang mengirim handler ini (buka modal Preview Berita Acara ringan, lihat
// BeritaAcaraQuickPreviewModal di bawah); badge di kartu per-olahraga
// (SportReconciliationCard) TIDAK mengirim onClick sama sekali -> tetap
// <span> non-interaktif seperti V10, tidak ada perubahan perilaku di sana.
function BeritaAcaraVerifiedBadge({ onClick }: { onClick?: (event: MouseEvent) => void } = {}) {
  const label = (
    <>
      <FileCheck size={12} /> Berita Acara
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="recon-badge recon-badge-ok" style={{ cursor: "pointer" }} title="Selisih telah diverifikasi dengan Berita Acara — klik untuk preview dokumen" onClick={onClick}>
        {label}
      </button>
    );
  }
  return (
    <span className="recon-badge recon-badge-ok" title="Selisih telah diverifikasi dengan Berita Acara">
      {label}
    </span>
  );
}

// V11 Goal 1/2: `beritaAcaraVerified` OPSIONAL — begitu true (dan bukan
// periode locked, lihat `locked` prop yang tetap diprioritaskan seperti V10),
// tampilkan badge "Berita Acara" DI SAMPING status Cocok kartu ini juga
// (bukan hanya TOTAL GABUNGAN seperti V10) — lihat
// resolveBeritaAcaraVerifiedComponent di lib/reconciliation-berita-acara-ui.ts
// untuk aturan ambiguitas kapan ini boleh true per component.
function SportReconciliationCard({ title, ayoLabel, olseraLabel, comparison, finalStatus, beritaAcaraVerified = false, wide = false, locked = false }: { title: string; ayoLabel: string; olseraLabel: string; comparison: SportComparison; finalStatus?: OmzetStatus; beritaAcaraVerified?: boolean; wide?: boolean; locked?: boolean }) {
  return (
    <section className={`recon-sport-card${wide ? " recon-sport-card-wide" : ""}`}>
      <h3>{title}</h3>
      <div className="recon-detail-grid">
        <div><span>{ayoLabel}</span><b>{formatRupiah(comparison.ayo.revenue)}</b></div>
        <div><span>{olseraLabel}</span><b>{formatRupiah(comparison.olsera)}</b></div>
        <div><span>Selisih (Olsera - AYO)</span><b>{formatRupiah(comparison.difference)}</b></div>
        <div><span>Status</span><div className="recon-card-status"><StatusBadge status={finalStatus ?? comparison.status} /> {locked ? <span className="recon-badge recon-badge-ok"><Lock size={12} /> Cocok — Terkunci</span> : beritaAcaraVerified && <BeritaAcaraVerifiedBadge />}</div></div>
      </div>
    </section>
  );
}

// V11 Goal 6/7: modal ringan "Preview Berita Acara" dipicu dari badge di
// tabel utama — REUSE resolveBeritaAcaraPreviewKind (sama seperti
// BeritaAcaraPreview di drawer detail, Goal 2 V8), bukan komponen preview
// baru yang terpisah logikanya. `onClose` juga dipicu klik backdrop, konsisten
// dengan pola dialog konfirmasi lain (recon-confirm-overlay sudah ada di
// globals.css, sebelumnya belum dipakai di mana pun).
function BeritaAcaraQuickPreviewModal({ attachment, onClose }: { attachment: NonNullable<PeriodLock["attachment"]>; onClose: () => void }) {
  const kind = resolveBeritaAcaraPreviewKind(attachment.mimeType);
  return (
    <div className="recon-confirm-overlay" role="dialog" aria-modal="true" aria-label="Preview Berita Acara" onClick={onClose}>
      <div className="recon-confirm-box" style={{ maxWidth: "min(680px, 92vw)" }} onClick={(event) => event.stopPropagation()}>
        <h3>Preview Berita Acara</h3>
        {kind === "pdf" ? (
          <div className="recon-ba-preview-frame-wrap">
            <iframe src={attachment.url} title={`Preview ${attachment.fileName}`} />
          </div>
        ) : kind === "image" ? (
          <div className="recon-ba-preview-image-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element -- URL Blob eksternal dinamis, bukan aset statis lokal */}
            <img src={attachment.url} alt={`Preview ${attachment.fileName}`} />
          </div>
        ) : (
          <p className="recon-ba-preview-unsupported">Pratinjau tidak didukung untuk tipe file ini — gunakan &quot;Buka File&quot;.</p>
        )}
        <div className="recon-actions">
          <a className="recon-link" href={attachment.url} target="_blank" rel="noreferrer">
            <ExternalLink size={12} /> Buka File
          </a>
          <button type="button" className="recon-button secondary" onClick={onClose}>
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}

// Goal 2: preview Berita Acara langsung dari Blob URL publik (access:"public",
// lihat lib/blob-storage.ts) — TIDAK di-proxy lewat backend (tidak perlu:
// URL publik, tidak ada token/secret di dalamnya). PDF lewat <iframe>
// (frame-src di lib/csp.ts mengizinkan origin Blob ini secara eksplisit),
// gambar lewat <img>. Selalu tampil begitu attachment ada, TERLEPAS dari
// hasil OCR (Goal 10: preview tetap tampil walau OCR gagal).
//
// V8 Goal 2 (bisa diminimize): `open` murni state UI lokal, TIDAK disimpan ke
// backend. Parent (di bawah) me-render dengan `key={attachment.url}` supaya
// upload Berita Acara BARU (URL beda) me-remount komponen ini -> `open`
// kembali ke default true (preview otomatis terbuka setelah upload baru),
// sementara toggle minimize/expand pada dokumen YANG SAMA tidak pernah
// direset oleh render ulang lain (mis. polling/re-fetch detail).
function BeritaAcaraPreview({ attachment }: { attachment: NonNullable<PeriodLock["attachment"]> }) {
  const [open, setOpen] = useState(true);
  const kind = resolveBeritaAcaraPreviewKind(attachment.mimeType);
  return (
    <div className="recon-ba-preview">
      <div className="recon-actions" style={{ justifyContent: "space-between" }}>
        <strong style={{ fontSize: ".78rem" }}>Preview Berita Acara</strong>
        <div style={{ display: "flex", gap: ".75rem", alignItems: "center" }}>
          <a className="recon-link" href={attachment.url} target="_blank" rel="noreferrer">
            <ExternalLink size={12} /> Buka File
          </a>
          <button type="button" className="recon-link" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? (
              <>
                <ChevronUp size={12} /> Minimize
              </>
            ) : (
              <>
                <ChevronDown size={12} /> Tampilkan
              </>
            )}
          </button>
        </div>
      </div>
      {open &&
        (kind === "pdf" ? (
          <div className="recon-ba-preview-frame-wrap">
            <iframe src={attachment.url} title={`Preview ${attachment.fileName}`} />
          </div>
        ) : kind === "image" ? (
          <div className="recon-ba-preview-image-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element -- URL Blob eksternal dinamis, bukan aset statis lokal */}
            <img src={attachment.url} alt={`Preview ${attachment.fileName}`} />
          </div>
        ) : (
          <p className="recon-ba-preview-unsupported">Pratinjau tidak didukung untuk tipe file ini — gunakan &quot;Buka File&quot;.</p>
        ))}
    </div>
  );
}

// Goal 4: 3 kartu hasil pencocokan, reuse .recon-sport-card + skema warna
// .recon-badge-{ok|warn|danger} yang sudah ada (lihat StatusBadge/STATUS_TONE
// di atas) — TIDAK ada warna/style baru yang diciptakan.
function BeritaAcaraResultCards({ analysis }: { analysis: BeritaAcaraAnalysis }) {
  const cards = buildBeritaAcaraCards(analysis);
  return (
    <section className="recon-ba-cards" aria-label="Hasil baca otomatis Berita Acara">
      <div className="recon-sport-card">
        <span>Selisih Sistem</span>
        <b>{cards.selisihSistemLabel}</b>
      </div>
      <div className="recon-sport-card">
        <span>Nominal Berita Acara</span>
        <b>{cards.nominalBeritaAcaraLabel}</b>
      </div>
      <div className="recon-sport-card">
        <span>Hasil Pencocokan</span>
        <b>
          <span className={`recon-badge recon-badge-${cards.matchTone}`}>{cards.matchLabel}</span>
        </b>
      </div>
    </section>
  );
}

function CollapsibleSection({ title, children, defaultOpen = false, warning = false }: { title: string; children: ReactNode; defaultOpen?: boolean; warning?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <section className={`recon-disclosure${warning ? " recon-disclosure-warning" : ""}`}>
      <button type="button" className="recon-disclosure-trigger" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
        <span>{title}</span><span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && <div id={contentId} className="recon-disclosure-content">{children}</div>}
    </section>
  );
}

export default function ReconciliationPage() {
  // Reuse tema global AYOSERA (SATU sumber kebenaran: lib/theme-mode.ts,
  // localStorage key "ayo-mode" yang sama dipakai app/page.tsx & app/login) —
  // BUKAN state/localStorage tema baru khusus halaman ini. Halaman Rekonsiliasi
  // sebelumnya tidak punya toggle sendiri: `data-mode` di <html> tetap ikut
  // nilai global (recon-*/--rd-* CSS sudah mendukung dark mode dengan benar),
  // tapi user tidak punya cara melihat/mengganti mode dari halaman ini.
  const [mode, setMode] = useState<ThemeMode>("light");
  const [user, setUser] = useState<User | null>(null);
  const [items, setItems] = useState<OmzetResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null);
  const [detail, setDetail] = useState<OmzetResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [finalization, setFinalization] = useState<PeriodLock | null>(null);
  const beritaAcaraFileInputId = useId();
  const [finalFile, setFinalFile] = useState<File | null>(null);
  const [finalAmount, setFinalAmount] = useState("");
  const [finalReason, setFinalReason] = useState("");
  const [finalPreview, setFinalPreview] = useState<{ ayo: number; olsera: number; difference: number; finalAgreedAmount: number; adjustmentAmount: number; lockedDisplay: { ayo: number; olsera: number; difference: number; status: string } } | null>(null);
  const [finalBusy, setFinalBusy] = useState(false);
  const [finalError, setFinalError] = useState("");
  const [uploadSuccessMessage, setUploadSuccessMessage] = useState("");
  const [finalSaveMessage, setFinalSaveMessage] = useState("");
  const [analysis, setAnalysis] = useState<BeritaAcaraAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [analysisStatus, setAnalysisStatus] = useState("");
  // Goal 6/CRITICAL (V7): true begitu user MENGETIK SENDIRI di textarea Alasan
  // penyesuaian — sekali true, auto-fill dari analisis OCR (sekarang atau
  // hasil re-analisis berikutnya) TIDAK PERNAH menimpa isian itu lagi (lihat
  // nextReasonAfterAnalysis di lib/reconciliation-berita-acara-ui.ts).
  // Direset ke false setiap kali dokumen/periode baru dibuka — itu siklus
  // analisis baru, bukan edit atas hasil yang sama.
  //
  // ROOT CAUSE V9 (alasan penyesuaian tetap kosong walau parser sudah
  // berhasil dapat reason): field ini SEBELUMNYA `useState` biasa. openDetail
  // dan uploadFinalAttachment memanggil setReasonEditedByUser(false) untuk
  // MERESET status "sudah diedit" sebelum menjalankan analisis baru
  // (analyzeAttachment/analyzeFileClient, keduanya async & butuh beberapa
  // detik untuk OCR sungguhan) — tapi applyAnalysisResult (dipanggil setelah
  // OCR selesai) membaca `reasonEditedByUser` lewat closure JS biasa, yang
  // TERIKAT ke snapshot state pada render SAAT fungsi async itu mulai
  // dipanggil, BUKAN nilai ter-update. Jadi kalau reasonEditedByUser sempat
  // true di render manapun sebelumnya (mis. user pernah mengetik alasan
  // manual untuk periode/dokumen LAIN dalam sesi halaman yang sama), setiap
  // analisis OCR berikutnya — walau parser SUDAH punya `result.reason` yang
  // benar — akan tetap dianggap "sudah diedit user" oleh closure basi itu,
  // sehingga nextReasonAfterAnalysis mengembalikan `current` (kosong) alih-
  // alih hasil parser. useRef dipakai di sini SENGAJA (bukan useState): nilai
  // ref dibaca langsung dari objek ref saat itu juga (live), tidak pernah
  // "basi" lewat closure — pas untuk flag yang HARUS dibaca akurat di dalam
  // callback async yang mulai berjalan sebelum reset-nya sempat ter-render
  // ulang. Field ini TIDAK PERNAH dipakai untuk render (lihat JSX di bawah),
  // jadi aman sepenuhnya jadi ref (tidak butuh re-render saat berubah).
  const reasonEditedByUserRef = useRef(false);
  const [showFinalLockConfirm, setShowFinalLockConfirm] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [unlockReason, setUnlockReason] = useState("");
  // V10 Goal 9-13: "Bersihkan Riwayat Upload" — state terpisah dari
  // finalBusy/finalError supaya tidak saling mengganggu dengan aksi
  // Simpan/Kunci/Buka Kunci yang berjalan di section yang sama.
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupError, setCleanupError] = useState("");
  // V11 Goal 8-11: "×" per-item pada Riwayat Aktivitas — hideConfirmIndex
  // menyimpan INDEX ARRAY MENTAH (sama seperti urutan tersimpan di
  // finalization.history, BUKAN index tampilan yang sudah difilter/dibalik,
  // lihat map+filter+reverse di render di bawah) dari entri yang sedang
  // diminta konfirmasi hide-nya; null berarti tidak ada konfirmasi terbuka.
  const [hideConfirmIndex, setHideConfirmIndex] = useState<number | null>(null);
  const [hideBusy, setHideBusy] = useState(false);
  const [hideError, setHideError] = useState("");
  // V11 Goal 6/7: attachment yang sedang di-preview lewat modal ringan (badge
  // "Berita Acara" di tabel utama) — TERPISAH dari `selectedPeriod`/`detail`
  // (Detail Rekonsiliasi) supaya klik badge TIDAK PERNAH membuka drawer detail.
  const [quickPreviewAttachment, setQuickPreviewAttachment] = useState<PeriodLock["attachment"] | null>(null);
  // V12 Goal 8-13: "Reset Finalisasi" — kosongkan active state (attachment/
  // OCR/nominal/alasan/verified) supaya user bisa mulai ulang dari nol.
  // State terpisah dari finalBusy/finalError, pola sama seperti cleanup.
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/reconciliation/court-revenue", { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Gagal memuat rekonsiliasi omset.");
      setItems(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memuat rekonsiliasi omset.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    const initialMode = readInitialThemeMode();
    setMode(initialMode);
    document.documentElement.setAttribute("data-mode", initialMode);
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, initialMode);
  }, []);
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUser(data?.user ?? null))
      .catch(() => setUser(null));
  }, []);

  const openDetail = async (period: string) => {
    setSelectedPeriod(period);
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    setFinalization(null); setFinalFile(null); setFinalAmount(""); setFinalReason(""); setFinalPreview(null); setFinalError(""); setShowFinalLockConfirm(false); setShowUnlock(false); setUnlockReason(""); setAnalysis(null); setAnalysisError(""); setUploadSuccessMessage(""); setFinalSaveMessage(""); setShowCleanupConfirm(false); setCleanupError(""); setHideConfirmIndex(null); setHideError(""); setShowResetConfirm(false); setResetError(""); reasonEditedByUserRef.current = false;
    try {
      const response = await fetch(`/api/reconciliation/court-revenue/${period}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Gagal memuat detail bulan ini.");
      setDetail(data.data);
      setFinalization(data.data.periodLock ?? null);
      setFinalAmount(String(data.data.periodLock?.finalAgreedAmount ?? data.data.olseraTotal));
      setFinalReason(data.data.periodLock?.adjustmentReason ?? (Math.abs(data.data.differenceRevenue) <= 1 ? "Penyesuaian pembulatan rekonsiliasi" : ""));
      // V11 Goal 3/4/5 (masalah #2 V11 — root cause "Tidak terbaca"/PERLU
      // REVIEW/alasan kosong saat reopen): kalau periode ini SUDAH pernah
      // Simpan dengan hasil analisis tersimpan (hasSavedBeritaAcaraAnalysis),
      // hydrate LANGSUNG dari lock tersimpan (restoreBeritaAcaraAnalysisFromLock)
      // — JANGAN jalankan OCR ulang lewat analyzeAttachment, karena server
      // TIDAK BISA merasterisasi PDF hasil scan (lihat komentar
      // analyzeAttachment di bawah), sehingga re-analyze otomatis di sini
      // justru MENIMPA hasil COCOK yang sudah tersimpan dengan
      // PERLU_REVIEW/"Tidak terbaca" palsu. OCR ulang HANYA untuk dokumen
      // lock lama (sebelum fitur ini ada) yang punya attachment tapi belum
      // pernah Simpan analisisnya sama sekali.
      if (data.data.periodLock?.attachment && data.data.periodLock.status !== "locked") {
        if (hasSavedBeritaAcaraAnalysis(data.data.periodLock)) {
          applyAnalysisResult(restoreBeritaAcaraAnalysisFromLock(data.data.periodLock, data.data.differenceRevenue), data.data.olseraTotal);
        } else {
          void analyzeAttachment(period, data.data.olseraTotal);
        }
      }
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Gagal memuat detail bulan ini.");
    } finally {
      setDetailLoading(false);
    }
  };

  // Terapkan hasil analisis (dari jalur mana pun) ke state UI: alasan
  // (menghormati reasonEditedByUserRef — Goal 6/CRITICAL, test wajib #13) dan
  // nominal final (Goal 7 — HANYA saat COCOK, dihitung dari
  // computeAutoFinalAgreedAmount yang murni menurunkan angka INPUT untuk
  // logika finalisasi yang SUDAH ADA; previewOmzetPeriodLock di
  // lib/reconciliation-omzet-period-lock.ts tetap satu-satunya yang
  // menghitung/menyimpan adjustmentAmount sungguhan — lihat
  // lib/reconciliation-berita-acara-ui.ts).
  const applyAnalysisResult = (result: BeritaAcaraAnalysis, originalOlseraAmount: number) => {
    setAnalysis(result);
    setFinalReason((current) => nextReasonAfterAnalysis({ current, userEdited: reasonEditedByUserRef.current, parsedReason: result.reason }));
    const autoFinalAmount = computeAutoFinalAgreedAmount({ originalOlseraAmount, analysis: result });
    if (autoFinalAmount !== null) setFinalAmount(String(autoFinalAmount));
    setFinalPreview(null);
    setShowFinalLockConfirm(false);
  };

  // Fallback: dipakai saat TIDAK ada objek File lokal (mis. membuka kembali
  // periode dengan attachment yang sudah tersimpan dari sesi sebelumnya) —
  // baca via server (lib/reconciliation-berita-acara-ocr.ts). Untuk PDF hasil
  // scan, server jujur melaporkan pdf-scanned-unsupported/PERLU_REVIEW
  // (rasterisasi PDF butuh binary native yang dilarang di server); jalur
  // BROWSER (analyzeFileClient di bawah, dipakai persis setelah upload saat
  // File masih ada di tangan) yang benar-benar men-support PDF hasil scan.
  // `originalOlseraAmount` WAJIB dikirim eksplisit oleh caller (bukan dibaca
  // dari state `detail` di sini) — saat dipanggil dari openDetail() persis
  // setelah setDetail(), closure `detail` di sini masih merujuk render
  // SEBELUMNYA (state React belum flush), jadi mengandalkannya di sini akan
  // memakai Total Omzet Olsera periode yang SALAH (basi/periode lain).
  const analyzeAttachment = async (period: string, originalOlseraAmount: number) => {
    setAnalysisLoading(true); setAnalysisError(""); setAnalysis(null); setAnalysisStatus("");
    try {
      const response = await fetch(`/api/reconciliation/court-revenue/${period}/finalization/analyze`, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Gagal membaca berita acara secara otomatis.");
      applyAnalysisResult(data.data as BeritaAcaraAnalysis, originalOlseraAmount);
    } catch (e) {
      setAnalysisError(e instanceof Error ? e.message : "Gagal membaca berita acara secara otomatis.");
    } finally {
      setAnalysisLoading(false);
    }
  };

  // Analisis BROWSER-SIDE: dipakai persis setelah upload, saat File yang
  // dipilih user masih tersedia di memori (lib/reconciliation-berita-acara-client-ocr.ts).
  // Ini satu-satunya jalur yang benar-benar men-support PDF Berita Acara hasil
  // scan (image-only) — server tidak bisa rasterisasi PDF tanpa binary native.
  // Kegagalan APA PUN (OCR crash, PDF korup, dsb.) TIDAK PERNAH ditebak —
  // langsung jatuh ke pesan fallback manual di bawah, dan status pencocokan
  // tidak pernah diisi otomatis.
  //
  // ROOT CAUSE V7 (lihat lib/csp.ts): sebelum perbaikan CSP, panggilan
  // analyzeBeritaAcaraFileClient di bawah SELALU melempar (tesseract.js
  // diblokir CSP saat fetch worker/core/lang CDN-nya) untuk dokumen hasil
  // scan/foto — persis kelas dokumen Berita Acara sungguhan yang dipakai
  // user (tanda tangan basah discan). Kegagalan itu jatuh ke catch di bawah
  // dan HANYA mengisi analysisError — `analysis` tidak pernah ke-set, jadi 3
  // kartu hasil dan alasan auto-fill tidak pernah tampil walau upload
  // attachment-nya sendiri sukses. Wiring applyAnalysisResult di sini TIDAK
  // BERUBAH secara struktur — yang berubah adalah CSP-nya (root cause
  // sebenarnya).
  const analyzeFileClient = async (file: File) => {
    setAnalysisLoading(true); setAnalysisError(""); setAnalysis(null); setAnalysisStatus(STATUS_READING);
    try {
      const systemDifference = detail?.differenceRevenue ?? 0;
      const result = await analyzeBeritaAcaraFileClient(file, systemDifference, { onStatus: setAnalysisStatus });
      applyAnalysisResult(result, detail?.olseraTotal ?? 0);
    } catch (e) {
      console.error("[reconciliation:client-ocr]", e);
      // Dokumen belum dapat dibaca otomatis — user tetap bisa lanjut lewat
      // isian manual (nominal/arah/alasan) di bawah, preview tetap wajib
      // sebelum Kunci Periode (canLockFinalization tidak pernah otomatis
      // meloloskan status ini).
      setAnalysisError("Dokumen belum dapat dibaca otomatis. Periksa hasil dan isi data secara manual.");
    } finally {
      setAnalysisLoading(false);
      setAnalysisStatus("");
    }
  };

  const finalizationRequest = async (path: string, init: RequestInit) => {
    if (!selectedPeriod) throw new Error("Periode belum dipilih.");
    const response = await fetch(`/api/reconciliation/court-revenue/${selectedPeriod}/finalization/${path}`, init);
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || "Permintaan finalisasi gagal.");
    return data;
  };
  const uploadFinalAttachment = async () => {
    if (!finalFile) return; setFinalBusy(true); setFinalError(""); setUploadSuccessMessage(""); setFinalSaveMessage("");
    // Dokumen baru diunggah = siklus analisis baru: edit alasan dari dokumen
    // SEBELUMNYA tidak relevan lagi untuk hasil OCR dokumen ini (Goal 6).
    reasonEditedByUserRef.current = false;
    try { const uploadedFile = finalFile; const form = new FormData(); form.set("file", finalFile); if (finalization) form.set("version", String(finalization.version)); const data = await finalizationRequest("upload", { method: "POST", body: form }); setFinalization(data.data); setFinalFile(null); setFinalPreview(null); setShowFinalLockConfirm(false); setUploadSuccessMessage("Berita Acara berhasil diunggah"); void analyzeFileClient(uploadedFile); }
    catch (error) { setFinalError(error instanceof Error ? error.message : "Gagal mengunggah berita acara."); }
    finally { setFinalBusy(false); }
  };
  // "Simpan" di UI = memanggil endpoint preview yang sama (recordOmzetPeriodLockPreview
  // di lib/reconciliation-omzet-period-lock.ts) — INI SENGAJA, bukan endpoint baru.
  // Precondition keamanan Kunci Periode (history terakhir harus "preview" yang
  // cocok persis dengan finalAgreedAmount/adjustmentReason saat ini) tidak boleh
  // dilemahkan, jadi "Simpan" secara internal tetap merekam entri "preview" yang
  // sama persis seperti sebelumnya — hanya label dan pesan sukses yang berubah
  // untuk user, bukan mekanisme keamanannya.
  const previewFinalization = async () => {
    setFinalBusy(true); setFinalError(""); setFinalSaveMessage("");
    try {
      // V10 Goal 7: kirim nominal/arah Berita Acara HASIL ANALISIS (kalau
      // ada) supaya server bisa menghitung verifiedMatchStatus SENDIRI
      // (matchBeritaAcaraToSystemDifference terhadap selisih sistem server,
      // bukan klaim client) — inilah yang membuat status tabel utama bisa
      // langsung "Cocok" begitu Simpan sukses, tanpa menunggu Kunci Periode.
      const data = await finalizationRequest("preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: finalization?.version, finalAgreedAmount: Number(finalAmount), adjustmentReason: finalReason, beritaAcaraNominal: analysis?.nominal ?? null, beritaAcaraDirection: analysis?.direction ?? null, beritaAcaraPeriod: analysis?.period ?? null }) });
      setFinalPreview(data.data);
      setFinalization(data.lock);
      setFinalSaveMessage("Finalisasi berhasil disimpan.");
      // Tabel utama (items) TIDAK otomatis ikut ter-update dari state
      // finalization di atas (fetch terpisah) — refresh supaya status/icon
      // Berita Acara di tabel langsung mencerminkan Simpan ini.
      await refresh();
    }
    catch (error) { setFinalError(error instanceof Error ? error.message : "Gagal menyimpan finalisasi."); }
    finally { setFinalBusy(false); }
  };
  const lockFinalization = async () => {
    if (!finalization) return; setFinalBusy(true); setFinalError("");
    try { await finalizationRequest("lock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: finalization.version, finalAgreedAmount: Number(finalAmount), adjustmentReason: finalReason }) }); if (selectedPeriod) { await openDetail(selectedPeriod); await refresh(); } }
    catch (error) { setFinalError(error instanceof Error ? error.message : "Gagal mengunci periode."); }
    finally { setFinalBusy(false); }
  };
  const unlockFinalization = async () => {
    if (!finalization) return; setFinalBusy(true); setFinalError("");
    try { await finalizationRequest("unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: finalization.version, reason: unlockReason }) }); if (selectedPeriod) { await openDetail(selectedPeriod); await refresh(); } }
    catch (error) { setFinalError(error instanceof Error ? error.message : "Gagal membuka kunci periode."); }
    finally { setFinalBusy(false); }
  };
  // V10 Goal 9-13: hapus HANYA entri "upload" lama/duplikat dari Riwayat
  // Aktivitas (lihat cleanupOmzetPeriodUploadHistory di
  // lib/reconciliation-omzet-period-lock.ts — mempertahankan upload
  // TERAKHIR/aktif, TIDAK PERNAH menyentuh preview/lock/relock/unlock).
  const cleanupUploadHistory = async () => {
    if (!finalization) return; setCleanupBusy(true); setCleanupError("");
    try { await finalizationRequest("cleanup-upload-history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: finalization.version }) }); setShowCleanupConfirm(false); if (selectedPeriod) await openDetail(selectedPeriod); }
    catch (error) { setCleanupError(error instanceof Error ? error.message : "Gagal membersihkan riwayat unggahan."); }
    finally { setCleanupBusy(false); }
  };

  // V11 Goal 8-11: sembunyikan SATU entri Riwayat Aktivitas (soft delete —
  // lihat hideOmzetPeriodHistoryEntry di lib/reconciliation-omzet-period-lock.ts,
  // event asli TIDAK PERNAH dihapus). `entryIndex` WAJIB index array MENTAH
  // (sama seperti urutan tersimpan finalization.history), bukan index
  // tampilan yang sudah difilter/dibalik.
  const hideHistoryEntry = async (entryIndex: number) => {
    if (!finalization) return; setHideBusy(true); setHideError("");
    try { await finalizationRequest("hide-history-entry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: finalization.version, entryIndex }) }); setHideConfirmIndex(null); if (selectedPeriod) await openDetail(selectedPeriod); }
    catch (error) { setHideError(error instanceof Error ? error.message : "Gagal menyembunyikan item riwayat."); }
    finally { setHideBusy(false); }
  };

  // V12 Goal 8-13: "Reset Finalisasi" — kosongkan active finalization state
  // (attachment/verifiedMatchStatus/beritaAcaraNominal/beritaAcaraDirection/
  // nominal final/alasan) supaya periode kembali "belum difinalisasi" dan
  // user bisa mulai ulang siklus Upload -> OCR -> Simpan dari nol. Riwayat
  // lama TIDAK dihapus (soft-hide di server, lihat
  // resetOmzetPeriodFinalization di lib/reconciliation-omzet-period-lock.ts)
  // — openDetail dipanggil ulang supaya SEMUA state lokal (analysis/
  // attachment/finalAmount/finalReason/dst.) ikut ter-reset dari database,
  // BUKAN hanya field yang di-set manual di sini; refresh() memperbarui
  // badge/status di tabel utama (attachment hilang -> badge Berita Acara
  // ikut hilang, sama seperti pola lock/unlock).
  const resetFinalization = async () => {
    if (!finalization) return; setResetBusy(true); setResetError("");
    try { await finalizationRequest("reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: finalization.version }) }); setShowResetConfirm(false); if (selectedPeriod) { await openDetail(selectedPeriod); await refresh(); } }
    catch (error) { setResetError(error instanceof Error ? error.message : "Gagal mereset finalisasi."); }
    finally { setResetBusy(false); }
  };

  // Gating Simpan (Goal 8, test wajib #14): attachment ada, tidak sedang
  // busy/analisis, alasan diisi, nominal final berupa integer valid. SENGAJA
  // tidak menyertakan matchStatus (lihat komentar di
  // canSaveBeritaAcaraFinalization) — jangan pernah blokir total user dari
  // menyimpan koreksi manual.
  const canSaveFinalization = canSaveBeritaAcaraFinalization({ hasAttachment: Boolean(finalization?.attachment), busy: finalBusy, analysisLoading, reason: finalReason, finalAmount });
  // Gating Kunci Periode (Langkah 8/9, test wajib #15): TIDAK PERNAH otomatis
  // blokir total — hanya mismatch YANG DIKETAHUI (TIDAK_COCOK) yang menahan
  // tombol lock, DAN hanya aktif setelah Simpan sukses (finalPreview ada).
  // Belum ada analisis (dokumen lama/kompat mundur) atau PERLU_REVIEW tetap
  // membuka jalur manual (user isi sendiri lalu preview ulang), sesuai
  // instruksi: jangan pernah memblokir total user pada data yang tidak pasti.
  const canLockFinalization = canLockAfterSave({ hasPreview: Boolean(finalPreview), busy: finalBusy, matchStatus: analysis?.matchStatus });

  // V10 Goal 7/8: diturunkan LANGSUNG dari `finalization` (state periodLock,
  // di-update setiap Simpan/Lock/Unlock — lihat previewFinalization dkk di
  // atas) alih-alih `detail.beritaAcaraVerified` (snapshot yang hanya
  // diambil sekali saat openDetail) — supaya banner/wording di drawer detail
  // langsung berubah begitu Simpan sukses, TANPA perlu refetch detail penuh
  // (yang akan membuang finalPreview yang baru saja ditampilkan). Predikat
  // ini SENGAJA sama persis dengan isBeritaAcaraVerifiedUnlocked di
  // lib/reconciliation-omzet-period-lock.ts (server) — duplikasi kecil yang
  // disengaja demi live-update tanpa refetch.
  const beritaAcaraVerified = Boolean(finalization && finalization.status !== "locked" && finalization.verifiedMatchStatus === "COCOK");
  // V11 Goal 1/2: begitu TOTAL periode ter-verifikasi BA, tandai HANYA
  // component (COURT/PICKLEBALL) yang jadi SATU-SATUNYA penyebab PERLU_DICEK
  // — lihat resolveBeritaAcaraVerifiedComponent untuk guard ambiguitas (dua
  // component sama-sama PERLU_DICEK -> tidak ditempelkan ke siapa pun).
  const componentVerified = detail ? resolveBeritaAcaraVerifiedComponent(detail.sportReconciliation, beritaAcaraVerified) : { court: false, pickleball: false };

  const supervisor = Boolean(user);
  if (user && !user.allowedModules.includes("rekonsiliasi") && !supervisor) {
    return (
      <main className="recon-page">
        <p className="recon-empty">Akses ditolak. Hubungi supervisor untuk meminta modul Rekonsiliasi.</p>
      </main>
    );
  }

  return (
    <main className="recon-page">
      <header className="recon-header">
        <div>
          <Link href="/" className="recon-back">
            ← Kembali ke Dashboard
          </Link>
          <h1>Rekonsiliasi Omzet AYOSERA</h1>
          <p>
            Omzet AYO (booking eligible) vs Omzet Olsera — akun ledger 40001 (Court Fees) + 40004 (Pickleball) sebelum reklasifikasi, diverifikasi ke akun 21003. Per bulan.
          </p>
        </div>
        <div style={{ display: "flex", gap: ".5rem" }}>
          <a href="/reconciliation/inventory" className="recon-button secondary">
            Rekonsiliasi Inventori
          </a>
          <button className="recon-button secondary" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} /> Muat ulang
          </button>
          <button
            type="button"
            className="recon-button secondary"
            aria-label={mode === "dark" ? "Ganti ke Light Mode" : "Ganti ke Dark Mode"}
            title={mode === "dark" ? "Light Mode" : "Dark Mode"}
            onClick={() =>
              setMode((current) => {
                const next: ThemeMode = current === "dark" ? "light" : "dark";
                document.documentElement.setAttribute("data-mode", next);
                window.localStorage.setItem(THEME_MODE_STORAGE_KEY, next);
                return next;
              })
            }
          >
            {mode === "dark" ? <Sun /> : <Moon />}
          </button>
        </div>
      </header>

      {error ? (
        <section className="recon-empty">
          <p>{error}</p>
          <button className="recon-button" onClick={() => void refresh()}>
            Coba lagi
          </button>
        </section>
      ) : loading ? (
        <section className="recon-skeleton">Memuat rekonsiliasi omset…</section>
      ) : !items?.length ? (
        <section className="recon-empty">
          <FileSearch />
          <p>Belum ada data untuk ditampilkan.</p>
        </section>
      ) : (
        <section className="recon-table-wrap">
          <table className="recon-table">
            <thead>
              <tr>
                <th>Bulan</th>
                <th>Omzet AYO</th>
                <th>Omzet Olsera (40001+40004)</th>
                <th>Selisih</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.period}>
                  <td>{monthLabel(row.period)}</td>
                  <td>{formatRupiah(row.ayo.revenue)}</td>
                  <td>{row.dataAvailable ? formatRupiah(row.olseraTotal) : "Data belum tersedia"}</td>
                  <td>{row.dataAvailable ? formatRupiah(row.differenceRevenue) : "-"}</td>
                  <td>
                    {/*
                    <StatusBadge status={row.status} /> {row.periodLock?.status === "locked" ? <span className="recon-badge recon-badge-ok" title="Detail Penyesuaian"><Lock size={12} /> Cocok â€” Terkunci · Detail Penyesuaian</span> : row.explanation?.locked && <LockBadge />}
                    */}
                    {/* V11 Goal 6/7: badge klik -> modal Preview Berita Acara ringan
                        (bukan buka Detail) — HANYA saat attachment benar-benar
                        ada (Goal 7: jangan tampil badge palsu/tidak bisa
                        diklik ke mana-mana). stopPropagation berjaga-jaga
                        walau badge di sini sudah di <td> terpisah dari
                        tombol Detail (tidak nested). */}
                    <StatusBadge status={reconciliationOmzetUiStatus(row.status, row.differenceRevenue, row.beritaAcaraVerified)} /> {row.periodLock?.status === "locked" ? <span className="recon-badge recon-badge-ok" title="Detail Penyesuaian"><Lock size={12} /> Cocok — Terkunci · Detail Penyesuaian</span> : row.beritaAcaraVerified && row.periodLock?.attachment ? <BeritaAcaraVerifiedBadge onClick={(event) => { event.stopPropagation(); setQuickPreviewAttachment(row.periodLock!.attachment); }} /> : row.explanation?.locked && <LockBadge />}
                  </td>
                  <td>
                    <button className="recon-link" onClick={() => void openDetail(row.period)}>
                      Detail <ChevronRight />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="recon-mobile-list">
            {items.map((row) => (
              // V11 Goal 6: `<div role="button">` (BUKAN <button>) — badge BA di
              // dalamnya SEKARANG bisa jadi <button> sungguhan sendiri
              // (BeritaAcaraVerifiedBadge onClick), dan <button> nested di
              // dalam <button> tidak valid HTML/aksesibilitas. onKeyDown
              // mempertahankan aktivasi keyboard yang biasanya gratis dari
              // elemen <button> asli.
              <div
                key={row.period}
                role="button"
                tabIndex={0}
                className="recon-mobile-card"
                onClick={() => void openDetail(row.period)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void openDetail(row.period); } }}
              >
                <div>
                  <strong>{monthLabel(row.period)}</strong>
                  <span>
                    AYO {formatRupiah(row.ayo.revenue)} · Olsera {row.dataAvailable ? formatRupiah(row.olseraTotal) : "belum tersedia"}
                  </span>
                </div>
                <div>
                  {/*
                  <StatusBadge status={row.status} /> {row.periodLock?.status === "locked" ? <span className="recon-badge recon-badge-ok" title="Detail Penyesuaian"><Lock size={12} /> Cocok â€” Terkunci</span> : row.explanation?.locked && <LockBadge />}
                  */}
                  <StatusBadge status={reconciliationOmzetUiStatus(row.status, row.differenceRevenue, row.beritaAcaraVerified)} /> {row.periodLock?.status === "locked" ? <span className="recon-badge recon-badge-ok" title="Detail Penyesuaian"><Lock size={12} /> Cocok — Terkunci</span> : row.beritaAcaraVerified && row.periodLock?.attachment ? <BeritaAcaraVerifiedBadge onClick={(event) => { event.stopPropagation(); setQuickPreviewAttachment(row.periodLock!.attachment); }} /> : row.explanation?.locked && <LockBadge />}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {selectedPeriod && (
        <aside key={selectedPeriod} className="recon-drawer" role="dialog" aria-modal="true" aria-label="Detail rekonsiliasi bulan">
          <div className="recon-drawer-head">
            <div>
              <p className="recon-eyebrow">Detail Rekonsiliasi Omzet</p>
              <h2>{monthLabel(selectedPeriod)}</h2>
            </div>
            <button aria-label="Tutup detail" onClick={() => setSelectedPeriod(null)}>
              <X />
            </button>
          </div>
          {detailLoading ? (
            <div className="recon-skeleton">Memuat detail…</div>
          ) : detailError ? (
            <div className="recon-empty">
              <p>{detailError}</p>
              <button className="recon-button" onClick={() => void openDetail(selectedPeriod)}>
                Coba lagi
              </button>
            </div>
          ) : detail ? (
            <div className="recon-drawer-body">
              {detail.status === "BULAN_BERJALAN" && (
                <p className="recon-draft">
                  <AlertTriangle /> <strong>Bulan berjalan.</strong> Data masih dapat berubah sampai bulan ini ditutup dan jurnal penutup/reklasifikasi diproses.
                </p>
              )}
              {!detail.dataAvailable && detail.status !== "BULAN_BERJALAN" && (
                <p className="recon-special">
                  <AlertTriangle /> <strong>Data belum dapat diverifikasi.</strong> Ledger akun 40001/40004 belum tersedia (belum disinkronkan) untuk periode ini.
                </p>
              )}
              {/* V10 Goal 6: wording "menunggu verifikasi" -> "telah diverifikasi"
                  HANYA saat beritaAcaraVerified true (Simpan sudah server-verified
                  COCOK) — selisih ASLI (detail.differenceRevenue, tidak diubah)
                  tetap muncul di kalimatnya, periode BELUM diverifikasi tetap
                  memakai detail.statusReason apa adanya dari server. */}
              <p className="recon-readonly">
                <strong>Penyebab status:</strong> {beritaAcaraVerified ? `Selisih ${formatRupiah(detail.differenceRevenue)} telah diverifikasi dengan Berita Acara.` : detail.statusReason}
              </p>

              <section className="recon-sport-sections" aria-label="Rincian omzet per olahraga">
                {/* V11 Goal 1/2/12: PICKLEBALL (atau COURT, tergantung mana
                    yang jadi SATU-SATUNYA penyebab Perlu Dicek — lihat
                    componentVerified/resolveBeritaAcaraVerifiedComponent)
                    sekarang ikut "Cocok + Berita Acara" begitu total periode
                    ter-verifikasi, BUKAN cuma TOTAL GABUNGAN seperti V10 —
                    supaya tidak ada campuran TOTAL Cocok tapi PICKLEBALL
                    Perlu Dicek untuk selisih yang sama yang sudah
                    diverifikasi BA. */}
                <SportReconciliationCard title="COURT" ayoLabel="Omzet AYO Court" olseraLabel="Olsera akun 40001" comparison={detail.sportReconciliation.court} finalStatus={componentVerified.court ? "COCOK" : undefined} beritaAcaraVerified={componentVerified.court} />
                <SportReconciliationCard title="PICKLEBALL" ayoLabel="Omzet AYO Pickleball" olseraLabel="Olsera akun 40004" comparison={detail.sportReconciliation.pickleball} finalStatus={componentVerified.pickleball ? "COCOK" : undefined} beritaAcaraVerified={componentVerified.pickleball} />
                <SportReconciliationCard
                  title="TOTAL GABUNGAN"
                  ayoLabel="Total Omzet AYO"
                  olseraLabel="Total Omzet Olsera (40001+40004)"
                  comparison={{ ayo: detail.sportReconciliation.total, olsera: detail.olseraTotal, difference: detail.differenceRevenue, status: reconciliationOmzetUiStatus(detail.status, detail.differenceRevenue, beritaAcaraVerified) === "COCOK" ? "COCOK" : "PERLU_DICEK" }}
                  finalStatus={reconciliationOmzetUiStatus(detail.status, detail.differenceRevenue, beritaAcaraVerified)}
                  beritaAcaraVerified={beritaAcaraVerified}
                  wide
                  locked={detail.periodLock?.status === "locked"}
                />
              </section>

              {detail.sportReconciliation.unmapped.count > 0 && (
                <CollapsibleSection title={`AYO Belum Terpetakan (${detail.sportReconciliation.unmapped.count})`} warning>
                <p className="recon-special">
                  <AlertTriangle /> <span><strong>AYO Belum Terpetakan.</strong> {detail.sportReconciliation.unmapped.count} event/booking senilai {formatRupiah(detail.sportReconciliation.unmapped.revenue)} tetap termasuk Total Gabungan.</span>
                </p>
                </CollapsibleSection>
              )}

              {/*
                V5: accordion detail teknis reklasifikasi 40004 -> 21003 dihapus
                dari tampilan atas permintaan (membingungkan sebagian besar user).
                Data dan logika backend (detail.pickleballVerification, dsb.)
                TIDAK dihapus -- tetap dikirim API dan tetap dipakai internal oleh
                engine rekonsiliasi bila perlu; hanya rendernya yang dihilangkan.
              */}

              {finalization?.status === "locked" && <p className="recon-lock-summary"><Lock size={14} /> Cocok — Terkunci · Detail Penyesuaian tersedia di Berita Acara dan Finalisasi.</p>}
              {/* V10 Goal 7: status Cocok begitu Simpan sukses server-verified,
                  TIDAK menunggu Kunci Periode (yang tetap langkah terpisah,
                  lihat tombol Kunci Periode di bawah). */}
              {beritaAcaraVerified && <p className="recon-lock-summary"><FileCheck size={14} /> Cocok — Selisih telah diverifikasi dengan Berita Acara.</p>}
              {supervisor && (
                <CollapsibleSection title="Berita Acara dan Finalisasi">
                <section className="recon-finalization">
                  {/* V8 Goal 1: metadata mentah (nama file panjang/ukuran/raw actor id,
                      dulunya "<file> (<size> KB) — diunggah <tanggal> oleh <raw id>")
                      TIDAK LAGI ditampilkan di sini — data itu tetap tersimpan di
                      backend (finalization.attachment) dan tetap terlihat, dalam
                      bentuk manusiawi (nama aktor, bukan raw id), di Riwayat
                      Aktivitas di bawah. */}
                  {!finalization?.attachment && <p className="recon-before">Unggah berita acara PDF/JPG/JPEG/PNG (maks. 10MB) sebelum preview dan lock.</p>}
                  {/* Goal 2/10: preview tampil begitu ada attachment, TERLEPAS dari status OCR/lock — user harus tetap bisa melihat dokumennya walau OCR gagal atau periode sudah terkunci. key={url}: upload baru (URL beda) -> preview otomatis terbuka lagi (Goal 2 V8). */}
                  {finalization?.attachment && <BeritaAcaraPreview key={finalization.attachment.url} attachment={finalization.attachment} />}
                  {finalization?.status !== "locked" && (
                    <>
                      {analysisLoading && <p className="recon-before">{analysisStatus || "Membaca berita acara..."}</p>}
                      {analysisError && <p className="recon-error">{analysisError} <button className="recon-link" onClick={() => selectedPeriod && void analyzeAttachment(selectedPeriod, detail?.olseraTotal ?? 0)}>Coba baca ulang</button></p>}
                      {analysis && <BeritaAcaraResultCards analysis={analysis} />}
                      {analysis?.matchStatus === "TIDAK_COCOK" && <p className="recon-error"><AlertTriangle size={14} /> Nominal/arah Berita Acara TIDAK cocok dengan selisih sistem. Periksa dokumen sebelum melanjutkan; preview dan lock ditahan sampai direview.</p>}
                      {analysis?.matchStatus === "PERLU_REVIEW" && <p className="recon-special"><AlertTriangle size={14} /> Berita Acara perlu direview manual (nominal/arah tidak terbaca otomatis, atau OCR belum yakin). Isi field di bawah secara manual.</p>}
                      {analysis?.matchStatus === "SALAH_PERIODE" && <p className="recon-error"><AlertTriangle size={14} /> Periode Berita Acara tidak sesuai dengan periode yang sedang dibuka. Periksa dokumen sebelum melanjutkan.</p>}
                      <div className="recon-file-picker">
                        <div className="recon-actions">
                          <input
                            id={beritaAcaraFileInputId}
                            type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                            className="recon-file-input-hidden"
                            disabled={finalBusy}
                            onChange={(event) => { setFinalFile(event.target.files?.[0] ?? null); setUploadSuccessMessage(""); }}
                          />
                          <label htmlFor={beritaAcaraFileInputId} className={`recon-button secondary recon-file-trigger${finalBusy ? " is-disabled" : ""}`}>
                            <Paperclip size={14} /> Pilih File
                          </label>
                          <button className="recon-button secondary" disabled={!finalFile || finalBusy} onClick={() => void uploadFinalAttachment()}><Paperclip size={14} /> Upload File</button>
                        </div>
                        {finalFile && <p className="recon-file-name">{finalFile.name}</p>}
                      </div>
                      {uploadSuccessMessage && <p className="recon-lock-summary">{uploadSuccessMessage}</p>}
                      <label className="recon-upload-label">Nominal final disepakati
                        <input type="number" step="1" value={finalAmount} disabled={finalBusy || !finalization?.attachment || analysis?.matchStatus === "COCOK"} onChange={(event) => { setFinalAmount(event.target.value); setFinalPreview(null); setShowFinalLockConfirm(false); setFinalSaveMessage(""); }} />
                        {/* Goal 7: tampilan Rupiah HANYA di lapisan UI — input/state tetap integer mentah, tidak ada perhitungan baru di sini. */}
                        {finalAmount.trim() !== "" && Number.isFinite(Number(finalAmount)) && <small className="recon-before">{formatRupiah(Number(finalAmount))}</small>}
                      </label>
                      <label className="recon-upload-label">Alasan penyesuaian
                        <textarea value={finalReason} disabled={finalBusy || !finalization?.attachment} onChange={(event) => { setFinalReason(event.target.value); reasonEditedByUserRef.current = true; setFinalPreview(null); setShowFinalLockConfirm(false); setFinalSaveMessage(""); }} />
                      </label>
                      <div className="recon-actions">
                        <button className="recon-button secondary" disabled={!canSaveFinalization} onClick={() => void previewFinalization()}>Simpan</button>
                        <button className="recon-button" disabled={!canLockFinalization} onClick={() => setShowFinalLockConfirm(true)} title={!finalPreview ? "Simpan finalisasi terlebih dahulu sebelum mengunci periode." : analysis?.matchStatus === "TIDAK_COCOK" ? "Kunci hanya diizinkan saat Berita Acara COCOK dengan selisih sistem (atau isi manual lalu Simpan ulang)." : undefined}><Lock size={14} /> Kunci Periode</button>
                      </div>
                      {finalSaveMessage && <p className="recon-lock-summary">{finalSaveMessage}</p>}
                      {showFinalLockConfirm && <div className="recon-form" role="alertdialog" aria-label="Konfirmasi finalisasi periode"><p>Nominal final akan menjadi tampilan periode terkunci. Data sumber rekonsiliasi tetap tidak diubah.</p><div className="recon-actions"><button className="recon-button" disabled={finalBusy} onClick={() => void lockFinalization()}>Ya, Kunci Periode</button><button className="recon-button secondary" disabled={finalBusy} onClick={() => setShowFinalLockConfirm(false)}>Batal</button></div></div>}
                      {/* V12 Goal 8-13: "Reset Finalisasi" — tautan kecil
                          (recon-link, bukan recon-button) supaya tidak
                          dominan, HANYA muncul kalau memang ada sesuatu untuk
                          direset (attachment atau hasil verifikasi sudah
                          ada). Backend (reset/route.ts) tetap WAJIB
                          requireUser() sendiri — tautan ini hanya UX. */}
                      {(finalization?.attachment || finalization?.verifiedMatchStatus) && (
                        <div className="recon-actions">
                          {!showResetConfirm ? (
                            <button type="button" className="recon-link" disabled={resetBusy} onClick={() => setShowResetConfirm(true)}>
                              Reset Finalisasi
                            </button>
                          ) : (
                            <div className="recon-form" role="alertdialog" aria-label="Konfirmasi reset finalisasi">
                              <p>Reset finalisasi periode ini? Data aktif Berita Acara, hasil OCR, alasan, dan status finalisasi akan dikosongkan. Data sumber AYO/Olsera dan jejak audit tidak akan dihapus.</p>
                              <div className="recon-actions">
                                <button type="button" className="recon-button" disabled={resetBusy} onClick={() => void resetFinalization()}>
                                  Ya, Reset Finalisasi
                                </button>
                                <button type="button" className="recon-button secondary" disabled={resetBusy} onClick={() => setShowResetConfirm(false)}>
                                  Batal
                                </button>
                              </div>
                            </div>
                          )}
                          {resetError && <p className="recon-error">{resetError}</p>}
                        </div>
                      )}
                    </>
                  )}
                  {finalization?.status === "locked" && (
                    <>
                      <p className="recon-readonly"><Lock size={16} /> <strong>PERIODE DIKUNCI</strong> — Cocok. Tabel utama menampilkan nominal final, sementara angka sumber tetap tersimpan di bawah.</p>
                      {!showUnlock ? (supervisor && <button className="recon-button secondary" disabled={finalBusy} onClick={() => setShowUnlock(true)}>Buka Kunci</button>) : <div className="recon-form" role="alertdialog" aria-label="Konfirmasi buka kunci periode"><p className="recon-error">Periode akan dapat diedit dan difinalisasi ulang. Berita Acara dan histori sebelumnya tidak akan dihapus.</p><label>Alasan buka kunci<textarea value={unlockReason} maxLength={2000} onChange={(event) => setUnlockReason(event.target.value)} /></label><div className="recon-actions"><button className="recon-button" disabled={finalBusy || !unlockReason.trim()} onClick={() => void unlockFinalization()}>Buka Kunci</button><button className="recon-button secondary" disabled={finalBusy} onClick={() => setShowUnlock(false)}>Batal</button></div></div>}
                    </>
                  )}
                  {finalPreview && <div className="recon-detail-grid"><div><span>AYO asli</span><b>{formatRupiah(finalPreview.ayo)}</b></div><div><span>Olsera asli</span><b>{formatRupiah(finalPreview.olsera)}</b></div><div><span>Selisih awal</span><b>{formatRupiah(finalPreview.difference)}</b></div><div><span>Penyesuaian</span><b>{formatRupiah(finalPreview.adjustmentAmount)}</b></div><div><span>Nominal final</span><b>{formatRupiah(finalPreview.finalAgreedAmount)}</b></div><div><span>Tampilan terkunci</span><b>AYO dan Olsera {formatRupiah(finalPreview.lockedDisplay.ayo)}, selisih Rp0</b></div></div>}
                  {finalization?.status === "locked" && <div className="recon-detail-grid"><div><span>AYO asli</span><b>{formatRupiah(finalization.originalAyoAmount ?? 0)}</b></div><div><span>Olsera asli</span><b>{formatRupiah(finalization.originalOlseraAmount ?? 0)}</b></div><div><span>Selisih awal</span><b>{formatRupiah(finalization.originalDifference ?? 0)}</b></div><div><span>Penyesuaian</span><b>{formatRupiah(finalization.adjustmentAmount ?? 0)}</b></div><div><span>Nominal final</span><b>{formatRupiah(finalization.finalAgreedAmount ?? 0)}</b></div><div><span>Alasan</span><b>{finalization.adjustmentReason}</b></div><div><span>Dikunci oleh</span><b>{finalization.lockedByName}</b></div><div><span>Waktu lock</span><b>{finalization.lockedAt ? dateTimeLabel(finalization.lockedAt) : "-"}</b></div></div>}
                  {/* V8 Goal 3: label diganti jadi "Riwayat Aktivitas" (bukan label audit
                      lama), kalimat manusiawi
                      (formatPeriodLockHistoryLine di lib/reconciliation-berita-acara-ui.ts)
                      memakai actorName yang SUDAH diresolve server — raw actor id
                      TIDAK PERNAH dirender di sini. Alasan buka kunci ditampilkan
                      eksplisit untuk action "unlock" (Goal 3: "Untuk unlock tampilkan
                      juga: Alasan: ..."). */}
                  {finalization?.history?.length ? (
                    <details className="recon-json">
                      {/* V12 masalah #6: counter WAJIB menghitung HANYA history
                          yang terlihat (isHistoryEntryVisible — hiddenAt
                          null/tidak ada), BUKAN finalization.history.length
                          mentah — sebelumnya bisa tertulis "(6)" walau
                          hanya 1 item yang benar-benar tampil di bawahnya
                          setelah sebagian di-hide. Disclosure-nya sendiri
                          tetap muncul selama ADA riwayat mentah sama sekali
                          (termasuk yang semuanya sudah hidden -> tampil
                          "(0)"), supaya bukan tiba-tiba hilang total. */}
                      <summary>Riwayat Aktivitas ({finalization.history.filter(isHistoryEntryVisible).length})</summary>
                      {/* V10 Goal 9/11/13: HANYA supervisor, HANYA saat ada >1 entri
                          "upload" (duplikat/percobaan lama untuk dibersihkan) — tombol
                          kecil (recon-link, bukan recon-button) supaya tidak dominan.
                          Backend (cleanup-upload-history/route.ts) tetap WAJIB
                          requireUser() sendiri — tombol ini hanya UX, bukan
                          satu-satunya lapisan otorisasi. */}
                      {supervisor && finalization.history.filter((item) => item.action === "upload").length > 1 && (
                        <div className="recon-actions">
                          {!showCleanupConfirm ? (
                            <button type="button" className="recon-link" disabled={cleanupBusy} onClick={() => setShowCleanupConfirm(true)}>
                              Bersihkan Riwayat Upload
                            </button>
                          ) : (
                            <div className="recon-form" role="alertdialog" aria-label="Konfirmasi bersihkan riwayat upload">
                              <p>Hapus riwayat upload lama/duplikat? Riwayat Simpan, Kunci, dan Buka Kunci tidak akan dihapus.</p>
                              <div className="recon-actions">
                                <button type="button" className="recon-button" disabled={cleanupBusy} onClick={() => void cleanupUploadHistory()}>
                                  Ya, Bersihkan
                                </button>
                                <button type="button" className="recon-button secondary" disabled={cleanupBusy} onClick={() => setShowCleanupConfirm(false)}>
                                  Batal
                                </button>
                              </div>
                            </div>
                          )}
                          {cleanupError && <p className="recon-error">{cleanupError}</p>}
                        </div>
                      )}
                      <ul className="recon-history">
                        {/* V11 Goal 8-11: `originalIndex` = index di array
                            MENTAH finalization.history (SEBELUM filter/reverse
                            di bawah) — WAJIB dikirim apa adanya ke
                            hideHistoryEntry/hideOmzetPeriodHistoryEntry,
                            supaya backend menandai entri yang BENAR walau
                            tampilan sudah disaring (isHistoryEntryVisible) dan
                            dibalik urutannya di sini. Entri yang sudah
                            hiddenAt disaring keluar dari render sama sekali
                            (Goal 9/11: soft delete — datanya tetap ada di DB,
                            hanya tidak dirender). */}
                        {finalization.history
                          .map((item, originalIndex) => ({ item, originalIndex }))
                          .filter(({ item }) => isHistoryEntryVisible(item))
                          .slice()
                          .reverse()
                          .map(({ item, originalIndex }) => {
                            const line = formatPeriodLockHistoryLine(item);
                            return (
                              <li key={`${item.timestamp}-${originalIndex}`}>
                                <div className="recon-actions" style={{ justifyContent: "space-between" }}>
                                  <span>{line.summary}</span>
                                  {supervisor &&
                                    (hideConfirmIndex === originalIndex ? (
                                      <span className="recon-actions">
                                        <small>Sembunyikan?</small>
                                        <button type="button" className="recon-link" disabled={hideBusy} onClick={() => void hideHistoryEntry(originalIndex)}>
                                          Ya
                                        </button>
                                        <button type="button" className="recon-link" disabled={hideBusy} onClick={() => setHideConfirmIndex(null)}>
                                          Batal
                                        </button>
                                      </span>
                                    ) : (
                                      <button type="button" className="recon-link" aria-label="Sembunyikan item riwayat ini" title="Sembunyikan item riwayat ini dari tampilan (data asli tetap tersimpan untuk audit)" disabled={hideBusy} onClick={() => setHideConfirmIndex(originalIndex)}>
                                        <X size={12} />
                                      </button>
                                    ))}
                                </div>
                                <small>{dateTimeLabel(item.timestamp)}</small>
                                {line.reason && <small>Alasan: {line.reason}</small>}
                              </li>
                            );
                          })}
                      </ul>
                      {hideError && <p className="recon-error">{hideError}</p>}
                    </details>
                  ) : null}
                  {finalError && <p className="recon-error">{finalError}</p>}
                </section>
                </CollapsibleSection>
              )}

              {detail.explanation && detail.explanation.evidenceType === LOCK_WITHOUT_EXPLANATION_MARKER ? (
                <>
                  <h3>Status Cocok Dikunci</h3>
                  <ul className="recon-history">
                    <li>
                      <span>Dikunci langsung dari status Cocok — tidak ada selisih untuk dijelaskan.</span>
                      <small>
                        <Lock size={12} /> Dikunci oleh {detail.explanation.lockedBy} pada {dateTimeLabel(detail.explanation.lockedAt)}
                      </small>
                    </li>
                  </ul>
                </>
              ) : detail.explanation ? (
                <>
                  <h3>Penjelasan selisih</h3>
                  <ul className="recon-history">
                    <li>
                      {/* evidenceType di sini TIDAK PERNAH LOCK_WITHOUT_EXPLANATION_MARKER — sudah ditangkap cabang di atas; cast murni supaya TS tahu itu */}
                      <span>{EVIDENCE_LABEL[detail.explanation.evidenceType as EvidenceType]} — {formatRupiah(detail.explanation.explainedAmount)}</span>
                      <span>{detail.explanation.description}</span>
                      <small>oleh {detail.explanation.createdBy} · {dateLabel(detail.explanation.updatedAt)}</small>
                      <small>
                        {detail.explanation.attachmentUrl ? (
                          <a href={detail.explanation.attachmentUrl} target="_blank" rel="noreferrer" className="recon-link">
                            <Paperclip size={12} /> Lihat Lampiran Berita Acara{detail.explanation.attachmentFileName ? ` (${detail.explanation.attachmentFileName})` : ""}
                          </a>
                        ) : (
                          "Belum ada lampiran"
                        )}
                      </small>
                      {detail.explanation.locked && (
                        <small>
                          <Lock size={12} /> Dikunci oleh {detail.explanation.lockedBy} pada {dateTimeLabel(detail.explanation.lockedAt)}
                        </small>
                      )}
                    </li>
                  </ul>
                </>
              ) : null}

            </div>
          ) : null}
        </aside>
      )}
      {/* V11 Goal 6/7: modal ringan Preview Berita Acara dari badge tabel
          utama — TERPISAH dari drawer Detail Rekonsiliasi (`selectedPeriod`
          di atas) supaya klik badge tidak pernah membuka Detail. */}
      {quickPreviewAttachment && <BeritaAcaraQuickPreviewModal attachment={quickPreviewAttachment} onClose={() => setQuickPreviewAttachment(null)} />}
    </main>
  );
}
