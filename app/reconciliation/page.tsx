"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, FileSearch, Lock, Paperclip, RefreshCw, X } from "lucide-react";

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
  olseraTotal: number;
  differenceRevenue: number;
  dataAvailable: boolean;
  status: OmzetStatus;
  statusReason: string;
  explanation: Explanation | null;
};
type User = { id: string; role: "supervisor" | "user"; allowedModules: string[] };

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

function AccountCard({ title, breakdown }: { title: string; breakdown: AccountBreakdown }) {
  return (
    <div>
      <span>{title} — bersih (sebelum reklasifikasi)</span>
      <b>{formatRupiah(breakdown.net)}</b>
    </div>
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
  const [showExplainForm, setShowExplainForm] = useState(false);
  const [explainSubmitting, setExplainSubmitting] = useState(false);
  const [explainError, setExplainError] = useState("");
  const [evidenceType, setEvidenceType] = useState<EvidenceType>("shifted-period");
  const [explainDescription, setExplainDescription] = useState("");
  const [uploadedAttachment, setUploadedAttachment] = useState<{ attachmentUrl: string; attachmentFileName: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showLockConfirm, setShowLockConfirm] = useState(false);
  const [lockSubmitting, setLockSubmitting] = useState(false);
  const [lockError, setLockError] = useState("");

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
    setShowExplainForm(false);
    setExplainError("");
    setUploadedAttachment(null);
    setUploadError("");
    setUploading(false);
    setShowLockConfirm(false);
    setLockError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    try {
      const response = await fetch(`/api/reconciliation/court-revenue/${period}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Gagal memuat detail bulan ini.");
      setDetail(data.data);
      setExplainDescription("");
      setEvidenceType("shifted-period");
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Gagal memuat detail bulan ini.");
    } finally {
      setDetailLoading(false);
    }
  };

  const uploadAttachment = async (file: File) => {
    if (!selectedPeriod) return;
    setUploading(true);
    setUploadError("");
    setUploadedAttachment(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch(`/api/reconciliation/court-revenue/${selectedPeriod}/attachment`, { method: "POST", body: formData });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Gagal mengunggah lampiran.");
      setUploadedAttachment(data.data);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Gagal mengunggah lampiran.");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } finally {
      setUploading(false);
    }
  };

  const submitExplanation = async () => {
    if (!selectedPeriod || !detail) return;
    setExplainSubmitting(true);
    setExplainError("");
    try {
      const response = await fetch(`/api/reconciliation/court-revenue/${selectedPeriod}/explanation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          evidenceType,
          description: explainDescription,
          explainedAmount: detail.differenceRevenue,
          attachmentUrl: uploadedAttachment?.attachmentUrl ?? null,
          attachmentFileName: uploadedAttachment?.attachmentFileName ?? null,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Gagal menyimpan penjelasan selisih.");
      setShowExplainForm(false);
      await openDetail(selectedPeriod);
      await refresh();
    } catch (e) {
      setExplainError(e instanceof Error ? e.message : "Gagal menyimpan penjelasan selisih.");
    } finally {
      setExplainSubmitting(false);
    }
  };

  const confirmLock = async () => {
    if (!selectedPeriod) return;
    setLockSubmitting(true);
    setLockError("");
    try {
      const response = await fetch(`/api/reconciliation/court-revenue/${selectedPeriod}/lock`, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Gagal mengunci periode ini.");
      setShowLockConfirm(false);
      await openDetail(selectedPeriod);
      await refresh();
    } catch (e) {
      setLockError(e instanceof Error ? e.message : "Gagal mengunci periode ini.");
    } finally {
      setLockSubmitting(false);
    }
  };

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
          <a href="/" className="recon-back">
            ← Kembali ke Dashboard
          </a>
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
                    <StatusBadge status={row.status} /> {row.explanation?.locked && <LockBadge />}
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
                  <StatusBadge status={row.status} /> {row.explanation?.locked && <LockBadge />}
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

              <section className="recon-detail-grid">
                <div>
                  <span>Omzet AYO</span>
                  <b>{formatRupiah(detail.ayo.revenue)}</b>
                </div>
                <div>
                  <span>Jumlah booking AYO eligible</span>
                  <b>{detail.ayo.count}</b>
                </div>
                <AccountCard title="Akun 40001 (Court Fees)" breakdown={detail.courtFees} />
                <AccountCard title="Akun 40004 (Pickleball)" breakdown={detail.pickleball} />
                <div>
                  <span>Verifikasi reklasifikasi 40004 → 21003</span>
                  <b>{detail.pickleballVerification.applicable ? (detail.pickleballVerification.verified ? "Terverifikasi" : detail.pickleballVerification.verified === false ? "Belum terverifikasi" : "Belum dapat dipastikan") : "Tidak berlaku (tidak ada aktivitas 40004)"}</b>
                </div>
                <div>
                  <span>Alasan verifikasi</span>
                  <b>{detail.pickleballVerification.reason}</b>
                </div>
                <div>
                  <span>Total Omzet Olsera final (40001+40004)</span>
                  <b>{formatRupiah(detail.olseraTotal)}</b>
                </div>
                <div>
                  <span>Selisih (Olsera − AYO)</span>
                  <b>{formatRupiah(detail.differenceRevenue)}</b>
                </div>
                <div>
                  <span>Status</span>
                  <div style={{ display: "flex", gap: ".35rem", flexWrap: "wrap" }}>
                    <StatusBadge status={detail.status} /> {detail.explanation?.locked && <LockBadge />}
                  </div>
                </div>
              </section>

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
                  <h3>Penjelasan selisih (bukti jurnal nyata)</h3>
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

              {supervisor && detail.differenceRevenue !== 0 && detail.status !== "BULAN_BERJALAN" && (
                <section className="recon-resolution">
                  {detail.explanation?.locked ? (
                    <p className="recon-readonly" style={{ width: "100%" }}>
                      <Lock size={16} /> Periode ini sudah dikunci dan tidak bisa diubah. Hubungi admin/developer bila perlu revisi.
                    </p>
                  ) : !showExplainForm ? (
                    <button className="recon-button secondary" onClick={() => setShowExplainForm(true)}>
                      {detail.explanation ? "Perbarui penjelasan selisih" : "Tambahkan penjelasan selisih"}
                    </button>
                  ) : (
                    <div className="recon-form" style={{ width: "100%" }}>
                      <h3>Bukti jurnal nyata untuk selisih {formatRupiah(detail.differenceRevenue)}</h3>
                      <label>
                        Jenis bukti
                        <select value={evidenceType} onChange={(e) => setEvidenceType(e.target.value as EvidenceType)}>
                          {(Object.keys(EVIDENCE_LABEL) as EvidenceType[]).map((key) => (
                            <option key={key} value={key}>
                              {EVIDENCE_LABEL[key]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Penjelasan (wajib — sebutkan transaksi/jurnal spesifik)
                        <textarea value={explainDescription} onChange={(e) => setExplainDescription(e.target.value)} placeholder="Contoh: transaksi BK/2428/260430 dibayar 1 Mei, dibukukan Olsera di bulan April (JU26050500001060)." />
                      </label>
                      <label>
                        Lampiran Berita Acara (opsional — PDF/JPG/PNG, maks 4MB)
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                          disabled={uploading || explainSubmitting}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void uploadAttachment(file);
                          }}
                        />
                      </label>
                      {uploading && <p className="recon-before">Mengunggah lampiran…</p>}
                      {uploadError && <p className="recon-error">{uploadError}</p>}
                      {uploadedAttachment && !uploading && (
                        <p className="recon-before">
                          <Paperclip size={12} /> Terunggah: {uploadedAttachment.attachmentFileName}
                        </p>
                      )}
                      {explainError && <p className="recon-error">{explainError}</p>}
                      <div className="recon-actions">
                        <button className="recon-button" disabled={explainSubmitting || uploading || !explainDescription.trim()} onClick={() => void submitExplanation()}>
                          Simpan penjelasan
                        </button>
                        <button className="recon-button secondary" disabled={explainSubmitting} onClick={() => setShowExplainForm(false)}>
                          Batal
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {supervisor &&
                !detail.explanation?.locked &&
                (detail.status === "COCOK" || (detail.explanation && detail.explanation.explainedAmount === detail.differenceRevenue)) && (
                  <section className="recon-resolution">
                    <button className="recon-button secondary" onClick={() => setShowLockConfirm(true)}>
                      <Lock size={14} /> Kunci Periode Ini
                    </button>
                  </section>
                )}
            </div>
          ) : null}
        </aside>
      )}

      {showLockConfirm && (
        <div className="recon-confirm-overlay" role="alertdialog" aria-modal="true" aria-label="Konfirmasi kunci periode">
          <div className="recon-confirm-box">
            {detail?.status === "COCOK" ? (
              <>
                <h3>Kunci bulan ini?</h3>
                <p>Setelah dikunci, status Cocok akan tetap berlaku walau data disinkron ulang di kemudian hari.</p>
              </>
            ) : (
              <>
                <h3>Kunci periode ini?</h3>
                <p>Setelah dikunci, penjelasan ini tidak bisa diubah lagi. Lanjutkan?</p>
              </>
            )}
            {lockError && <p className="recon-error">{lockError}</p>}
            <div className="recon-actions">
              <button className="recon-button" disabled={lockSubmitting} onClick={() => void confirmLock()}>
                Ya, kunci
              </button>
              <button className="recon-button secondary" disabled={lockSubmitting} onClick={() => setShowLockConfirm(false)}>
                Batal
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
