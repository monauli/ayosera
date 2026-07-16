"use client";

import { useEffect, useRef, useState, type ElementType } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpDown,
  BadgeCheck,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  DatabaseZap,
  FileSpreadsheet,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  Search,
  RotateCcw,
  Store,
  Users,
  Webhook,
  Clock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OlseraInventoryPanel } from "@/components/olsera-inventory-panel";
import { UsersPanel } from "@/components/users-panel";
import { AyoseraHeader } from "@/components/redesign/ayosera-header";
import { AyoseraShell } from "@/components/redesign/ayosera-shell";
import { AyoseraSidebar } from "@/components/redesign/ayosera-sidebar";
import { DashboardOverview } from "@/components/redesign/dashboard-overview";
import { DashboardStatCard } from "@/components/redesign/dashboard-stat-card";
import { TransactionExportMenu } from "@/components/redesign/transaction-export-menu";

type HourlyPoint = { time: string; transactions: number; revenue: number };
type ServicePoint = { name: string; branch: string; revenue: string; count: number; progress: number };
type PaymentPoint = { name: string; value: number; color: string };
type RevenuePoint = { day: string; amount: number };
type OccupancyPoint = { branch: string; rate: number };
type SyncEvent = { label: string; detail: string; time: string; tone: string };

type DashboardPayload = {
  metrics: {
    totalTransactions: number;
    revenueToday: string;
    revenueMonth: string;
    activeCustomers: number;
  };
  hourlyTransactions: HourlyPoint[];
  topServices: ServicePoint[];
  paymentBreakdown: PaymentPoint[];
  revenueTrend: RevenuePoint[];
  occupancy: OccupancyPoint[];
  syncEvents: SyncEvent[];
  branchOptions: { label: string; value: string }[];
};

type TransactionRow = {
  id: string;
  orderDetailId?: string;
  date?: string;
  customer: string;
  phone?: string;
  email?: string;
  branch: string;
  service: string;
  fieldId?: string;
  amount: string;
  amountValue?: number;
  payment: string;
  bookingSource?: string;
  status: string;
  time: string;
  endTime?: string;
  rawStatus?: string;
  createdAt?: string;
  syncedAt?: string;
  note?: string;
  changeType?: "new" | "updated" | "rescheduled" | null;
  changedAt?: string;
  previousSchedule?: { date: string; start_time: string; end_time: string };
  fieldChanges?: { field: string; from: string; to: string }[];
};
type DatePreset = "today" | "yesterday" | "month" | "lastMonth" | "custom" | "manualMonth";

type WebhookLogRow = {
  receivedAt: string;
  method: string;
  status: "received" | "invalid" | "error";
  ok: boolean;
  itemCount: number;
  ids: Record<string, string[]>;
  message: string;
  bodyPreview: string;
};

type OlseraSyncStatus = {
  /** Jumlah item yang belum punya mapping kategori (audit canonical resolver). */
  unresolvedItemCount?: number;
  lastFullySyncedDate: string | null;
  firstSyncedDate: string | null;
  lastSync: {
    status: "success" | "partial" | "failed";
    startDate: string;
    endDate: string;
    expectedOrderCount: number;
    processedOrderCount: number;
    errorMessage: string | null;
    startedAt: string;
    finishedAt: string | null;
  } | null;
};

type WebhookPayload = {
  total: number;
  lastReceivedAt: string | null;
  logs: WebhookLogRow[];
};

type SortKey = "date" | "id" | "customer" | "service" | "amount" | "status";
type SortState = { key: SortKey; dir: "asc" | "desc" };

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th className={`h-10 px-2 font-medium ${align === "right" ? "text-right" : ""}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-slate-100 ${
          align === "right" ? "flex-row-reverse" : ""
        } ${active ? "text-slate-100" : ""}`}
        title="Klik untuk mengurutkan"
      >
        {label}
        <Icon className={`h-3 w-3 ${active ? "" : "opacity-40"}`} />
      </button>
    </th>
  );
}

// `label` adalah kunci internal navigasi (dipakai activeNav di banyak kondisi),
// `display` adalah teks yang tampil di sidebar. `subItems` menjadikan menu
// collapsible — submenu baru (mis. Inventori) cukup ditambahkan ke array ini.
const navItems = [
  { label: "Dasbor", display: "Dashboard Ayosera", icon: LayoutDashboard, module: "dasbor" },
  { label: "Transaksi", display: "Transaksi AYO", icon: Activity, module: "transaksi" },
  {
    label: "Olsera",
    display: "Olsera",
    icon: Store,
    module: "olsera",
    subItems: [
      { label: "Kategori Penjualan", nav: "Olsera" },
      { label: "Inventori", nav: "OlseraInventori" },
    ],
  },
  { label: "Webhook", display: "Webhook", icon: Webhook, module: "webhook" },
];

type SessionUserInfo = {
  id: string;
  email: string;
  name: string;
  role: "supervisor" | "user";
  allowedModules: string[];
};

const THEME_STORAGE_KEY = "ayo-theme";
const themeOptions = [
  { value: "white", label: "Putih + Rosé", swatch: "#ffffff", ring: "#FFD8DF" },
  { value: "rose", label: "Rosé", swatch: "#FFD8DF", ring: "#f472b6" },
  { value: "mint", label: "Mint", swatch: "#A8DF8E", ring: "#86c36e" },
  { value: "lavender", label: "Lavender", swatch: "#DDD6FE", ring: "#a78bfa" },
  { value: "ocean", label: "Ocean", swatch: "#A5E6F0", ring: "#67c8dc" },
  { value: "amber", label: "Amber", swatch: "#FDDDA8", ring: "#f5b45a" },
];

