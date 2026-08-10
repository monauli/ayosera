"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, FileSearch, Loader2, RefreshCw, Save, Search, X } from "lucide-react";
import { visibleInventoryRows } from "@/lib/olsera-inventory-ui";

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

type LoadResult = { storeId: number; year: number; month: number; rows: Row[]; summary: Summary };
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
  const [year, setYear] = useState(String(initial.year));
  const [month, setMonth] = useState(String(initial.month));
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

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.user ?? null))
      .catch(() => setUser(null));
  }, []);

  const supervisor = user?.role === "supervisor";

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
      const response = await fetch(`/api/reconciliation/inventory-opname?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`, { cache: "no-store" });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Gagal memuat data rekonsiliasi inventori.");
      setData(result);
      seedEdits(result.rows);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memuat data rekonsiliasi inventori.");
      setData(null);
    } finally {
      setLoading(false);
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
      if (!edit) return row;
      const physicalQty = edit.physicalQty;
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
  }, [data, edits]);

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
        {supervisor && data && (
          <button className="recon-button" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="spin" /> : <Save />} Simpan Semua
          </button>
        )}
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
        <label className="recon-check" style={{ alignSelf: "end" }}>
          <button className="recon-button secondary" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="spin" /> : <RefreshCw />} Tampilkan Data
          </button>
        </label>
      </section>

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
