"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronRight, FileSearch, Lock, Paperclip, RefreshCw, X } from "lucide-react";
import { reconciliationOmzetUiStatus } from "@/lib/reconciliation-omzet-ui";
import { analyzeBeritaAcaraFileClient, STATUS_READING } from "@/lib/reconciliation-berita-acara-client-ocr";

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
type PeriodLock = { status: "draft" | "locked" | "unlocked"; version: number; originalAyoAmount: number | null; originalOlseraAmount: number | null; originalDifference: number | null; finalAgreedAmount: number | null; adjustmentAmount: number | null; adjustmentReason: string | null; attachment: { fileName: string; mimeType: string; size: number; url: string; uploadedAt: string; uploadedBy: string } | null; lockedAt: string | null; lockedBy: string | null; unlockedAt: string | null; unlockedBy: string | null; history: Array<{ action: string; actor: string; timestamp: string; reason: string | null }> };
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
};
type User = { id: string; role: "supervisor" | "user"; allowedModules: string[] };
type BeritaAcaraAnalysis = {
  systemDifference: number;
  nominal: number | null;
  direction: "PENAMBAHAN" | "PENGURANGAN" | null;
  reason: string | null;
  parseStatus: "OK" | "PERLU_REVIEW";
  matchStatus: "COCOK" | "TIDAK_COCOK" | "PERLU_REVIEW";
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

function formatRupiah(value: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value).replace(/\s/g, "");
}
function formatSignedRupiah(value: number) {
  return `${value > 0 ? "+" : ""}${formatRupiah(value)}`;
}
const MATCH_STATUS_LABEL: Record<"COCOK" | "TIDAK_COCOK" | "PERLU_REVIEW", string> = {
  COCOK: "COCOK",
  TIDAK_COCOK: "TIDAK COCOK",
  PERLU_REVIEW: "PERLU REVIEW",
};
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

