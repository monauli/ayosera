"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, FileSearch, RefreshCw, X } from "lucide-react";

type Side = { count: number; revenue: number };
type MonthSummary = {
  period: string;
  ayo: Side;
  olsera: Side;
  differenceRevenue: number;
  differenceCount: number;
  displayStatus: "MATCH" | "NEEDS_REVIEW" | "CURRENT_PERIOD";
};
type DayRow = { date: string; ayo: Side; olsera: Side; differenceRevenue: number; statusLabel: string };
type MonthDetail = MonthSummary & { mismatchedDays: DayRow[] };
type User = { id: string; role: "supervisor" | "user"; allowedModules: string[] };

const STATUS_LABEL: Record<MonthSummary["displayStatus"], string> = {
  MATCH: "Cocok",
  NEEDS_REVIEW: "Perlu Dicek",
  CURRENT_PERIOD: "Bulan Berjalan",
};
const STATUS_TONE: Record<MonthSummary["displayStatus"], "ok" | "warn" | "neutral"> = {
  MATCH: "ok",
  NEEDS_REVIEW: "warn",
  CURRENT_PERIOD: "neutral",
};

function formatRupiah(value: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value).replace(/\s/g, "");
}
function monthLabel(period: string) {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(new Date(Date.UTC(year, month - 1, 1)));
}
function dateLabel(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", timeZone: "Asia/Jakarta" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function StatusBadge({ status }: { status: MonthSummary["displayStatus"] }) {
  return <span className={`recon-badge recon-badge-${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

export default function ReconciliationPage() {
  const [user, setUser] = useState<User | null>(null);
  const [items, setItems] = useState<MonthSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null);
  const [detail, setDetail] = useState<MonthDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

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
    try {
      const response = await fetch(`/api/reconciliation/court-revenue/${period}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Gagal memuat detail bulan ini.");
      setDetail(data.data);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Gagal memuat detail bulan ini.");
    } finally {
      setDetailLoading(false);
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
          <h1>Rekonsiliasi Omset AYO vs Olsera</h1>
          <p>Perbandingan omset booking lapangan AYO dengan omset transaksi kategori lapangan Olsera, per bulan.</p>
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
                <th>Omset AYO</th>
                <th>Omset Olsera</th>
                <th>Selisih</th>
                <th>Booking AYO</th>
                <th>Transaksi Olsera</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.period}>
                  <td>{monthLabel(row.period)}</td>
                  <td>{formatRupiah(row.ayo.revenue)}</td>
                  <td>{formatRupiah(row.olsera.revenue)}</td>
                  <td>{formatRupiah(row.differenceRevenue)}</td>
                  <td>{row.ayo.count}</td>
                  <td>{row.olsera.count}</td>
                  <td>
                    <StatusBadge status={row.displayStatus} />
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
                    AYO {formatRupiah(row.ayo.revenue)} · Olsera {formatRupiah(row.olsera.revenue)}
                  </span>
                </div>
                <div>
                  <StatusBadge status={row.displayStatus} />
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
              <p className="recon-eyebrow">Detail Rekonsiliasi</p>
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
              {detail.displayStatus === "CURRENT_PERIOD" && (
                <p className="recon-draft">
                  <AlertTriangle /> <strong>Bulan berjalan.</strong> Data masih dapat berubah sampai bulan ini ditutup.
                </p>
              )}
              <section className="recon-detail-grid">
                <div>
                  <span>Omset AYO</span>
                  <b>{formatRupiah(detail.ayo.revenue)}</b>
                </div>
                <div>
                  <span>Jumlah booking AYO</span>
                  <b>{detail.ayo.count}</b>
                </div>
                <div>
                  <span>Omset Olsera (kategori lapangan)</span>
                  <b>{formatRupiah(detail.olsera.revenue)}</b>
                </div>
                <div>
                  <span>Jumlah transaksi Olsera</span>
                  <b>{detail.olsera.count}</b>
                </div>
                <div>
                  <span>Selisih nominal</span>
                  <b>{formatRupiah(detail.differenceRevenue)}</b>
                </div>
                <div>
                  <span>Status</span>
                  <StatusBadge status={detail.displayStatus} />
                </div>
              </section>
              <h3>Tanggal yang perlu dicek</h3>
              {detail.mismatchedDays.length === 0 ? (
                <p className="recon-readonly">Tidak ada tanggal dengan selisih pada bulan ini.</p>
              ) : (
                <table className="recon-table">
                  <thead>
                    <tr>
                      <th>Tanggal</th>
                      <th>Omset AYO</th>
                      <th>Omset Olsera</th>
                      <th>Selisih</th>
                      <th>Keterangan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.mismatchedDays.map((day) => (
                      <tr key={day.date}>
                        <td>{dateLabel(day.date)}</td>
                        <td>{formatRupiah(day.ayo.revenue)}</td>
                        <td>{formatRupiah(day.olsera.revenue)}</td>
                        <td>{formatRupiah(day.differenceRevenue)}</td>
                        <td>{day.statusLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}
        </aside>
      )}
    </main>
  );
}
