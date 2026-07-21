"use client";

// Panel halaman "Inventori Olsera" — modul read-only terpisah dari Kategori
// Penjualan. Tema visual dark hitam–graphite mengikuti Dashboard, Transaksi
// AYO, dan Kategori Penjualan Olsera (kelas rd-* di globals.css).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  CalendarRange,
  ClipboardList,
  Loader2,
  PackageSearch,
  RefreshCw,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InventoryExportMenu } from "@/components/redesign/inventory-export-menu";
import { OLSERA_INVENTORY_BASELINE_DATE } from "@/lib/olsera-baseline";

const TITLE = "text-[15px] font-semibold tracking-tight text-slate-50";
const DESC = "mt-1 text-[13px] leading-relaxed text-slate-400";
const ICON_CHIP = "rd-stat-icon rounded-xl p-2.5";
const FIELD = "rd-field flex h-10 items-center gap-2 rounded-full px-3";
const PRIMARY_BTN =
  "rounded-lg bg-rose-600 font-medium text-white shadow-sm transition-colors hover:bg-rose-500 active:bg-rose-700";
const SELECT_CLASS = "rd-input h-10 px-2 text-sm";
const TH = "h-11 px-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400";
const WARNING_BOX =
  "flex items-start gap-3 rounded-lg border border-amber-400/25 border-l-4 border-l-amber-400/70 bg-amber-400/10 px-3.5 py-3";
const NOTE_BOX =
  "flex items-start gap-3 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-3";
const PAGE_BTN = "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 hover:text-white";

const BASELINE_DATE = OLSERA_INVENTORY_BASELINE_DATE;

function formatRupiah(value: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 })
    .format(value)
    .replace(/\s/g, "");
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/\./g, ":");
}

function jakartaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );
}

async function redirectToLogin() {
  try {
    await fetch("/api/auth/sign-out", { method: "POST" });
  } catch {
    // tetap arahkan ke login
  }
  window.location.href = "/login";
}

type Summary = {
  totalProducts: number;
  activeProducts: number;
  outOfStock: number;
  lowStock: number;
  totalStock: number;
  totalValue: number;
  usesDefaultThreshold: boolean;
  defaultThreshold: number;
};

type SyncRun = {
  id: string;
  status: "running" | "success" | "partial" | "failed";
  phase: "products" | "movements" | "done";
  startDate: string;
  endDate: string;
  currentDate: string | null;
  processedDays: number;
  totalDays: number;
  totalProducts: number;
  totalMovements: number;
  failedDates: string[];
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  isStale?: boolean;
  lastHeartbeatAt?: string;
};

type SyncStatus = {
  state: {
    lastSuccessfulSyncAt: string | null;
    lastSyncedDate: string | null;
    firstSyncAt: string | null;
    earliestAvailableDate: string | null;
    earliestSalesDate: string | null;
    earliestSnapshotDate: string | null;
    historyCoverage: string;
  };
  run: SyncRun | null;
  productCount: number;
  movementCount: number;
  staleAfterMinutes?: number;
};

type ProductRow = {
  id: string;
  sku: string | null;
  name: string;
  variantName: string | null;
  category: string;
  uom: string | null;
  storeName: string | null;
  stockQty: number;
  lowStockAlert: number | null;
  usesDefaultThreshold: boolean;
  status: string;
  buyPrice: number;
  value: number;
  active: boolean;
  trackInventory: boolean;
  modifiedTime: string | null;
};

type MovementRow = {
  id: string;
  date: string;
  movementAt: string;
  sku: string | null;
  productName: string;
  type: string;
  qtyChange: number;
  costPrice: number | null;
  value: number | null;
  reference: string | null;
  note: string | null;
};

type ConsistencyRow = {
  key: string;
  sku: string | null;
  name: string;
  category: string;
  startSnapshotQty: number | null;
  recordedSales: number | null;
  endSnapshotQty: number | null;
  snapshotChange: number | null;
  status: string;
};

function stockStatusBadge(status: string) {
  if (status === "Aman") return <Badge variant="success" className="rounded-full px-2.5">Aman</Badge>;
  if (status === "Hampir Habis") return <Badge variant="warning" className="rounded-full px-2.5">Hampir Habis</Badge>;
  if (status === "Habis") return <Badge variant="danger" className="rounded-full px-2.5">Habis</Badge>;
  return <Badge variant="secondary" className="rounded-full px-2.5">Data Tidak Lengkap</Badge>;
}

function consistencyBadge(status: string) {
  // Tidak pernah "Cocok" — status hanya menyatakan cakupan data, bukan kebenaran stok fisik.
  if (status === "Perlu Stock Opname") return <Badge variant="warning" className="rounded-full px-2.5">Perlu Stock Opname</Badge>;
  if (status === "Snapshot Tersedia") return <Badge variant="info" className="rounded-full px-2.5">Snapshot Tersedia</Badge>;
  return <Badge variant="secondary" className="rounded-full px-2.5">{status}</Badge>;
}

