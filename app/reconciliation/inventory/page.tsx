"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSearch, FileUp, Loader2, LockKeyhole, Moon, RefreshCw, Save, Search, Sun, Unlock, X } from "lucide-react";
import { visibleInventoryRows } from "@/lib/olsera-inventory-ui";
import { readInitialThemeMode, THEME_MODE_STORAGE_KEY, type ThemeMode } from "@/lib/theme-mode";

type OpnameStatus = "BELUM_DIISI" | "COCOK" | "PERLU_DICEK" | "BUTUH_ADJUST_MANUAL";

type Row = {
  productId: number;
  variantId: number | null;
  productName: string;
  productSku: string | null;
  category: string;
  openingQty: number | null;
  incomingQty: number | null;
  returnQty: number | null;
  salesQty: number | null;
  outgoingQty: number | null;
  snapshotClosingQty: number | null;
  formulaClosingQty: number | null;
  systemClosingQty: number | null;
  formulaMismatch: boolean;
  snapshotStatus: "complete" | "boundary-only" | "incomplete";
  snapshotDiagnostics: string[];
  manualAdjust: boolean;
  physicalQty: number | null;
  differenceQty: number | null;
  status: OpnameStatus;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  evidenceSource?: "BA_INPUT" | "BA_OMITTED_ASSUMED_MATCH" | null;
};

type Summary = {
  totalProduk: number;
  cocok: number;
  perluDicek: number;
  belumDiisi: number;
  butuhAdjustManual: number;
  totalSelisihPositif: number;
  totalSelisihNegatif: number;
};

// cutoffDate/startDate/endDate: HANYA terisi bila query pakai cutoff tanggal BA
// (lihat lib/inventory-stock-opname-store.ts:loadInventoryOpnameCutoff) — kosong
// (undefined) berarti Stok Akhir Sistem masih basis snapshot akhir bulan (perilaku lama).
type Attachment = { url: string; fileName: string; mimeType: string; size: number; uploadedBy?: string; uploadedAt?: string };
type LockState = { status: "LOCKED" | "UNLOCKED"; cutoff: string | null; cutoffDate: string | null; lockedBy: string | null; lockedAt: string | null; attachment: Attachment | null };
type LoadResult = { storeId: number; year: number; month: number; rows: Row[]; summary: Summary; cutoffDate?: string; startDate?: string; endDate?: string; lock: LockState | null };
type User = { id: string; role: "supervisor" | "user"; allowedModules: string[] };
type Edit = { physicalQty: number | null; note: string | null };

const STATUS_LABEL: Record<OpnameStatus, string> = {
  BELUM_DIISI: "Belum Diisi",
  COCOK: "Cocok",
  PERLU_DICEK: "Perlu Dicek",
  BUTUH_ADJUST_MANUAL: "Butuh Adjust Manual",
};
const STATUS_TONE: Record<OpnameStatus, "ok" | "warn" | "danger" | "neutral"> = {
  BELUM_DIISI: "neutral",
  COCOK: "ok",
  PERLU_DICEK: "warn",
  BUTUH_ADJUST_MANUAL: "danger",
};
const STATUS_FILTERS: Array<{ value: "ALL" | OpnameStatus; label: string }> = [
  { value: "ALL", label: "Semua" },
  { value: "COCOK", label: "Cocok" },
  { value: "PERLU_DICEK", label: "Perlu Dicek" },
  { value: "BELUM_DIISI", label: "Belum Diisi" },
  { value: "BUTUH_ADJUST_MANUAL", label: "Butuh Adjust Manual" },
];

const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

function currentJakartaYearMonth(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" }).format(new Date());
  const [year, month] = parts.split("-").map(Number);
  return { year, month };
}

function rowKey(productId: number, variantId: number | null): string {
  return `${productId}:${variantId ?? 0}`;
}

function formatQty(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("id-ID").format(value);
}

function formatSignedQty(value: number | null): string {
  if (value === null) return "—";
  const formatted = new Intl.NumberFormat("id-ID").format(Math.abs(value));
  return value > 0 ? `+${formatted}` : value < 0 ? `-${formatted}` : formatted;
}

