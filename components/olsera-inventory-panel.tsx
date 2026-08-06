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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InventoryExportMenu } from "@/components/redesign/inventory-export-menu";
import { OLSERA_INVENTORY_BASELINE_DATE } from "@/lib/olsera-baseline";
import { acquireOlseraSyncLock, releaseOlseraSyncLock, subscribeOlseraSyncLock } from "@/lib/olsera-sync-lock";
import {
  displayValue,
  formatQty,
  hasAnyMeaningfulValue,
  hiddenInventoryRowCount,
  periodStatusLabel,
  stockEmptyStateMessage,
  syncStatusLabel,
  visibleInventoryRows,
  visibleInventoryTabs,
} from "@/lib/olsera-inventory-ui";

const TITLE = "text-[16px] font-semibold tracking-tight text-slate-50";
const DESC = "mt-1 text-[13.5px] leading-relaxed text-slate-400";
const ICON_CHIP = "rd-stat-icon rounded-xl p-2.5";
const FIELD = "rd-field flex h-10 items-center gap-2 rounded-full px-3";
const PRIMARY_BTN =
  "rounded-lg bg-rose-600 font-medium text-white shadow-sm transition-colors hover:bg-rose-500 active:bg-rose-700";
const SELECT_CLASS = "rd-input h-10 px-2 text-[13.5px]";
const TH = "h-11 px-3 text-left text-[12px] font-semibold uppercase tracking-wider text-slate-400";
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
  hasData?: boolean;
  totalProducts: number;
  productsWithStock: number;
  outOfStock: number;
  lowStock: number;
  totalStock: number;
  totalValue: number;
  usesDefaultThreshold: boolean;
  defaultThreshold: number;
  missingCostRows?: number;
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
  /** Belum disediakan API Olsera — kolom Gudang otomatis tersembunyi selama kosong. */
  warehouseName?: string | null;
  stockQty: number;
  closingQty: number | null;
  openingQty: number | null;
  incomingQty: number | null;
  returnQty: number | null;
  salesQty: number | null;
  outgoingQty: number | null;
  lowStockAlert: number | null;
  usesDefaultThreshold: boolean;
  status: string;
  buyPrice: number;
  value: number | null;
  active: boolean;
  trackInventory: boolean;
  modifiedTime: string | null;
  snapshotStatus?: "complete" | "boundary-only" | "incomplete";
  diagnostics?: string[];
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