function SportReconciliationCard({ title, ayoLabel, olseraLabel, comparison, finalStatus, wide = false, locked = false }: { title: string; ayoLabel: string; olseraLabel: string; comparison: SportComparison; finalStatus?: OmzetStatus; wide?: boolean; locked?: boolean }) {
  return (
    <section className={`recon-sport-card${wide ? " recon-sport-card-wide" : ""}`}>
      <h3>{title}</h3>
      <div className="recon-detail-grid">
        <div><span>{ayoLabel}</span><b>{formatRupiah(comparison.ayo.revenue)}</b></div>
        <div><span>{olseraLabel}</span><b>{formatRupiah(comparison.olsera)}</b></div>
        <div><span>Selisih (Olsera - AYO)</span><b>{formatRupiah(comparison.difference)}</b></div>
        <div><span>Status</span><div className="recon-card-status"><StatusBadge status={finalStatus ?? comparison.status} /> {locked && <span className="recon-badge recon-badge-ok"><Lock size={12} /> Cocok â€” Terkunci</span>}</div></div>
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
  const [user, setUser] = useState<User | null>(null);
  const [items, setItems] = useState<OmzetResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null);
  const [detail, setDetail] = useState<OmzetResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [finalization, setFinalization] = useState<PeriodLock | null>(null);
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
  const [showFinalLockConfirm, setShowFinalLockConfirm] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [unlockReason, setUnlockReason] = useState("");

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
    setFinalization(null); setFinalFile(null); setFinalAmount(""); setFinalReason(""); setFinalPreview(null); setFinalError(""); setShowFinalLockConfirm(false); setShowUnlock(false); setUnlockReason(""); setAnalysis(null); setAnalysisError(""); setUploadSuccessMessage(""); setFinalSaveMessage("");
    try {
      const response = await fetch(`/api/reconciliation/court-revenue/${period}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Gagal memuat detail bulan ini.");
      setDetail(data.data);
      setFinalization(data.data.periodLock ?? null);
      setFinalAmount(String(data.data.periodLock?.finalAgreedAmount ?? data.data.olseraTotal));
      setFinalReason(data.data.periodLock?.adjustmentReason ?? (Math.abs(data.data.differenceRevenue) <= 1 ? "Penyesuaian pembulatan rekonsiliasi" : ""));
      // Dokumen lock lama (sebelum fitur baca-otomatis ini ada) tetap harus
      // terbaca normal (kompatibilitas mundur) — bila sudah ada attachment
      // tersimpan, jalankan analisis otomatis juga saat refresh/buka detail,
      // bukan hanya persis setelah upload.
      if (data.data.periodLock?.attachment && data.data.periodLock.status !== "locked") {
        void analyzeAttachment(period);
      }
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Gagal memuat detail bulan ini.");
    } finally {
      setDetailLoading(false);
    }
  };

  // Fallback: dipakai saat TIDAK ada objek File lokal (mis. membuka kembali
  // periode dengan attachment yang sudah tersimpan dari sesi sebelumnya) —
  // baca via server (lib/reconciliation-berita-acara-ocr.ts). Untuk PDF hasil
  // scan, server jujur melaporkan pdf-scanned-unsupported/PERLU_REVIEW
  // (rasterisasi PDF butuh binary native yang dilarang di server); jalur
  // BROWSER (analyzeFileClient di bawah, dipakai persis setelah upload saat
  // File masih ada di tangan) yang benar-benar men-support PDF hasil scan.
  const analyzeAttachment = async (period: string) => {
    setAnalysisLoading(true); setAnalysisError(""); setAnalysis(null); setAnalysisStatus("");
    try {
      const response = await fetch(`/api/reconciliation/court-revenue/${period}/finalization/analyze`, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Gagal membaca berita acara secara otomatis.");
      const result = data.data as BeritaAcaraAnalysis;
      setAnalysis(result);
      // Nominal final TIDAK dihitung ulang lewat rumus baru — tetap memakai
      // logika finalisasi yang sudah ada (default "Nominal final disepakati"
      // = Total Omzet Olsera, sama seperti sebelum fitur ini ada; lihat
      // openDetail di atas). Saat BA COCOK, field ini hanya dikunci
      // read-only di UI (bukan diformulasikan ulang) — previewOmzetPeriodLock
      // tetap satu-satunya sumber kebenaran untuk adjustmentAmount.
      if (result.reason) setFinalReason((current) => current || result.reason!);
      setFinalPreview(null);
      setShowFinalLockConfirm(false);
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
  const analyzeFileClient = async (file: File) => {
    setAnalysisLoading(true); setAnalysisError(""); setAnalysis(null); setAnalysisStatus(STATUS_READING);
    try {
      const systemDifference = detail?.differenceRevenue ?? 0;
      const result = await analyzeBeritaAcaraFileClient(file, systemDifference, { onStatus: setAnalysisStatus });
      setAnalysis(result);
      if (result.reason) setFinalReason((current) => current || result.reason!);
      setFinalPreview(null);
      setShowFinalLockConfirm(false);
    } catch (e) {
      console.error("[reconciliation:client-ocr]", e);
      // Dokumen belum dapat dibaca otomatis — user tetap bisa lanjut lewat
      // isian manual (nominal/arah/alasan) di bawah, preview tetap wajib
      // sebelum Kunci Periode (canLockFinalization tidak pernah otomatis
      // meloloskan status ini).
      setAnalysisError("Dokumen belum dapat dibaca otomatis. Periksa dan isi data secara manual.");
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
    try { const data = await finalizationRequest("preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: finalization?.version, finalAgreedAmount: Number(finalAmount), adjustmentReason: finalReason }) }); setFinalPreview(data.data); setFinalization(data.lock); setFinalSaveMessage("Finalisasi berhasil disimpan."); }
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

  // Gating Kunci Periode (Langkah 8): TIDAK PERNAH otomatis blokir total —
  // hanya mismatch YANG DIKETAHUI (TIDAK_COCOK) yang menahan tombol lock.
  // Belum ada analisis (dokumen lama/kompat mundur) atau PERLU_REVIEW tetap
  // membuka jalur manual (user isi sendiri lalu preview ulang), sesuai
  // instruksi: jangan pernah memblokir total user pada data yang tidak pasti.
  const canLockFinalization = analysis?.matchStatus !== "TIDAK_COCOK";

  const supervisor = user?.role === "supervisor";
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
                    <StatusBadge status={reconciliationOmzetUiStatus(row.status, row.differenceRevenue)} /> {row.periodLock?.status === "locked" ? <span className="recon-badge recon-badge-ok" title="Detail Penyesuaian"><Lock size={12} /> Cocok — Terkunci · Detail Penyesuaian</span> : row.explanation?.locked && <LockBadge />}
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
              <button key={row.period} className="recon-mobile-card" onClick={() => void openDetail(row.period)}>
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
                  <StatusBadge status={reconciliationOmzetUiStatus(row.status, row.differenceRevenue)} /> {row.periodLock?.status === "locked" ? <span className="recon-badge recon-badge-ok" title="Detail Penyesuaian"><Lock size={12} /> Cocok — Terkunci</span> : row.explanation?.locked && <LockBadge />}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {selectedPeriod && (
        <aside className="recon-drawer" role="dialog" aria-modal="true" aria-label="Detail rekonsiliasi bulan">
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
              <p className="recon-readonly">
                <strong>Penyebab status:</strong> {detail.statusReason}
              </p>

              <section className="recon-sport-sections" aria-label="Rincian omzet per olahraga">
                <SportReconciliationCard title="COURT" ayoLabel="Omzet AYO Court" olseraLabel="Olsera akun 40001" comparison={detail.sportReconciliation.court} />
                <SportReconciliationCard title="PICKLEBALL" ayoLabel="Omzet AYO Pickleball" olseraLabel="Olsera akun 40004" comparison={detail.sportReconciliation.pickleball} />
                <SportReconciliationCard
                  title="TOTAL GABUNGAN"
                  ayoLabel="Total Omzet AYO"
                  olseraLabel="Total Omzet Olsera (40001+40004)"
                  comparison={{ ayo: detail.sportReconciliation.total, olsera: detail.olseraTotal, difference: detail.differenceRevenue, status: reconciliationOmzetUiStatus(detail.status, detail.differenceRevenue) === "COCOK" ? "COCOK" : "PERLU_DICEK" }}
                  finalStatus={reconciliationOmzetUiStatus(detail.status, detail.differenceRevenue)}
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

              {finalization?.status === "locked" && <p className="recon-lock-summary"><Lock size={14} /> Cocok â€” Terkunci · Detail Penyesuaian tersedia di Berita Acara dan Finalisasi.</p>}
              {supervisor && (
                <CollapsibleSection title="Berita Acara dan Finalisasi">
                <section className="recon-finalization">
                  {finalization?.attachment ? (
                    <p className="recon-before"><Paperclip size={12} /> {finalization.attachment.fileName} ({Math.ceil(finalization.attachment.size / 1024)} KB) â€” diunggah {dateTimeLabel(finalization.attachment.uploadedAt)} oleh {finalization.attachment.uploadedBy} <a className="recon-link" href={finalization.attachment.url} target="_blank" rel="noreferrer">Lihat</a></p>
                  ) : <p className="recon-before">Unggah berita acara PDF/JPG/JPEG/PNG (maks. 10MB) sebelum preview dan lock.</p>}
                  {finalization?.status !== "locked" && (
                    <>
                      {analysisLoading && <p className="recon-before">{analysisStatus || "Membaca berita acara..."}</p>}
                      {analysisError && <p className="recon-error">{analysisError} <button className="recon-link" onClick={() => selectedPeriod && void analyzeAttachment(selectedPeriod)}>Coba baca ulang</button></p>}
                      {analysis && (
                        <section className="recon-detail-grid" aria-label="Hasil baca otomatis Berita Acara">
                          <div><span>Selisih Sistem</span><b>{formatSignedRupiah(analysis.systemDifference)}</b></div>
                          <div><span>Nominal Berita Acara</span><b>{analysis.nominal !== null ? `${analysis.direction === "PENGURANGAN" ? "-" : "+"}${formatRupiah(analysis.nominal)}` : "Tidak terbaca"}</b></div>
                          <div><span>Hasil Pencocokan</span><b>{MATCH_STATUS_LABEL[analysis.matchStatus]}</b></div>
                        </section>
                      )}
                      {analysis?.matchStatus === "TIDAK_COCOK" && <p className="recon-error"><AlertTriangle size={14} /> Nominal/arah Berita Acara TIDAK cocok dengan selisih sistem. Periksa dokumen sebelum melanjutkan; preview dan lock ditahan sampai direview.</p>}
                      {analysis?.matchStatus === "PERLU_REVIEW" && <p className="recon-special"><AlertTriangle size={14} /> Berita Acara perlu direview manual (nominal/arah tidak terbaca otomatis, atau OCR belum yakin). Isi field di bawah secara manual.</p>}
                      <div className="recon-actions">
                        <label className="recon-upload-label">Pilih File
                          <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={finalBusy} onChange={(event) => { setFinalFile(event.target.files?.[0] ?? null); setUploadSuccessMessage(""); }} />
                        </label>
                        <button className="recon-button secondary" disabled={!finalFile || finalBusy} onClick={() => void uploadFinalAttachment()}><Paperclip size={14} /> Upload File</button>
                      </div>
                      {uploadSuccessMessage && <p className="recon-lock-summary">{uploadSuccessMessage}</p>}
                      <label className="recon-upload-label">Nominal final disepakati
                        <input type="number" step="1" value={finalAmount} disabled={finalBusy || !finalization?.attachment || analysis?.matchStatus === "COCOK"} onChange={(event) => { setFinalAmount(event.target.value); setFinalPreview(null); setShowFinalLockConfirm(false); setFinalSaveMessage(""); }} />
                      </label>
                      <label className="recon-upload-label">Alasan penyesuaian
                        <textarea value={finalReason} disabled={finalBusy || !finalization?.attachment} onChange={(event) => { setFinalReason(event.target.value); setFinalPreview(null); setShowFinalLockConfirm(false); setFinalSaveMessage(""); }} />
                      </label>
                      <div className="recon-actions">
                        <button className="recon-button secondary" disabled={!finalization?.attachment || finalBusy || !finalReason.trim()} onClick={() => void previewFinalization()}>Simpan</button>
                        <button className="recon-button" disabled={!finalPreview || finalBusy || !canLockFinalization} onClick={() => setShowFinalLockConfirm(true)} title={!canLockFinalization ? "Kunci hanya diizinkan saat Berita Acara COCOK dengan selisih sistem (atau isi manual lalu preview ulang)." : undefined}><Lock size={14} /> Kunci Periode</button>
                      </div>
                      {finalSaveMessage && <p className="recon-lock-summary">{finalSaveMessage}</p>}
                      {showFinalLockConfirm && <div className="recon-form" role="alertdialog" aria-label="Konfirmasi finalisasi periode"><p>Nominal final akan menjadi tampilan periode terkunci. Data sumber rekonsiliasi tetap tidak diubah.</p><div className="recon-actions"><button className="recon-button" disabled={finalBusy} onClick={() => void lockFinalization()}>Ya, Kunci Periode</button><button className="recon-button secondary" disabled={finalBusy} onClick={() => setShowFinalLockConfirm(false)}>Batal</button></div></div>}
                    </>
                  )}
                  {finalization?.status === "locked" && (
                    <>
                      <p className="recon-readonly"><Lock size={16} /> <strong>PERIODE DIKUNCI</strong> â€” Cocok. Tabel utama menampilkan nominal final, sementara angka sumber tetap tersimpan di bawah.</p>
                      {!showUnlock ? (supervisor && <button className="recon-button secondary" disabled={finalBusy} onClick={() => setShowUnlock(true)}>Buka Kunci</button>) : <div className="recon-form" role="alertdialog" aria-label="Konfirmasi buka kunci periode"><p className="recon-error">Periode akan dapat diedit dan difinalisasi ulang. Berita Acara dan histori sebelumnya tidak akan dihapus.</p><label>Alasan buka kunci<textarea value={unlockReason} maxLength={2000} onChange={(event) => setUnlockReason(event.target.value)} /></label><div className="recon-actions"><button className="recon-button" disabled={finalBusy || !unlockReason.trim()} onClick={() => void unlockFinalization()}>Buka Kunci</button><button className="recon-button secondary" disabled={finalBusy} onClick={() => setShowUnlock(false)}>Batal</button></div></div>}
                    </>
                  )}
                  {finalPreview && <div className="recon-detail-grid"><div><span>AYO asli</span><b>{formatRupiah(finalPreview.ayo)}</b></div><div><span>Olsera asli</span><b>{formatRupiah(finalPreview.olsera)}</b></div><div><span>Selisih awal</span><b>{formatRupiah(finalPreview.difference)}</b></div><div><span>Penyesuaian</span><b>{formatRupiah(finalPreview.adjustmentAmount)}</b></div><div><span>Nominal final</span><b>{formatRupiah(finalPreview.finalAgreedAmount)}</b></div><div><span>Tampilan terkunci</span><b>AYO dan Olsera {formatRupiah(finalPreview.lockedDisplay.ayo)}, selisih Rp0</b></div></div>}
                  {finalization?.status === "locked" && <div className="recon-detail-grid"><div><span>AYO asli</span><b>{formatRupiah(finalization.originalAyoAmount ?? 0)}</b></div><div><span>Olsera asli</span><b>{formatRupiah(finalization.originalOlseraAmount ?? 0)}</b></div><div><span>Selisih awal</span><b>{formatRupiah(finalization.originalDifference ?? 0)}</b></div><div><span>Penyesuaian</span><b>{formatRupiah(finalization.adjustmentAmount ?? 0)}</b></div><div><span>Nominal final</span><b>{formatRupiah(finalization.finalAgreedAmount ?? 0)}</b></div><div><span>Alasan</span><b>{finalization.adjustmentReason}</b></div><div><span>Dikunci oleh</span><b>{finalization.lockedBy}</b></div><div><span>Waktu lock</span><b>{finalization.lockedAt ? dateTimeLabel(finalization.lockedAt) : "-"}</b></div></div>}
                  {finalization?.history?.length ? <details className="recon-json"><summary>Riwayat audit ({finalization.history.length})</summary><ul className="recon-history">{finalization.history.slice().reverse().map((item, index) => <li key={`${item.timestamp}-${index}`}><span>{item.action} oleh {item.actor}</span><small>{dateTimeLabel(item.timestamp)}{item.reason ? ` â€” ${item.reason}` : ""}</small></li>)}</ul></details> : null}
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
    </main>
  );
}