/** "2026-07-13T11:11:39Z" → "13 Jul 2026 pukul 18:11:39" (Asia/Jakarta). */
function formatSyncDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")} pukul ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Jam "18:11:39" (Asia/Jakarta) dari timestamp; "" bila tidak valid. */
function formatJakartaTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}:${get("second")}`;
}

function statusVariant(status: string) {
  if (status === "Completed") return "success";
  if (status === "Pending") return "warning";
  return "danger";
}

function statusLabel(status: string) {
  if (status === "Completed") return "Selesai";
  if (status === "Pending") return "Belum Bayar";
  if (status === "Cancelled") return "Dibatalkan";
  return status;
}

function changeIndicator(row: TransactionRow) {
  if (row.changeType === "rescheduled") {
    const prev = row.previousSchedule;
    const title = prev
      ? `Jadwal diubah dari ${prev.date} ${prev.start_time?.slice(0, 5)}-${prev.end_time?.slice(0, 5)}`
      : "Jadwal diubah (reschedule)";
    return {
      label: "Reschedule",
      icon: CalendarClock,
      className: "bg-amber-100 text-amber-800",
      title,
    };
  }
  // changeType "new"/"updated" sengaja tidak diberi badge (tampil "—" seperti tanpa perubahan);
  // datanya (changeType/changedAt/fieldChanges) tetap tersimpan di database.
  return null;
}

function formatJakartaDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function monthStartJakarta() {
  const today = formatJakartaDate(new Date());
  return `${today.slice(0, 7)}-01`;
}

function monthRangeFromValue(value: string) {
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) {
    const today = formatJakartaDate(new Date());
    return { startDate: today, endDate: today };
  }

  const startDate = `${value}-01`;
  const endDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { startDate, endDate };
}

function previousMonthValue() {
  const [year, month] = formatJakartaDate(new Date()).slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}

function getDatePresetRange(value: DatePreset) {
  const now = new Date();
  const currentDate = formatJakartaDate(now);

  if (value === "today") {
    return { startDate: currentDate, endDate: currentDate };
  }

  if (value === "yesterday") {
    const yesterday = addDaysISO(currentDate, -1);
    return { startDate: yesterday, endDate: yesterday };
  }

  if (value === "lastMonth") {
    return monthRangeFromValue(previousMonthValue());
  }

  return { startDate: monthStartJakarta(), endDate: currentDate };
}

function isInvalidDateRange(startDate: string, endDate: string) {
  return Boolean(startDate && endDate && startDate > endDate);
}

function addDaysISO(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function daysBetweenISO(startDate: string, endDate: string) {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
}

function formatDisplayDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value || "-";

  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatMonthLabel(value: string) {
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return value || "-";

  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function getRevenueFilterDetail(preset: DatePreset, startDate: string, endDate: string) {
  if (preset === "today") return `Hari ini (${formatDisplayDate(startDate)})`;
  if (preset === "yesterday") return `Kemarin (${formatDisplayDate(startDate)})`;
  if (preset === "month") return `Bulan ini (${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)})`;
  if (preset === "lastMonth") return `Bulan lalu (${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)})`;
  if (preset === "manualMonth")
    return `${formatMonthLabel(startDate.slice(0, 7))} (${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)})`;
  if (startDate === endDate) return `Filter tanggal ${formatDisplayDate(startDate)}`;
  return `Filter ${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`;
}

function formatRupiah(value: number) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  })
    .format(value)
    .replace(/\s/g, "");
}

const datePresetButtons: { label: string; value: DatePreset }[] = [
  { label: "Hari ini", value: "today" },
  { label: "Kemarin", value: "yesterday" },
  { label: "Bulan ini", value: "month" },
  { label: "Bulan lalu", value: "lastMonth" },
];

// Sesi tidak valid (401): bersihkan cookie sesi yang basi lalu arahkan ke /login.
// Tanpa sign-out, cookie kedaluwarsa tetap tersisa dan bikin pengalaman membingungkan.
async function redirectToLogin() {
  try {
    await fetch("/api/auth/sign-out", { method: "POST" });
  } catch {
    // abaikan — tetap arahkan ke login apa pun hasilnya
  }
  window.location.href = "/login";
}

// ---- Gaya bersama halaman Penjualan Olsera (visual saja, tanpa logic) ----
const OLSERA_CARD =
  "rounded-2xl border-slate-200 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_14px_36px_-22px_rgba(15,23,42,0.3)]";
const OLSERA_CARD_HEADER =
  "rounded-t-2xl border-b border-slate-100 bg-gradient-to-r from-slate-50/90 via-white to-rose-50/50";
const OLSERA_CARD_CONTENT = "pt-5";
const OLSERA_TITLE = "text-[15px] font-semibold tracking-tight text-slate-900";
const OLSERA_DESC = "mt-1 text-[13px] leading-relaxed text-slate-500";
const OLSERA_ICON_CHIP = "rounded-xl p-2.5 ring-1 ring-inset";
const OLSERA_FIELD =
  "flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 shadow-sm transition-colors focus-within:border-rose-300 focus-within:ring-2 focus-within:ring-rose-200";
const OLSERA_PRIMARY_BTN =
  "rounded-lg bg-rose-600 font-medium text-white shadow-sm transition-colors hover:bg-rose-700 active:bg-rose-800";
const OLSERA_SEGMENT_BTN =
  "inline-flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400";
const OLSERA_MENU_ITEM =
  "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 transition-colors hover:bg-rose-50 focus-visible:bg-rose-50 focus-visible:outline-none";

export default function DashboardPage() {
  const today = formatJakartaDate(new Date());
  const currentMonth = today.slice(0, 7);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [transactionRows, setTransactionRows] = useState<TransactionRow[]>([]);
  const [txnMeta, setTxnMeta] = useState<{ total: number; totalPages: number }>({ total: 0, totalPages: 1 });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [courtFilter, setCourtFilter] = useState("all");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [filterMonth, setFilterMonth] = useState(currentMonth);
  // Input custom range terpisah dari startDate/endDate: baru diterapkan saat kedua tanggal valid.
  const [customRangeStart, setCustomRangeStart] = useState(today);
  const [customRangeEnd, setCustomRangeEnd] = useState(today);
  const [syncMonth, setSyncMonth] = useState(currentMonth);
  const [syncRangeStart, setSyncRangeStart] = useState(today);
  const [syncRangeEnd, setSyncRangeEnd] = useState(today);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [syncMode, setSyncMode] = useState<"range" | "month" | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [theme, setTheme] = useState("white");
  const [olseraNavOpen, setOlseraNavOpen] = useState(false);
  const [activeNav, setActiveNav] = useState("Dasbor");
  const [sessionUser, setSessionUser] = useState<SessionUserInfo | null>(null);
  const [webhookData, setWebhookData] = useState<WebhookPayload | null>(null);
  const [webhookStatus, setWebhookStatus] = useState<"unknown" | "active" | "inactive">("unknown");
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [webhookRefresh, setWebhookRefresh] = useState(0);
  // Filter tampilan halaman Olsera. Dua mode laporan yang saling eksklusif:
  // "range" (rentang tanggal, default Kemarin — data hari ini sering belum
  // lengkap) dan "monthly" (satu bulan penuh, untuk laporan Omset Kategori).
  const olseraYesterday = addDaysISO(today, -1);
  const [olseraReportMode, setOlseraReportMode] = useState<"range" | "monthly">("range");
  const [olseraStart, setOlseraStart] = useState(olseraYesterday);
  const [olseraEnd, setOlseraEnd] = useState(olseraYesterday);
  const [olseraFilterMonth, setOlseraFilterMonth] = useState(currentMonth);
  const [olseraRangeStart, setOlseraRangeStart] = useState(olseraYesterday);
  const [olseraRangeEnd, setOlseraRangeEnd] = useState(olseraYesterday);
  const [olseraRows, setOlseraRows] = useState<{ kategori: string; qty?: number; totalPenjualan: number }[]>([]);
  const [olseraLoading, setOlseraLoading] = useState(false);
  const [olseraError, setOlseraError] = useState("");
  const [olseraSyncStatus, setOlseraSyncStatus] = useState<OlseraSyncStatus | null>(null);
  const [olseraSyncing, setOlseraSyncing] = useState(false);
  const [olseraSyncMessage, setOlseraSyncMessage] = useState("");
  const [olseraSyncRefresh, setOlseraSyncRefresh] = useState(0);
  // Guard klik ganda tombol Sync Olsera — state React async, ref langsung akurat.
  const olseraSyncRunRef = useRef(false);
  const [olseraExporting, setOlseraExporting] = useState(false);
  const [olseraExportMessage, setOlseraExportMessage] = useState("");
  const [olseraItemExporting, setOlseraItemExporting] = useState(false);
  const [olseraItemExportMessage, setOlseraItemExportMessage] = useState("");
  const [olseraCategoryExporting, setOlseraCategoryExporting] = useState(false);
  const [olseraCategoryExportMessage, setOlseraCategoryExportMessage] = useState("");
  const [olseraOmsetKategoriExporting, setOlseraOmsetKategoriExporting] = useState(false);
  const [olseraOmsetKategoriExportMessage, setOlseraOmsetKategoriExportMessage] = useState("");
  const [olseraLabersExporting, setOlseraLabersExporting] = useState(false);
  const [olseraLabersExportMessage, setOlseraLabersExportMessage] = useState("");
  const [olseraExportMenuOpen, setOlseraExportMenuOpen] = useState(false);
  const olseraExportMenuRef = useRef<HTMLDivElement | null>(null);

  // Dropdown Export: tutup saat klik di luar atau tekan Escape.
  useEffect(() => {
    if (!olseraExportMenuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (olseraExportMenuRef.current && !olseraExportMenuRef.current.contains(event.target as Node)) {
        setOlseraExportMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOlseraExportMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [olseraExportMenuOpen]);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportDate, setExportDate] = useState(today);
  const [exportStart, setExportStart] = useState(today);
  const [exportEnd, setExportEnd] = useState(today);
  const [exportMonth, setExportMonth] = useState(currentMonth);
  const [sort, setSort] = useState<SortState>({ key: "date", dir: "asc" });
  const emptyColumnFilters = { date: today, id: "", customer: "", service: "", status: "", change: "" };
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>(emptyColumnFilters);

  function handleSort(key: SortKey) {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
    setPage(1);
  }

  function setColumnFilter(key: string, value: string) {
    setColumnFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }

  // Muat info sesi (role + modul yang diizinkan) untuk mengatur nav & tombol sync.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/auth/me?_t=${Date.now()}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          await redirectToLogin();
          return null;
        }
        return (await response.json().catch(() => null)) as { user?: SessionUserInfo } | null;
      })
      .then((payload) => {
        if (cancelled || !payload?.user) return;
        setSessionUser(payload.user);
        // User biasa yang tidak punya akses "Dasbor" diarahkan ke modul pertama miliknya.
        if (payload.user.role !== "supervisor") {
          const allowedLabels = navItems
            .filter((item) => payload.user!.allowedModules.includes(item.module))
            .map((item) => item.label);
          if (!allowedLabels.includes("Dasbor")) {
            setActiveNav(allowedLabels[0] ?? "");
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved) setTheme(saved);
    // Sidebar terbuka secara default di desktop, tertutup di mobile.
    setDrawerOpen(window.matchMedia("(min-width: 1024px)").matches);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  function buildFilterParams(range = { startDate, endDate }) {
    const params = new URLSearchParams();
    if (searchTerm.trim()) params.set("q", searchTerm.trim());
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (courtFilter !== "all") params.set("branch", courtFilter);
    if (range.startDate) params.set("start_date", range.startDate);
    if (range.endDate) params.set("end_date", range.endDate);

    return params;
  }

  async function loadData(range = { startDate, endDate }) {
    if (isInvalidDateRange(range.startDate, range.endDate)) return;

    const params = buildFilterParams(range);
    // Cache buster: pastikan browser/CDN tidak mengembalikan data lama.
    params.set("_t", String(Date.now()));
    const dashboardPath = `/api/dashboard?${params.toString()}`;

    // Transaksi diambil per-halaman (server-side pagination + filter).
    const txnParams = new URLSearchParams();
    if (range.startDate) txnParams.set("start_date", range.startDate);
    if (range.endDate) txnParams.set("end_date", range.endDate);
    txnParams.set("page", String(page));
    txnParams.set("limit", String(limit));
    txnParams.set("sort", sort.key);
    txnParams.set("dir", sort.dir);
    if (columnFilters.id.trim()) txnParams.set("bookingId", columnFilters.id.trim());
    if (columnFilters.customer.trim()) txnParams.set("search", columnFilters.customer.trim());
    if (columnFilters.service) txnParams.set("court", columnFilters.service);
    if (columnFilters.status) txnParams.set("status", columnFilters.status);
    if (columnFilters.change) txnParams.set("change", columnFilters.change);
    txnParams.set("_t", String(Date.now()));
    const transactionPath = `/api/transactions?${txnParams.toString()}`;

    const [dashboardResponse, transactionsResponse] = await Promise.all([
      fetch(dashboardPath, { cache: "no-store" }),
      fetch(transactionPath, { cache: "no-store" }),
    ]);

    if (dashboardResponse.status === 401 || transactionsResponse.status === 401) {
      await redirectToLogin();
      return;
    }

    if (dashboardResponse.ok) setDashboard(await dashboardResponse.json());
    if (transactionsResponse.ok) {
      const payload = (await transactionsResponse.json()) as {
        data: TransactionRow[];
        page: number;
        total: number;
        totalPages: number;
      };
      setTransactionRows(payload.data);
      setTxnMeta({ total: payload.total, totalPages: payload.totalPages });
      // Server mengoreksi halaman bila melebihi total; sinkronkan agar UI konsisten.
      if (payload.page !== page) setPage(payload.page);
    }
  }

  async function syncRange(range: { startDate: string; endDate: string }) {
    if (isInvalidDateRange(range.startDate, range.endDate)) return;

    setSyncing(true);
    setSyncMessage("");
    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: range.startDate, end_date: range.endDate }),
      });
      if (response.status === 401) {
        await redirectToLogin();
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as {
        total_received?: number;
        inserted?: number;
        duplicate?: number;
        warning_days?: number;
        error?: string;
      };
      if (!response.ok) {
        setSyncMessage(payload.error || "Sinkronisasi gagal.");
        return;
      }

      setStartDate(range.startDate);
      setEndDate(range.endDate);
      setSyncMessage(
        [
          "Sinkronisasi selesai",
          `total diterima ${payload.total_received ?? 0}`,
          `ditambahkan ${payload.inserted ?? 0}`,
          `duplikat ${payload.duplicate ?? 0}`,
          `hari peringatan ${payload.warning_days ?? 0}`,
        ].join("; "),
      );
      await loadData(range);
    } finally {
      setSyncing(false);
    }
  }

  async function handleExportHarian() {
    if (!exportDate) return;
    setExporting(true);
    setSyncMessage("");
    try {
      const response = await fetch(`/api/transactions/export/harian?date=${exportDate}`, { cache: "no-store" });
      if (response.status === 401) {
        await redirectToLogin();
        return;
      }
      if (!response.ok) {
        setSyncMessage("Ekspor harian gagal.");
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Omzet Harian ${exportDate}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setSyncMessage(`Ekspor harian ${exportDate} selesai.`);
      setExportMenuOpen(false);
    } finally {
      setExporting(false);
    }
  }

  async function downloadExcelExport(url: string, fallbackName: string) {
    setExporting(true);
    setSyncMessage("");
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.status === 401) {
        await redirectToLogin();
        return false;
      }
      if (!response.ok) return false;
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
      return true;
    } finally {
      setExporting(false);
    }
  }

  async function handleExportRange() {
    if (!exportStart || !exportEnd) return;
    if (exportStart > exportEnd) {
      setSyncMessage("Tanggal awal harus sebelum atau sama dengan tanggal akhir.");
      return;
    }
    const fallback =
      exportStart === exportEnd ? `Omzet ${exportStart}.xlsx` : `Omzet ${exportStart} sd ${exportEnd}.xlsx`;
    const ok = await downloadExcelExport(
      `/api/transactions/export/range?start=${exportStart}&end=${exportEnd}`,
      fallback,
    );
    setSyncMessage(ok ? `Ekspor range ${exportStart} sd ${exportEnd} selesai.` : "Ekspor range gagal.");
    if (ok) setExportMenuOpen(false);
  }

  async function handleExportBulanan() {
    if (!exportMonth) return;
    const ok = await downloadExcelExport(
      `/api/transactions/export/bulanan?month=${exportMonth}`,
      `Omzet Bulanan ${exportMonth}.xlsx`,
    );
    setSyncMessage(ok ? `Ekspor bulanan ${exportMonth} selesai.` : "Ekspor bulanan gagal.");
    if (ok) setExportMenuOpen(false);
  }

  // Ekspor mengikuti filter atas yang sedang aktif (Hari ini / Bulan ini / Bulan lalu / bulan manual).
  async function handleExportFilter() {
    if (isInvalidDateRange(startDate, endDate)) return;
    const fallback =
      startDate === endDate ? `Omzet ${startDate}.xlsx` : `Omzet ${startDate} sd ${endDate}.xlsx`;
    const ok = await downloadExcelExport(
      `/api/transactions/export/range?start=${startDate}&end=${endDate}`,
      fallback,
    );
    setSyncMessage(
      ok ? `Ekspor sesuai filter (${startDate} sd ${endDate}) selesai.` : "Ekspor sesuai filter gagal.",
    );
    if (ok) setExportMenuOpen(false);
  }

  function handleRangePreset(value: DatePreset) {
    const range = getDatePresetRange(value);
    setDatePreset(value);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    setPage(1);
  }

  function handleMonthFilter(value: string) {
    if (!value) return;
    setFilterMonth(value);
    setDatePreset("manualMonth");
    const range = monthRangeFromValue(value);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    setPage(1);
  }

  function handleCustomRangeChange(rangeStart: string, rangeEnd: string) {
    setCustomRangeStart(rangeStart);
    setCustomRangeEnd(rangeEnd);
    setDatePreset("custom");
    // Terapkan hanya kalau kedua tanggal terisi dan urutannya valid;
    // kalau belum, data terakhir tetap tampil sampai rentang valid.
    if (rangeStart && rangeEnd && rangeStart <= rangeEnd) {
      setStartDate(rangeStart);
      setEndDate(rangeEnd);
      setPage(1);
    }
  }

  function closeSyncMenu() {
    setSyncMenuOpen(false);
    setSyncMode(null);
  }

  async function handleSyncNow() {
    const range = getDatePresetRange("month");
    setDatePreset("month");
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    closeSyncMenu();
    await syncRange(range);
  }

  async function handleSyncRangeForm() {
    if (isInvalidDateRange(syncRangeStart, syncRangeEnd)) return;
    setDatePreset("custom");
    closeSyncMenu();
    await syncRange({ startDate: syncRangeStart, endDate: syncRangeEnd });
  }

  async function handleSyncMonth(value = syncMonth) {
    const range = monthRangeFromValue(value);
    setDatePreset(value === currentMonth ? "month" : value === previousMonthValue() ? "lastMonth" : "custom");
    closeSyncMenu();
    await syncRange(range);
  }

  async function handleSyncLastMonth() {
    const value = previousMonthValue();
    setSyncMonth(value);
    setDatePreset("lastMonth");
    await handleSyncMonth(value);
  }

  function handleResetFilters() {
    const range = getDatePresetRange("today");
    setSearchTerm("");
    setStatusFilter("all");
    setCourtFilter("all");
    setDatePreset("today");
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    setFilterMonth(currentMonth);
    setCustomRangeStart(range.startDate);
    setCustomRangeEnd(range.endDate);
    setColumnFilters(emptyColumnFilters);
    setPage(1);
  }

  useEffect(() => {
    // Debounce 350ms: mencegah request bertubi-tubi saat mengetik pencarian.
    const timeout = window.setTimeout(() => {
      loadData().catch(() => undefined);
    }, 350);

    return () => window.clearTimeout(timeout);
    // columnFilters & sort adalah objek — perubahannya (referensi baru) memicu fetch ulang.
  }, [searchTerm, statusFilter, courtFilter, startDate, endDate, page, limit, sort, columnFilters]);

  useEffect(() => {
    if (activeNav !== "Webhook") return;
    let cancelled = false;

    async function loadWebhook() {
      setWebhookLoading(true);
      try {
        const [healthResponse, logsResponse] = await Promise.all([
          fetch(`/api/webhooks/ayo?_t=${Date.now()}`, { cache: "no-store" }),
          fetch(`/api/webhooks/logs?_t=${Date.now()}`, { cache: "no-store" }),
        ]);

        if (logsResponse.status === 401) {
          await redirectToLogin();
          return;
        }

        if (cancelled) return;
        setWebhookStatus(healthResponse.ok ? "active" : "inactive");
        if (logsResponse.ok) setWebhookData(await logsResponse.json());
      } catch {
        if (!cancelled) setWebhookStatus("inactive");
      } finally {
        if (!cancelled) setWebhookLoading(false);
      }
    }

    loadWebhook().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeNav, webhookRefresh]);

  // Halaman Olsera: viewer live ke API Olsera (tanpa sync/tulis database).
  useEffect(() => {
    if (activeNav !== "Olsera") return;
    if (isInvalidDateRange(olseraStart, olseraEnd)) return;
    let cancelled = false;

    async function loadOlsera() {
      setOlseraLoading(true);
      setOlseraError("");
      try {
        const params = new URLSearchParams({ from: olseraStart, to: olseraEnd, _t: String(Date.now()) });
        const response = await fetch(`/api/olsera/sales-by-category?${params.toString()}`, { cache: "no-store" });

        if (response.status === 401) {
          await redirectToLogin();
          return;
        }

        const payload = (await response.json().catch(() => null)) as
          | { data?: { kategori: string; totalPenjualan: number }[]; error?: string }
          | null;

        if (cancelled) return;
        if (!response.ok || !payload || !Array.isArray(payload.data)) {
          setOlseraRows([]);
          setOlseraError(payload?.error || "Gagal memuat data penjualan Olsera.");
          return;
        }
        setOlseraRows(payload.data);
      } catch {
        if (!cancelled) {
          setOlseraRows([]);
          setOlseraError("Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.");
        }
      } finally {
        if (!cancelled) setOlseraLoading(false);
      }
    }

    loadOlsera().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeNav, olseraStart, olseraEnd, olseraSyncRefresh]);

  // Status sync Olsera (checkpoint + log terakhir) — terpisah total dari sync AYO.
  useEffect(() => {
    if (activeNav !== "Olsera") return;
    let cancelled = false;

    fetch(`/api/olsera/sync?_t=${Date.now()}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          await redirectToLogin();
          return null;
        }
        return (await response.json().catch(() => null)) as OlseraSyncStatus | null;
      })
      .then((payload) => {
        if (cancelled || !payload || !("lastFullySyncedDate" in payload)) return;
        setOlseraSyncStatus(payload);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [activeNav, olseraSyncRefresh]);

  // Sync Olsera bulan berjalan: audit tanggal 1 s/d hari ini SATU TANGGAL PER
  // REQUEST (aman di Vercel — tidak ada satu proses server panjang). Backend
  // membandingkan API Olsera vs MongoDB dan hanya menarik ulang tanggal yang
  // belum lengkap; upsert menjamin tidak ada duplikat walau di-klik berulang.
  async function handleOlseraSync() {
    if (olseraSyncRunRef.current) return;
    olseraSyncRunRef.current = true;
    setOlseraSyncing(true);
    setOlseraSyncMessage("");

    const runStartedAt = new Date().toISOString();
    const startedMs = Date.now();
    const monthStart = `${today.slice(0, 7)}-01`;
    const dates: string[] = [];
    for (let date = monthStart; date <= today; date = addDaysISO(date, 1)) dates.push(date);

    let matched = 0;
    let updated = 0;
    let expectedOrders = 0;
    let processedOrders = 0;
    let unresolvedNew = 0;
    const failedDates: string[] = [];

    try {
      for (let index = 0; index < dates.length; index++) {
        const date = dates[index];
        setOlseraSyncMessage(
          `Memeriksa ${formatDisplayDate(date)}... (${index} dari ${dates.length} tanggal selesai diperiksa)`,
        );
        try {
          const response = await fetch("/api/olsera/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date }),
          });
          if (response.status === 401) {
            await redirectToLogin();
            return;
          }
          const payload = (await response.json().catch(() => null)) as
            | {
                action?: "match" | "resynced" | "failed";
                expectedOrderCount?: number;
                processedOrderCount?: number;
                errorMessage?: string | null;
                error?: string;
                resolutionStats?: { unresolved?: number };
              }
            | null;
          if (!response.ok || !payload || payload.error || payload.action === "failed" || !payload.action) {
            failedDates.push(date);
          } else {
            expectedOrders += payload.expectedOrderCount ?? 0;
            unresolvedNew += payload.resolutionStats?.unresolved ?? 0;
            if (payload.action === "resynced") {
              updated++;
              processedOrders += payload.processedOrderCount ?? 0;
            } else {
              matched++;
            }
          }
        } catch {
          // Request putus — tanggal ini dianggap gagal; klik Sync berikutnya
          // akan memeriksanya lagi (tanggal yang sudah cocok hanya diaudit ringan).
          failedDates.push(date);
        }
      }

      // Tulis log ringkasan run (status terakhir + badge mengikuti log ini).
      await fetch("/api/olsera/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          finalize: {
            start_date: monthStart,
            end_date: today,
            checked: dates.length,
            matched,
            updated,
            expected_orders: expectedOrders,
            processed_orders: processedOrders,
            failed_dates: failedDates,
            started_at: runStartedAt,
          },
        }),
      }).catch(() => undefined);

      const durationSec = Math.max(1, Math.round((Date.now() - startedMs) / 1000));
      // Sync tidak dilaporkan mulus bila ada item baru tanpa mapping kategori.
      const unresolvedNote = unresolvedNew > 0 ? ` Peringatan: ${unresolvedNew} item belum memiliki mapping kategori.` : "";
      setOlseraSyncMessage(
        failedDates.length
          ? `Sync sebagian selesai: ${matched + updated} tanggal cocok, ${failedDates.length} tanggal gagal (${failedDates
              .map(formatDisplayDate)
              .join(", ")}). Durasi ${durationSec} detik.${unresolvedNote}`
          : `Sync selesai: ${dates.length} tanggal diperiksa, ${updated} tanggal diperbarui, ${processedOrders} transaksi diproses. Durasi ${durationSec} detik.${unresolvedNote}`,
      );
    } finally {
      olseraSyncRunRef.current = false;
      setOlseraSyncing(false);
      // Refresh tabel kategori, status sync, dan warning tanpa reload browser.
      setOlseraSyncRefresh((value) => value + 1);
    }
  }

  function handleOlseraYesterday() {
    setOlseraReportMode("range");
    setOlseraRangeStart(olseraYesterday);
    setOlseraRangeEnd(olseraYesterday);
    setOlseraStart(olseraYesterday);
    setOlseraEnd(olseraYesterday);
  }

  // Ganti mode laporan: tabel langsung mengikuti filter milik mode tersebut,
  // sehingga filter bulan dan rentang tanggal tidak pernah aktif bersamaan.
  function handleOlseraReportModeChange(mode: "range" | "monthly") {
    if (mode === olseraReportMode) return;
    setOlseraReportMode(mode);
    if (mode === "monthly") {
      const range = monthRangeFromValue(olseraFilterMonth || currentMonth);
      setOlseraStart(range.startDate);
      setOlseraEnd(range.endDate);
    } else if (olseraRangeStart && olseraRangeEnd && olseraRangeStart <= olseraRangeEnd) {
      setOlseraStart(olseraRangeStart);
      setOlseraEnd(olseraRangeEnd);
    } else {
      setOlseraRangeStart(olseraYesterday);
      setOlseraRangeEnd(olseraYesterday);
      setOlseraStart(olseraYesterday);
      setOlseraEnd(olseraYesterday);
    }
  }

  function handleOlseraMonthFilter(value: string) {
    if (!value) return;
    const range = monthRangeFromValue(value);
    setOlseraFilterMonth(value);
    setOlseraReportMode("monthly");
    setOlseraStart(range.startDate);
    setOlseraEnd(range.endDate);
  }

  function handleOlseraRangeChange(startDate: string, endDate: string) {
    setOlseraRangeStart(startDate);
    setOlseraRangeEnd(endDate);
    setOlseraReportMode("range");
    // Terapkan hanya kalau kedua tanggal terisi dan urutannya valid;
    // kalau belum, data terakhir tetap tampil sampai rentang valid.
    if (startDate && endDate && startDate <= endDate) {
      setOlseraStart(startDate);
      setOlseraEnd(endDate);
    }
  }

  function handleOlseraResetFilters() {
    if (olseraReportMode === "monthly") {
      const range = monthRangeFromValue(currentMonth);
      setOlseraFilterMonth(currentMonth);
      setOlseraStart(range.startDate);
      setOlseraEnd(range.endDate);
      return;
    }
    setOlseraRangeStart(olseraYesterday);
    setOlseraRangeEnd(olseraYesterday);
    setOlseraStart(olseraYesterday);
    setOlseraEnd(olseraYesterday);
  }

  async function handleOlseraExport() {
    if (isInvalidDateRange(olseraStart, olseraEnd)) return;
    setOlseraExporting(true);
    setOlseraExportMessage("");
    try {
      const params = new URLSearchParams({ start_date: olseraStart, end_date: olseraEnd });
      const response = await fetch(`/api/olsera/export?${params.toString()}`, { cache: "no-store" });
      if (response.status === 401) {
        await redirectToLogin();
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setOlseraExportMessage(payload?.error || "Ekspor Excel Olsera gagal.");
        return;
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      const match = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/);
      link.download =
        match?.[1] ||
        (olseraStart === olseraEnd ? `Omset Olsera ${olseraStart}.xlsx` : `Omset Olsera ${olseraStart} sd ${olseraEnd}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
      setOlseraExportMessage("Ekspor Excel selesai.");
    } catch {
      setOlseraExportMessage("Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.");
    } finally {
      setOlseraExporting(false);
    }
  }

  async function handleOlseraItemExport() {
    if (isInvalidDateRange(olseraStart, olseraEnd)) return;
    setOlseraItemExporting(true);
    setOlseraItemExportMessage("");
    try {
      const params = new URLSearchParams({ start_date: olseraStart, end_date: olseraEnd });
      const response = await fetch(`/api/olsera/export-items?${params.toString()}`, { cache: "no-store" });
      if (response.status === 401) {
        await redirectToLogin();
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setOlseraItemExportMessage(payload?.error || "Ekspor Rincian Penjualan Olsera gagal.");
        return;
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      const match = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/);
      link.download =
        match?.[1] ||
        (olseraStart === olseraEnd
          ? `Rincian Penjualan-${olseraStart}__${olseraEnd}.xlsx`
          : `Rincian Penjualan-${olseraStart}__${olseraEnd}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
      setOlseraItemExportMessage("Ekspor Rincian Penjualan selesai.");
    } catch {
      setOlseraItemExportMessage("Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.");
    } finally {
      setOlseraItemExporting(false);
    }
  }

  async function handleOlseraCategoryExport() {
    if (isInvalidDateRange(olseraStart, olseraEnd)) return;
    setOlseraCategoryExporting(true);
    setOlseraCategoryExportMessage("");
    try {
      const params = new URLSearchParams({ start_date: olseraStart, end_date: olseraEnd });
      const response = await fetch(`/api/olsera/export-categories?${params.toString()}`, { cache: "no-store" });
      if (response.status === 401) {
        await redirectToLogin();
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setOlseraCategoryExportMessage(payload?.error || "Ekspor Kategori Penjualan Olsera gagal.");
        return;
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      const match = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/);
      link.download = match?.[1] || `Kategori Penjualan-${olseraStart}__${olseraEnd}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
      setOlseraCategoryExportMessage("Ekspor Kategori Penjualan selesai.");
    } catch {
      setOlseraCategoryExportMessage("Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.");
    } finally {
      setOlseraCategoryExporting(false);
    }
  }

  // Laporan bulanan "Total Keseluruhan Omset". Mode bulanan memakai filter
  // bulan; mode rentang tanggal memakai bulan dari tanggal awal (startDate) —
  // filter bulan disinkronkan internal tanpa mengubah rentang yang aktif.
  async function handleOlseraOmsetKategoriExport() {
    const month = olseraReportMode === "monthly" ? olseraFilterMonth : olseraStart.slice(0, 7);
    if (!month || olseraOmsetKategoriExporting) return;
    if (month !== olseraFilterMonth) setOlseraFilterMonth(month);
    setOlseraOmsetKategoriExporting(true);
    setOlseraOmsetKategoriExportMessage("");
    try {
      const params = new URLSearchParams({ month });
      const response = await fetch(`/api/olsera/export-category-revenue?${params.toString()}`, { cache: "no-store" });
      if (response.status === 401) {
        await redirectToLogin();
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setOlseraOmsetKategoriExportMessage(payload?.error || "Ekspor Omset Kategori gagal.");
        return;
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      const match = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/);
      link.download = match?.[1] || `Omset Kategori-${month}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
      setOlseraOmsetKategoriExportMessage(`Ekspor Omset Kategori ${formatMonthLabel(month)} selesai.`);
    } catch {
      setOlseraOmsetKategoriExportMessage("Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.");
    } finally {
      setOlseraOmsetKategoriExporting(false);
    }
  }

  // Export "Pembagian Hasil LABERS" — hanya untuk mode Bulanan, memakai bulan
  // filter yang sedang aktif (tidak menambah input tanggal/bulan baru).
  async function handleOlseraLabersExport() {
    if (olseraReportMode !== "monthly" || !olseraFilterMonth || olseraLabersExporting) return;
    setOlseraLabersExporting(true);
    setOlseraLabersExportMessage("");
    try {
      const params = new URLSearchParams({ month: olseraFilterMonth });
      const response = await fetch(`/api/olsera/export-labers-sharing?${params.toString()}`, { cache: "no-store" });
      if (response.status === 401) {
        await redirectToLogin();
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setOlseraLabersExportMessage(payload?.error || "Ekspor Pembagian Hasil LABERS gagal.");
        return;
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      const match = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/);
      link.download = match?.[1] || `Pembagian Hasil LABERS-${olseraFilterMonth}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
      setOlseraLabersExportMessage(`Ekspor Pembagian Hasil LABERS ${formatMonthLabel(olseraFilterMonth)} selesai.`);
    } catch {
      setOlseraLabersExportMessage("Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.");
    } finally {
      setOlseraLabersExporting(false);
    }
  }

  function getOlseraFilterDetail() {
    if (olseraReportMode === "monthly")
      return `${formatMonthLabel(olseraFilterMonth)} (${formatDisplayDate(olseraStart)} - ${formatDisplayDate(olseraEnd)})`;
    if (olseraStart === olseraEnd && olseraStart === olseraYesterday) return `Kemarin (${formatDisplayDate(olseraStart)})`;
    if (olseraStart === olseraEnd) return `Tanggal ${formatDisplayDate(olseraStart)}`;
    return `${formatDisplayDate(olseraStart)} - ${formatDisplayDate(olseraEnd)}`;
  }

  const olseraAnyExporting =
    olseraItemExporting || olseraCategoryExporting || olseraOmsetKategoriExporting || olseraLabersExporting;
  const olseraExportMessages = [
    olseraItemExportMessage,
    olseraCategoryExportMessage,
    olseraOmsetKategoriExportMessage,
    olseraLabersExportMessage,
  ].filter(Boolean);

  const isSupervisor = sessionUser?.role === "supervisor";
  // Aksi sync tidak lagi khusus supervisor — cukup punya modul terkait.
  // (allowedModules dari /api/auth/me sudah dinormalisasi; supervisor otomatis punya semua modul.)
  const canSyncAyo = ["dasbor", "transaksi"].some((module) => sessionUser?.allowedModules.includes(module));
  const canSyncOlsera = Boolean(sessionUser?.allowedModules.includes("olsera"));
  const visibleNavItems = sessionUser
    ? isSupervisor
      ? navItems
      : navItems.filter((item) => sessionUser.allowedModules.includes(item.module))
    : [];
  const activeNavAllowed =
    activeNav === "Pengguna"
      ? isSupervisor
      : Boolean(sessionUser) &&
        visibleNavItems.some(
          (item) =>
            item.label === activeNav ||
            ("subItems" in item && item.subItems?.some((sub) => sub.nav === activeNav)),
        );

  const metrics = dashboard?.metrics;
  const dateRangeInvalid = isInvalidDateRange(startDate, endDate);
  // Pagination & filtering kini dilakukan di server; transactionRows hanya berisi halaman aktif.
  const pagedRows = transactionRows;
  const pageCount = Math.max(1, txnMeta.totalPages);
  const currentPage = Math.min(page, pageCount);
  const serviceOptions = Array.from(
    new Map(
      [
        ...(dashboard?.branchOptions ?? []),
        { label: "pickleball 1", value: "Pickleball Court No 1" },
        { label: "pickleball 2", value: "Pickleball Court No 2" },
      ].map((option) => [option.value, option] as const),
    ).values(),
  );
  const serviceRows = dashboard?.topServices ?? [];
  const paymentRows = dashboard?.paymentBreakdown ?? [];
  const eventRows = dashboard?.syncEvents ?? [];
  const courtOptions = dashboard?.branchOptions ?? [];
  const latestEvent = eventRows[0];
  const syncStatusLabel = latestEvent ? (latestEvent.tone.includes("teal") ? "OK" : "Gagal") : "-";
  const lastCheckpoint = latestEvent ? formatEventTime(latestEvent.time) : "-";

  // Panel filter tanggal dark (halaman Transaksi) — handler & preset sama
  // persis dengan versi lama, hanya gaya visual yang berubah.
  const presetFilterRow = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="rd-capsule-group inline-flex flex-wrap items-center gap-1 rounded-full p-1">
        {datePresetButtons.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => handleRangePreset(preset.value)}
            className={`rd-capsule inline-flex items-center gap-1.5 ${
              datePreset === preset.value ? "rd-capsule-active" : ""
            }`}
          >
            <CalendarRange className="h-4 w-4" />
            {preset.label}
          </button>
        ))}
      </div>
      <div
        className={`rd-field flex h-10 items-center gap-2 rounded-full px-3 ${
          datePreset === "manualMonth" ? "rd-field-active" : ""
        }`}
      >
        <CalendarDays className="h-4 w-4 text-slate-400" />
        <Input
          type="month"
          aria-label="Filter bulan tertentu"
          value={filterMonth}
          className="h-8 w-[150px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
          onClick={(event) => event.currentTarget.showPicker?.()}
          onChange={(event) => handleMonthFilter(event.target.value)}
        />
      </div>
      <div
        className={`rd-field flex h-10 items-center gap-2 rounded-full px-3 ${
          datePreset === "custom" ? "rd-field-active" : ""
        }`}
      >
        <CalendarRange className="h-4 w-4 text-slate-400" />
        <Input
          type="date"
          aria-label="Tanggal mulai filter custom"
          value={customRangeStart}
          className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
          onClick={(event) => event.currentTarget.showPicker?.()}
          onChange={(event) => handleCustomRangeChange(event.target.value, customRangeEnd)}
        />
        <span className="text-xs text-slate-500">s/d</span>
        <Input
          type="date"
          aria-label="Tanggal selesai filter custom"
          value={customRangeEnd}
          className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
          onClick={(event) => event.currentTarget.showPicker?.()}
          onChange={(event) => handleCustomRangeChange(customRangeStart, event.target.value)}
        />
      </div>
      <button type="button" onClick={handleResetFilters} className="rd-capsule inline-flex items-center gap-1.5">
        <RotateCcw className="h-4 w-4" />
        Reset
      </button>
      {datePreset === "custom" && isInvalidDateRange(customRangeStart, customRangeEnd) && (
        <span className="text-sm text-rose-400">Tanggal selesai tidak boleh sebelum tanggal mulai.</span>
      )}
    </div>
  );

  // Judul & deskripsi header — mapping sama persis dengan versi lama.
  const headerTitle =
    activeNav === "Transaksi"
      ? "Transaksi AYO"
      : activeNav === "Olsera"
        ? "Kategori Penjualan Olsera"
        : activeNav === "OlseraInventori"
          ? "Inventori Olsera"
          : activeNav === "Webhook"
            ? "Monitoring Webhook AYO"
            : activeNav === "Pengguna"
              ? "Manajemen Pengguna"
              : "Dasbor Transaksi Real-Time";
  const headerDescription =
    activeNav === "OlseraInventori"
      ? "Monitoring stok, mutasi, harga modal, dan nilai persediaan Olsera."
      : activeNav === "Dasbor"
        ? "Monitoring transaksi, pendapatan, sinkronisasi, dan integrasi AYO."
        : undefined;

  const sidebarItems = [
    ...visibleNavItems,
    ...(isSupervisor ? [{ label: "Pengguna", display: "Pengguna", icon: Users, module: "" }] : []),
  ];

  // Dropdown Sync AYO lama — handler & endpoint tidak berubah, hanya dipindah
  // ke variabel agar bisa disuntikkan sebagai slot `actions` di header baru.
  const ayoSyncControl =
    canSyncAyo && activeNav !== "Olsera" && activeNav !== "OlseraInventori" && activeNav !== "Pengguna" ? (
            <div className="relative">
              <Button
                className={OLSERA_PRIMARY_BTN}
                onClick={() => {
                  setSyncMode(null);
                  setSyncMenuOpen((open) => !open);
                }}
                disabled={syncing}
                aria-expanded={syncMenuOpen}
              >
                {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {syncing ? "Menyinkronkan AYO..." : "Sync AYO"}
                <ChevronDown className={`h-4 w-4 transition-transform ${syncMenuOpen ? "rotate-180" : ""}`} />
              </Button>
              {syncMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={closeSyncMenu} />
                  <div className="absolute right-0 z-50 mt-2 w-80 rounded-md border bg-white p-4 shadow-lg">
                    {syncMode === null && (
                      <div className="space-y-2">
                        <Button className="w-full justify-start" onClick={handleSyncNow} disabled={syncing}>
                          <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
                          Sync Now
                        </Button>
                        <Button className="w-full justify-start" variant="outline" onClick={() => setSyncMode("range")}>
                          <CalendarRange className="h-4 w-4" />
                          Sinkron Rentang Tanggal
                        </Button>
                        <Button className="w-full justify-start" variant="outline" onClick={() => setSyncMode("month")}>
                          <CalendarDays className="h-4 w-4" />
                          Sinkron Bulanan
                        </Button>
                      </div>
                    )}

                    {syncMode === "range" && (
                      <div className="space-y-3">
                        <button
                          type="button"
                          className="text-xs font-medium text-slate-500 hover:text-slate-900"
                          onClick={() => setSyncMode(null)}
                        >
                          ← Kembali
                        </button>
                        <p className="text-xs font-medium text-slate-500">Pilih rentang tanggal</p>
                        <Input
                          aria-label="Tanggal mulai sinkron"
                          type="date"
                          className="cursor-pointer"
                          value={syncRangeStart}
                          onClick={(event) => event.currentTarget.showPicker?.()}
                          onChange={(event) => setSyncRangeStart(event.target.value)}
                        />
                        <Input
                          aria-label="Tanggal akhir sinkron"
                          type="date"
                          className="cursor-pointer"
                          value={syncRangeEnd}
                          onClick={(event) => event.currentTarget.showPicker?.()}
                          onChange={(event) => setSyncRangeEnd(event.target.value)}
                        />
                        <Button
                          className="w-full"
                          onClick={handleSyncRangeForm}
                          disabled={syncing || isInvalidDateRange(syncRangeStart, syncRangeEnd)}
                        >
                          <RefreshCw className="h-4 w-4" />
                          Sinkronkan
                        </Button>
                      </div>
                    )}

                    {syncMode === "month" && (
                      <div className="space-y-3">
                        <button
                          type="button"
                          className="text-xs font-medium text-slate-500 hover:text-slate-900"
                          onClick={() => setSyncMode(null)}
                        >
                          ← Kembali
                        </button>
                        <p className="text-xs font-medium text-slate-500">Pilih bulan</p>
                        <Input
                          aria-label="Bulan sinkron"
                          type="month"
                          className="cursor-pointer"
                          value={syncMonth}
                          onClick={(event) => event.currentTarget.showPicker?.()}
                          onChange={(event) => setSyncMonth(event.target.value)}
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <Button onClick={() => handleSyncMonth()} disabled={syncing || !syncMonth}>
                            <CalendarRange className="h-4 w-4" />
                            Sinkronkan
                          </Button>
                          <Button variant="outline" onClick={handleSyncLastMonth} disabled={syncing}>
                            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
                            Bulan Lalu
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
    ) : null;

  return (
    <AyoseraShell
      sidebarOpen={drawerOpen}
      onOverlayClick={() => setDrawerOpen(false)}
      sidebar={
        <AyoseraSidebar
          open={drawerOpen}
          items={sidebarItems}
          activeNav={activeNav}
          onSelect={(nav) => {
            setActiveNav(nav);
            if (!window.matchMedia("(min-width: 1024px)").matches) setDrawerOpen(false);
          }}
          groupOpen={olseraNavOpen}
          onToggleGroup={() => setOlseraNavOpen((value) => !value)}
          statusLabel={syncStatusLabel}
          lastCheckpoint={lastCheckpoint}
        />
      }
      header={
        <AyoseraHeader
          title={headerTitle}
          description={headerDescription}
          onToggleSidebar={() => setDrawerOpen((open) => !open)}
          sidebarOpen={drawerOpen}
          ayoStatus={syncStatusLabel}
          olseraStatus={olseraSyncStatus?.lastSync?.status ?? null}
          lastCheckpoint={lastCheckpoint}
          actions={ayoSyncControl}
          onLogout={() => void redirectToLogin()}
        />
      }
    >
        <div className="px-4 py-5 sm:px-6">
          {syncMessage && <p className="mb-4 text-sm text-slate-300">{syncMessage}</p>}

          {!sessionUser && (
            <p className="py-10 text-center text-sm text-slate-400">Memuat sesi…</p>
          )}

          {sessionUser && !activeNavAllowed && (
            <Card>
              <CardContent className="p-8 text-center">
                <p className="text-sm font-medium text-slate-700">Akses ditolak</p>
                <p className="mt-1 text-sm text-slate-500">
                  Anda tidak memiliki izin untuk modul ini. Hubungi supervisor untuk meminta akses.
                </p>
              </CardContent>
            </Card>
          )}

          {activeNavAllowed && activeNav === "Pengguna" && isSupervisor && (
            <div className="rd-legacy p-4 sm:p-5">
              <UsersPanel currentUserId={sessionUser!.id} />
            </div>
          )}

          {activeNavAllowed && activeNav === "Dasbor" && (
            <DashboardOverview
              presets={datePresetButtons}
              activePreset={datePreset}
              onPreset={(value) => handleRangePreset(value as DatePreset)}
              filterMonth={filterMonth}
              onMonthFilter={handleMonthFilter}
              customRangeStart={customRangeStart}
              customRangeEnd={customRangeEnd}
              onCustomRangeChange={handleCustomRangeChange}
              onResetFilters={handleResetFilters}
              customRangeInvalid={isInvalidDateRange(customRangeStart, customRangeEnd)}
              stats={[
                {
                  title: "Total Transaksi",
                  value: String(metrics?.totalTransactions ?? 0),
                  detail: getRevenueFilterDetail(datePreset, startDate, endDate),
                  icon: Activity,
                },
                {
                  title: "Pendapatan Hari Ini",
                  value: metrics?.revenueToday ?? "Rp 0",
                  detail: `Hari ini (${formatDisplayDate(today)})`,
                  icon: BadgeCheck,
                },
                {
                  title: "Pendapatan (Filter)",
                  value: metrics?.revenueMonth ?? "Rp 0",
                  detail: getRevenueFilterDetail(datePreset, startDate, endDate),
                  icon: CalendarDays,
                },
              ]}
              paymentRows={paymentRows}
              serviceRows={serviceRows}
              syncStatusLabel={syncStatusLabel}
              latestEventText={
                latestEvent ? `${latestEvent.label} · ${formatEventTime(latestEvent.time)}` : "Belum ada sinkronisasi"
              }
              events={eventRows.map((event) => ({
                label: event.label,
                detail: event.detail,
                timeText: formatEventTime(event.time),
                ok: event.tone.includes("teal"),
              }))}
            />
          )}

          {activeNavAllowed && activeNav === "Transaksi" && (
          <div>
          <div className="rd-enter mb-4">{presetFilterRow}</div>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <DashboardStatCard
              title="Total Transaksi"
              value={String(metrics?.totalTransactions ?? 0)}
              detail={getRevenueFilterDetail(datePreset, startDate, endDate)}
              icon={Activity}
              beam
            />
            <DashboardStatCard
              title="Pendapatan Hari Ini"
              value={metrics?.revenueToday ?? "Rp 0"}
              detail={`Hari ini (${formatDisplayDate(today)})`}
              icon={BadgeCheck}
              delay={90}
            />
            <DashboardStatCard
              title="Pendapatan (Filter)"
              value={metrics?.revenueMonth ?? "Rp 0"}
              detail={getRevenueFilterDetail(datePreset, startDate, endDate)}
              icon={CalendarDays}
              delay={180}
            />
            <div className="rd-card rd-enter relative rounded-2xl" style={{ animationDelay: "270ms" }}>
              <div className="relative flex h-full items-center justify-between gap-4 p-5">
                <div className="min-w-0">
                  <p className="text-sm text-slate-400">Ekspor</p>
                  <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-50">Excel</p>
                  <p className="mt-1 text-xs text-slate-500">Ikut filter aktif</p>
                </div>
                <div className="shrink-0">
                  <TransactionExportMenu
                    open={exportMenuOpen}
                    onOpenChange={setExportMenuOpen}
                    exporting={exporting}
                    dateRangeInvalid={dateRangeInvalid}
                    filterDetail={getRevenueFilterDetail(datePreset, startDate, endDate)}
                    exportDate={exportDate}
                    onExportDateChange={setExportDate}
                    exportStart={exportStart}
                    onExportStartChange={setExportStart}
                    exportEnd={exportEnd}
                    onExportEndChange={setExportEnd}
                    exportMonth={exportMonth}
                    onExportMonthChange={setExportMonth}
                    onExportFilter={handleExportFilter}
                    onExportHarian={handleExportHarian}
                    onExportRange={handleExportRange}
                    onExportBulanan={handleExportBulanan}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="mt-8">
            <div className="rd-card rd-enter relative rounded-2xl p-5" style={{ animationDelay: "340ms" }}>
                <div className="overflow-x-auto">
                  <table className="rd-table w-full min-w-[1000px] text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                        <SortableHeader label="Tanggal" sortKey="date" sort={sort} onSort={handleSort} />
                        <th className="h-10 px-2 font-medium">Jam</th>
                        <SortableHeader label="ID Booking" sortKey="id" sort={sort} onSort={handleSort} />
                        <SortableHeader label="Pelanggan" sortKey="customer" sort={sort} onSort={handleSort} />
                        <th className="h-10 px-2 font-medium">Telepon</th>
                        <SortableHeader label="Lapangan" sortKey="service" sort={sort} onSort={handleSort} />
                        <SortableHeader label="Nominal" sortKey="amount" sort={sort} onSort={handleSort} align="right" />
                        <SortableHeader label="Status" sortKey="status" sort={sort} onSort={handleSort} />
                        <th className="h-10 px-2 font-medium">Perubahan</th>
                      </tr>
                      <tr className="border-b border-white/10">
                        <th className="px-2 pb-2" />
                        <th className="px-2 pb-2" />
                        <th className="px-2 pb-2">
                          <input
                            value={columnFilters.id}
                            onChange={(event) => setColumnFilter("id", event.target.value)}
                            placeholder="Cari ID Booking"
                            className="rd-input h-7 w-full px-2 text-xs font-normal normal-case"
                          />
                        </th>
                        <th className="px-2 pb-2">
                          <input
                            value={columnFilters.customer}
                            onChange={(event) => setColumnFilter("customer", event.target.value)}
                            placeholder="Nama, telepon, atau ID"
                            className="rd-input h-7 w-full px-2 text-xs font-normal normal-case"
                          />
                        </th>
                        <th className="px-2 pb-2" />
                        <th className="px-2 pb-2">
                          <select
                            value={columnFilters.service}
                            onChange={(event) => setColumnFilter("service", event.target.value)}
                            className="rd-input h-7 w-full px-1 text-xs font-normal normal-case"
                          >
                            <option value="">Semua</option>
                            {serviceOptions.map((service) => (
                              <option key={service.value} value={service.value}>
                                {service.label}
                              </option>
                            ))}
                          </select>
                        </th>
                        <th className="px-2 pb-2" />
                        <th className="px-2 pb-2">
                          <select
                            value={columnFilters.status}
                            onChange={(event) => setColumnFilter("status", event.target.value)}
                            className="rd-input h-7 w-full px-1 text-xs font-normal normal-case"
                          >
                            <option value="">Semua</option>
                            <option value="Completed">Selesai</option>
                            <option value="Pending">Belum Bayar</option>
                            <option value="Cancelled">Dibatalkan</option>
                          </select>
                        </th>
                        <th className="px-2 pb-2">
                          <select
                            value={columnFilters.change}
                            onChange={(event) => setColumnFilter("change", event.target.value)}
                            className="rd-input h-7 w-full px-1 text-xs font-normal normal-case"
                          >
                            <option value="">Semua</option>
                            <option value="rescheduled">Reschedule</option>
                          </select>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedRows.length ? (
                        pagedRows.map((transaction) => (
                          <tr key={transaction.id} className="h-[58px]">
                            <td className="whitespace-nowrap px-2 py-2">{transaction.date}</td>
                            <td className="whitespace-nowrap px-2 py-2">
                              {transaction.time} - {transaction.endTime || "-"}
                            </td>
                            <td className="px-2 py-2">
                              <p className="whitespace-nowrap font-medium">{transaction.id}</p>
                              {transaction.note && transaction.note !== "-" && (
                                <p className="max-w-[240px] truncate text-xs text-slate-500">{transaction.note}</p>
                              )}
                            </td>
                            <td className="max-w-[150px] truncate px-2 py-2">{transaction.customer}</td>
                            <td className="max-w-[130px] truncate px-2 py-2">{transaction.phone}</td>
                            <td className="max-w-[180px] truncate px-2 py-2">{transaction.service}</td>
                            <td className="px-2 py-2 text-right font-medium">{transaction.amount}</td>
                            <td className="px-2 py-2">
                              <Badge variant={statusVariant(transaction.status)}>{statusLabel(transaction.status)}</Badge>
                            </td>
                            <td className="px-2 py-2">
                              {(() => {
                                const indicator = changeIndicator(transaction);
                                if (!indicator) return <span className="text-slate-600">—</span>;
                                const Icon = indicator.icon;
                                return (
                                  <span
                                    title={indicator.title}
                                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${indicator.className}`}
                                  >
                                    <Icon className="h-3.5 w-3.5" />
                                    {indicator.label}
                                  </span>
                                );
                              })()}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={9} className="h-[360px] text-center text-sm text-slate-400">
                            Tidak ada transaksi ditemukan
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex flex-col items-center justify-between gap-3 border-t border-white/10 pt-4 text-sm sm:flex-row">
                  <div className="flex items-center gap-3">
                    <span className="text-slate-400">
                      {txnMeta.total
                        ? `Menampilkan ${(currentPage - 1) * limit + 1}–${Math.min(
                            currentPage * limit,
                            txnMeta.total,
                          )} dari ${txnMeta.total} transaksi`
                        : "0 transaksi"}
                    </span>
                    <select
                      value={limit}
                      onChange={(event) => {
                        setLimit(Number(event.target.value));
                        setPage(1);
                      }}
                      aria-label="Jumlah baris per halaman"
                      className="rd-input h-8 px-2 text-xs"
                    >
                      <option value={50}>50 / halaman</option>
                      <option value={100}>100 / halaman</option>
                      <option value={200}>200 / halaman</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      className="border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 hover:text-white"
                      onClick={() => setPage((value) => Math.max(1, value - 1))}
                      disabled={currentPage <= 1}
                    >
                      Sebelumnya
                    </Button>
                    <span className="text-slate-400">
                      Halaman {currentPage} / {pageCount}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      className="border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 hover:text-white"
                      onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                      disabled={currentPage >= pageCount}
                    >
                      Berikutnya
                    </Button>
                  </div>
                </div>
            </div>
          </section>
          </div>
          )}

          {activeNavAllowed && activeNav === "Olsera" && (
          <div className="rd-legacy min-h-[calc(100vh-8rem)] bg-gradient-to-b from-slate-50 via-slate-50 to-rose-50/40 p-4 sm:p-5">
          {/* Kartu sinkronisasi Olsera untuk semua user bermodul "olsera". */}
          {canSyncOlsera && (
          <section className="mb-6">
            <Card className={OLSERA_CARD}>
              <CardHeader className={`${OLSERA_CARD_HEADER} flex flex-row items-start justify-between gap-3 space-y-0`}>
                <div className="flex items-start gap-3.5">
                  <div className={`${OLSERA_ICON_CHIP} bg-rose-50 text-rose-600 ring-rose-100`}>
                    <RefreshCw className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className={OLSERA_TITLE}>Sync Olsera</CardTitle>
                    <CardDescription className={OLSERA_DESC}>
                      {olseraSyncStatus?.lastFullySyncedDate ? (
                        <>
                          Data tersinkron{" "}
                          <span className="font-medium text-slate-700">
                            {formatDisplayDate(olseraSyncStatus.firstSyncedDate ?? olseraSyncStatus.lastFullySyncedDate)}
                            {" - "}
                            {formatDisplayDate(olseraSyncStatus.lastFullySyncedDate)}
                          </span>
                          {olseraSyncStatus.lastSync?.finishedAt && (
                            <> · terakhir sync {formatSyncDateTime(olseraSyncStatus.lastSync.finishedAt)}</>
                          )}
                        </>
                      ) : (
                        "Belum pernah sync — isi tanggal mulai dan selesai untuk sync pertama kali."
                      )}
                    </CardDescription>
                  </div>
                </div>
                {olseraSyncing ? (
                  <Badge variant="info" className="gap-1.5 rounded-full px-2.5 ring-1 ring-inset ring-sky-200/70">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Running
                  </Badge>
                ) : olseraSyncStatus?.lastSync ? (
                  olseraSyncStatus.lastSync.status === "success" ? (
                    <Badge variant="success" className="gap-1.5 rounded-full px-2.5 ring-1 ring-inset ring-emerald-200/70">
                      <CheckCircle2 className="h-3 w-3" />
                      Success
                    </Badge>
                  ) : olseraSyncStatus.lastSync.status === "partial" ? (
                    <Badge variant="warning" className="gap-1.5 rounded-full px-2.5 ring-1 ring-inset ring-amber-200/70">
                      <AlertTriangle className="h-3 w-3" />
                      Partial
                    </Badge>
                  ) : (
                    <Badge variant="danger" className="gap-1.5 rounded-full px-2.5 ring-1 ring-inset ring-red-200/70">
                      <AlertTriangle className="h-3 w-3" />
                      Failed
                    </Badge>
                  )
                ) : (
                  <Badge variant="secondary" className="rounded-full px-2.5 ring-1 ring-inset ring-slate-200/70">
                    Belum sync
                  </Badge>
                )}
              </CardHeader>
              <CardContent className={OLSERA_CARD_CONTENT}>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    className={OLSERA_PRIMARY_BTN}
                    onClick={handleOlseraSync}
                    disabled={olseraSyncing}
                  >
                    {olseraSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    {olseraSyncing ? "Menyinkronkan Olsera..." : "Sync Olsera"}
                  </Button>
                  <span className="text-xs text-slate-500">
                    Memeriksa dan memperbarui data bulan berjalan secara otomatis.
                  </span>
                </div>
                {olseraSyncMessage && (
                  <p className="mt-3 text-sm text-slate-600" aria-live="polite">
                    {olseraSyncMessage}
                  </p>
                )}
              </CardContent>
            </Card>
          </section>
          )}

          <section className="mb-6">
            <Card className={OLSERA_CARD}>
              <CardHeader className={`${OLSERA_CARD_HEADER} flex flex-row items-start gap-3.5 space-y-0`}>
                <div className={`${OLSERA_ICON_CHIP} bg-slate-100 text-slate-600 ring-slate-200/80`}>
                  <FileSpreadsheet className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className={OLSERA_TITLE}>Laporan Penjualan</CardTitle>
                  <CardDescription className={OLSERA_DESC}>
                    Pilih mode laporan, atur periodenya, lalu unduh export yang tersedia untuk mode tersebut.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className={OLSERA_CARD_CONTENT}>
                <div className="flex flex-wrap items-center gap-2.5">
                  {/* Segmented control mode laporan — bulan & rentang tidak pernah aktif bersamaan. */}
                  <div
                    role="tablist"
                    aria-label="Mode laporan Olsera"
                    className="inline-flex h-10 items-center rounded-xl bg-slate-100/90 p-1 ring-1 ring-inset ring-slate-200/70"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={olseraReportMode === "range"}
                      onClick={() => handleOlseraReportModeChange("range")}
                      className={`${OLSERA_SEGMENT_BTN} ${
                        olseraReportMode === "range"
                          ? "bg-rose-600 font-semibold text-white shadow-sm"
                          : "font-medium text-slate-500 hover:bg-white/70 hover:text-slate-700"
                      }`}
                    >
                      <CalendarRange className="h-4 w-4" />
                      Rentang Tanggal
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={olseraReportMode === "monthly"}
                      onClick={() => handleOlseraReportModeChange("monthly")}
                      className={`${OLSERA_SEGMENT_BTN} ${
                        olseraReportMode === "monthly"
                          ? "bg-rose-600 font-semibold text-white shadow-sm"
                          : "font-medium text-slate-500 hover:bg-white/70 hover:text-slate-700"
                      }`}
                    >
                      <CalendarDays className="h-4 w-4" />
                      Bulanan
                    </button>
                  </div>

                  {olseraReportMode === "range" ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        className={`rounded-lg shadow-sm transition-colors ${
                          olseraStart === olseraYesterday && olseraEnd === olseraYesterday
                            ? "border-rose-200 bg-rose-50 font-medium text-rose-700 hover:bg-rose-100"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-rose-50 hover:text-rose-700"
                        }`}
                        onClick={handleOlseraYesterday}
                      >
                        Kemarin
                      </Button>
                      <div className={OLSERA_FIELD}>
                        <CalendarRange className="h-4 w-4 shrink-0 text-slate-400" />
                        <Input
                          type="date"
                          aria-label="Tanggal mulai filter Olsera"
                          value={olseraRangeStart}
                          className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
                          onClick={(event) => event.currentTarget.showPicker?.()}
                          onChange={(event) => handleOlseraRangeChange(event.target.value, olseraRangeEnd)}
                        />
                        <span className="text-xs text-slate-400">s/d</span>
                        <Input
                          type="date"
                          aria-label="Tanggal selesai filter Olsera"
                          value={olseraRangeEnd}
                          className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
                          onClick={(event) => event.currentTarget.showPicker?.()}
                          onChange={(event) => handleOlseraRangeChange(olseraRangeStart, event.target.value)}
                        />
                      </div>
                    </>
                  ) : (
                    <div className={OLSERA_FIELD}>
                      <CalendarDays className="h-4 w-4 shrink-0 text-slate-400" />
                      <Input
                        type="month"
                        aria-label="Filter bulan tertentu (Olsera)"
                        value={olseraFilterMonth}
                        className="h-8 w-[150px] cursor-pointer border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
                        onClick={(event) => event.currentTarget.showPicker?.()}
                        onChange={(event) => handleOlseraMonthFilter(event.target.value)}
                      />
                    </div>
                  )}

                  <Button
                    type="button"
                    variant="ghost"
                    className="rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
                    onClick={handleOlseraResetFilters}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Reset
                  </Button>

                  {/* Tombol Export tunggal + dropdown yang mengikuti mode aktif. */}
                  <div ref={olseraExportMenuRef} className="relative ml-auto w-full sm:w-auto">
                    <Button
                      type="button"
                      className={`${OLSERA_PRIMARY_BTN} w-full sm:w-auto`}
                      aria-haspopup="menu"
                      aria-expanded={olseraExportMenuOpen}
                      disabled={olseraAnyExporting || isInvalidDateRange(olseraStart, olseraEnd)}
                      onClick={() => setOlseraExportMenuOpen((value) => !value)}
                    >
                      {olseraAnyExporting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ArrowDownToLine className="h-4 w-4" />
                      )}
                      {olseraAnyExporting ? "Mengekspor..." : "Export"}
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${olseraExportMenuOpen ? "rotate-180" : ""}`}
                      />
                    </Button>
                    {olseraExportMenuOpen && (
                      <div
                        role="menu"
                        aria-label="Pilihan export Olsera"
                        className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl shadow-slate-900/10"
                      >
                        {/* Ketiga export selalu tersedia; Omset Kategori memakai
                            bulan filter (mode bulanan) atau bulan startDate (mode rentang). */}
                        <button
                          type="button"
                          role="menuitem"
                          className={OLSERA_MENU_ITEM}
                          onClick={() => {
                            setOlseraExportMenuOpen(false);
                            handleOlseraItemExport();
                          }}
                        >
                          <span className="mt-0.5 rounded-md bg-rose-50 p-1.5 text-rose-600 ring-1 ring-inset ring-rose-100">
                            <FileSpreadsheet className="h-4 w-4" />
                          </span>
                          <span>
                            <span className="block font-medium">Export Rincian Penjualan</span>
                            <span className="block text-xs text-slate-500">
                              Detail transaksi pada rentang tanggal aktif
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className={OLSERA_MENU_ITEM}
                          onClick={() => {
                            setOlseraExportMenuOpen(false);
                            handleOlseraCategoryExport();
                          }}
                        >
                          <span className="mt-0.5 rounded-md bg-rose-50 p-1.5 text-rose-600 ring-1 ring-inset ring-rose-100">
                            <FileSpreadsheet className="h-4 w-4" />
                          </span>
                          <span>
                            <span className="block font-medium">Export Kategori Penjualan</span>
                            <span className="block text-xs text-slate-500">
                              Rincian item per kategori pada rentang tanggal aktif
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className={OLSERA_MENU_ITEM}
                          onClick={() => {
                            setOlseraExportMenuOpen(false);
                            handleOlseraOmsetKategoriExport();
                          }}
                        >
                          <span className="mt-0.5 rounded-md bg-rose-50 p-1.5 text-rose-600 ring-1 ring-inset ring-rose-100">
                            <FileSpreadsheet className="h-4 w-4" />
                          </span>
                          <span>
                            <span className="block font-medium">Export Omset Kategori</span>
                            <span className="block text-xs text-slate-500">
                              Rekap omset kategori untuk bulan yang dipilih
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={olseraReportMode !== "monthly"}
                          className={`${OLSERA_MENU_ITEM} ${
                            olseraReportMode !== "monthly" ? "cursor-not-allowed opacity-50 hover:bg-transparent" : ""
                          }`}
                          onClick={() => {
                            setOlseraExportMenuOpen(false);
                            handleOlseraLabersExport();
                          }}
                        >
                          <span className="mt-0.5 rounded-md bg-rose-50 p-1.5 text-rose-600 ring-1 ring-inset ring-rose-100">
                            <FileSpreadsheet className="h-4 w-4" />
                          </span>
                          <span>
                            <span className="block font-medium">Export Pembagian Hasil LABERS</span>
                            <span className="block text-xs text-slate-500">
                              {olseraReportMode === "monthly"
                                ? `Rekap penjualan LABERS & pembagian Padel/Labers bulan ${formatMonthLabel(olseraFilterMonth)}`
                                : "Pilih mode Bulanan"}
                            </span>
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {olseraReportMode === "range" && isInvalidDateRange(olseraRangeStart, olseraRangeEnd) && (
                  <p className="mt-3 text-sm text-red-600">Tanggal selesai tidak boleh sebelum tanggal mulai.</p>
                )}
                {olseraExportMessages.length > 0 && (
                  <p className="mt-3 text-sm text-slate-600">{olseraExportMessages.join(" · ")}</p>
                )}
                {/* Export Excel (Omset+Laba) disembunyikan sementara — jangan hapus, tinggal ganti false -> true untuk memunculkan lagi. */}
                {false && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleOlseraExport}
                    disabled={olseraExporting || isInvalidDateRange(olseraStart, olseraEnd)}
                  >
                    <ArrowDownToLine className="h-4 w-4" />
                    {olseraExporting ? "Mengekspor..." : "Export Excel"}
                  </Button>
                )}
                {false && olseraExportMessage && <span className="text-sm text-slate-600">{olseraExportMessage}</span>}
              </CardContent>
            </Card>
          </section>

          <section>
            <Card className={OLSERA_CARD}>
              <CardHeader
                className={`${OLSERA_CARD_HEADER} flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between`}
              >
                <div className="flex items-start gap-3.5">
                  <div className={`${OLSERA_ICON_CHIP} bg-rose-50 text-rose-600 ring-rose-100`}>
                    <Store className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className={OLSERA_TITLE}>Penjualan per Kategori</CardTitle>
                    <CardDescription className={OLSERA_DESC}>
                      Data hasil sync dari MongoDB — {getOlseraFilterDetail()}
                    </CardDescription>
                  </div>
                </div>
                {olseraRows.length > 0 && !olseraLoading && !olseraError && (
                  <div className="flex shrink-0 items-center gap-5 rounded-xl border border-slate-200/70 bg-slate-50/80 px-4 py-2.5">
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Kategori</p>
                      <p className="mt-0.5 text-sm font-semibold tabular-nums tracking-tight text-slate-900">
                        {olseraRows.length}
                      </p>
                    </div>
                    <div className="h-8 w-px bg-slate-200" />
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Total Penjualan</p>
                      <p className="mt-0.5 text-sm font-semibold tabular-nums tracking-tight text-rose-700">
                        {formatRupiah(olseraRows.reduce((sum, row) => sum + row.totalPenjualan, 0))}
                      </p>
                    </div>
                  </div>
                )}
              </CardHeader>
              <CardContent className={OLSERA_CARD_CONTENT}>
                {(olseraSyncStatus?.unresolvedItemCount ?? 0) > 0 && (
                  <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200/80 border-l-4 border-l-amber-400 bg-amber-50/80 px-3.5 py-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <p className="text-sm text-amber-900">
                      Ada {olseraSyncStatus!.unresolvedItemCount} item yang belum memiliki mapping kategori.
                    </p>
                  </div>
                )}
                {olseraSyncStatus?.lastFullySyncedDate && olseraEnd > olseraSyncStatus.lastFullySyncedDate && (
                  <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200/80 border-l-4 border-l-amber-400 bg-amber-50/80 px-3.5 py-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <div>
                      <p className="text-sm font-semibold text-amber-900">Data belum lengkap</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-amber-700">
                        Data baru tersinkron sampai {formatDisplayDate(olseraSyncStatus.lastFullySyncedDate)}
                        {olseraSyncStatus.lastSync?.finishedAt &&
                          formatJakartaTime(olseraSyncStatus.lastSync.finishedAt) &&
                          ` pukul ${formatJakartaTime(olseraSyncStatus.lastSync.finishedAt)}`}
                        . Total hanya mencerminkan data yang sudah tersedia.
                      </p>
                      {olseraSyncStatus.lastSync &&
                        olseraSyncStatus.lastSync.status !== "success" &&
                        olseraSyncStatus.lastSync.errorMessage && (
                          <p className="mt-0.5 text-xs leading-relaxed text-amber-700">
                            {olseraSyncStatus.lastSync.errorMessage}
                          </p>
                        )}
                    </div>
                  </div>
                )}
                {olseraLoading ? (
                  <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Memuat data penjualan Olsera...
                  </div>
                ) : olseraError ? (
                  <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                    {olseraError}
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-200/80">
                    <table className="w-full min-w-[400px] text-sm">
                      <thead className="bg-slate-50/90">
                        <tr className="border-b border-slate-200/80 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                          <th className="h-11 px-4">Kategori</th>
                          <th className="h-11 px-4 text-right">Qty</th>
                          <th className="h-11 px-4 text-right">Total Penjualan</th>
                        </tr>
                      </thead>
                      <tbody>
                        {olseraRows.length ? (
                          olseraRows.map((row) => (
                            <tr
                              key={row.kategori}
                              className="border-b border-slate-100 transition-colors last:border-0 odd:bg-slate-50/50 hover:bg-rose-50/60"
                            >
                              <td className="px-4 py-3 font-medium text-slate-700">{row.kategori}</td>
                              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-500">
                                {row.qty ?? "-"}
                              </td>
                              <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums tracking-tight text-slate-800">
                                {formatRupiah(row.totalPenjualan)}
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={3} className="px-4 py-12 text-center">
                              <div className="mx-auto flex max-w-sm flex-col items-center gap-2.5">
                                <span className="rounded-xl bg-slate-100 p-2.5 text-slate-400">
                                  <Search className="h-5 w-5" />
                                </span>
                                <p className="text-sm text-slate-500">
                                  Tidak ada data penjualan pada periode ini. Jalankan sinkronisasi terlebih dahulu.
                                </p>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                      {olseraRows.length > 0 && (
                        <tfoot>
                          <tr className="border-t-2 border-rose-200/80 bg-rose-50/80">
                            <td className="px-4 py-3.5 font-bold tracking-tight text-slate-900">Total</td>
                            <td className="whitespace-nowrap px-4 py-3.5 text-right font-bold tabular-nums text-slate-900">
                              {olseraRows.reduce((sum, row) => sum + (row.qty ?? 0), 0)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3.5 text-right font-bold tabular-nums tracking-tight text-rose-700">
                              {formatRupiah(olseraRows.reduce((sum, row) => sum + row.totalPenjualan, 0))}
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          </div>
          )}

          {activeNavAllowed && activeNav === "OlseraInventori" && (
            <div className="rd-legacy min-h-[calc(100vh-8rem)] bg-gradient-to-b from-slate-50 via-slate-50 to-rose-50/40 p-4 sm:p-5">
              <OlseraInventoryPanel />
            </div>
          )}

          {activeNavAllowed && activeNav === "Webhook" && (
          <div className="rd-legacy p-4 sm:p-5">
          <section className="grid gap-4 md:grid-cols-3">
            <MetricCard
              title="Status Route"
              value={webhookStatus === "active" ? "Aktif" : webhookStatus === "inactive" ? "Tidak Aktif" : "Memeriksa…"}
              detail="GET /api/webhooks/ayo"
              icon={Webhook}
              accent="bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
            />
            <MetricCard
              title="Total Webhook Diterima"
              value={String(webhookData?.total ?? 0)}
              detail="Sejak awal pencatatan"
              icon={DatabaseZap}
              accent="bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
            />
            <MetricCard
              title="Webhook Terakhir"
              value={formatWebhookTime(webhookData?.lastReceivedAt)}
              detail="Waktu Asia/Jakarta"
              icon={Clock}
              accent="bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
            />
          </section>

          <section className="mt-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle>Log Webhook Terbaru</CardTitle>
                    <CardDescription>20 payload terakhir yang diterima dari AYO</CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setWebhookRefresh((value) => value + 1)}
                    disabled={webhookLoading}
                    aria-label="Muat ulang log webhook"
                  >
                    <RefreshCw className={`h-4 w-4 ${webhookLoading ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] text-sm">
                    <thead className="bg-white">
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="h-10 px-2 font-medium">Waktu</th>
                        <th className="h-10 px-2 font-medium">Status</th>
                        <th className="h-10 px-2 font-medium">Item</th>
                        <th className="h-10 px-2 font-medium">ID Terdeteksi</th>
                        <th className="h-10 px-2 font-medium">Pesan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(webhookData?.logs ?? []).length ? (
                        (webhookData?.logs ?? []).map((log, index) => {
                          const style = webhookStatusStyle(log.status);
                          const idText = Object.entries(log.ids)
                            .flatMap(([key, list]) => list.map((value) => `${key}: ${value}`))
                            .join(", ");
                          return (
                            <tr key={`${log.receivedAt}-${index}`} className="border-b align-top last:border-0">
                              <td className="whitespace-nowrap px-2 py-2">{formatWebhookTime(log.receivedAt)}</td>
                              <td className="px-2 py-2">
                                <span
                                  className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ${style.className}`}
                                >
                                  {style.label}
                                </span>
                              </td>
                              <td className="px-2 py-2">{log.itemCount}</td>
                              <td className="max-w-[200px] truncate px-2 py-2" title={idText}>
                                {idText || "—"}
                              </td>
                              <td className="max-w-[220px] truncate px-2 py-2" title={log.message}>
                                {log.message || "—"}
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={5} className="h-[200px] text-center text-sm text-slate-500">
                            {webhookLoading ? "Memuat…" : "Belum ada webhook yang diterima"}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </section>
          </div>
          )}
        </div>
    </AyoseraShell>
  );
}

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
  accent,
}: {
  title: string;
  value: string;
  detail: string;
  icon: ElementType;
  accent: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-slate-500">{title}</p>
            <p className="mt-2 text-2xl font-semibold tracking-normal">{value}</p>
            <p className="mt-1 text-xs text-slate-500">{detail}</p>
          </div>
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md ${accent}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function formatWebhookTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function webhookStatusStyle(status: WebhookLogRow["status"]) {
  if (status === "received") return { label: "Diterima", className: "bg-emerald-100 text-emerald-800" };
  if (status === "invalid") return { label: "JSON Invalid", className: "bg-amber-100 text-amber-800" };
  return { label: "Error", className: "bg-rose-100 text-rose-800" };
}

function formatEventTime(value: string) {
  if (!value.includes("T")) return value;
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