export function OlseraInventoryPanel({ isSupervisor = false }: { isSupervisor?: boolean }) {
  const today = jakartaToday();
  const monthStart = `${today.slice(0, 7)}-01`;

  // Modul "olsera" sudah cukup untuk seluruh tab, termasuk Konsistensi.
  const tabs = visibleInventoryTabs(isSupervisor);

  const [summary, setSummary] = useState<Summary | null>(null);
  // Default tersembunyi saat halaman pertama dibuka (keputusan UX) — user
  // tetap bisa membukanya lewat tombol toggle di bawah.
  const [showSummary, setShowSummary] = useState(false);
  const [periodStatus, setPeriodStatus] = useState("Snapshot Tidak Tersedia");
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const syncRunningRef = useRef(false);
  // "Sync Semua Olsera" (orkestrator di app/page.tsx) berbagi lock ini agar
  // tombol modul ini tidak bisa jalan bersamaan dengan sync modul lain.
  const [externallyLocked, setExternallyLocked] = useState(false);
  useEffect(() => subscribeOlseraSyncLock(setExternallyLocked), []);

  const [tab, setTab] = useState<"stock" | "movements">("stock");
  const [period, setPeriod] = useState(() => {
    if (typeof window === "undefined") return today.slice(0, 7);
    const value = new URLSearchParams(window.location.search).get("inventoryPeriod");
    return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : today.slice(0, 7);
  });

  // Stok Saat Ini
  const [stockRows, setStockRows] = useState<ProductRow[]>([]);
  const [stockCategories, setStockCategories] = useState<string[]>([]);
  const [stockSearch, setStockSearch] = useState("");
  const [stockCategory, setStockCategory] = useState("");
  const [stockStatusFilter, setStockStatusFilter] = useState("");
  const [stockSort, setStockSort] = useState<{ key: "name" | "stock" | "value"; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const [stockPage, setStockPage] = useState(1);
  const [showHiddenItems, setShowHiddenItems] = useState(false);
  const [stockMeta, setStockMeta] = useState({ total: 0, totalPages: 1 });
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState(false);
  const [stockHasData, setStockHasData] = useState<boolean | null>(null);
  const [stockReloadTick, setStockReloadTick] = useState(0);

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
  const [movementError, setMovementError] = useState(false);
  const [movementReloadTick, setMovementReloadTick] = useState(0);

  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  // Dropdown Export kini dirender lewat portal (InventoryExportMenu) —
  // penutupan klik-luar/Escape ditangani komponen tersebut.
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("inventoryPeriod", period);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    const [year, month] = period.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const end = period === today.slice(0, 7) ? today : `${period}-${String(lastDay).padStart(2, "0")}`;
    setMovementStart(`${period}-01`);
    setMovementEnd(end);
    setMovementPage(1);
  }, [period, today]);

  // Status sync tetap memakai endpoint status; kartu/tabel bulanan memakai
  // endpoint snapshot yang sama agar tidak pernah mencampur stok current.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/olsera/inventory/summary?_t=${Date.now()}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) { await redirectToLogin(); return null; }
        return (await response.json().catch(() => null)) as { status?: SyncStatus } | null;
      })
      .then((payload) => { if (!cancelled && payload?.status) setSyncStatus(payload.status); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [refreshTick]);

  // Tabel stok. Sengaja TIDAK digerbang oleh tab — kartu Laporan Stock Opname
  // Bulanan dan Ringkasan (di luar blok tab) memakai state yang sama, jadi
  // status periode & tombol export harus tetap segar walau user sedang di
  // tab Riwayat Mutasi saat mengganti periode.
  useEffect(() => {
    let cancelled = false;
    setStockLoading(true);
    setStockError(false);
    setStockRows([]);
    setStockHasData(null);
    setSummary(null);
    setPeriodStatus("Memuat status periode...");
    const params = new URLSearchParams({
      period,
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
      fetch(`/api/olsera/inventory/monthly?${params.toString()}`, { cache: "no-store" })
        .then(async (response) => {
          if (response.status === 401) {
            await redirectToLogin();
            return null;
          }
          return (await response.json().catch(() => null)) as
            | { hasData?: boolean; data?: ProductRow[]; total?: number; totalPages?: number; categories?: string[]; summary?: Summary; syncStatus?: SyncStatus; status?: string }
            | null;
        })
        .then((payload) => {
          if (cancelled) return;
          if (!payload?.data) {
            setStockError(true);
            return;
          }
          setStockRows(payload.data);
          setStockHasData(payload.hasData ?? null);
          setStockMeta({ total: payload.total ?? 0, totalPages: payload.totalPages ?? 1 });
          if (payload.categories) setStockCategories(payload.categories);
          if (payload.summary) setSummary({ ...payload.summary, hasData: payload.hasData });
          if (payload.syncStatus) setSyncStatus(payload.syncStatus);
          if (payload.status) setPeriodStatus(payload.status);
        })
        .catch(() => {
          if (!cancelled) setStockError(true);
        })
        .finally(() => {
          if (!cancelled) setStockLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [tab, period, stockSearch, stockCategory, stockStatusFilter, stockSort, stockPage, refreshTick, stockReloadTick]);

  // Riwayat mutasi
  useEffect(() => {
    if (tab !== "movements") return;
    if (movementStart > movementEnd) return;
    let cancelled = false;
    setMovementLoading(true);
    setMovementError(false);
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
          if (cancelled) return;
          if (!payload?.data) {
            setMovementError(true);
            return;
          }
          setMovementRows(payload.data);
          setMovementMeta({ total: payload.total ?? 0, totalPages: payload.totalPages ?? 1 });
          if (payload.types) setMovementTypes(payload.types);
        })
        .catch(() => {
          if (!cancelled) setMovementError(true);
        })
        .finally(() => {
          if (!cancelled) setMovementLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [tab, period, movementStart, movementEnd, movementType, movementSearch, movementPage, refreshTick, movementReloadTick]);

  // Sync bertahap: start lalu step berulang sampai selesai (aman untuk Vercel).
  const handleSync = useCallback(async () => {
    if (syncRunningRef.current || !acquireOlseraSyncLock()) return;
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
          setSyncMessage("Menarik katalog produk dan data stok...");
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
      releaseOlseraSyncLock();
      setSyncing(false);
      setRefreshTick((value) => value + 1);
    }
  }, []);

  async function downloadExportFromPath(path: string, fallbackName: string) {
    setExporting(true);
    setExportMessage("");
    try {
      const response = await fetch(path, { cache: "no-store" });
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

  // Dropdown "Export Inventori" berisi dua laporan berbeda, bukan pengganti
  // satu sama lain: Laporan Stock Opname Bulanan (format lama, kolom
  // tanggal/per hari, dikembalikan dari commit f5bf8f0 — lihat
  // tmp/ai-handoff.md) dan Export Pergerakan Stok (canonical, sheet
  // "[Bulan] Terjual"/"[Bulan] Keseluruhan", aturan produk historis dari
  // commit 938d16f — label diganti dari "Export Inventori 2 Sheet" di commit
  // ed6eec9, hanya teks UI, route/generator/nama sheet TIDAK berubah).
  // Keduanya memakai periode yang sedang aktif dipilih di atas dan
  // self-healing lewat ensureMonthlySnapshotChain — snapshot bulanan periode
  // ini dibangun dulu on-demand bila belum ada sebelum file diunduh.
  function handleExportMonthlyStockOpname() {
    const [yearStr, monthStr] = period.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (!year || !month) {
      setExportMessage("Pilih bulan terlebih dahulu.");
      return;
    }
    void downloadExportFromPath(
      `/api/olsera/inventory/export/monthly-stock-opname?year=${year}&month=${month}`,
      `Laporan Stock Opname Bulanan-${period}.xlsx`,
    );
  }

  function handleExportInventory() {
    const [yearStr, monthStr] = period.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (!year || !month) {
      setExportMessage("Pilih bulan terlebih dahulu.");
      return;
    }
    void downloadExportFromPath(
      `/api/olsera/inventory/export/monthly-auto?year=${year}&month=${month}`,
      `Inventori-${period}.xlsx`,
    );
  }

  const state = syncStatus?.state;
  const run = syncStatus?.run;

  // Kolom disembunyikan bila SELURUH baris pada data aktif tidak punya nilai
  // bermakna (null/undefined/""/"-"); tetap tampil bila minimal satu baris
  // valid. Dihitung per-tabel. Field-nya tetap ada di database & export
  // internal — ini murni tampilan.
  const hiddenStockRowCount = hiddenInventoryRowCount(stockRows);
  const visibleStockRows = visibleInventoryRows(stockRows, showHiddenItems);
  const showStockSku = hasAnyMeaningfulValue(stockRows.map((row) => row.sku));
  const showStockUom = hasAnyMeaningfulValue(stockRows.map((row) => row.uom));
  const showStockWarehouse = hasAnyMeaningfulValue(stockRows.map((row) => row.warehouseName));
  const showMovementSku = hasAnyMeaningfulValue(movementRows.map((row) => row.sku));

  // Kolom tetap tabel Stok (setelah "Terakhir Diperbarui"/"Outlet"/"Stok
  // Minimum"/"Status Stok"/"Harga Modal"/"Nilai Persediaan" dihapus dari
  // tampilan — field & formula backend TIDAK dihapus, hanya tidak dirender):
  // Produk, Varian, Kategori, Stok Awal, Barang Masuk, Retur, Penjualan,
  // Barang Keluar, Sisa Stok.
  const stockColSpan =
    9 + (showStockSku ? 1 : 0) + (showStockUom ? 1 : 0) + (showStockWarehouse ? 1 : 0);
  // Kolom tetap tabel Mutasi (setelah "Catatan" dihapus): Tanggal, Produk,
  // Jenis, Perubahan, Harga Modal, Nilai, Referensi.
  const movementColSpan = 7 + (showMovementSku ? 1 : 0);

  const summaryCards: { label: string; value: string; accent?: string }[] = summary
    ? [
        { label: "Total Produk", value: String(summary.totalProducts) },
        { label: "Produk dengan Sisa Stok", value: String(summary.productsWithStock) },
        { label: "Stok Habis", value: String(summary.outOfStock), accent: "text-rose-400" },
        { label: "Stok Hampir Habis", value: String(summary.lowStock), accent: "text-amber-300" },
        { label: "Total Stok", value: String(summary.totalStock) },
      ]
    : [];

  return (
    <div className="inv-panel">
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
                  {state?.lastSuccessfulSyncAt
                    ? `${syncStatus?.productCount ?? 0} produk · ${syncStatus?.movementCount ?? 0} mutasi tersinkron.`
                    : `Belum pernah sync — sync pertama memeriksa ${formatDate(BASELINE_DATE)} sampai hari ini.`}
                </p>
              </div>
            </div>
            {syncing || run?.status === "running" ? (
              run?.isStale && !syncing ? (
                <span className="rd-chip rd-chip-danger">
                  <AlertTriangle className="h-3 w-3" />
                  {syncStatusLabel("stale")}
                </span>
              ) : (
                <span className="rd-chip">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {syncStatusLabel("running")}
                </span>
              )
            ) : run?.status === "success" ? (
              <span className="rd-chip rd-chip-ok">{syncStatusLabel("success")}</span>
            ) : run?.status === "partial" ? (
              <span className="rd-chip border-amber-400/40 bg-amber-400/10 text-amber-300">{syncStatusLabel("partial")}</span>
            ) : run?.status === "failed" ? (
              <span className="rd-chip rd-chip-danger">{syncStatusLabel("failed")}</span>
            ) : (
              <span className="rd-chip">{syncStatusLabel("idle")}</span>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="button" className={PRIMARY_BTN} onClick={handleSync} disabled={syncing || externallyLocked}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {syncing ? "Menyinkronkan Inventori..." : "Sync Inventori"}
            </Button>
            <span className="text-xs text-slate-500">
              Sync berikutnya melanjutkan otomatis dari data terakhir.
            </span>
          </div>
          {externallyLocked && !syncing ? (
            <p className="mt-3 text-sm text-amber-400">Sinkronisasi Olsera lain sedang berjalan (mis. Sync Semua Olsera) — tunggu hingga selesai.</p>
          ) : null}
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
        </div>
      </section>

      {/* Periode Inventori — dipakai bersama oleh tabel Stok Bulanan, Riwayat
          Mutasi, dan tombol Export Inventori di kartu Data Inventori di bawah. */}
      <section className="rd-enter mb-4" style={{ animationDelay: "80ms" }}>
        <div className="rd-card relative rounded-2xl p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3.5">
              <div className={ICON_CHIP}>
                <ClipboardList className="h-5 w-5" />
              </div>
              <div>
                <p className={TITLE}>Periode Inventori</p>
                <p className={DESC}>
                  Pilih bulan untuk menampilkan Stok Bulanan, Riwayat Mutasi, dan mengunduh Export Inventori periode
                  tersebut.
                </p>
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className={FIELD}>
              <CalendarRange className="h-4 w-4 shrink-0 text-slate-400" />
              <Input
                type="month"
                aria-label="Periode Inventori"
                value={period}
                className="h-8 w-[150px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
                onClick={(event) => event.currentTarget.showPicker?.()}
                onChange={(event) => setPeriod(event.target.value)}
              />
            </div>
            <p className="text-xs text-slate-500">Periode aktif: {period} · kartu, tabel, mutasi, dan export mengikuti periode ini.</p>
            <p className="mt-2 text-sm font-medium text-slate-300">Status periode: {periodStatusLabel(periodStatus)}</p>
            {periodStatus === "Bulan Berjalan / Belum Final" && (
              <p className="mt-1 text-xs text-amber-300">Data sementara sampai tanggal sinkron terakhir: {formatDate(state?.lastSyncedDate)}</p>
            )}
          </div>
        </div>
      </section>

      {/* Ringkasan */}
      {summary && summary.hasData !== false && (
        <section className="mb-4">
          <Button type="button" variant="outline" className="mb-3" onClick={() => setShowSummary((visible) => !visible)} aria-expanded={showSummary}>
            {showSummary ? "Sembunyikan Ringkasan" : "Tampilkan Ringkasan"}
          </Button>
          {showSummary && <div className="flex gap-4 overflow-x-auto pb-1">
          {summaryCards.map((card, index) => (
            <div
              key={card.label}
              className="rd-card rd-enter relative min-w-44 flex-1 rounded-2xl p-4"
              style={{ animationDelay: `${index * 60}ms` }}
            >
              <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{card.label}</p>
              <p className={`mt-1 text-lg font-semibold tabular-nums tracking-tight ${card.accent ?? "text-slate-50"}`}>
                {card.value}
              </p>
            </div>
          ))}
          </div>}
          {showSummary && summary.usesDefaultThreshold && (
            <p className="mt-2 text-xs text-slate-500">
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
                  Stok bulanan dan riwayat mutasi dari database hasil sync.
                </p>
              </div>
            </div>
            <InventoryExportMenu
              open={exportMenuOpen}
              onOpenChange={setExportMenuOpen}
              exporting={exporting}
              label="Export Inventori"
              items={[
                {
                  label: "Laporan Stock Opname Bulanan",
                  detail: "Laporan stok bulanan dengan rincian tanggal/per hari.",
                  onClick: handleExportMonthlyStockOpname,
                },
                {
                  label: "Export Pergerakan Stok",
                  detail: "Laporan produk terjual dan keseluruhan dalam dua sheet.",
                  onClick: handleExportInventory,
                },
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
              {tabs.map((item) => (
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
                    <option value="manual">Butuh Adjust Manual</option>
                  </select>
                  <Button
                    type="button"
                    variant={showHiddenItems ? "secondary" : "outline"}
                    aria-pressed={showHiddenItems}
                    className={showHiddenItems ? "border border-rose-400/40 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25" : PAGE_BTN}
                    onClick={() => {
                      setShowHiddenItems((current) => !current);
                      setStockPage(1);
                    }}
                  >
                    Hidden Item{hiddenStockRowCount > 0 ? ` (${hiddenStockRowCount})` : ""}
                  </Button>
                </div>
                <p className="-mt-1 mb-4 text-xs leading-relaxed text-slate-500">
                  Item tersembunyi tetap ikut dihitung di laporan dan export.
                </p>
                <div className="overflow-x-auto rounded-xl border border-white/10">
                  <table className="rd-table w-full min-w-[980px] text-sm">
                    <thead>
                      <tr>
                        {showStockSku && <th className={TH}>SKU</th>}
                        <th className={TH}>Produk</th>
                        <th className={TH}>Varian</th>
                        <th className={TH}>Kategori</th>
                        {showStockUom && <th className={TH}>Satuan</th>}
                        {showStockWarehouse && <th className={TH}>Gudang</th>}
                        <th className={`${TH} text-right`}>Stok Awal</th>
                        <th className={`${TH} text-right`}>Barang Masuk</th>
                        <th className={`${TH} text-right`}>Retur</th>
                        <th className={`${TH} text-right`}>Penjualan</th>
                        <th className={`${TH} text-right`}>Barang Keluar</th>
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
                            Sisa Stok {stockSort.key === "stock" ? (stockSort.dir === "asc" ? "↑" : "↓") : ""}
                          </button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {stockLoading ? (
                        <tr>
                          <td colSpan={stockColSpan} className="px-4 py-10 text-center text-slate-500">
                            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                            Memuat stok...
                          </td>
                        </tr>
                      ) : stockError ? (
                        <tr>
                          <td colSpan={stockColSpan} className="px-4 py-12 text-center">
                            <div className="mx-auto flex max-w-sm flex-col items-center gap-2.5">
                              <p className="text-sm text-slate-300">Gagal memuat data. Silakan coba lagi.</p>
                              <Button
                                type="button"
                                variant="outline"
                                className={PAGE_BTN}
                                onClick={() => setStockReloadTick((value) => value + 1)}
                              >
                                Coba Lagi
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ) : visibleStockRows.length ? (
                        visibleStockRows.map((row) => (
                          <tr
                            key={row.id}>
                            {showStockSku && (
                              <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{displayValue(row.sku)}</td>
                            )}
                            <td className="max-w-[240px] truncate px-3 py-2.5 font-medium text-slate-200" title={row.name}>
                              {row.name}
                            </td>
                            <td className="max-w-[120px] truncate px-3 py-2.5 text-slate-500">{displayValue(row.variantName)}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{displayValue(row.category)}</td>
                            {showStockUom && <td className="px-3 py-2.5 text-slate-500">{displayValue(row.uom)}</td>}
                            {showStockWarehouse && (
                              <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{displayValue(row.warehouseName)}</td>
                            )}
                            {[row.openingQty, row.incomingQty, row.returnQty, row.salesQty, row.outgoingQty].map((value, index) => (
                              <td key={index} className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-500">
                                {formatQty(value)}
                              </td>
                            ))}
                            <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-100">
                              {formatQty(row.closingQty)}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={stockColSpan} className="px-4 py-12 text-center">
                            <div className="mx-auto flex max-w-sm flex-col items-center gap-2.5">
                              <span className="rounded-xl bg-white/5 p-2.5 text-slate-500">
                                <PackageSearch className="h-5 w-5" />
                              </span>
                              <p className="text-sm text-slate-500">
                                {stockEmptyStateMessage({
                                  totalRows: stockRows.length,
                                  visibleRows: visibleStockRows.length,
                                  hasData: stockHasData,
                                })}
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
                <div className="mb-4 flex flex-wrap items-center gap-2.5">
                  <div className={`${FIELD} text-sm text-slate-300`}>
                    <CalendarRange className="h-4 w-4 shrink-0 text-slate-400" />
                    Periode {period} ({formatDate(movementStart)} s/d {formatDate(movementEnd)})
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
                </div>
                <div className="overflow-x-auto rounded-xl border border-white/10">
                  <table className="rd-table w-full min-w-[880px] text-sm">
                    <thead>
                      <tr>
                        <th className={TH}>Tanggal</th>
                        {showMovementSku && <th className={TH}>SKU</th>}
                        <th className={TH}>Produk</th>
                        <th className={TH}>Jenis Mutasi</th>
                        <th className={`${TH} text-right`}>Perubahan</th>
                        <th className={`${TH} text-right`}>Harga Modal</th>
                        <th className={`${TH} text-right`}>Nilai</th>
                        <th className={TH}>Referensi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {movementLoading ? (
                        <tr>
                          <td colSpan={movementColSpan} className="px-4 py-10 text-center text-slate-500">
                            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                            Memuat mutasi...
                          </td>
                        </tr>
                      ) : movementError ? (
                        <tr>
                          <td colSpan={movementColSpan} className="px-4 py-12 text-center">
                            <div className="mx-auto flex max-w-sm flex-col items-center gap-2.5">
                              <p className="text-sm text-slate-300">Gagal memuat data. Silakan coba lagi.</p>
                              <Button
                                type="button"
                                variant="outline"
                                className={PAGE_BTN}
                                onClick={() => setMovementReloadTick((value) => value + 1)}
                              >
                                Coba Lagi
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ) : movementRows.length ? (
                        movementRows.map((row) => (
                          <tr
                            key={row.id}>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{row.movementAt}</td>
                            {showMovementSku && (
                              <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{displayValue(row.sku)}</td>
                            )}
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
                              {row.costPrice === null ? "" : formatRupiah(row.costPrice)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-100">
                              {row.value === null ? "" : formatRupiah(row.value)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{displayValue(row.reference)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={movementColSpan} className="px-4 py-12 text-center">
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

          </div>
        </div>
      </section>
    </div>
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