export function OlseraInventoryPanel() {
  const today = jakartaToday();
  const monthStart = `${today.slice(0, 7)}-01`;

  const [summary, setSummary] = useState<Summary | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const syncRunningRef = useRef(false);

  const [tab, setTab] = useState<"stock" | "movements" | "consistency">("stock");

  // Stok Saat Ini
  const [stockRows, setStockRows] = useState<ProductRow[]>([]);
  const [stockCategories, setStockCategories] = useState<string[]>([]);
  const [stockSearch, setStockSearch] = useState("");
  const [stockCategory, setStockCategory] = useState("");
  const [stockStatusFilter, setStockStatusFilter] = useState("");
  const [stockSort, setStockSort] = useState<{ key: "name" | "stock" | "value"; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const [stockPage, setStockPage] = useState(1);
  const [stockMeta, setStockMeta] = useState({ total: 0, totalPages: 1 });
  const [stockLoading, setStockLoading] = useState(false);

  // Riwayat Mutasi
  const [movementRows, setMovementRows] = useState<MovementRow[]>([]);
  const [movementTypes, setMovementTypes] = useState<string[]>([]);
  const [movementStart, setMovementStart] = useState(monthStart);
  const [movementEnd, setMovementEnd] = useState(today);
  const [movementType, setMovementType] = useState("");
  const [movementSearch, setMovementSearch] = useState("");
  const [movementPage, setMovementPage] = useState(1);
  const [movementMeta, setMovementMeta] = useState({ total: 0, totalPages: 1 });
  const [movementLoading, setMovementLoading] = useState(false);

  // Konsistensi
  const [consistencyRows, setConsistencyRows] = useState<ConsistencyRow[]>([]);
  const [consistencyNote, setConsistencyNote] = useState("");
  const [consistencyLoading, setConsistencyLoading] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  // Dropdown Export kini dirender lewat portal (InventoryExportMenu) —
  // penutupan klik-luar/Escape ditangani komponen tersebut.
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // Laporan Stock Opname Bulanan — export utama OTOMATIS (bulan+tahun saja,
  // tanpa upload file): Open API Olsera (stockmovement) menggantikan file
  // summary manual. Terpisah dari state export tabel di atas.
  const [monthlyReportMonth, setMonthlyReportMonth] = useState(today.slice(0, 7));
  const [monthlyReportExporting, setMonthlyReportExporting] = useState(false);
  const [monthlyReportMessage, setMonthlyReportMessage] = useState("");

  // Ringkasan + status
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/olsera/inventory/summary?_t=${Date.now()}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          await redirectToLogin();
          return null;
        }
        return (await response.json().catch(() => null)) as { summary?: Summary; status?: SyncStatus } | null;
      })
      .then((payload) => {
        if (cancelled || !payload) return;
        if (payload.summary) setSummary(payload.summary);
        if (payload.status) setSyncStatus(payload.status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // Tabel stok
  useEffect(() => {
    if (tab !== "stock") return;
    let cancelled = false;
    setStockLoading(true);
    const params = new URLSearchParams({
      page: String(stockPage),
      limit: "50",
      sort: stockSort.key,
      dir: stockSort.dir,
      _t: String(Date.now()),
    });
    if (stockSearch.trim()) params.set("q", stockSearch.trim());
    if (stockCategory) params.set("category", stockCategory);
    if (stockStatusFilter) params.set("status", stockStatusFilter);
    const timeout = window.setTimeout(() => {
      fetch(`/api/olsera/inventory/products?${params.toString()}`, { cache: "no-store" })
        .then(async (response) => {
          if (response.status === 401) {
            await redirectToLogin();
            return null;
          }
          return (await response.json().catch(() => null)) as
            | { data?: ProductRow[]; total?: number; totalPages?: number; categories?: string[] }
            | null;
        })
        .then((payload) => {
          if (cancelled || !payload?.data) return;
          setStockRows(payload.data);
          setStockMeta({ total: payload.total ?? 0, totalPages: payload.totalPages ?? 1 });
          if (payload.categories) setStockCategories(payload.categories);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setStockLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [tab, stockSearch, stockCategory, stockStatusFilter, stockSort, stockPage, refreshTick]);

  // Riwayat mutasi
  useEffect(() => {
    if (tab !== "movements") return;
    if (movementStart > movementEnd) return;
    let cancelled = false;
    setMovementLoading(true);
    const params = new URLSearchParams({
      start_date: movementStart,
      end_date: movementEnd,
      page: String(movementPage),
      limit: "50",
      _t: String(Date.now()),
    });
    if (movementType) params.set("type", movementType);
    if (movementSearch.trim()) params.set("q", movementSearch.trim());
    const timeout = window.setTimeout(() => {
      fetch(`/api/olsera/inventory/movements?${params.toString()}`, { cache: "no-store" })
        .then(async (response) => {
          if (response.status === 401) {
            await redirectToLogin();
            return null;
          }
          return (await response.json().catch(() => null)) as
            | { data?: MovementRow[]; total?: number; totalPages?: number; types?: string[] }
            | null;
        })
        .then((payload) => {
          if (cancelled || !payload?.data) return;
          setMovementRows(payload.data);
          setMovementMeta({ total: payload.total ?? 0, totalPages: payload.totalPages ?? 1 });
          if (payload.types) setMovementTypes(payload.types);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setMovementLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [tab, movementStart, movementEnd, movementType, movementSearch, movementPage, refreshTick]);

  // Konsistensi
  useEffect(() => {
    if (tab !== "consistency") return;
    let cancelled = false;
    setConsistencyLoading(true);
    fetch(`/api/olsera/inventory/consistency?_t=${Date.now()}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          await redirectToLogin();
          return null;
        }
        return (await response.json().catch(() => null)) as { rows?: ConsistencyRow[]; note?: string } | null;
      })
      .then((payload) => {
        if (cancelled || !payload?.rows) return;
        setConsistencyRows(payload.rows);
        setConsistencyNote(payload.note ?? "");
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setConsistencyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, refreshTick]);

  // Sync bertahap: start lalu step berulang sampai selesai (aman untuk Vercel).
  const handleSync = useCallback(async () => {
    if (syncRunningRef.current) return;
    syncRunningRef.current = true;
    setSyncing(true);
    setSyncMessage("Memulai sync inventori...");
    try {
      const startResponse = await fetch("/api/olsera/inventory/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      if (startResponse.status === 401) {
        await redirectToLogin();
        return;
      }
      const startPayload = (await startResponse.json().catch(() => null)) as { run?: SyncRun; error?: string } | null;
      if (!startResponse.ok || !startPayload?.run) {
        setSyncMessage(startPayload?.error || "Gagal memulai sync inventori.");
        return;
      }

      let lastRun: SyncRun = startPayload.run;
      for (;;) {
        if (lastRun.phase === "products") {
          setSyncMessage("Menarik katalog produk dan snapshot stok...");
        } else {
          setSyncMessage(
            `Memproses ${Math.min(lastRun.processedDays + 1, lastRun.totalDays)} dari ${lastRun.totalDays} hari` +
              (lastRun.currentDate ? ` — mutasi ${formatDate(lastRun.currentDate)}` : ""),
          );
        }
        const stepResponse = await fetch("/api/olsera/inventory/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "step" }),
        });
        if (stepResponse.status === 401) {
          await redirectToLogin();
          return;
        }
        const stepPayload = (await stepResponse.json().catch(() => null)) as
          | { done?: boolean; run?: SyncRun; error?: string }
          | null;
        if (!stepResponse.ok || !stepPayload?.run) {
          setSyncMessage(stepPayload?.error || "Sync terputus — klik Sync Inventori untuk melanjutkan dari checkpoint.");
          return;
        }
        lastRun = stepPayload.run;
        if (stepPayload.done) break;
      }

      if (lastRun.status === "success") {
        setSyncMessage(
          `Sync selesai: ${lastRun.totalProducts} produk, ${lastRun.totalDays} hari diperiksa, ${lastRun.totalMovements} mutasi diproses.`,
        );
      } else if (lastRun.status === "partial") {
        setSyncMessage(
          `Sync sebagian selesai: ${lastRun.failedDates.length} tanggal gagal (${lastRun.failedDates.map(formatDate).join(", ")}). Klik lagi untuk mengulang tanggal gagal.`,
        );
      } else {
        setSyncMessage(lastRun.errorMessage || "Sync inventori gagal.");
      }
    } catch {
      setSyncMessage("Tidak dapat terhubung ke server — klik Sync Inventori untuk melanjutkan dari checkpoint.");
    } finally {
      syncRunningRef.current = false;
      setSyncing(false);
      setRefreshTick((value) => value + 1);
    }
  }, []);

  async function downloadExport(query: string, fallbackName: string) {
    setExporting(true);
    setExportMessage("");
    try {
      const response = await fetch(`/api/olsera/inventory/export?${query}`, { cache: "no-store" });
      if (response.status === 401) {
        await redirectToLogin();
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setExportMessage(payload?.error || "Export inventori gagal.");
        return;
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      const match = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/);
      link.download = match?.[1] || fallbackName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
      setExportMessage("Export selesai.");
    } catch {
      setExportMessage("Tidak dapat terhubung ke server. Coba lagi.");
    } finally {
      setExporting(false);
    }
  }

  function handleExportStock() {
    const params = new URLSearchParams({ type: "stock" });
    if (stockSearch.trim()) params.set("q", stockSearch.trim());
    if (stockCategory) params.set("category", stockCategory);
    void downloadExport(params.toString(), `Stok Inventori-${today}.xlsx`);
  }

  function handleExportMovements() {
    const params = new URLSearchParams({ type: "movements", start_date: movementStart, end_date: movementEnd });
    if (movementType) params.set("movement_type", movementType);
    if (movementSearch.trim()) params.set("q", movementSearch.trim());
    void downloadExport(params.toString(), `Mutasi Inventori-${movementStart}__${movementEnd}.xlsx`);
  }

  function handleExportConsistency() {
    const start = syncStatus?.state.earliestSnapshotDate ?? today;
    const params = new URLSearchParams({ type: "consistency", start_date: start });
    void downloadExport(params.toString(), `Konsistensi Inventori-${start}__${today}.xlsx`);
  }

  // Laporan Stock Opname Bulanan: hanya bulan+tahun, tidak ada upload file —
  // endpoint terpisah dari /api/olsera/inventory/export (yang dipakai tabel
  // Stok/Mutasi/Konsistensi di atas).
  async function handleExportMonthlyStockOpname() {
    const [yearStr, monthStr] = monthlyReportMonth.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (!year || !month) {
      setMonthlyReportMessage("Pilih bulan terlebih dahulu.");
      return;
    }
    setMonthlyReportExporting(true);
    setMonthlyReportMessage("");
    try {
      const response = await fetch(`/api/olsera/inventory/export/monthly-auto?year=${year}&month=${month}`, {
        cache: "no-store",
      });
      if (response.status === 401) {
        await redirectToLogin();
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setMonthlyReportMessage(payload?.error || "Gagal membuat Laporan Stock Opname Bulanan.");
        return;
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      const match = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/);
      link.download = match?.[1] || `Laporan Stock Opname Bulanan-${monthlyReportMonth}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
      setMonthlyReportMessage("Laporan selesai diunduh.");
    } catch {
      setMonthlyReportMessage("Tidak dapat terhubung ke server. Coba lagi.");
    } finally {
      setMonthlyReportExporting(false);
    }
  }

  const state = syncStatus?.state;
  const run = syncStatus?.run;

  const summaryCards: { label: string; value: string; accent?: string }[] = summary
    ? [
        { label: "Total Produk", value: String(summary.totalProducts) },
        { label: "Produk Aktif", value: String(summary.activeProducts) },
        { label: "Stok Habis", value: String(summary.outOfStock), accent: "text-rose-400" },
        { label: "Stok Hampir Habis", value: String(summary.lowStock), accent: "text-amber-300" },
        { label: "Total Stok", value: String(summary.totalStock) },
        { label: "Total Nilai Persediaan", value: formatRupiah(summary.totalValue) },
        { label: "Terakhir Sync", value: state?.lastSuccessfulSyncAt ? formatDateTime(state.lastSuccessfulSyncAt) : "-" },
      ]
    : [];

  // Cakupan data — baseline, riwayat penjualan, dan snapshot stok TIDAK sama;
  // ditampilkan terpisah supaya tidak membingungkan (lihat CLAUDE.md finalisasi Inventori).
  const coverageRows: { label: string; value: string }[] = [
    { label: "Baseline yang diminta", value: formatDate(BASELINE_DATE) },
    { label: "Riwayat penjualan tersedia sejak", value: formatDate(state?.earliestSalesDate) },
    { label: "Snapshot stok tersedia sejak", value: formatDate(state?.earliestSnapshotDate) },
    { label: "Terakhir sync", value: state?.lastSuccessfulSyncAt ? formatDateTime(state.lastSuccessfulSyncAt) : "-" },
    { label: "Histori mutasi stok lengkap", value: "Tidak tersedia dari API Olsera" },
  ];

  return (
    <>
      {/* Sync Inventori */}
      <section className="rd-enter mb-4">
        <div className="rd-card relative rounded-2xl p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3.5">
              <div className={ICON_CHIP}>
                <RefreshCw className="h-5 w-5" />
              </div>
              <div>
                <p className={TITLE}>Sync Inventori</p>
                <p className={DESC}>
                  {state?.lastSuccessfulSyncAt ? (
                    <>
                      Terakhir sync{" "}
                      <span className="font-medium text-slate-200">{formatDateTime(state.lastSuccessfulSyncAt)}</span>
                      {" · "}
                      {syncStatus?.productCount ?? 0} produk · {syncStatus?.movementCount ?? 0} mutasi
                    </>
                  ) : (
                    `Belum pernah sync — sync pertama memeriksa ${formatDate(BASELINE_DATE)} sampai hari ini.`
                  )}
                </p>
              </div>
            </div>
            {syncing || run?.status === "running" ? (
              run?.isStale && !syncing ? (
                <span className="rd-chip rd-chip-danger">
                  <AlertTriangle className="h-3 w-3" />
                  Stale
                </span>
              ) : (
                <span className="rd-chip">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Running
                </span>
              )
            ) : run?.status === "success" ? (
              <span className="rd-chip rd-chip-ok">Success</span>
            ) : run?.status === "partial" ? (
              <span className="rd-chip border-amber-400/40 bg-amber-400/10 text-amber-300">Partial</span>
            ) : run?.status === "failed" ? (
              <span className="rd-chip rd-chip-danger">Failed</span>
            ) : (
              <span className="rd-chip">Idle</span>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="button" className={PRIMARY_BTN} onClick={handleSync} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {syncing ? "Menyinkronkan Inventori..." : "Sync Inventori"}
            </Button>
            <span className="text-xs text-slate-500">
              Baseline {formatDate(BASELINE_DATE)} — sync berikutnya melanjutkan otomatis dari checkpoint.
            </span>
          </div>
          {syncMessage ? (
            <p className="mt-3 text-sm text-slate-300" aria-live="polite">
              {syncMessage}
            </p>
          ) : (
            !syncing &&
            run &&
            run.status !== "running" &&
            run.status !== "success" &&
            run.errorMessage && (
              <p className="mt-3 text-sm text-slate-300" aria-live="polite">
                {run.errorMessage}
              </p>
            )
          )}
          <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-3">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {coverageRows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3 text-xs sm:justify-start">
                  <dt className="text-slate-500">{row.label}</dt>
                  <dd className="font-medium text-slate-300">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className={`mt-3 ${WARNING_BOX}`}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-xs leading-relaxed text-amber-200/90">
              API Olsera tidak menyediakan histori lengkap untuk stok masuk, adjustment, transfer, retur, serta
              saldo sebelum dan sesudah. Riwayat yang tersedia terutama berasal dari transaksi penjualan dan
              snapshot stok aplikasi.
            </p>
          </div>
        </div>
      </section>

      {/* Laporan Stock Opname Bulanan — export utama, otomatis dari Open API */}
      <section className="rd-enter mb-4" style={{ animationDelay: "80ms" }}>
        <div className="rd-card relative rounded-2xl p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3.5">
              <div className={ICON_CHIP}>
                <ClipboardList className="h-5 w-5" />
              </div>
              <div>
                <p className={TITLE}>Laporan Stock Opname Bulanan</p>
                <p className={DESC}>
                  Pilih bulan, Excel langsung terunduh. Stok Awal/Barang Masuk/Keluar/Sisa diambil otomatis dari Open
                  API Olsera — tidak perlu upload file summary manual.
                </p>
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className={FIELD}>
              <CalendarRange className="h-4 w-4 shrink-0 text-slate-400" />
              <Input
                type="month"
                aria-label="Bulan Laporan Stock Opname"
                value={monthlyReportMonth}
                className="h-8 w-[150px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
                onClick={(event) => event.currentTarget.showPicker?.()}
                onChange={(event) => setMonthlyReportMonth(event.target.value)}
              />
            </div>
            <Button
              type="button"
              className={PRIMARY_BTN}
              onClick={() => void handleExportMonthlyStockOpname()}
              disabled={monthlyReportExporting || !monthlyReportMonth}
            >
              {monthlyReportExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardList className="h-4 w-4" />}
              {monthlyReportExporting ? "Membuat Laporan..." : "Export Laporan Stock Opname Bulanan"}
            </Button>
          </div>
          {monthlyReportMessage && (
            <p className="mt-3 text-sm text-slate-300" aria-live="polite">
              {monthlyReportMessage}
            </p>
          )}
        </div>
      </section>

      {/* Ringkasan */}
      {summary && (
        <section className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          {summaryCards.map((card, index) => (
            <div
              key={card.label}
              className="rd-card rd-enter relative rounded-2xl p-4"
              style={{ animationDelay: `${index * 60}ms` }}
            >
              <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{card.label}</p>
              <p className={`mt-1 text-lg font-semibold tabular-nums tracking-tight ${card.accent ?? "text-slate-50"}`}>
                {card.value}
              </p>
            </div>
          ))}
          {summary.usesDefaultThreshold && (
            <p className="col-span-2 -mt-1 text-xs text-slate-500 md:col-span-4">
              Sebagian produk tidak punya minimum stock dari Olsera — threshold default {summary.defaultThreshold} digunakan.
            </p>
          )}
        </section>
      )}

      {/* Data inventori */}
      <section className="rd-enter" style={{ animationDelay: "180ms" }}>
        <div className="rd-card relative rounded-2xl p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3.5">
              <div className={ICON_CHIP}>
                <Boxes className="h-5 w-5" />
              </div>
              <div>
                <p className={TITLE}>Data Inventori</p>
                <p className={DESC}>
                  Stok saat ini, riwayat mutasi, dan konsistensi sistem dari database hasil sync.
                </p>
              </div>
            </div>
            <InventoryExportMenu
              open={exportMenuOpen}
              onOpenChange={setExportMenuOpen}
              exporting={exporting}
              items={[
                { label: "Export Stok Saat Ini", detail: "Mengikuti pencarian & kategori aktif", onClick: handleExportStock },
                {
                  label: "Export Riwayat Mutasi",
                  detail: `Periode ${formatDate(movementStart)} - ${formatDate(movementEnd)}`,
                  onClick: handleExportMovements,
                },
                { label: "Export Konsistensi Inventori", detail: "Perhitungan konsistensi sistem", onClick: handleExportConsistency },
              ]}
            />
          </div>
          <div className="mt-5">
            {exportMessage && <p className="mb-3 text-sm text-slate-300">{exportMessage}</p>}

            {/* Tab */}
            <div
              role="tablist"
              aria-label="Bagian inventori"
              className="rd-capsule-group mb-4 inline-flex items-center rounded-full p-1"
            >
              {(
                [
                  { key: "stock", label: "Stok Saat Ini" },
                  { key: "movements", label: "Riwayat Mutasi" },
                  { key: "consistency", label: "Konsistensi" },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.key}
                  onClick={() => setTab(item.key)}
                  className={`rd-capsule ${tab === item.key ? "rd-capsule-active" : ""}`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {tab === "stock" && (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-2.5">
                  <div className={`${FIELD} w-full sm:w-64`}>
                    <Search className="h-4 w-4 shrink-0 text-slate-400" />
                    <Input
                      aria-label="Cari SKU atau nama produk"
                      placeholder="Cari SKU / nama produk"
                      value={stockSearch}
                      className="h-8 border-0 bg-transparent px-1 text-slate-200 shadow-none placeholder:text-slate-500 focus-visible:ring-0"
                      onChange={(event) => {
                        setStockSearch(event.target.value);
                        setStockPage(1);
                      }}
                    />
                  </div>
                  <select
                    aria-label="Filter kategori"
                    className={SELECT_CLASS}
                    value={stockCategory}
                    onChange={(event) => {
                      setStockCategory(event.target.value);
                      setStockPage(1);
                    }}
                  >
                    <option value="">Semua Kategori</option>
                    {stockCategories.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Filter status stok"
                    className={SELECT_CLASS}
                    value={stockStatusFilter}
                    onChange={(event) => {
                      setStockStatusFilter(event.target.value);
                      setStockPage(1);
                    }}
                  >
                    <option value="">Semua Status</option>
                    <option value="aman">Aman</option>
                    <option value="hampir">Hampir Habis</option>
                    <option value="habis">Habis</option>
                    <option value="nolengkap">Data Tidak Lengkap</option>
                  </select>
                </div>
                <div className="overflow-x-auto rounded-xl border border-white/10">
                  <table className="rd-table w-full min-w-[1180px] text-sm">
                    <thead>
                      <tr>
                        <th className={TH}>SKU</th>
                        <th className={TH}>Produk</th>
                        <th className={TH}>Varian</th>
                        <th className={TH}>Kategori</th>
                        <th className={TH}>Satuan</th>
                        <th className={TH}>Outlet</th>
                        <th className={TH}>Gudang</th>
                        <th className={`${TH} text-right`}>
                          <button
                            type="button"
                            className="uppercase tracking-wider transition-colors hover:text-slate-100"
                            onClick={() =>
                              setStockSort((prev) =>
                                prev.key === "stock" ? { key: "stock", dir: prev.dir === "asc" ? "desc" : "asc" } : { key: "stock", dir: "asc" },
                              )
                            }
                            title="Urutkan stok"
                          >
                            Stok Saat Ini {stockSort.key === "stock" ? (stockSort.dir === "asc" ? "↑" : "↓") : ""}
                          </button>
                        </th>
                        <th className={`${TH} text-right`}>Stok Minimum</th>
                        <th className={TH}>Status Stok</th>
                        <th className={`${TH} text-right`}>Harga Modal</th>
                        <th className={`${TH} text-right`}>
                          <button
                            type="button"
                            className="uppercase tracking-wider transition-colors hover:text-slate-100"
                            onClick={() =>
                              setStockSort((prev) =>
                                prev.key === "value" ? { key: "value", dir: prev.dir === "asc" ? "desc" : "asc" } : { key: "value", dir: "desc" },
                              )
                            }
                            title="Urutkan nilai persediaan"
                          >
                            Nilai Persediaan {stockSort.key === "value" ? (stockSort.dir === "asc" ? "↑" : "↓") : ""}
                          </button>
                        </th>
                        <th className={TH}>Terakhir Diperbarui</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stockLoading ? (
                        <tr>
                          <td colSpan={13} className="px-4 py-10 text-center text-slate-500">
                            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                            Memuat stok...
                          </td>
                        </tr>
                      ) : stockRows.length ? (
                        stockRows.map((row) => (
                          <tr
                            key={row.id}>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{row.sku ?? "-"}</td>
                            <td className="max-w-[240px] truncate px-3 py-2.5 font-medium text-slate-200" title={row.name}>
                              {row.name}
                            </td>
                            <td className="max-w-[120px] truncate px-3 py-2.5 text-slate-500">{row.variantName ?? "-"}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{row.category}</td>
                            <td className="px-3 py-2.5 text-slate-500">{row.uom ?? "-"}</td>
                            <td className="max-w-[130px] truncate px-3 py-2.5 text-slate-500">{row.storeName ?? "-"}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-400" title="Tidak tersedia dari API Olsera">
                              -
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-100">
                              {row.trackInventory ? row.stockQty : "-"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-500">
                              {row.trackInventory ? (
                                <span title={row.usesDefaultThreshold ? "Threshold default (bukan dari Olsera)" : "Minimum stock Olsera"}>
                                  {row.lowStockAlert ?? `${summary?.defaultThreshold ?? 5}*`}
                                </span>
                              ) : (
                                "-"
                              )}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5">{stockStatusBadge(row.status)}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-500">
                              {formatRupiah(row.buyPrice)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-100">
                              {row.trackInventory ? formatRupiah(row.value) : "-"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-500">{row.modifiedTime ?? "-"}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={13} className="px-4 py-12 text-center">
                            <div className="mx-auto flex max-w-sm flex-col items-center gap-2.5">
                              <span className="rounded-xl bg-white/5 p-2.5 text-slate-500">
                                <PackageSearch className="h-5 w-5" />
                              </span>
                              <p className="text-sm text-slate-500">
                                Belum ada data produk. Jalankan Sync Inventori terlebih dahulu.
                              </p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <PaginationRow page={stockPage} meta={stockMeta} onPage={setStockPage} unit="produk" />
              </>
            )}

            {tab === "movements" && (
              <>
                <div className={`mb-4 ${NOTE_BOX}`}>
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                  <p className="text-xs leading-relaxed text-slate-400">
                    Riwayat yang tersedia berasal dari transaksi penjualan Olsera. Histori stok masuk, adjustment,
                    transfer, retur, dan saldo sebelum/sesudah tidak tersedia dari API.
                  </p>
                </div>
                <div className="mb-4 flex flex-wrap items-center gap-2.5">
                  <div className={FIELD}>
                    <CalendarRange className="h-4 w-4 shrink-0 text-slate-400" />
                    <Input
                      type="date"
                      aria-label="Tanggal awal mutasi"
                      value={movementStart}
                      className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
                      onClick={(event) => event.currentTarget.showPicker?.()}
                      onChange={(event) => {
                        setMovementStart(event.target.value);
                        setMovementPage(1);
                      }}
                    />
                    <span className="text-xs text-slate-400">s/d</span>
                    <Input
                      type="date"
                      aria-label="Tanggal akhir mutasi"
                      value={movementEnd}
                      className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
                      onClick={(event) => event.currentTarget.showPicker?.()}
                      onChange={(event) => {
                        setMovementEnd(event.target.value);
                        setMovementPage(1);
                      }}
                    />
                  </div>
                  <select
                    aria-label="Filter jenis mutasi"
                    className={SELECT_CLASS}
                    value={movementType}
                    onChange={(event) => {
                      setMovementType(event.target.value);
                      setMovementPage(1);
                    }}
                  >
                    <option value="">Semua Jenis</option>
                    {movementTypes.map((type) => (
                      <option key={type} value={type}>
                        {type === "penjualan" ? "Penjualan" : type}
                      </option>
                    ))}
                  </select>
                  <div className={`${FIELD} w-full sm:w-60`}>
                    <Search className="h-4 w-4 shrink-0 text-slate-400" />
                    <Input
                      aria-label="Cari produk, SKU, atau referensi"
                      placeholder="Produk / SKU / referensi"
                      value={movementSearch}
                      className="h-8 border-0 bg-transparent px-1 text-slate-200 shadow-none placeholder:text-slate-500 focus-visible:ring-0"
                      onChange={(event) => {
                        setMovementSearch(event.target.value);
                        setMovementPage(1);
                      }}
                    />
                  </div>
                  {movementStart > movementEnd && (
                    <span className="text-sm text-rose-400">Tanggal akhir tidak boleh sebelum tanggal awal.</span>
                  )}
                </div>
                <div className="overflow-x-auto rounded-xl border border-white/10">
                  <table className="rd-table w-full min-w-[1000px] text-sm">
                    <thead>
                      <tr>
                        <th className={TH}>Tanggal</th>
                        <th className={TH}>SKU</th>
                        <th className={TH}>Produk</th>
                        <th className={TH}>Jenis Mutasi</th>
                        <th className={`${TH} text-right`}>Perubahan</th>
                        <th className={`${TH} text-right`}>Harga Modal</th>
                        <th className={`${TH} text-right`}>Nilai</th>
                        <th className={TH}>Referensi</th>
                        <th className={TH}>Catatan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {movementLoading ? (
                        <tr>
                          <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                            Memuat mutasi...
                          </td>
                        </tr>
                      ) : movementRows.length ? (
                        movementRows.map((row) => (
                          <tr
                            key={row.id}>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{row.movementAt}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{row.sku ?? "-"}</td>
                            <td className="max-w-[240px] truncate px-3 py-2.5 font-medium text-slate-200" title={row.productName}>
                              {row.productName}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 capitalize text-slate-300">{row.type}</td>
                            <td
                              className={`whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums ${
                                row.qtyChange < 0 ? "text-rose-400" : "text-emerald-400"
                              }`}
                            >
                              {row.qtyChange > 0 ? `+${row.qtyChange}` : row.qtyChange}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-500">
                              {row.costPrice === null ? "-" : formatRupiah(row.costPrice)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-100">
                              {row.value === null ? "-" : formatRupiah(row.value)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{row.reference ?? "-"}</td>
                            <td className="max-w-[200px] truncate px-3 py-2.5 text-xs text-slate-500" title={row.note ?? ""}>
                              {row.note ?? "-"}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={9} className="px-4 py-12 text-center">
                            <div className="mx-auto flex max-w-sm flex-col items-center gap-2.5">
                              <span className="rounded-xl bg-white/5 p-2.5 text-slate-500">
                                <PackageSearch className="h-5 w-5" />
                              </span>
                              <p className="text-sm text-slate-500">Tidak ada mutasi pada filter ini.</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <PaginationRow page={movementPage} meta={movementMeta} onPage={setMovementPage} unit="mutasi" />
              </>
            )}

            {tab === "consistency" && (
              <>
                {consistencyNote && (
                  <div className={`mb-4 ${NOTE_BOX}`}>
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                    <p className="text-xs leading-relaxed text-slate-400">{consistencyNote}</p>
                  </div>
                )}
                <div className="overflow-x-auto rounded-xl border border-white/10">
                  <table className="rd-table w-full min-w-[900px] text-sm">
                    <thead>
                      <tr>
                        <th className={TH}>SKU</th>
                        <th className={TH}>Produk</th>
                        <th className={TH}>Kategori</th>
                        <th className={`${TH} text-right`}>Snapshot Stok Awal</th>
                        <th className={`${TH} text-right`}>Penjualan Tercatat</th>
                        <th className={`${TH} text-right`}>Snapshot Stok Terakhir</th>
                        <th className={`${TH} text-right`}>Perubahan Snapshot</th>
                        <th className={TH}>Status Cakupan Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {consistencyLoading ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                            Menghitung konsistensi...
                          </td>
                        </tr>
                      ) : consistencyRows.length ? (
                        consistencyRows.map((row) => (
                          <tr
                            key={row.key}>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{row.sku ?? "-"}</td>
                            <td className="max-w-[240px] truncate px-3 py-2.5 font-medium text-slate-200" title={row.name}>
                              {row.name}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{row.category}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-500">
                              {row.startSnapshotQty ?? "Tidak tersedia"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-rose-400">
                              {row.recordedSales ?? "Tidak tersedia"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-200">
                              {row.endSnapshotQty ?? "Tidak tersedia"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-200">
                              {row.snapshotChange ?? "Tidak tersedia"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5">{consistencyBadge(row.status)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={8} className="px-4 py-12 text-center">
                            <div className="mx-auto flex max-w-sm flex-col items-center gap-2.5">
                              <span className="rounded-xl bg-white/5 p-2.5 text-slate-500">
                                <PackageSearch className="h-5 w-5" />
                              </span>
                              <p className="text-sm text-slate-500">
                                Belum ada data konsistensi. Jalankan Sync Inventori terlebih dahulu.
                              </p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function PaginationRow({
  page,
  meta,
  onPage,
  unit,
}: {
  page: number;
  meta: { total: number; totalPages: number };
  onPage: (page: number) => void;
  unit: string;
}) {
  const currentPage = Math.min(page, Math.max(1, meta.totalPages));
  return (
    <div className="mt-4 flex flex-col items-center justify-between gap-3 border-t border-white/10 pt-4 text-sm sm:flex-row">
      <span className="text-slate-400">
        {meta.total} {unit}
      </span>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className={PAGE_BTN}
          onClick={() => onPage(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
        >
          Sebelumnya
        </Button>
        <span className="text-slate-400">
          Halaman {currentPage} / {Math.max(1, meta.totalPages)}
        </span>
        <Button
          type="button"
          variant="outline"
          className={PAGE_BTN}
          onClick={() => onPage(Math.min(meta.totalPages, currentPage + 1))}
          disabled={currentPage >= meta.totalPages}
        >
          Berikutnya
        </Button>
      </div>
    </div>
  );
}
