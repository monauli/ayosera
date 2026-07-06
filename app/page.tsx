"use client";

import { useEffect, useState, type ElementType } from "react";
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpDown,
  BadgeCheck,
  Bell,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Check,
  PencilLine,
  Sparkles,
  CheckCircle2,
  ChevronDown,
  DatabaseZap,
  LayoutDashboard,
  Menu,
  RefreshCw,
  Search,
  RotateCcw,
  Store,
  Webhook,
  Copy,
  Clock,
} from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
};
type DatePreset = "today" | "month" | "lastMonth" | "custom" | "manualMonth";

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
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-900 ${
          align === "right" ? "flex-row-reverse" : ""
        } ${active ? "text-slate-900" : ""}`}
        title="Klik untuk mengurutkan"
      >
        {label}
        <Icon className={`h-3 w-3 ${active ? "" : "opacity-40"}`} />
      </button>
    </th>
  );
}

const navItems = [
  { label: "Dasbor", icon: LayoutDashboard },
  { label: "Transaksi", icon: Activity },
  { label: "Olsera", icon: Store },
  { label: "Webhook", icon: Webhook },
];

const WEBHOOK_URL = "https://ayosera.vercel.app/api/webhooks/ayo";

const THEME_STORAGE_KEY = "ayo-theme";
const themeOptions = [
  { value: "white", label: "Putih + Rosé", swatch: "#ffffff", ring: "#FFD8DF" },
  { value: "rose", label: "Rosé", swatch: "#FFD8DF", ring: "#f472b6" },
  { value: "mint", label: "Mint", swatch: "#A8DF8E", ring: "#86c36e" },
  { value: "lavender", label: "Lavender", swatch: "#DDD6FE", ring: "#a78bfa" },
  { value: "ocean", label: "Ocean", swatch: "#A5E6F0", ring: "#67c8dc" },
  { value: "amber", label: "Amber", swatch: "#FDDDA8", ring: "#f5b45a" },
];

function statusVariant(status: string) {
  if (status === "Completed") return "default";
  if (status === "Pending") return "warning";
  return "danger";
}

function statusLabel(status: string) {
  if (status === "Completed") return "Selesai";
  if (status === "Pending") return "Tertunda";
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
  if (row.changeType === "updated") {
    return {
      label: "Diperbarui",
      icon: PencilLine,
      className: "bg-sky-100 text-sky-800",
      title: "Data diperbarui pada sinkronisasi terakhir",
    };
  }
  if (row.changeType === "new") {
    return {
      label: "Baru",
      icon: Sparkles,
      className: "bg-emerald-100 text-emerald-800",
      title: "Data baru ditarik dari AYO",
    };
  }
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
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [activeNav, setActiveNav] = useState("Dasbor");
  const [webhookData, setWebhookData] = useState<WebhookPayload | null>(null);
  const [webhookStatus, setWebhookStatus] = useState<"unknown" | "active" | "inactive">("unknown");
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [webhookRefresh, setWebhookRefresh] = useState(0);
  // Filter tampilan halaman Olsera: default "Kemarin" (data hari ini sering belum lengkap).
  const olseraYesterday = addDaysISO(today, -1);
  const [olseraFilterMode, setOlseraFilterMode] = useState<"yesterday" | "month" | "range">("yesterday");
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
  const [olseraSyncStart, setOlseraSyncStart] = useState("");
  const [olseraSyncEnd, setOlseraSyncEnd] = useState("");
  const [olseraSyncValidationError, setOlseraSyncValidationError] = useState("");
  const [olseraSyncRefresh, setOlseraSyncRefresh] = useState(0);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportDate, setExportDate] = useState(today);
  const [exportStart, setExportStart] = useState(today);
  const [exportEnd, setExportEnd] = useState(today);
  const [exportMonth, setExportMonth] = useState(currentMonth);
  const [sort, setSort] = useState<SortState>({ key: "date", dir: "asc" });
  const emptyColumnFilters = { date: today, id: "", customer: "", service: "", status: "" };
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>(emptyColumnFilters);

  function handleSort(key: SortKey) {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
    setPage(1);
  }

  function setColumnFilter(key: string, value: string) {
    setColumnFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }

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

  function handleCustomStartDate(value: string) {
    setDatePreset("custom");
    setStartDate(value);
  }

  function handleCustomEndDate(value: string) {
    setDatePreset("custom");
    setEndDate(value);
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
        // Pre-fill: sync lanjutan mulai dari checkpoint+1 s/d hari ini (boleh diubah user).
        if (payload.lastFullySyncedDate) {
          setOlseraSyncStart(addDaysISO(payload.lastFullySyncedDate, 1));
          setOlseraSyncEnd(today);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [activeNav, olseraSyncRefresh]);

  async function handleOlseraSync() {
    if (!olseraSyncStart || !olseraSyncEnd) return;

    setOlseraSyncValidationError("");
    if (olseraSyncEnd < olseraSyncStart) {
      setOlseraSyncValidationError("Tanggal selesai tidak boleh sebelum tanggal mulai.");
      return;
    }
    if (olseraSyncEnd > today) {
      setOlseraSyncValidationError("Tanggal selesai tidak boleh melewati hari ini.");
      return;
    }

    setOlseraSyncing(true);
    setOlseraSyncMessage("");
    try {
      // Kirim rentang persis yang dipilih user — jangan diam-diam meluas sampai hari ini.
      const response = await fetch("/api/olsera/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: olseraSyncStart, end_date: olseraSyncEnd }),
      });
      if (response.status === 401) {
        await redirectToLogin();
        return;
      }
      const payload = (await response.json().catch(() => null)) as
        | { status?: string; expectedOrderCount?: number; processedOrderCount?: number; error?: string }
        | null;
      if (!response.ok || !payload || payload.error) {
        setOlseraSyncMessage(payload?.error || "Sync Olsera gagal.");
        return;
      }
      setOlseraSyncMessage(
        `Sync ${payload.status === "success" ? "berhasil" : payload.status === "partial" ? "sebagian" : "gagal"}: ` +
          `${payload.processedOrderCount ?? 0}/${payload.expectedOrderCount ?? 0} order diproses.`,
      );
    } catch {
      setOlseraSyncMessage("Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.");
    } finally {
      setOlseraSyncing(false);
      setOlseraSyncRefresh((value) => value + 1);
    }
  }

  function handleOlseraYesterday() {
    setOlseraFilterMode("yesterday");
    setOlseraStart(olseraYesterday);
    setOlseraEnd(olseraYesterday);
  }

  function handleOlseraMonthFilter(value: string) {
    if (!value) return;
    const range = monthRangeFromValue(value);
    setOlseraFilterMonth(value);
    setOlseraFilterMode("month");
    setOlseraStart(range.startDate);
    setOlseraEnd(range.endDate);
  }

  function handleOlseraRangeChange(startDate: string, endDate: string) {
    setOlseraRangeStart(startDate);
    setOlseraRangeEnd(endDate);
    setOlseraFilterMode("range");
    // Terapkan hanya kalau kedua tanggal terisi dan urutannya valid;
    // kalau belum, data terakhir tetap tampil sampai rentang valid.
    if (startDate && endDate && startDate <= endDate) {
      setOlseraStart(startDate);
      setOlseraEnd(endDate);
    }
  }

  function handleOlseraResetFilters() {
    setOlseraFilterMode("yesterday");
    setOlseraStart(olseraYesterday);
    setOlseraEnd(olseraYesterday);
    setOlseraFilterMonth(currentMonth);
    setOlseraRangeStart(olseraYesterday);
    setOlseraRangeEnd(olseraYesterday);
  }

  function getOlseraFilterDetail() {
    if (olseraFilterMode === "yesterday") return `Kemarin (${formatDisplayDate(olseraStart)})`;
    if (olseraFilterMode === "month")
      return `${formatMonthLabel(olseraFilterMonth)} (${formatDisplayDate(olseraStart)} - ${formatDisplayDate(olseraEnd)})`;
    if (olseraStart === olseraEnd) return `Filter tanggal ${formatDisplayDate(olseraStart)}`;
    return `Filter ${formatDisplayDate(olseraStart)} - ${formatDisplayDate(olseraEnd)}`;
  }

  async function handleCopyWebhookUrl() {
    try {
      await navigator.clipboard.writeText(WEBHOOK_URL);
      setWebhookCopied(true);
      window.setTimeout(() => setWebhookCopied(false), 2000);
    } catch {
      // Abaikan jika clipboard tidak tersedia.
    }
  }

  const metrics = dashboard?.metrics;
  const dateRangeInvalid = isInvalidDateRange(startDate, endDate);
  // Pagination & filtering kini dilakukan di server; transactionRows hanya berisi halaman aktif.
  const pagedRows = transactionRows;
  const pageCount = Math.max(1, txnMeta.totalPages);
  const currentPage = Math.min(page, pageCount);
  const serviceOptions = (dashboard?.branchOptions ?? []).map((option) => option.value);
  const serviceRows = dashboard?.topServices ?? [];
  const paymentRows = dashboard?.paymentBreakdown ?? [];
  const eventRows = dashboard?.syncEvents ?? [];
  const courtOptions = dashboard?.branchOptions ?? [];
  const currentTheme = themeOptions.find((option) => option.value === theme) ?? themeOptions[0];
  const latestEvent = eventRows[0];
  const syncStatusLabel = latestEvent ? (latestEvent.tone.includes("teal") ? "OK" : "Gagal") : "-";
  const lastCheckpoint = latestEvent ? formatEventTime(latestEvent.time) : "-";

  const presetFilterRow = (
    <div className="flex flex-wrap items-center gap-2">
      {datePresetButtons.map((preset) => (
        <Button
          key={preset.value}
          type="button"
          variant={datePreset === preset.value ? "default" : "outline"}
          onClick={() => handleRangePreset(preset.value)}
        >
          <CalendarRange className="h-4 w-4" />
          {preset.label}
        </Button>
      ))}
      <div
        className={`flex h-10 items-center gap-2 rounded-md border px-2 ${
          datePreset === "manualMonth"
            ? "border-[rgb(var(--primary))] bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
            : "bg-white"
        }`}
      >
        <CalendarDays className="h-4 w-4 text-slate-500" />
        <Input
          type="month"
          aria-label="Filter bulan tertentu"
          value={filterMonth}
          className="h-8 w-[150px] cursor-pointer border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
          onClick={(event) => event.currentTarget.showPicker?.()}
          onChange={(event) => handleMonthFilter(event.target.value)}
        />
      </div>
      <Button type="button" variant="ghost" onClick={handleResetFilters}>
        <RotateCcw className="h-4 w-4" />
        Reset
      </Button>
    </div>
  );

  return (
    <main className="min-h-screen bg-[rgb(var(--background))] text-[rgb(var(--foreground))]">
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 transform border-r bg-white transition-transform duration-300 ease-in-out ${
          drawerOpen ? "translate-x-0 shadow-xl" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center gap-3 px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[rgb(var(--primary))] text-[rgb(var(--primary-foreground))]">
            <DatabaseZap className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold">Integrasi AYO</p>
            <p className="text-xs text-slate-500">Platform Transaksi</p>
          </div>
        </div>
        <nav className="space-y-1 px-3 py-4">
          {navItems.map((item) => (
            <button
              key={item.label}
              onClick={() => {
                setActiveNav(item.label);
                if (!window.matchMedia("(min-width: 1024px)").matches) setDrawerOpen(false);
              }}
              className={`flex h-10 w-full items-center gap-3 rounded-md px-3 text-sm transition-colors ${
                activeNav === item.label
                  ? "bg-[rgb(var(--accent))] font-medium text-[rgb(var(--accent-foreground))]"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="absolute inset-x-0 bottom-0 space-y-3 border-t p-4">
          <div className="relative">
            <p className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-slate-400">Theme</p>
            <button
              type="button"
              onClick={() => setThemeMenuOpen((open) => !open)}
              aria-expanded={themeMenuOpen}
              className="flex h-9 w-full items-center justify-between rounded-md border bg-white px-3 text-sm hover:bg-slate-50"
            >
              <span className="flex items-center gap-2">
                <span
                  className="h-4 w-4 rounded-full border border-black/10"
                  style={{ backgroundColor: currentTheme.swatch }}
                />
                {currentTheme.label}
              </span>
              <ChevronDown className={`h-4 w-4 transition-transform ${themeMenuOpen ? "rotate-180" : ""}`} />
            </button>
            {themeMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setThemeMenuOpen(false)} />
                <div className="absolute bottom-full left-0 z-50 mb-2 w-full overflow-hidden rounded-md border bg-white p-1 shadow-lg">
                  {themeOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setTheme(option.value);
                        setThemeMenuOpen(false);
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-sm hover:bg-slate-100"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="h-4 w-4 rounded-full border border-black/10"
                          style={{ backgroundColor: option.swatch }}
                        />
                        {option.label}
                      </span>
                      {theme === option.value && <Check className="h-4 w-4 text-slate-600" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="rounded-md bg-[rgb(var(--accent))] p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="h-4 w-4 text-[rgb(var(--accent-foreground))]" />
              API Sehat
            </div>
            <p className="mt-1 text-xs text-slate-500">Checkpoint terakhir: {lastCheckpoint}</p>
          </div>
        </div>
      </aside>

      <section className={`transition-[padding] duration-300 ease-in-out ${drawerOpen ? "lg:pl-64" : "pl-0"}`}>
        <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDrawerOpen((open) => !open)}
              aria-label="Buka/tutup navigasi"
              aria-expanded={drawerOpen}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold">
                {activeNav === "Transaksi"
                  ? "Transaksi AYO"
                  : activeNav === "Olsera"
                    ? "Penjualan Olsera"
                    : activeNav === "Webhook"
                      ? "Monitoring Webhook AYO"
                      : "Dasbor Transaksi Real-Time"}
              </h1>
              {activeNav === "Dasbor" && (
                <p className="hidden text-sm text-slate-500 sm:block">
                  Monitoring transaksi, pendapatan, sinkronisasi, dan integrasi AYO.
                </p>
              )}
            </div>
            <Button variant="outline" size="icon" aria-label="Notifikasi">
              <Bell className="h-4 w-4" />
            </Button>
            {/* Tombol sync AYO disembunyikan khusus di halaman Olsera (punya tombol sync sendiri). */}
            {activeNav !== "Olsera" && (
            <div className="relative">
              <Button
                onClick={() => {
                  setSyncMode(null);
                  setSyncMenuOpen((open) => !open);
                }}
                disabled={syncing}
                aria-expanded={syncMenuOpen}
              >
                <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Menyinkronkan" : "Sinkronkan Sekarang"}
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
            )}
          </div>
        </header>

        <div className="px-4 py-5 sm:px-6">
          {syncMessage && <p className="mb-4 text-sm text-slate-600">{syncMessage}</p>}

          {activeNav === "Dasbor" && (
          <>
          <div className="mb-4">{presetFilterRow}</div>

          <section className="grid gap-4 md:grid-cols-3">
            <MetricCard
              title="Total Transaksi"
              value={String(metrics?.totalTransactions ?? 0)}
              detail={getRevenueFilterDetail(datePreset, startDate, endDate)}
              icon={Activity}
              accent="bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
            />
            <MetricCard
              title="Pendapatan Hari Ini"
              value={metrics?.revenueToday ?? "Rp 0"}
              detail={`Hari ini (${formatDisplayDate(today)})`}
              icon={BadgeCheck}
              accent="bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
            />
            <MetricCard
              title="Pendapatan (Filter)"
              value={metrics?.revenueMonth ?? "Rp 0"}
              detail={getRevenueFilterDetail(datePreset, startDate, endDate)}
              icon={CalendarDays}
              accent="bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
            />
          </section>
          </>
          )}

          {activeNav === "Transaksi" && (
          <>
          <div className="mb-4">{presetFilterRow}</div>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="Total Transaksi"
              value={String(metrics?.totalTransactions ?? 0)}
              detail={getRevenueFilterDetail(datePreset, startDate, endDate)}
              icon={Activity}
              accent="bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
            />
            <MetricCard
              title="Pendapatan Hari Ini"
              value={metrics?.revenueToday ?? "Rp 0"}
              detail={`Hari ini (${formatDisplayDate(today)})`}
              icon={BadgeCheck}
              accent="bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
            />
            <MetricCard
              title="Pendapatan (Filter)"
              value={metrics?.revenueMonth ?? "Rp 0"}
              detail={getRevenueFilterDetail(datePreset, startDate, endDate)}
              icon={CalendarDays}
              accent="bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
            />
            <Card>
              <CardContent className="relative flex h-full items-center justify-between gap-4 p-5">
                <div className="min-w-0">
                  <p className="text-sm text-slate-500">Ekspor</p>
                  <p className="mt-2 text-2xl font-semibold tracking-normal">Excel</p>
                  <p className="mt-1 text-xs text-slate-500">Ikut filter aktif</p>
                </div>
                <div className="relative shrink-0">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setExportMenuOpen((open) => !open)}
                    disabled={exporting}
                    aria-expanded={exportMenuOpen}
                    className="h-11 w-11"
                  >
                    <ArrowDownToLine className="h-5 w-5" />
                  </Button>
                      {exportMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setExportMenuOpen(false)} />
                          <div className="absolute right-0 z-50 mt-2 w-72 rounded-md border bg-white p-4 text-left shadow-lg">
                            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                              Ekspor Sesuai Filter (.xlsx)
                            </p>
                            <p className="mb-2 text-xs text-slate-500">
                              {getRevenueFilterDetail(datePreset, startDate, endDate)}
                            </p>
                            <Button
                              className="w-full"
                              onClick={handleExportFilter}
                              disabled={exporting || dateRangeInvalid}
                            >
                              <ArrowDownToLine className="h-4 w-4" />
                              {exporting ? "Mengekspor" : "Unduh Sesuai Filter"}
                            </Button>
                            <p className="mb-2 mt-3 border-t pt-3 text-xs font-medium uppercase tracking-wide text-slate-500">
                              Ekspor Harian (.xlsx)
                            </p>
                            <Input
                              type="date"
                              aria-label="Tanggal ekspor harian"
                              value={exportDate}
                              className="mb-2 cursor-pointer"
                              onClick={(event) => event.currentTarget.showPicker?.()}
                              onChange={(event) => setExportDate(event.target.value)}
                            />
                            <Button className="w-full" onClick={handleExportHarian} disabled={exporting || !exportDate}>
                              <ArrowDownToLine className="h-4 w-4" />
                              {exporting ? "Mengekspor" : "Unduh Harian"}
                            </Button>
                            <div className="mt-3 space-y-2 border-t pt-3">
                              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                                Ekspor Range Tanggal (.xlsx)
                              </p>
                              <div className="flex gap-2">
                                <Input
                                  type="date"
                                  aria-label="Tanggal awal ekspor range"
                                  value={exportStart}
                                  className="cursor-pointer"
                                  onClick={(event) => event.currentTarget.showPicker?.()}
                                  onChange={(event) => setExportStart(event.target.value)}
                                />
                                <Input
                                  type="date"
                                  aria-label="Tanggal akhir ekspor range"
                                  value={exportEnd}
                                  className="cursor-pointer"
                                  onClick={(event) => event.currentTarget.showPicker?.()}
                                  onChange={(event) => setExportEnd(event.target.value)}
                                />
                              </div>
                              <Button
                                variant="outline"
                                className="w-full justify-start"
                                onClick={handleExportRange}
                                disabled={exporting || !exportStart || !exportEnd}
                              >
                                <CalendarRange className="h-4 w-4" />
                                {exporting ? "Mengekspor" : "Unduh Range"}
                              </Button>
                            </div>
                            <div className="mt-3 space-y-2 border-t pt-3">
                              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                                Ekspor Bulanan (.xlsx)
                              </p>
                              <Input
                                type="month"
                                aria-label="Bulan ekspor"
                                value={exportMonth}
                                className="cursor-pointer"
                                onClick={(event) => event.currentTarget.showPicker?.()}
                                onChange={(event) => setExportMonth(event.target.value)}
                              />
                              <Button
                                variant="outline"
                                className="w-full justify-start"
                                onClick={handleExportBulanan}
                                disabled={exporting || !exportMonth}
                              >
                                <CalendarDays className="h-4 w-4" />
                                {exporting ? "Mengekspor" : "Unduh Bulanan"}
                              </Button>
                            </div>
                          </div>
                        </>
                      )}
                </div>
              </CardContent>
            </Card>
          </section>

          <section className="mt-4">
            <Card>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1000px] text-sm">
                    <thead className="bg-white">
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
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
                      <tr className="border-b">
                        <th className="px-2 pb-2" />
                        <th className="px-2 pb-2" />
                        <th className="px-2 pb-2">
                          <input
                            value={columnFilters.id}
                            onChange={(event) => setColumnFilter("id", event.target.value)}
                            placeholder="Cari ID Booking"
                            className="h-7 w-full rounded border bg-white px-2 text-xs font-normal normal-case text-slate-700"
                          />
                        </th>
                        <th className="px-2 pb-2">
                          <input
                            value={columnFilters.customer}
                            onChange={(event) => setColumnFilter("customer", event.target.value)}
                            placeholder="Nama, telepon, atau ID"
                            className="h-7 w-full rounded border px-2 text-xs font-normal normal-case text-slate-700"
                          />
                        </th>
                        <th className="px-2 pb-2" />
                        <th className="px-2 pb-2">
                          <select
                            value={columnFilters.service}
                            onChange={(event) => setColumnFilter("service", event.target.value)}
                            className="h-7 w-full rounded border bg-white px-1 text-xs font-normal normal-case text-slate-700"
                          >
                            <option value="">Semua</option>
                            {serviceOptions.map((service) => (
                              <option key={service} value={service}>
                                {service}
                              </option>
                            ))}
                          </select>
                        </th>
                        <th className="px-2 pb-2" />
                        <th className="px-2 pb-2">
                          <select
                            value={columnFilters.status}
                            onChange={(event) => setColumnFilter("status", event.target.value)}
                            className="h-7 w-full rounded border bg-white px-1 text-xs font-normal normal-case text-slate-700"
                          >
                            <option value="">Semua</option>
                            <option value="Completed">Selesai</option>
                            <option value="Pending">Tertunda</option>
                            <option value="Cancelled">Dibatalkan</option>
                          </select>
                        </th>
                        <th className="px-2 pb-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {pagedRows.length ? (
                        pagedRows.map((transaction) => (
                          <tr key={transaction.id} className="h-[58px] border-b last:border-0">
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
                                if (!indicator) return <span className="text-slate-300">—</span>;
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
                          <td colSpan={9} className="h-[360px] text-center text-sm text-slate-500">
                            Tidak ada transaksi ditemukan
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex flex-col items-center justify-between gap-3 border-t pt-4 text-sm sm:flex-row">
                  <div className="flex items-center gap-3">
                    <span className="text-slate-500">
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
                      className="h-8 rounded border bg-white px-2 text-xs text-slate-700"
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
                      onClick={() => setPage((value) => Math.max(1, value - 1))}
                      disabled={currentPage <= 1}
                    >
                      Sebelumnya
                    </Button>
                    <span className="text-slate-500">
                      Halaman {currentPage} / {pageCount}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                      disabled={currentPage >= pageCount}
                    >
                      Berikutnya
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>
          </>
          )}

          {activeNav === "Olsera" && (
          <>
          <section className="mb-4">
            <Card>
              <CardHeader>
                <CardTitle>Sinkronisasi Olsera</CardTitle>
                <CardDescription>
                  {olseraSyncStatus?.lastFullySyncedDate ? (
                    <>
                      Data tersinkron:{" "}
                      <span className="font-medium">
                        {formatDisplayDate(olseraSyncStatus.firstSyncedDate ?? olseraSyncStatus.lastFullySyncedDate)}
                        {" - "}
                        {formatDisplayDate(olseraSyncStatus.lastFullySyncedDate)}
                      </span>
                      {olseraSyncStatus.lastSync && (
                        <>
                          {" "}— terakhir sync{" "}
                          {olseraSyncStatus.lastSync.finishedAt
                            ? new Date(olseraSyncStatus.lastSync.finishedAt).toLocaleString("id-ID", {
                                timeZone: "Asia/Jakarta",
                              })
                            : "-"}
                          , status{" "}
                          <span
                            className={
                              olseraSyncStatus.lastSync.status === "success"
                                ? "font-medium text-emerald-600"
                                : olseraSyncStatus.lastSync.status === "partial"
                                  ? "font-medium text-amber-600"
                                  : "font-medium text-red-600"
                            }
                          >
                            {olseraSyncStatus.lastSync.status}
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    "Belum pernah sync — isi tanggal mulai dan selesai untuk sync pertama kali."
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="date"
                    aria-label="Tanggal mulai sync Olsera"
                    value={olseraSyncStart}
                    max={today}
                    className="h-10 w-[170px] cursor-pointer"
                    onClick={(event) => event.currentTarget.showPicker?.()}
                    onChange={(event) => {
                      setOlseraSyncStart(event.target.value);
                      setOlseraSyncValidationError("");
                    }}
                  />
                  <span className="text-sm text-slate-500">s/d</span>
                  <Input
                    type="date"
                    aria-label="Tanggal selesai sync Olsera"
                    value={olseraSyncEnd}
                    max={today}
                    className="h-10 w-[170px] cursor-pointer"
                    onClick={(event) => event.currentTarget.showPicker?.()}
                    onChange={(event) => {
                      setOlseraSyncEnd(event.target.value);
                      setOlseraSyncValidationError("");
                    }}
                  />
                  <Button
                    type="button"
                    onClick={handleOlseraSync}
                    disabled={olseraSyncing || !olseraSyncStart || !olseraSyncEnd}
                  >
                    <RefreshCw className={`h-4 w-4 ${olseraSyncing ? "animate-spin" : ""}`} />
                    Sinkronkan Olsera
                  </Button>
                  {olseraSyncMessage && <span className="text-sm text-slate-600">{olseraSyncMessage}</span>}
                </div>
                {olseraSyncValidationError && (
                  <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    {olseraSyncValidationError}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={olseraFilterMode === "yesterday" ? "default" : "outline"}
              onClick={handleOlseraYesterday}
            >
              <CalendarRange className="h-4 w-4" />
              Kemarin
            </Button>
            <div
              className={`flex h-10 items-center gap-2 rounded-md border px-2 ${
                olseraFilterMode === "month"
                  ? "border-[rgb(var(--primary))] bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
                  : "bg-white"
              }`}
            >
              <CalendarDays className="h-4 w-4 text-slate-500" />
              <Input
                type="month"
                aria-label="Filter bulan tertentu (Olsera)"
                value={olseraFilterMonth}
                className="h-8 w-[150px] cursor-pointer border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
                onClick={(event) => event.currentTarget.showPicker?.()}
                onChange={(event) => handleOlseraMonthFilter(event.target.value)}
              />
            </div>
            <div
              className={`flex h-10 items-center gap-2 rounded-md border px-2 ${
                olseraFilterMode === "range"
                  ? "border-[rgb(var(--primary))] bg-[rgb(var(--accent))] text-[rgb(var(--accent-foreground))]"
                  : "bg-white"
              }`}
            >
              <CalendarRange className="h-4 w-4 text-slate-500" />
              <Input
                type="date"
                aria-label="Tanggal mulai filter Olsera"
                value={olseraRangeStart}
                className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
                onClick={(event) => event.currentTarget.showPicker?.()}
                onChange={(event) => handleOlseraRangeChange(event.target.value, olseraRangeEnd)}
              />
              <span className="text-xs text-slate-500">s/d</span>
              <Input
                type="date"
                aria-label="Tanggal selesai filter Olsera"
                value={olseraRangeEnd}
                className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
                onClick={(event) => event.currentTarget.showPicker?.()}
                onChange={(event) => handleOlseraRangeChange(olseraRangeStart, event.target.value)}
              />
            </div>
            <Button type="button" variant="ghost" onClick={handleOlseraResetFilters}>
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
            {olseraFilterMode === "range" && isInvalidDateRange(olseraRangeStart, olseraRangeEnd) && (
              <span className="text-sm text-red-600">Tanggal selesai tidak boleh sebelum tanggal mulai.</span>
            )}
          </div>

          <section>
            <Card>
              <CardHeader>
                <CardTitle>Penjualan per Kategori</CardTitle>
                <CardDescription>
                  Data hasil sync dari MongoDB — {getOlseraFilterDetail()}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {olseraSyncStatus?.lastFullySyncedDate && olseraEnd > olseraSyncStatus.lastFullySyncedDate && (
                  <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    ⚠️ Data hanya lengkap sampai{" "}
                    <span className="font-medium">{formatDisplayDate(olseraSyncStatus.lastFullySyncedDate)}</span> —{" "}
                    {daysBetweenISO(
                      olseraStart > olseraSyncStatus.lastFullySyncedDate
                        ? olseraStart
                        : addDaysISO(olseraSyncStatus.lastFullySyncedDate, 1),
                      olseraEnd,
                    ) + 1}{" "}
                    hari tersisa dalam rentang ini belum disinkron. Total di bawah HANYA mencerminkan hari yang sudah
                    disync.
                  </div>
                )}
                {olseraLoading ? (
                  <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Memuat data penjualan Olsera...
                  </div>
                ) : olseraError ? (
                  <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                    {olseraError}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[400px] text-sm">
                      <thead className="bg-white">
                        <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                          <th className="h-10 px-2 font-medium">Kategori</th>
                          <th className="h-10 px-2 text-right font-medium">Qty</th>
                          <th className="h-10 px-2 text-right font-medium">Total Penjualan</th>
                        </tr>
                      </thead>
                      <tbody>
                        {olseraRows.length ? (
                          olseraRows.map((row) => (
                            <tr key={row.kategori} className="border-b last:border-0">
                              <td className="px-2 py-3">{row.kategori}</td>
                              <td className="whitespace-nowrap px-2 py-3 text-right">{row.qty ?? "-"}</td>
                              <td className="whitespace-nowrap px-2 py-3 text-right">
                                {formatRupiah(row.totalPenjualan)}
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={3} className="px-2 py-10 text-center text-slate-500">
                              Tidak ada data penjualan pada rentang tanggal ini. Jalankan sinkronisasi terlebih dahulu.
                            </td>
                          </tr>
                        )}
                      </tbody>
                      {olseraRows.length > 0 && (
                        <tfoot>
                          <tr className="border-t bg-[rgb(var(--accent))]">
                            <td className="px-2 py-3 font-semibold">Total</td>
                            <td className="whitespace-nowrap px-2 py-3 text-right font-semibold">
                              {olseraRows.reduce((sum, row) => sum + (row.qty ?? 0), 0)}
                            </td>
                            <td className="whitespace-nowrap px-2 py-3 text-right font-semibold">
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

          </>
          )}

          {activeNav === "Webhook" && (
          <>
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
                <CardTitle>Webhook URL Produksi</CardTitle>
                <CardDescription>Berikan URL ini ke pihak AYO</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <code className="flex-1 break-all rounded-md border bg-slate-50 px-3 py-2 text-sm text-slate-700">
                    {WEBHOOK_URL}
                  </code>
                  <Button variant="outline" onClick={handleCopyWebhookUrl}>
                    <Copy className="h-4 w-4" />
                    {webhookCopied ? "Tersalin" : "Salin URL"}
                  </Button>
                </div>
              </CardContent>
            </Card>
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
                        <th className="h-10 px-2 font-medium">Payload</th>
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
                              <td className="px-2 py-2">
                                <pre className="max-h-24 max-w-[280px] overflow-auto rounded bg-slate-50 p-2 text-xs text-slate-600">
                                  {log.bodyPreview || "—"}
                                </pre>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={6} className="h-[200px] text-center text-sm text-slate-500">
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
          </>
          )}

          {activeNav === "Dasbor" && (
          <>
          <section className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Rincian Pembayaran</CardTitle>
                <CardDescription>Pembagian pendapatan per metode pembayaran</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[236px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={paymentRows} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={4}>
                        {paymentRows.map((entry) => (
                          <Cell key={entry.name} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ borderRadius: 8, borderColor: "#e2e8f0" }} formatter={(value) => [`${value}%`, "Porsi"]} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {paymentRows.map((item) => (
                    <div key={item.name} className="flex items-center gap-2 text-sm">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                      <span className="text-slate-600">{item.name}</span>
                      <span className="ml-auto font-medium">{item.value}%</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Layanan Terlaris</CardTitle>
                <CardDescription>Diurutkan berdasarkan pendapatan pada filter</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {serviceRows.map((service) => (
                  <div key={service.name} className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{service.name}</p>
                        <p className="text-xs text-slate-500">{service.branch} · {service.count} pesanan</p>
                      </div>
                      <span className="text-sm font-semibold">{service.revenue}</span>
                    </div>
                    <Progress value={service.progress} />
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>

          <section className="mt-4">
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      latestEvent ? latestEvent.tone.replace("text", "bg") : "bg-slate-300"
                    }`}
                  />
                  <span className="text-sm font-medium">Kesehatan Sinkronisasi</span>
                  <Badge variant={syncStatusLabel === "Gagal" ? "danger" : "default"}>{syncStatusLabel}</Badge>
                </div>
                <span className="text-xs text-slate-500">
                  {latestEvent ? `${latestEvent.label} · ${formatEventTime(latestEvent.time)}` : "Belum ada sinkronisasi"}
                </span>
              </CardContent>
            </Card>
          </section>
          </>
          )}
        </div>
      </section>
    </main>
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