function StatusBadge({ status }: { status: OpnameStatus }) {
  return <span className={`recon-badge recon-badge-${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

export default function InventoryOpnamePage() {
  const initial = currentJakartaYearMonth();
  // Reuse tema global AYOSERA (localStorage key "ayo-mode", sama seperti
  // app/page.tsx dan app/reconciliation/page.tsx) — bukan mekanisme baru.
  const [mode, setMode] = useState<ThemeMode>("light");
  const [year, setYear] = useState(String(initial.year));
  const [month, setMonth] = useState(String(initial.month));
  // Cutoff tanggal BA (basis BARU rekonsiliasi — lihat AYOSERA-HANDOFF-LATEST.md).
  // Tahun/Bulan di atas TETAP dipakai sebagai filter pencarian BA, BUKAN lagi
  // sumber boundary Stok Akhir Sistem begitu cutoffDate dikonfirmasi & dipakai.
  const [cutoffDate, setCutoffDate] = useState("");
  const [cutoffConfirmed, setCutoffConfirmed] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<LoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | OpnameStatus>("ALL");
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [baOnlyDifferencesConfirmed, setBaOnlyDifferencesConfirmed] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState("");
  const [unlockReason, setUnlockReason] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.user ?? null))
      .catch(() => setUser(null));
  }, []);
  useEffect(() => {
    const initialMode = readInitialThemeMode();
    setMode(initialMode);
    document.documentElement.setAttribute("data-mode", initialMode);
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, initialMode);
  }, []);

  const supervisor = Boolean(user);

  const seedEdits = (rows: Row[]) => {
    const next: Record<string, Edit> = {};
    for (const row of rows) next[rowKey(row.productId, row.variantId)] = { physicalQty: row.physicalQty, note: row.note };
    setEdits(next);
  };

  const load = async () => {
    setLoading(true);
    setError("");
    setSaveMessage("");
    setSaveError("");
    try {
      // cutoffDate HANYA dikirim setelah user secara eksplisit mencentang
      // konfirmasi (cutoffConfirmed) — sesuai aturan "cutoff WAJIB dikonfirmasi
      // user, bukan otomatis tanpa konfirmasi". Tanpa konfirmasi, query tetap
      // basis snapshot bulanan lama (backward compatible).
      const useCutoff = cutoffConfirmed && cutoffDate.trim() !== "";
      const url = `/api/reconciliation/inventory-opname?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}${useCutoff ? `&cutoffDate=${encodeURIComponent(cutoffDate.trim())}` : ""}`;
      const response = await fetch(url, { cache: "no-store" });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Gagal memuat data rekonsiliasi inventori.");
      setData(result);
      setAttachment(result.lock?.attachment ?? attachment);
      seedEdits(result.rows);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memuat data rekonsiliasi inventori.");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  const uploadBa = async (file: File) => {
    setUploading(true);
    setFinalizeError("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("year", year);
      form.set("month", month);
      const response = await fetch("/api/reconciliation/inventory-opname/upload", { method: "POST", body: form });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Gagal mengunggah Berita Acara.");
      setAttachment(result.data);
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : "Gagal mengunggah Berita Acara.");
    } finally {
      setUploading(false);
    }
  };

  const finalize = async () => {
    if (!data || !attachment || !cutoffDate || !cutoffConfirmed || !baOnlyDifferencesConfirmed) return;
    setFinalizing(true);
    setFinalizeError("");
    try {
      const entries = data.rows.map((row) => {
        const edit = edits[rowKey(row.productId, row.variantId)] ?? { physicalQty: row.physicalQty, note: row.note };
        return { productId: row.productId, variantId: row.variantId, physicalQty: edit.physicalQty, note: edit.note };
      });
      const saveResponse = await fetch("/api/reconciliation/inventory-opname", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ year: Number(year), month: Number(month), entries }) });
      const saveResult = await saveResponse.json().catch(() => null);
      if (!saveResponse.ok) throw new Error(saveResult?.error || "Gagal menyimpan input Berita Acara sebelum finalisasi.");
      const response = await fetch("/api/reconciliation/inventory-opname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finalize", year: Number(year), month: Number(month), cutoff: cutoffDate, cutoffDate, cutoffConfirmed, baOnlyDifferencesConfirmed, attachment }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Finalisasi gagal. Periksa kembali data checker.");
      setSaveMessage("Stock Opname berhasil dikunci.");
      await load();
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : "Finalisasi gagal.");
    } finally {
      setFinalizing(false);
    }
  };

  const unlock = async () => {
    if (!unlockReason.trim()) {
      setFinalizeError("Alasan buka kunci wajib diisi.");
      return;
    }
    setUnlocking(true);
    setFinalizeError("");
    try {
      const response = await fetch("/api/reconciliation/inventory-opname", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unlock", year: Number(year), month: Number(month), reason: unlockReason }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Gagal membuka kunci.");
      setUnlockReason("");
      setSaveMessage("Stock Opname berhasil dibuka kuncinya.");
      await load();
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : "Gagal membuka kunci.");
    } finally {
      setUnlocking(false);
    }
  };

  const setEdit = (row: Row, patch: Partial<Edit>) => {
    setEdits((prev) => {
      const key = rowKey(row.productId, row.variantId);
      const current = prev[key] ?? { physicalQty: row.physicalQty, note: row.note };
      return { ...prev, [key]: { ...current, ...patch } };
    });
  };

  const save = async () => {
    if (!data || !supervisor) return;
    setSaving(true);
    setSaveError("");
    setSaveMessage("");
    try {
      const entries = data.rows.map((row) => {
        const edit = edits[rowKey(row.productId, row.variantId)] ?? { physicalQty: row.physicalQty, note: row.note };
        return { productId: row.productId, variantId: row.variantId, physicalQty: edit.physicalQty, note: edit.note };
      });
      const response = await fetch("/api/reconciliation/inventory-opname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: Number(year), month: Number(month), entries }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Gagal menyimpan berita acara.");
      setData(result);
      seedEdits(result.rows);
      setSaveMessage("Berita acara tersimpan.");
      if (selected) {
        const updated = (result.rows as Row[]).find((r) => r.productId === selected.productId && r.variantId === selected.variantId);
        setSelected(updated ?? null);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Gagal menyimpan berita acara.");
    } finally {
      setSaving(false);
    }
  };

  const rowsWithEdits: Row[] = useMemo(() => {
    if (!data) return [];
    return data.rows.map((row) => {
      const edit = edits[rowKey(row.productId, row.variantId)];
      const physicalQty = edit?.physicalQty ?? row.physicalQty;
      if (baOnlyDifferencesConfirmed && physicalQty === null && row.systemClosingQty !== null && !row.manualAdjust) {
        return { ...row, physicalQty: row.systemClosingQty, differenceQty: 0, status: "COCOK" as OpnameStatus, evidenceSource: "BA_OMITTED_ASSUMED_MATCH" as const };
      }
      if (!edit) return row;
      const differenceQty = physicalQty === null || row.systemClosingQty === null ? null : physicalQty - row.systemClosingQty;
      const status: OpnameStatus = row.manualAdjust
        ? "BUTUH_ADJUST_MANUAL"
        : physicalQty === null
          ? "BELUM_DIISI"
          : row.systemClosingQty === null || physicalQty !== row.systemClosingQty
            ? "PERLU_DICEK"
            : "COCOK";
      return { ...row, physicalQty, note: edit.note, differenceQty, status };
    });
  }, [data, edits, baOnlyDifferencesConfirmed]);

  const visibleRows = useMemo(() => visibleInventoryRows(rowsWithEdits, showHidden), [rowsWithEdits, showHidden]);
  const hiddenCount = rowsWithEdits.length - visibleRows.length;

  const filteredRows = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return visibleRows.filter((row) => {
      if (statusFilter !== "ALL" && row.status !== statusFilter) return false;
      if (!keyword) return true;
      return row.productName.toLowerCase().includes(keyword) || (row.productSku ?? "").toLowerCase().includes(keyword);
    });
  }, [visibleRows, statusFilter, search]);

  const liveSummary: Summary = useMemo(() => {
    const summary: Summary = { totalProduk: rowsWithEdits.length, cocok: 0, perluDicek: 0, belumDiisi: 0, butuhAdjustManual: 0, totalSelisihPositif: 0, totalSelisihNegatif: 0 };
    for (const row of rowsWithEdits) {
      if (row.status === "COCOK") summary.cocok += 1;
      else if (row.status === "PERLU_DICEK") summary.perluDicek += 1;
      else if (row.status === "BELUM_DIISI") summary.belumDiisi += 1;
      else summary.butuhAdjustManual += 1;
      if (row.differenceQty !== null) {
        if (row.differenceQty > 0) summary.totalSelisihPositif += row.differenceQty;
        else if (row.differenceQty < 0) summary.totalSelisihNegatif += row.differenceQty;
      }
    }
    return summary;
  }, [rowsWithEdits]);

  if (user && !user.allowedModules.includes("rekonsiliasi") && user.role !== "supervisor") {
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
          <a href="/reconciliation" className="recon-back">
            ← Kembali ke Rekonsiliasi
          </a>
          <h1>Rekonsiliasi Inventori dengan Berita Acara</h1>
          <p>Mencocokkan snapshot inventori bulanan Olsera dengan stok fisik hasil stock opname (input manual).</p>
        </div>
        <div style={{ display: "flex", gap: ".5rem" }}>
          {supervisor && data && (
            <button className="recon-button" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="spin" /> : <Save />} Simpan Semua
            </button>
          )}
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

      <section className="recon-filters" aria-label="Pilih periode">
        <label>
          Tahun
          <input type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(e.target.value)} />
        </label>
        <label>
          Bulan
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {MONTH_NAMES.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Cutoff tanggal BA (opsional)
          <input
            type="date"
            value={cutoffDate}
            onChange={(e) => {
              setCutoffDate(e.target.value);
              setCutoffConfirmed(false);
            }}
          />
        </label>
        <label className="recon-check" style={{ alignSelf: "end" }}>
          <input type="checkbox" checked={cutoffConfirmed} disabled={!cutoffDate.trim()} onChange={(e) => setCutoffConfirmed(e.target.checked)} /> Konfirmasi cutoff — Stok Akhir Sistem dihitung persis pada tanggal ini
        </label>
        <label className="recon-check" style={{ alignSelf: "end" }}>
          <button className="recon-button secondary" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="spin" /> : <RefreshCw />} Tampilkan Data
          </button>
        </label>
      </section>

      {data?.cutoffDate && (
        <p className="recon-readonly">
          Stok Akhir Sistem dihitung persis pada cutoff <strong>{data.cutoffDate}</strong> (bukan akhir bulan kalender) — jendela query {data.startDate} s/d {data.endDate}.
        </p>
      )}

      <section className="recon-filters recon-finalization" aria-label="Berita Acara dan finalisasi">
        <label>
          Berita Acara Stock Opname
          <input type="file" accept="application/pdf,image/jpeg,image/png" disabled={!supervisor || uploading || data?.lock?.status === "LOCKED"} onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadBa(file); e.currentTarget.value = ""; }} />
        </label>
        <div className="recon-finalization">
          {attachment ? <p className="recon-lock-summary"><CheckCircle2 /> {attachment.fileName} — Berhasil diupload</p> : <p className="recon-readonly">PDF/JPG/PNG, maksimal 4 MB.</p>}
          {attachment && data?.lock?.status !== "LOCKED" && <label className="recon-button secondary">Ganti file<input type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadBa(file); e.currentTarget.value = ""; }} /></label>}
        </div>
        <label className="recon-check">
          <input type="checkbox" checked={baOnlyDifferencesConfirmed} disabled={!supervisor || data?.lock?.status === "LOCKED"} onChange={(e) => setBaOnlyDifferencesConfirmed(e.target.checked)} /> Berita Acara hanya mencantumkan item yang memiliki selisih
        </label>
        <div className="recon-finalization">
          {data?.lock?.status === "LOCKED" ? <>
            <p className="recon-lock-summary"><LockKeyhole /> Stock Opname Terkunci</p>
            <p className="recon-readonly">Cutoff: {data.lock.cutoffDate ?? data.lock.cutoff ?? "—"} · Difinalisasi oleh: {data.lock.lockedBy ?? "—"}{data.lock.lockedAt ? ` · ${new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(data.lock.lockedAt))}` : ""}</p>
            <p className="recon-readonly">File BA: {data.lock.attachment?.fileName ?? attachment?.fileName ?? "—"}</p>
            <p className="recon-readonly">Data pemeriksaan pada tanggal cutoff sudah dikunci. Transaksi inventori setelah tanggal tersebut tetap berjalan normal.</p>
            {supervisor && <><input value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} placeholder="Alasan buka kunci" /><button className="recon-button danger" onClick={() => void unlock()} disabled={unlocking}>{unlocking ? <Loader2 className="spin" /> : <Unlock />} Buka Kunci</button></>}
          </> : <button className="recon-button" onClick={() => void finalize()} disabled={!supervisor || !data || !attachment || !cutoffDate || !cutoffConfirmed || !baOnlyDifferencesConfirmed || liveSummary.perluDicek > 0 || liveSummary.butuhAdjustManual > 0 || finalizing}>{finalizing ? <Loader2 className="spin" /> : <FileUp />} Finalisasi Stock Opname</button>}
        </div>
      </section>
      {finalizeError && <p className="recon-draft"><AlertTriangle /> {finalizeError}</p>}

      {saveMessage && <p className="recon-readonly">{saveMessage}</p>}
      {saveError && <p className="recon-draft"><AlertTriangle /> {saveError}</p>}

      {error ? (
        <section className="recon-empty">
          <p>{error}</p>
        </section>
      ) : !data ? (
        <section className="recon-empty">
          <FileSearch />
          <p>Pilih tahun & bulan, lalu klik &quot;Tampilkan Data&quot;.</p>
        </section>
      ) : (
        <>
          <section className="recon-cards">
            {([
              ["Total Produk", liveSummary.totalProduk],
              ["Cocok", liveSummary.cocok],
              ["Perlu Dicek", liveSummary.perluDicek],
              ["Belum Diisi", liveSummary.belumDiisi],
              ["Butuh Adjust Manual", liveSummary.butuhAdjustManual],
              ["Total Selisih Positif", formatSignedQty(liveSummary.totalSelisihPositif || 0)],
              ["Total Selisih Negatif", formatSignedQty(liveSummary.totalSelisihNegatif || 0)],
            ] as const).map(([label, value]) => (
              <div className="recon-card" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </section>

          <section className="recon-filters" aria-label="Filter produk">
            <label className="recon-keyword">
              Cari produk / SKU
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nama produk atau SKU" />
            </label>
            <label>
              Status
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "ALL" | OpnameStatus)}>
                {STATUS_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="recon-check">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Tampilkan item tersembunyi{hiddenCount ? ` (${hiddenCount})` : ""}
            </label>
          </section>

          {!filteredRows.length ? (
            <section className="recon-empty">
              <Search />
              <p>Tidak ada produk untuk filter ini.</p>
            </section>
          ) : (
            <section className="recon-table-wrap">
              <table className="recon-table">
                <thead>
                  <tr>
                    <th>Produk</th>
                    <th>Varian</th>
                    <th>SKU</th>
                    <th>Stok Awal</th>
                    <th>Barang Masuk</th>
                    <th>Retur Masuk</th>
                    <th>Penjualan</th>
                    <th>Barang Keluar</th>
                    <th>Stok Akhir Sistem</th>
                    <th>Stok Berita Acara</th>
                    <th>Selisih</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={rowKey(row.productId, row.variantId)}>
                      <td>
                        <button className="recon-link" onClick={() => setSelected(row)}>
                          {row.productName}
                        </button>
                      </td>
                      <td>{row.variantId ?? "—"}</td>
                      <td>{row.productSku ?? "—"}</td>
                      <td>{formatQty(row.openingQty)}</td>
                      <td>{formatQty(row.incomingQty)}</td>
                      <td>{formatQty(row.returnQty)}</td>
                      <td>{formatQty(row.salesQty)}</td>
                      <td>{formatQty(row.outgoingQty)}</td>
                      <td>{formatQty(row.systemClosingQty)}</td>
                      <td>
                        <div className="recon-opname-cell">
                          <input
                            className="recon-opname-input"
                            type="number"
                            disabled={!supervisor}
                            value={row.physicalQty ?? ""}
                            onChange={(e) => setEdit(row, { physicalQty: e.target.value === "" ? null : Number(e.target.value) })}
                          />
                          {supervisor && row.physicalQty !== null && (
                            <button className="recon-opname-clear" aria-label="Hapus nilai" onClick={() => setEdit(row, { physicalQty: null })}>
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                      <td>{formatSignedQty(row.differenceQty)}</td>
                      <td>
                        <StatusBadge status={row.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="recon-mobile-list">
                {filteredRows.map((row) => (
                  <button key={rowKey(row.productId, row.variantId)} className="recon-mobile-card" onClick={() => setSelected(row)}>
                    <div>
                      <strong>{row.productName}</strong>
                      <span>
                        Sistem {formatQty(row.systemClosingQty)} · BA {formatQty(row.physicalQty)}
                      </span>
                    </div>
                    <div>
                      <StatusBadge status={row.status} />
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {selected && (
        <aside className="recon-drawer" role="dialog" aria-modal="true" aria-label="Detail produk">
          <div className="recon-drawer-head">
            <div>
              <p className="recon-eyebrow">Detail Produk</p>
              <h2>{selected.productName}</h2>
            </div>
            <button aria-label="Tutup detail" onClick={() => setSelected(null)}>
              <X />
            </button>
          </div>
          <div className="recon-drawer-body">
            {selected.manualAdjust && (
              <p className="recon-special">
                <AlertTriangle /> Produk ini butuh tinjauan manual (identitas/data snapshot belum pasti) — status tidak dipaksakan menjadi Cocok atau Perlu Dicek.
              </p>
            )}
            <section className="recon-detail-grid">
              <div>
                <span>Stok Awal</span>
                <b>{formatQty(selected.openingQty)}</b>
              </div>
              <div>
                <span>Barang Masuk</span>
                <b>{formatQty(selected.incomingQty)}</b>
              </div>
              <div>
                <span>Retur Masuk</span>
                <b>{formatQty(selected.returnQty)}</b>
              </div>
              <div>
                <span>Penjualan</span>
                <b>{formatQty(selected.salesQty)}</b>
              </div>
              <div>
                <span>Barang Keluar</span>
                <b>{formatQty(selected.outgoingQty)}</b>
              </div>
              <div>
                <span>Stok Akhir Sistem</span>
                <b>{formatQty(selected.systemClosingQty)}</b>
              </div>
              <div>
                <span>Stok Berita Acara</span>
                <b>{formatQty(selected.physicalQty)}</b>
              </div>
              <div>
                <span>Selisih</span>
                <b>{formatSignedQty(selected.differenceQty)}</b>
              </div>
              <div>
                <span>Status</span>
                <StatusBadge status={selected.status} />
              </div>
            </section>

            {selected.formulaMismatch && (
              <p className="recon-special">
                <AlertTriangle /> Rumus (Stok Awal + Masuk + Retur − Jual − Keluar) menghasilkan angka berbeda dari closingQty snapshot ({formatQty(selected.formulaClosingQty)}) — closingQty snapshot tetap dipakai sebagai Stok Akhir Sistem.
              </p>
            )}

            {selected.snapshotDiagnostics.length > 0 && (
              <>
                <h3>Diagnostik Snapshot</h3>
                <ul>
                  {selected.snapshotDiagnostics.map((line, index) => (
                    <li key={index} style={{ fontSize: ".8125rem", color: "rgb(var(--rd-text-tertiary))" }}>
                      {line}
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3>Catatan Berita Acara</h3>
            <textarea
              className="recon-opname-note"
              disabled={!supervisor}
              value={selected.note ?? ""}
              onChange={(e) => {
                setEdit(selected, { note: e.target.value || null });
                setSelected({ ...selected, note: e.target.value || null });
              }}
              placeholder={supervisor ? "Catatan opsional untuk produk ini" : "Belum ada catatan"}
            />
            {!supervisor && <p className="recon-readonly">Anda memiliki akses baca. Hanya supervisor dapat mengubah stok berita acara.</p>}
            {selected.updatedBy && (
              <p className="recon-before">
                Terakhir diperbarui oleh {selected.updatedBy}
                {selected.updatedAt ? ` · ${new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(selected.updatedAt))}` : ""}
              </p>
            )}
          </div>
        </aside>
      )}
    </main>
  );
}
