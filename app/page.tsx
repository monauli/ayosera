"use client";

import { useEffect, useRef, useState, type ElementType } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
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
  ShieldCheck,
  Store,
  Users,
  Webhook,
  Clock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OlseraFinancialPanel } from "@/components/olsera-financial-panel";
import { OlseraInventoryPanel } from "@/components/olsera-inventory-panel";
import { acquireOlseraSyncLock, releaseOlseraSyncLock } from "@/lib/olsera-sync-lock";
import { runOlseraSyncAll, type StageId, type StageStatus } from "@/lib/olsera-sync-orchestrator";
import { UsersPanel } from "@/components/users-panel";
import { AyoseraHeader } from "@/components/redesign/ayosera-header";
import { AyoseraShell } from "@/components/redesign/ayosera-shell";
import { AyoseraSidebar } from "@/components/redesign/ayosera-sidebar";
import { DashboardOverview } from "@/components/redesign/dashboard-overview";
import { DashboardStatCard } from "@/components/redesign/dashboard-stat-card";
import { TransactionExportMenu } from "@/components/redesign/transaction-export-menu";
import { OlseraExportMenu } from "@/components/redesign/olsera-export-menu";
import type { BookingStatusItem } from "@/components/redesign/booking-status-donut";
import type { MonthlyRevenuePoint, MonthlyRevenueStatus } from "@/components/redesign/annual-revenue-chart";

type HourlyPoint = { time: string; transactions: number; revenue: number };
// `revenueValue` sudah dikembalikan API (server men-spread objek asli sebelum
// memformat `revenue`) — deklarasi ini hanya melengkapi tipe klien, bukan
// mengubah response.
type ServicePoint = { name: string; branch: string; revenue: string; revenueValue: number; count: number; progress: number };
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
type DatePreset = "today" | "yesterday" | "week" | "month" | "lastMonth" | "custom" | "manualMonth";

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
  { label: "Dasbor", display: "Dashboard AYO", icon: LayoutDashboard, module: "dasbor" },
  { label: "Transaksi", display: "Transaksi AYO", icon: Activity, module: "transaksi" },
  {
    label: "Olsera",
    display: "Olsera",
    icon: Store,
    module: "olsera",
    subItems: [
      { label: "Kategori Penjualan", nav: "Olsera" },
      { label: "Inventori", nav: "OlseraInventori" },
      { label: "Laporan Keuangan", nav: "OlseraKeuangan" },
    ],
  },
  { label: "Webhook", display: "Webhook", icon: Webhook, module: "webhook" },
  { label: "Rekonsiliasi", display: "Rekonsiliasi", icon: ShieldCheck, module: "rekonsiliasi" },
];

type SessionUserInfo = {
  id: string;
  email: string;
  name: string;
  role: "supervisor" | "user";
  allowedModules: string[];
};

const THEME_STORAGE_KEY = "ayo-theme";
const MODE_STORAGE_KEY = "ayo-mode";
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

function statusVariant(status: string): "success" | "warning" | "danger" {
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

  if (value === "week") {
    // Minggu berjalan (Asia/Jakarta): Senin s/d hari ini.
    const dayOfWeek = new Date(`${currentDate}T00:00:00Z`).getUTCDay();
    const offsetFromMonday = (dayOfWeek + 6) % 7;
    return { startDate: addDaysISO(currentDate, -offsetFromMonday), endDate: currentDate };
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
  if (preset === "week") return `Minggu ini (${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)})`;
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

/** "Rp277.457.500" → 277457500. /api/dashboard mengembalikan revenueMonth
 *  sudah diformat (toIdrFull, sama seperti formatRupiah di atas — tanpa
 *  desimal), jadi strip-non-digit selalu lossless untuk membalikkannya. */
function parseRupiahToNumber(formatted: string | undefined | null) {
  if (!formatted) return 0;
  const digits = formatted.replace(/[^0-9]/g, "");
  return digits ? Number(digits) : 0;
}

const MONTH_SHORT_LABELS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const MONTH_FULL_LABELS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

// Enam lapangan Ayosera untuk kartu Performa Lapangan — presentasi saja,
// TIDAK mengubah nama field_name di database/API. Deteksi Pickleball & nomor
// lapangan mengikuti pola canonical yang sama dengan lib/omzet-export.ts
// (PICKLE_CANONICAL_1/2, pickleCourtNumber) supaya konsisten dengan export.
const COURT_DISPLAY_ORDER = ["Court No 1", "Court No 2", "Court No 3", "Court No 4", "Pickleball 1", "Pickleball 2"];

function normalizeCourtName(rawName: string): string | null {
  if (/pickle/i.test(rawName)) {
    const isTwo = /(?:no\.?|court|pickleball)\s*2\b/i.test(rawName);
    return isTwo ? "Pickleball 2" : "Pickleball 1";
  }
  const match = rawName.match(/(\d+)/);
  if (match) {
    const num = Number(match[1]);
    if (num >= 1 && num <= 4) return `Court No ${num}`;
  }
  return null;
}

const datePresetButtons: { label: string; value: DatePreset }[] = [
  { label: "Hari ini", value: "today" },
  { label: "Kemarin", value: "yesterday" },
  { label: "Bulan ini", value: "month" },
  { label: "Bulan lalu", value: "lastMonth" },
];

// Filter ringkas khusus modul Transaksi Real-Time (Dashboard AYO):
// Hari & Minggu sebagai kapsul; Bulan & Rentang khusus ditangani DashboardOverview.
const dashboardPresetButtons: { label: string; value: DatePreset }[] = [
  { label: "Hari", value: "today" },
  { label: "Minggu", value: "week" },
];

/** Judul dinamis kartu Pendapatan sesuai filter aktif — nilainya tetap dari
 *  metrics.revenueMonth (total pendapatan filter existing). */
function getRevenueCardTitle(preset: DatePreset, startDate: string, endDate: string, filterMonth: string) {
  if (preset === "today") return "Pendapatan Hari Ini";
  if (preset === "yesterday") return "Pendapatan Kemarin";
  if (preset === "week") return "Pendapatan Minggu Ini";
  if (preset === "month") return "Pendapatan Bulan Ini";
  if (preset === "lastMonth") return "Pendapatan Bulan Lalu";
  if (preset === "manualMonth") return `Pendapatan ${formatMonthLabel(filterMonth)}`;
  if (startDate === endDate) return `Pendapatan ${formatDisplayDate(startDate)}`;
  return `Pendapatan ${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`;
}

// Sesi tidak valid (401): bersihkan cookie sesi yang basi lalu arahkan ke /login.
// Tanpa sign-out, cookie kedaluwarsa tetap tersisa dan bikin pengalaman membingungkan.
let redirectToLoginPromise: Promise<void> | null = null;

function redirectToLogin() {
  if (redirectToLoginPromise) return redirectToLoginPromise;
  redirectToLoginPromise = (async () => {
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      // abaikan — tetap arahkan ke login apa pun hasilnya
    } finally {
      window.location.href = "/login";
    }
  })();
  return redirectToLoginPromise;
}

// Tombol aksi utama (pink/merah) — dipakai Sync AYO dan tombol aksi Olsera.
const OLSERA_PRIMARY_BTN =
  "rounded-lg bg-rose-600 font-medium text-white shadow-sm transition-colors hover:bg-rose-700 active:bg-rose-800";

export default function DashboardPage() {
  const today = formatJakartaDate(new Date());
  const currentMonth = today.slice(0, 7);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [transactionRows, setTransactionRows] = useState<TransactionRow[]>([]);
  // Penanda "request paling baru" untuk loadData() — mencegah response yang
  // lebih lambat dari request LAMA menimpa state dengan data basi bila
  // datang belakangan daripada response request BARU (race condition).
  const loadRequestIdRef = useRef(0);
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
  // Light/Dark Mode — default "light" (sesuai atribut yang sudah di-set skrip
  // bootstrap blocking di app/layout.tsx sebelum hydration, jadi nilai awal
  // di sini tidak pernah menyebabkan mismatch: dibaca ulang di useEffect
  // setelah mount, sama seperti pola `theme` di atas).
  const [mode, setMode] = useState<"dark" | "light">("light");
  const [olseraNavOpen, setOlseraNavOpen] = useState(false);
  const [activeNav, setActiveNav] = useState("Dasbor");
  // Kartu "Pendapatan Bulanan" (Jan–Des) — tahun independen dari filter
  // Dashboard utama. Data & cache per tahun dikelola effect terkait di bawah;
  // earliestTransactionDate dipakai untuk membedakan bulan "Belum tersedia"
  // (sebelum cakupan data AYO) dari Rp0 sungguhan — diambil sekali saja
  // (undefined = belum pernah dicoba, null = gagal/kosong).
  const currentYear = currentMonth.slice(0, 4);
  const [annualRevenueYear, setAnnualRevenueYear] = useState(currentYear);
  const [annualRevenueData, setAnnualRevenueData] = useState<MonthlyRevenuePoint[]>([]);
  const [annualRevenueLoading, setAnnualRevenueLoading] = useState(false);
  const [earliestTransactionDate, setEarliestTransactionDate] = useState<string | null | undefined>(undefined);
  const annualRevenueCacheRef = useRef<Map<string, MonthlyRevenuePoint[]>>(new Map());
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
  // Tahap 6 — orkestrator "Sync Semua Olsera" (Kategori/Penjualan -> Inventori -> Laporan Keuangan, berurutan).
  const olseraSyncAllRunRef = useRef(false);
  const [olseraSyncAllRunning, setOlseraSyncAllRunning] = useState(false);
  const [olseraSyncAllMessage, setOlseraSyncAllMessage] = useState("");
  const [olseraSyncAllStages, setOlseraSyncAllStages] = useState<Record<StageId, StageStatus>>({
    kategori: "Menunggu",
    inventori: "Menunggu",
    keuangan: "Menunggu",
  });
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
  // Dropdown Export Olsera kini dirender lewat portal (OlseraExportMenu) —
  // penutupan klik-luar/Escape ditangani komponen tersebut.
  const [olseraExportMenuOpen, setOlseraExportMenuOpen] = useState(false);
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
    // Sinkronkan state React dengan atribut yang sudah di-set skrip bootstrap
    // (localStorage → default terang) tanpa menulis
    // ulang localStorage di sini — mencegah flash & hydration warning.
    const bootstrapped = document.documentElement.getAttribute("data-mode");
    if (bootstrapped === "light" || bootstrapped === "dark") setMode(bootstrapped);
    // Sidebar terbuka secara default di desktop, tertutup di mobile.
    setDrawerOpen(window.matchMedia("(min-width: 1024px)").matches);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

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

    // Guard race condition: tanpa ini, request lama (mis. rentang lebar
    // seperti "Bulan" yang query-nya lebih berat) bisa selesai SETELAH
    // request baru (mis. "Hari", query ringan) dan menimpa transactionRows
    // dengan data basi — persis gejala panel "Transaksi Terbaru" menampilkan
    // tanggal di luar filter aktif. requestId dibandingkan lagi setelah
    // Promise.all selesai; response yang bukan lagi "yang terbaru" dibuang.
    const requestId = ++loadRequestIdRef.current;

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

    // Sudah ada request lebih baru yang berjalan (mis. user pindah filter
    // lagi sebelum request ini selesai) — buang hasilnya, biarkan request
    // terbaru yang menentukan state.
    if (requestId !== loadRequestIdRef.current) return;

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
      if (requestId !== loadRequestIdRef.current) return;
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

  // `columnFilters` (termasuk `status` yang diisi "Pending" oleh card "Belum
  // Bayar" atau dropdown filter kolom Transaksi) dan `page` adalah state
  // khusus tabel Transaksi — tapi disimpan di komponen ini dan dipakai
  // bersama oleh `transactionRows`, yang juga menjadi sumber widget Dashboard
  // (Transaksi Terbaru, Status Transaksi Terbaru, pendingCount). Tanpa reset,
  // filter itu "bocor": kembali ke Dasbor tetap membawa transactionRows hasil
  // fetch ber-filter Pending, membuat kedua widget itu tampak kosong. Reset
  // HANYA saat benar-benar keluar dari tab Transaksi, dan HANYA state
  // filter/pagination tabel — datePreset/startDate/endDate (filter
  // Hari/Minggu/Bulan/Rentang khusus Dashboard) sengaja tidak disentuh.
  const previousNavRef = useRef(activeNav);
  useEffect(() => {
    if (previousNavRef.current === "Transaksi" && activeNav !== "Transaksi") {
      setColumnFilters(emptyColumnFilters);
      setPage(1);
    }
    previousNavRef.current = activeNav;
  }, [activeNav]);

  useEffect(() => {
    // Debounce 350ms: mencegah request bertubi-tubi saat mengetik pencarian.
    const timeout = window.setTimeout(() => {
      loadData().catch(() => undefined);
    }, 350);

    return () => window.clearTimeout(timeout);
    // columnFilters & sort adalah objek — perubahannya (referensi baru) memicu fetch ulang.
  }, [searchTerm, statusFilter, courtFilter, startDate, endDate, page, limit, sort, columnFilters]);

  // Tanggal booking AYO paling awal yang benar-benar tersedia — dipakai
  // kartu "Pendapatan Bulanan" untuk membedakan bulan "Belum tersedia"
  // (sebelum cakupan data) dari Rp0 sungguhan. Endpoint transaksi existing,
  // limit=1 (bukan untuk menghitung total, hanya baris paling awal) —
  // diambil SEKALI per sesi (guard `earliestTransactionDate !== undefined`),
  // dicache di state sehingga pindah tahun tidak mengulang request ini.
  useEffect(() => {
    if (activeNav !== "Dasbor") return;
    if (earliestTransactionDate !== undefined) return;
    const controller = new AbortController();
    let cancelled = false;
    const params = new URLSearchParams({ page: "1", limit: "1", sort: "date", dir: "asc", _t: String(Date.now()) });
    fetch(`/api/transactions?${params.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          await redirectToLogin();
          return;
        }
        const payload = response.ok
          ? ((await response.json().catch(() => null)) as { data?: TransactionRow[] } | null)
          : null;
        if (cancelled) return;
        setEarliestTransactionDate(payload?.data?.[0]?.date ?? null);
      })
      .catch((error) => {
        if (!cancelled && (error as Error)?.name !== "AbortError") setEarliestTransactionDate(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeNav, earliestTransactionDate]);

  // Kartu "Pendapatan Bulanan": SATU request /api/dashboard per bulan yang
  // relevan (bukan per tanggal, bukan /api/transactions yang kena limit
  // pagination — /api/dashboard menghitung total dari query Mongo TANPA
  // limit, sama persis dengan formula KPI, sehingga nilainya PASTI cocok
  // dengan KPI saat Dashboard difilter ke bulan yang sama). Bulan sebelum
  // earliestTransactionDate & sesudah bulan berjalan dilewati (tanpa fetch)
  // dan langsung ditandai "unavailable"/"future". Hasil 12 bulan di-cache
  // per tahun (annualRevenueCacheRef) — pindah ke tahun yang sudah pernah
  // dimuat tidak melakukan fetch ulang. Tidak ada polling/interval.
  useEffect(() => {
    if (activeNav !== "Dasbor") return;
    if (earliestTransactionDate === undefined) return;

    const cached = annualRevenueCacheRef.current.get(annualRevenueYear);
    if (cached) {
      setAnnualRevenueData(cached);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setAnnualRevenueLoading(true);

    const earliestMonth = earliestTransactionDate ? earliestTransactionDate.slice(0, 7) : null;
    const earliestDay = earliestTransactionDate ? earliestTransactionDate.slice(8, 10) : null;

    async function run() {
      const points: MonthlyRevenuePoint[] = [];
      for (let index = 0; index < 12; index++) {
        const monthValue = `${annualRevenueYear}-${String(index + 1).padStart(2, "0")}`;
        const label = MONTH_SHORT_LABELS[index];
        const fullLabel = `${MONTH_FULL_LABELS[index]} ${annualRevenueYear}`;

        if (monthValue > currentMonth) {
          points.push({ monthIndex: index, label, fullLabel, amount: null, transactionCount: null, status: "future" });
          continue;
        }
        if (earliestMonth && monthValue < earliestMonth) {
          points.push({ monthIndex: index, label, fullLabel, amount: null, transactionCount: null, status: "unavailable" });
          continue;
        }

        const range = monthRangeFromValue(monthValue);
        const fetchRange = monthValue === currentMonth ? { startDate: range.startDate, endDate: today } : range;
        const params = new URLSearchParams({
          start_date: fetchRange.startDate,
          end_date: fetchRange.endDate,
          _t: String(Date.now()),
        });

        try {
          const response = await fetch(`/api/dashboard?${params.toString()}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (response.status === 401) {
            await redirectToLogin();
            return;
          }
          const payload = response.ok
            ? ((await response.json().catch(() => null)) as {
                metrics?: { revenueMonth?: string; totalTransactions?: number };
              } | null)
            : null;
          if (cancelled) return;

          let status: MonthlyRevenueStatus = "complete";
          if (monthValue === currentMonth) status = "running";
          else if (earliestMonth === monthValue && earliestDay && earliestDay !== "01") status = "partial";

          points.push({
            monthIndex: index,
            label,
            fullLabel,
            amount: parseRupiahToNumber(payload?.metrics?.revenueMonth),
            transactionCount: payload?.metrics?.totalTransactions ?? 0,
            status,
          });
        } catch (error) {
          if ((error as Error)?.name === "AbortError") return;
          points.push({ monthIndex: index, label, fullLabel, amount: null, transactionCount: null, status: "unavailable" });
        }
      }
      if (cancelled) return;
      annualRevenueCacheRef.current.set(annualRevenueYear, points);
      setAnnualRevenueData(points);
    }

    run()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAnnualRevenueLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeNav, annualRevenueYear, currentMonth, today, earliestTransactionDate]);

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
  // Inti loop sync Kategori/Penjualan, TANPA guard lock/ref — dipakai baik
  // oleh tombol "Sync Olsera" (handleOlseraSync, yang menambahkan lock+ref)
  // maupun oleh orkestrator "Sync Semua Olsera" (yang sudah memegang lock
  // sendiri sebelum memanggil tahap ini, sehingga tidak boleh mengunci lagi).
  async function runKategoriPenjualanCore(): Promise<{ ok: boolean; message: string }> {
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
            return { ok: false, message: "Sesi berakhir — silakan login kembali." };
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
      const finalMessage = failedDates.length
        ? `Sync sebagian selesai: ${matched + updated} tanggal cocok, ${failedDates.length} tanggal gagal (${failedDates
            .map(formatDisplayDate)
            .join(", ")}). Durasi ${durationSec} detik.${unresolvedNote}`
        : `Sync selesai: ${dates.length} tanggal diperiksa, ${updated} tanggal diperbarui, ${processedOrders} transaksi diproses. Durasi ${durationSec} detik.${unresolvedNote}`;
      setOlseraSyncMessage(finalMessage);
      return { ok: failedDates.length === 0, message: finalMessage };
    } finally {
      // Refresh tabel kategori, status sync, dan warning tanpa reload browser.
      setOlseraSyncRefresh((value) => value + 1);
    }
  }

  async function handleOlseraSync() {
    if (olseraSyncRunRef.current || !acquireOlseraSyncLock()) return;
    olseraSyncRunRef.current = true;
    setOlseraSyncing(true);
    try {
      await runKategoriPenjualanCore();
    } finally {
      olseraSyncRunRef.current = false;
      releaseOlseraSyncLock();
      setOlseraSyncing(false);
    }
  }

  // ==========================================================================
  // Tahap 6 — "Sync Semua Olsera": orkestrator berurutan
  // Kategori/Penjualan -> Inventori -> Laporan Keuangan.
  //
  // Ketiga fungsi runner di bawah memanggil ENDPOINT LAMA yang sama persis
  // dengan yang dipakai tombol per-modul (tidak ada jalur sync baru). Mereka
  // TIDAK mengambil/melepas lock sendiri — lock sudah dipegang orkestrator
  // (handleSyncAllOlsera) selama seluruh 3 tahap berjalan, sehingga tombol
  // per-modul individual tidak bisa berjalan bersamaan (lihat externallyLocked
  // di olsera-inventory-panel.tsx / olsera-financial-panel.tsx, dan
  // olseraSyncRunRef di atas untuk Kategori/Penjualan).
  // ==========================================================================

  async function runInventoriSyncStage(): Promise<{ ok: boolean; status: "success" | "partial" | "failed" | "connection-expired"; message: string }> {
    type SyncRun = {
      status?: string;
      phase?: string;
      totalProducts?: number;
      totalDays?: number;
      totalMovements?: number;
      failedDates?: string[];
      errorMessage?: string | null;
    };
    try {
      const startResponse = await fetch("/api/olsera/inventory/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      if (startResponse.status === 401) {
        await redirectToLogin();
        return { ok: false, status: "failed", message: "Sesi berakhir — silakan login kembali." };
      }
      const startPayload = (await startResponse.json().catch(() => null)) as { run?: SyncRun; error?: string } | null;
      if (!startResponse.ok || !startPayload?.run) {
        return { ok: false, status: "failed", message: startPayload?.error || "Gagal memulai sync inventori." };
      }

      let lastRun: SyncRun = startPayload.run;
      for (;;) {
        const stepResponse = await fetch("/api/olsera/inventory/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "step" }),
        });
        if (stepResponse.status === 401) {
          await redirectToLogin();
          return { ok: false, status: "failed", message: "Sesi berakhir — silakan login kembali." };
        }
        const stepPayload = (await stepResponse.json().catch(() => null)) as { done?: boolean; run?: SyncRun; error?: string } | null;
        if (!stepResponse.ok || !stepPayload?.run) {
          return { ok: false, status: "failed", message: stepPayload?.error || "Sync inventori terputus — klik Sync Inventori untuk melanjutkan dari checkpoint." };
        }
        lastRun = stepPayload.run;
        if (stepPayload.done) break;
      }

      if (lastRun.status === "success") {
        return {
          ok: true,
          status: "success",
          message: `Inventori: ${lastRun.totalProducts ?? 0} produk, ${lastRun.totalDays ?? 0} hari diperiksa, ${lastRun.totalMovements ?? 0} mutasi diproses.`,
        };
      }
      if (lastRun.status === "partial") {
        return {
          ok: false,
          status: "partial",
          message: `Sync inventori sebagian selesai: ${lastRun.failedDates?.length ?? 0} tanggal gagal.`,
        };
      }
      return { ok: false, status: "failed", message: lastRun.errorMessage || "Sync inventori gagal." };
    } catch {
      return { ok: false, status: "failed", message: "Tidak dapat terhubung ke server saat sync inventori." };
    } finally {
      // Panel Inventori (bila sedang mounted di tab lain) akan menampilkan
      // data terbaru saat dibuka kembali — tidak perlu memaksa refresh di sini.
    }
  }

  async function runKeuanganSyncStage(): Promise<{ ok: boolean; status: "success" | "partial" | "failed" | "connection-expired"; message: string }> {
    type StepPayload = { status?: string; message?: string; phase?: string; accountsProcessed?: number; recordsProcessed?: number };
    try {
      const [year, month] = today.slice(0, 7).split("-");
      const startResponse = await fetch("/api/olsera/financial/sync/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: Number(year), month: Number(month) }),
      });
      if (startResponse.status === 401) {
        await redirectToLogin();
        return { ok: false, status: "failed", message: "Sesi berakhir — silakan login kembali." };
      }
      const startPayload = (await startResponse.json().catch(() => null)) as
        | { status?: string; message?: string; runId?: string; accounts?: number }
        | null;
      if (startPayload?.status === "connection-expired") {
        return { ok: false, status: "connection-expired", message: startPayload.message || "Koneksi Olsera kedaluwarsa." };
      }
      if (!startResponse.ok || !startPayload?.runId) {
        return { ok: false, status: "failed", message: startPayload?.message || "Gagal memulai sync laporan keuangan." };
      }
      const runId = startPayload.runId;

      let status = "running";
      for (;;) {
        const stepResponse = await fetch("/api/olsera/financial/sync/step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId }),
        });
        if (stepResponse.status === 401) {
          await redirectToLogin();
          return { ok: false, status: "failed", message: "Sesi berakhir — silakan login kembali." };
        }
        const stepPayload = (await stepResponse.json().catch(() => null)) as StepPayload | null;
        if (stepPayload?.status === "connection-expired") {
          return { ok: false, status: "connection-expired", message: stepPayload.message || "Koneksi Olsera kedaluwarsa." };
        }
        if (!stepResponse.ok || !stepPayload?.status) {
          return { ok: false, status: "failed", message: stepPayload?.message || "Sync laporan keuangan terputus — klik Sync lagi untuk melanjutkan." };
        }
        status = stepPayload.status;
        if (status !== "running") break;
      }

      if (status === "success") return { ok: true, status: "success", message: "Laporan keuangan selesai disinkronkan." };
      if (status === "partial") return { ok: false, status: "partial", message: "Sync laporan keuangan sebagian selesai — sebagian Buku Besar Detail gagal." };
      return { ok: false, status: "failed", message: "Sync laporan keuangan gagal." };
    } catch {
      return { ok: false, status: "failed", message: "Tidak dapat terhubung ke server saat sync laporan keuangan." };
    }
  }

  async function handleSyncAllOlsera() {
    if (olseraSyncAllRunRef.current) return;
    olseraSyncAllRunRef.current = true;
    setOlseraSyncAllRunning(true);
    setOlseraSyncAllMessage("");
    setOlseraSyncAllStages({ kategori: "Menunggu", inventori: "Menunggu", keuangan: "Menunggu" });
    try {
      const result = await runOlseraSyncAll({
        acquireLock: acquireOlseraSyncLock,
        releaseLock: releaseOlseraSyncLock,
        runKategori: async () => {
          const core = await runKategoriPenjualanCore();
          return { ok: core.ok, status: core.ok ? "success" : "failed", message: core.message };
        },
        runInventori: runInventoriSyncStage,
        runKeuangan: runKeuanganSyncStage,
        onStageChange: (stage, status) => setOlseraSyncAllStages((prev) => ({ ...prev, [stage]: status })),
      });
      setOlseraSyncAllMessage(result.message);
      if (result.ok) {
        // Semua tahap berhasil — refresh data UI terkait (tabel/kategori Kategori-Penjualan;
        // panel Inventori/Keuangan membaca ulang snapshot MongoDB sendiri saat dibuka/mount).
        setOlseraSyncRefresh((value) => value + 1);
      }
    } finally {
      olseraSyncAllRunRef.current = false;
      setOlseraSyncAllRunning(false);
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
      ? navItems.filter((item) => item.label !== "Transaksi")
      : navItems.filter((item) => item.label !== "Transaksi" && sessionUser.allowedModules.includes(item.module))
    : [];
  // "Transaksi" sengaja disembunyikan dari sidebar (lihat visibleNavItems di
  // atas) tapi tetap harus dapat diakses lewat tombol "Lihat Semua" pada
  // Dashboard. Permission-nya dicek terpisah dari visibleNavItems supaya
  // menyembunyikan menu tidak ikut menghapusnya dari registry izin —
  // Supervisor selalu boleh, user biasa hanya bila modul "transaksi" dimiliki.
  const activeNavAllowed =
    activeNav === "Pengguna"
      ? isSupervisor
      : activeNav === "Transaksi"
        ? isSupervisor || Boolean(sessionUser?.allowedModules.includes("transaksi"))
        : Boolean(sessionUser) &&
          visibleNavItems.some(
            (item) =>
              item.label === activeNav ||
              ("subItems" in item && item.subItems?.some((sub) => sub.nav === activeNav)),
          );

  const metrics = dashboard?.metrics;
  // 18 item (bukan 12) supaya card "Transaksi Terbaru" & "Status Transaksi
  // Terbaru" mengisi tinggi card secara proporsional — masih data existing
  // (transactionRows sudah menampung sampai `limit`=50 per halaman), tidak
  // ada fetch/pagination baru.
  const recentRows = transactionRows.slice(0, 18);
  const pendingCount = transactionRows.filter((row) => row.status === "Pending").length;
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
  const paymentRows = dashboard?.paymentBreakdown ?? [];
  // Donut "Status Booking": reuse paymentBreakdown (Reservation/AYO Order/
  // Pending/Cancelled/Completed) yang sudah ada, tanpa fetch/endpoint baru.
  // "Pending" DIGABUNG ke Reservation: statusLabel() di file ini sendiri
  // (baris lain) sudah memetakan status "Pending" → "Belum Bayar" — identik
  // dengan makna Reservation ("Pemesanan belum dibayar"), jadi audit ini
  // memenuhi syarat penggabungan. `row.value` dari backend adalah RAW COUNT
  // booking (bukan persentase) dan kelima kategori saling eksklusif — jadi
  // penjumlahan di bawah ini sudah pasti angka eksak, tidak perlu rescaling/
  // pembulatan apa pun lagi di sini. Titik pembulatan HANYA ada satu di
  // seluruh alur: persentase tampilan (`safePercent`) di dalam
  // BookingStatusDonut, dihitung dari count eksak ini saat dirender.
  const totalBookings = metrics?.totalTransactions ?? 0;
  const reservationCount =
    (paymentRows.find((row) => row.name === "Reservation")?.value ?? 0) +
    (paymentRows.find((row) => row.name === "Pending")?.value ?? 0);
  const ayoOrderCount = paymentRows.find((row) => row.name === "AYO Order")?.value ?? 0;
  const cancelledCount = paymentRows.find((row) => row.name === "Cancelled")?.value ?? 0;
  const completedCount = paymentRows.find((row) => row.name === "Completed")?.value ?? 0;
  const bookingStatusItems: BookingStatusItem[] = [
    { key: "reservation", label: "Reservation", description: "Pemesanan belum dibayar", value: reservationCount, color: "#fda4af" },
    { key: "ayo-order", label: "AYO Order", description: "Pesanan yang sudah dibayar", value: ayoOrderCount, color: "#e11d48" },
    { key: "cancelled", label: "Cancelled", description: "Pesanan yang dibatalkan", value: cancelledCount, color: "#7f1d1d" },
    { key: "completed", label: "Selesai", description: "Pesanan yang sudah selesai", value: completedCount, color: "#10b981" },
  ];
  const eventRows = dashboard?.syncEvents ?? [];
  const courtOptions = dashboard?.branchOptions ?? [];
  const latestEvent = eventRows[0];
  const syncStatusLabel = latestEvent ? (latestEvent.tone.includes("teal") ? "OK" : "Gagal") : "-";
  const lastCheckpoint = latestEvent ? formatEventTime(latestEvent.time) : "-";

  // Kartu "Performa Lapangan": reuse dashboard.topServices existing (sudah
  // mengikuti filter Dashboard aktif, sudah revenue-eligible & tanpa
  // cancelled — lihat app/api/dashboard/route.ts). Dinormalisasi ke 6
  // lapangan Ayosera tetap (termasuk yang Rp0/0 pesanan) hanya untuk
  // presentasi — field_name asli di database/API tidak diubah.
  const courtRevenueByName = new Map<string, { revenueValue: number; count: number }>();
  for (const service of dashboard?.topServices ?? []) {
    const canonical = normalizeCourtName(service.name);
    if (!canonical) continue;
    const entry = courtRevenueByName.get(canonical) ?? { revenueValue: 0, count: 0 };
    entry.revenueValue += service.revenueValue ?? 0;
    entry.count += service.count ?? 0;
    courtRevenueByName.set(canonical, entry);
  }
  const courtMaxRevenue = Math.max(1, ...COURT_DISPLAY_ORDER.map((name) => courtRevenueByName.get(name)?.revenueValue ?? 0));
  const courtPerformance = COURT_DISPLAY_ORDER.map((name) => {
    const entry = courtRevenueByName.get(name) ?? { revenueValue: 0, count: 0 };
    return {
      key: name,
      label: name,
      revenueValue: entry.revenueValue,
      revenue: formatRupiah(entry.revenueValue),
      count: entry.count,
      progress: entry.revenueValue > 0 ? Math.max(4, Math.round((entry.revenueValue / courtMaxRevenue) * 100)) : 0,
    };
  }).sort((a, b) => b.revenueValue - a.revenueValue);
  const courtTotalRevenue = courtPerformance.reduce((sum, item) => sum + item.revenueValue, 0);
  const courtTotalOrders = courtPerformance.reduce((sum, item) => sum + item.count, 0);
  const courtTopCourt = courtPerformance[0];
  const courtTopLabel = courtTopCourt && courtTopCourt.revenueValue > 0 ? courtTopCourt.label : "-";
  const courtTopContributionPercent =
    courtTotalRevenue > 0 && courtTopCourt ? Math.round((courtTopCourt.revenueValue / courtTotalRevenue) * 100) : 0;

  // Kartu "Pendapatan Bulanan": ringkasan tertinggi/terendah/total/rata-rata
  // dari data yang sudah diagregasi di effect terkait (annualRevenueData) —
  // tidak ada perhitungan/fetch tambahan di sini. Bulan "future"/"unavailable"
  // (amount null) diabaikan; bulan "running"/"partial" tetap dihitung tapi
  // labelnya tetap tampil di kartu ringkasan (lihat statusSuffix di
  // annual-revenue-chart.tsx) supaya tidak dibandingkan tanpa keterangan.
  const annualRevenueValidPoints = annualRevenueData.filter(
    (point): point is MonthlyRevenuePoint & { amount: number } => point.amount !== null,
  );
  const annualRevenueHighestPoint = annualRevenueValidPoints.length
    ? annualRevenueValidPoints.reduce((max, point) => (point.amount > max.amount ? point : max))
    : null;
  const annualRevenueLowestPoint = annualRevenueValidPoints.length
    ? annualRevenueValidPoints.reduce((min, point) => (point.amount < min.amount ? point : min))
    : null;
  const annualRevenueHighest = annualRevenueHighestPoint
    ? { label: annualRevenueHighestPoint.fullLabel, amount: annualRevenueHighestPoint.amount, status: annualRevenueHighestPoint.status }
    : null;
  const annualRevenueLowest = annualRevenueLowestPoint
    ? { label: annualRevenueLowestPoint.fullLabel, amount: annualRevenueLowestPoint.amount, status: annualRevenueLowestPoint.status }
    : null;
  const annualRevenueTotal = annualRevenueValidPoints.reduce((sum, point) => sum + point.amount, 0);
  const annualRevenueAverage =
    annualRevenueValidPoints.length > 0 ? Math.round(annualRevenueTotal / annualRevenueValidPoints.length) : 0;
  const annualRevenueYearOptions = Array.from(
    { length: 4 },
    (_, index) => String(Number(currentYear) - 3 + index),
  );

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
          : activeNav === "OlseraKeuangan"
            ? "Laporan Keuangan Olsera"
            : activeNav === "Webhook"
              ? "Monitoring Webhook AYO"
              : activeNav === "Pengguna"
                ? "Manajemen Pengguna"
                : "Dashboard AYO";
  const headerDescription =
    activeNav === "OlseraInventori"
      ? "Monitoring stok, mutasi, harga modal, dan nilai persediaan Olsera."
      : activeNav === "OlseraKeuangan"
        ? "Neraca, Laba Rugi, Arus Kas, dan Buku Besar dari snapshot sinkronisasi Olsera."
        : activeNav === "Dasbor"
          ? "Pusat monitoring operasional dan transaksi AYO."
          : undefined;

  const sidebarItems = [
    ...visibleNavItems,
    ...(isSupervisor ? [{ label: "Pengguna", display: "Pengguna", icon: Users, module: "" }] : []),
  ];

  // Dropdown Sync AYO lama — handler & endpoint tidak berubah, hanya dipindah
  // ke variabel agar bisa disuntikkan sebagai slot `actions` di header baru.
  const ayoSyncControl =
    canSyncAyo && activeNav !== "Olsera" && activeNav !== "OlseraInventori" && activeNav !== "OlseraKeuangan" && activeNav !== "Pengguna" ? (
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
            if (nav === "Rekonsiliasi") { window.location.assign("/reconciliation"); return; }
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
          mode={mode}
          onToggleMode={() => setMode((current) => (current === "dark" ? "light" : "dark"))}
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
            <div>
            <DashboardOverview
              presets={dashboardPresetButtons}
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
                  title: getRevenueCardTitle(datePreset, startDate, endDate, filterMonth),
                  value: metrics?.revenueMonth ?? "Rp 0",
                  detail: getRevenueFilterDetail(datePreset, startDate, endDate),
                  icon: BadgeCheck,
                },
                {
                  title: "Belum Bayar",
                  value: String(pendingCount),
                  detail: "Booking yang belum dibayar pada filter aktif",
                  icon: AlertTriangle,
                  onClick: () => {
                    // Buka Transaksi (mekanisme "Lihat Semua" existing) dengan
                    // filter kolom "Status" existing diset ke Pending — tanpa
                    // endpoint/route baru, mengikuti aturan izin activeNavAllowed
                    // yang sudah menangani akses Supervisor & modul "transaksi".
                    setColumnFilter("status", "Pending");
                    setActiveNav("Transaksi");
                  },
                },
              ]}
              recentRows={recentRows.map((transaction) => ({
                date: transaction.date ?? "-",
                time: transaction.endTime ? `${transaction.time}–${transaction.endTime}` : transaction.time || "-",
                id: transaction.id,
                service: transaction.service,
                customer: transaction.customer,
                amount: transaction.amount,
                statusVariant: statusVariant(transaction.status),
                statusLabel: statusLabel(transaction.status),
                receivedDate: receivedDateLabel(transaction),
                receivedTime: receivedTimeLabel(transaction),
                receivedAtMs: receivedAtMs(transaction),
              }))}
              recentLoading={false}
              onViewAll={() => setActiveNav("Transaksi")}
              bookingStatusItems={bookingStatusItems}
              totalBookings={totalBookings}
              annualRevenueData={annualRevenueData}
              annualRevenueYear={annualRevenueYear}
              onAnnualRevenueYearChange={setAnnualRevenueYear}
              annualRevenueYearOptions={annualRevenueYearOptions}
              annualRevenueLoading={annualRevenueLoading}
              annualRevenueHighest={annualRevenueHighest}
              annualRevenueLowest={annualRevenueLowest}
              annualRevenueTotal={annualRevenueTotal}
              annualRevenueAverage={annualRevenueAverage}
              courtPerformance={courtPerformance}
              courtTopLabel={courtTopLabel}
              courtTotalOrders={courtTotalOrders}
              courtTopContributionPercent={courtTopContributionPercent}
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
            </div>
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
          <div className="min-h-[calc(100vh-8rem)]">
          {/* Tahap 6 — tombol utama "Sync Semua Olsera" (Kategori/Penjualan -> Inventori -> Laporan Keuangan, berurutan). Sync AYO TIDAK termasuk di sini. */}
          {canSyncOlsera && (
          <section className="rd-enter mb-4">
            <div className="rd-card relative rounded-2xl p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3.5">
                  <div className="rd-stat-icon rounded-xl p-2.5">
                    <RefreshCw className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-[15px] font-semibold tracking-tight text-slate-50">Sync Semua Olsera</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
                      Menjalankan Kategori/Penjualan → Inventori → Laporan Keuangan secara berurutan. Sync AYO terpisah, tidak termasuk.
                    </p>
                  </div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  className="rounded-lg bg-rose-600 font-medium text-white shadow-sm transition-colors hover:bg-rose-500 active:bg-rose-700"
                  onClick={handleSyncAllOlsera}
                  disabled={olseraSyncAllRunning || olseraSyncing}
                >
                  {olseraSyncAllRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {olseraSyncAllRunning ? "Menyinkronkan Semua Olsera..." : "Sync Semua Olsera"}
                </Button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-4">
                {(
                  [
                    ["kategori", "Kategori/Penjualan"],
                    ["inventori", "Inventori"],
                    ["keuangan", "Laporan Keuangan"],
                  ] as const
                ).map(([key, label]) => {
                  const stageStatus = olseraSyncAllStages[key];
                  const chipClass =
                    stageStatus === "Berhasil"
                      ? "rd-chip rd-chip-ok"
                      : stageStatus === "Gagal"
                        ? "rd-chip rd-chip-danger"
                        : stageStatus === "Sedang Sinkron"
                          ? "rd-chip"
                          : "rd-chip border-slate-600/40 bg-slate-600/10 text-slate-400";
                  return (
                    <div key={key} className="flex items-center gap-2 text-[13px] text-slate-300">
                      <span>{label}:</span>
                      <span className={chipClass}>
                        {stageStatus === "Sedang Sinkron" && <Loader2 className="h-3 w-3 animate-spin" />}
                        {stageStatus === "Berhasil" && <CheckCircle2 className="h-3 w-3" />}
                        {stageStatus === "Gagal" && <AlertTriangle className="h-3 w-3" />}
                        {stageStatus}
                      </span>
                    </div>
                  );
                })}
              </div>
              {olseraSyncAllMessage && (
                <p className="mt-3 text-sm text-slate-300" aria-live="polite">
                  {olseraSyncAllMessage}
                </p>
              )}
            </div>
          </section>
          )}

          {/* Kartu sinkronisasi Olsera untuk semua user bermodul "olsera". */}
          {canSyncOlsera && (
          <section className="rd-enter mb-4">
            <div className="rd-card relative rounded-2xl p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3.5">
                  <div className="rd-stat-icon rounded-xl p-2.5">
                    <RefreshCw className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-[15px] font-semibold tracking-tight text-slate-50">Sync Olsera</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
                      {olseraSyncStatus?.lastFullySyncedDate ? (
                        <>
                          Data tersinkron{" "}
                          <span className="font-medium text-slate-200">
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
                    </p>
                  </div>
                </div>
                {olseraSyncing ? (
                  <span className="rd-chip">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Running
                  </span>
                ) : olseraSyncStatus?.lastSync ? (
                  olseraSyncStatus.lastSync.status === "success" ? (
                    <span className="rd-chip rd-chip-ok">
                      <CheckCircle2 className="h-3 w-3" />
                      Success
                    </span>
                  ) : olseraSyncStatus.lastSync.status === "partial" ? (
                    <span className="rd-chip border-amber-400/40 bg-amber-400/10 text-amber-300">
                      <AlertTriangle className="h-3 w-3" />
                      Partial
                    </span>
                  ) : (
                    <span className="rd-chip rd-chip-danger">
                      <AlertTriangle className="h-3 w-3" />
                      Failed
                    </span>
                  )
                ) : (
                  <span className="rd-chip">Belum sync</span>
                )}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  className="rounded-lg bg-rose-600 font-medium text-white shadow-sm transition-colors hover:bg-rose-500 active:bg-rose-700"
                  onClick={handleOlseraSync}
                  disabled={olseraSyncing || olseraSyncAllRunning}
                >
                  {olseraSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {olseraSyncing ? "Menyinkronkan Olsera..." : "Sync Olsera"}
                </Button>
                <span className="text-xs text-slate-500">
                  Memeriksa dan memperbarui data bulan berjalan secara otomatis.
                </span>
              </div>
              {olseraSyncMessage && (
                <p className="mt-3 text-sm text-slate-300" aria-live="polite">
                  {olseraSyncMessage}
                </p>
              )}
            </div>
          </section>
          )}

          <section className="rd-enter mb-4" style={{ animationDelay: "90ms" }}>
            <div className="rd-card relative rounded-2xl p-5">
              <div className="flex items-start gap-3.5">
                <div className="rd-stat-icon rounded-xl p-2.5">
                  <FileSpreadsheet className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[15px] font-semibold tracking-tight text-slate-50">Laporan Penjualan</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
                    Pilih mode laporan, atur periodenya, lalu unduh export yang tersedia untuk mode tersebut.
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                {/* Segmented control mode laporan — bulan & rentang tidak pernah aktif bersamaan. */}
                <div
                  role="tablist"
                  aria-label="Mode laporan Olsera"
                  className="rd-capsule-group inline-flex items-center rounded-full p-1"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={olseraReportMode === "range"}
                    onClick={() => handleOlseraReportModeChange("range")}
                    className={`rd-capsule inline-flex items-center gap-1.5 ${
                      olseraReportMode === "range" ? "rd-capsule-active" : ""
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
                    className={`rd-capsule inline-flex items-center gap-1.5 ${
                      olseraReportMode === "monthly" ? "rd-capsule-active" : ""
                    }`}
                  >
                    <CalendarDays className="h-4 w-4" />
                    Bulanan
                  </button>
                </div>

                {olseraReportMode === "range" ? (
                  <>
                    <button
                      type="button"
                      onClick={handleOlseraYesterday}
                      className={`rd-capsule inline-flex items-center gap-1.5 ${
                        olseraStart === olseraYesterday && olseraEnd === olseraYesterday ? "rd-capsule-active" : ""
                      }`}
                    >
                      Kemarin
                    </button>
                    <div className="rd-field flex h-10 items-center gap-2 rounded-full px-3">
                      <CalendarRange className="h-4 w-4 shrink-0 text-slate-400" />
                      <Input
                        type="date"
                        aria-label="Tanggal mulai filter Olsera"
                        value={olseraRangeStart}
                        className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
                        onClick={(event) => event.currentTarget.showPicker?.()}
                        onChange={(event) => handleOlseraRangeChange(event.target.value, olseraRangeEnd)}
                      />
                      <span className="text-xs text-slate-500">s/d</span>
                      <Input
                        type="date"
                        aria-label="Tanggal selesai filter Olsera"
                        value={olseraRangeEnd}
                        className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
                        onClick={(event) => event.currentTarget.showPicker?.()}
                        onChange={(event) => handleOlseraRangeChange(olseraRangeStart, event.target.value)}
                      />
                    </div>
                  </>
                ) : (
                  <div className="rd-field flex h-10 items-center gap-2 rounded-full px-3">
                    <CalendarDays className="h-4 w-4 shrink-0 text-slate-400" />
                    <Input
                      type="month"
                      aria-label="Filter bulan tertentu (Olsera)"
                      value={olseraFilterMonth}
                      className="h-8 w-[150px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
                      onClick={(event) => event.currentTarget.showPicker?.()}
                      onChange={(event) => handleOlseraMonthFilter(event.target.value)}
                    />
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleOlseraResetFilters}
                  className="rd-capsule inline-flex items-center gap-1.5"
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </button>

                {/* Tombol Export tunggal + dropdown portal yang mengikuti mode aktif. */}
                <div className="ml-auto w-full sm:w-auto">
                  <OlseraExportMenu
                    open={olseraExportMenuOpen}
                    onOpenChange={setOlseraExportMenuOpen}
                    exporting={olseraAnyExporting}
                    disabled={olseraAnyExporting || isInvalidDateRange(olseraStart, olseraEnd)}
                    monthlyMode={olseraReportMode === "monthly"}
                    monthLabel={formatMonthLabel(olseraFilterMonth)}
                    onExportItems={handleOlseraItemExport}
                    onExportCategories={handleOlseraCategoryExport}
                    onExportOmsetKategori={handleOlseraOmsetKategoriExport}
                    onExportLabers={handleOlseraLabersExport}
                  />
                </div>
              </div>

              {olseraReportMode === "range" && isInvalidDateRange(olseraRangeStart, olseraRangeEnd) && (
                <p className="mt-3 text-sm text-rose-400">Tanggal selesai tidak boleh sebelum tanggal mulai.</p>
              )}
              {olseraExportMessages.length > 0 && (
                <p className="mt-3 text-sm text-slate-300">{olseraExportMessages.join(" · ")}</p>
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
              {false && olseraExportMessage && <span className="text-sm text-slate-400">{olseraExportMessage}</span>}
            </div>
          </section>

          <section className="rd-enter" style={{ animationDelay: "180ms" }}>
            <div className="rd-card relative rounded-2xl p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3.5">
                  <div className="rd-stat-icon rounded-xl p-2.5">
                    <Store className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-[15px] font-semibold tracking-tight text-slate-50">Penjualan per Kategori</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
                      Data hasil sync dari MongoDB — {getOlseraFilterDetail()}
                    </p>
                  </div>
                </div>
                {olseraRows.length > 0 && !olseraLoading && !olseraError && (
                  <div className="flex shrink-0 items-center gap-5 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5">
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Kategori</p>
                      <p className="mt-0.5 text-sm font-semibold tabular-nums tracking-tight text-slate-100">
                        {olseraRows.length}
                      </p>
                    </div>
                    <div className="h-8 w-px bg-white/10" />
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Total Penjualan</p>
                      <p className="mt-0.5 text-sm font-semibold tabular-nums tracking-tight text-slate-50">
                        {formatRupiah(olseraRows.reduce((sum, row) => sum + row.totalPenjualan, 0))}
                      </p>
                    </div>
                  </div>
                )}
              </div>
              <div className="mt-5">
                {(olseraSyncStatus?.unresolvedItemCount ?? 0) > 0 && (
                  <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-400/25 border-l-4 border-l-amber-400/70 bg-amber-400/10 px-3.5 py-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <p className="text-sm text-amber-200">
                      Ada {olseraSyncStatus!.unresolvedItemCount} item yang belum memiliki mapping kategori.
                    </p>
                  </div>
                )}
                {olseraSyncStatus?.lastFullySyncedDate && olseraEnd > olseraSyncStatus.lastFullySyncedDate && (
                  <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-400/25 border-l-4 border-l-amber-400/70 bg-amber-400/10 px-3.5 py-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <div>
                      <p className="text-sm font-semibold text-amber-200">Data belum lengkap</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-amber-200/80">
                        Data baru tersinkron sampai {formatDisplayDate(olseraSyncStatus.lastFullySyncedDate)}
                        {olseraSyncStatus.lastSync?.finishedAt &&
                          formatJakartaTime(olseraSyncStatus.lastSync.finishedAt) &&
                          ` pukul ${formatJakartaTime(olseraSyncStatus.lastSync.finishedAt)}`}
                        . Total hanya mencerminkan data yang sudah tersedia.
                      </p>
                      {olseraSyncStatus.lastSync &&
                        olseraSyncStatus.lastSync.status !== "success" &&
                        olseraSyncStatus.lastSync.errorMessage && (
                          <p className="mt-0.5 text-xs leading-relaxed text-amber-200/80">
                            {olseraSyncStatus.lastSync.errorMessage}
                          </p>
                        )}
                    </div>
                  </div>
                )}
                {olseraLoading ? (
                  <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Memuat data penjualan Olsera...
                  </div>
                ) : olseraError ? (
                  <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
                    {olseraError}
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-white/10">
                    <table className="rd-table w-full min-w-[400px] text-sm">
                      <thead>
                        <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                          <th className="h-11 px-4">Kategori</th>
                          <th className="h-11 px-4 text-right">Qty</th>
                          <th className="h-11 px-4 text-right">Total Penjualan</th>
                        </tr>
                      </thead>
                      <tbody>
                        {olseraRows.length ? (
                          olseraRows.map((row) => (
                            <tr key={row.kategori}>
                              <td className="px-4 py-3 font-medium text-slate-200">{row.kategori}</td>
                              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-400">
                                {row.qty ?? "-"}
                              </td>
                              <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums tracking-tight text-slate-100">
                                {formatRupiah(row.totalPenjualan)}
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={3} className="px-4 py-12 text-center">
                              <div className="mx-auto flex max-w-sm flex-col items-center gap-2.5">
                                <span className="rounded-xl bg-white/5 p-2.5 text-slate-500">
                                  <Search className="h-5 w-5" />
                                </span>
                                <p className="text-sm text-slate-400">
                                  Tidak ada data penjualan pada periode ini. Jalankan sinkronisasi terlebih dahulu.
                                </p>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                      {olseraRows.length > 0 && (
                        <tfoot>
                          <tr className="border-t-2 border-white/15 bg-white/[0.04]">
                            <td className="px-4 py-3.5 font-bold tracking-tight text-slate-50">Total</td>
                            <td className="whitespace-nowrap px-4 py-3.5 text-right font-bold tabular-nums text-slate-50">
                              {olseraRows.reduce((sum, row) => sum + (row.qty ?? 0), 0)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3.5 text-right font-bold tabular-nums tracking-tight text-slate-50">
                              {formatRupiah(olseraRows.reduce((sum, row) => sum + row.totalPenjualan, 0))}
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                )}
              </div>
            </div>
          </section>

          </div>
          )}

          {activeNavAllowed && activeNav === "OlseraInventori" && (
            <div className="min-h-[calc(100vh-8rem)]">
              <OlseraInventoryPanel isSupervisor={isSupervisor} />
            </div>
          )}

          {activeNavAllowed && activeNav === "OlseraKeuangan" && (
            <div className="min-h-[calc(100vh-8rem)]">
              <OlseraFinancialPanel />
            </div>
          )}

          {activeNavAllowed && activeNav === "Webhook" && (
          <div>
          <section className="grid gap-4 md:grid-cols-3">
            <MetricCard
              title="Status Route"
              value={webhookStatus === "active" ? "Aktif" : webhookStatus === "inactive" ? "Tidak Aktif" : "Memeriksa…"}
              detail="GET /api/webhooks/ayo"
              icon={Webhook}
              valueClassName={
                webhookStatus === "active"
                  ? "text-emerald-300"
                  : webhookStatus === "inactive"
                    ? "text-rose-300"
                    : "text-slate-300"
              }
            />
            <MetricCard
              title="Total Webhook Diterima"
              value={String(webhookData?.total ?? 0)}
              detail="Sejak awal pencatatan"
              icon={DatabaseZap}
              delay={90}
            />
            <MetricCard
              title="Webhook Terakhir"
              value={formatWebhookTime(webhookData?.lastReceivedAt)}
              detail="Waktu Asia/Jakarta"
              icon={Clock}
              delay={180}
            />
          </section>

          <section className="mt-4">
            <div className="rd-card rd-enter relative rounded-2xl p-5" style={{ animationDelay: "270ms" }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[15px] font-semibold tracking-tight text-slate-50">Log Webhook Terbaru</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
                    20 payload terakhir yang diterima dari AYO
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0 border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 hover:text-white"
                  onClick={() => setWebhookRefresh((value) => value + 1)}
                  disabled={webhookLoading}
                  aria-label="Muat ulang log webhook"
                >
                  <RefreshCw className={`h-4 w-4 ${webhookLoading ? "animate-spin" : ""}`} />
                </Button>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="rd-table w-full min-w-[900px] text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
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
                          <tr key={`${log.receivedAt}-${index}`} className="align-top">
                            <td className="whitespace-nowrap px-2 py-2 text-slate-300">
                              {formatWebhookTime(log.receivedAt)}
                            </td>
                            <td className="px-2 py-2">
                              <span
                                className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ${style.className}`}
                              >
                                {style.label}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-slate-300">{log.itemCount}</td>
                            <td className="max-w-[280px] break-words px-2 py-2 text-slate-300" title={idText}>
                              {idText || "—"}
                            </td>
                            <td className="max-w-[260px] break-words px-2 py-2 text-slate-400" title={log.message}>
                              {log.message || "—"}
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={5} className="h-[200px] text-center text-sm text-slate-400">
                          {webhookLoading ? "Memuat…" : "Belum ada webhook yang diterima"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
          </div>
          )}
        </div>
    </AyoseraShell>
  );
}

// Kartu ringkasan dark halaman Webhook — data & sumber nilai tidak berubah,
// hanya gaya. `valueClassName` opsional untuk memberi warna status pada nilai
// utama (hijau aktif / merah bermasalah); default netral terang.
function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
  valueClassName = "text-slate-50",
  delay = 0,
}: {
  title: string;
  value: string;
  detail: string;
  icon: ElementType;
  valueClassName?: string;
  delay?: number;
}) {
  return (
    <div className="rd-card rd-enter relative rounded-2xl" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center justify-between gap-4 p-5">
        <div className="min-w-0">
          <p className="text-sm text-slate-400">{title}</p>
          <p className={`mt-2 truncate text-2xl font-semibold tracking-tight ${valueClassName}`}>{value}</p>
          <p className="mt-1 text-xs text-slate-500">{detail}</p>
        </div>
        <div className="rd-stat-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
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
  if (status === "received")
    return { label: "Diterima", className: "border border-emerald-400/30 bg-emerald-400/10 text-emerald-300" };
  if (status === "invalid")
    return { label: "JSON Invalid", className: "border border-amber-400/30 bg-amber-400/10 text-amber-300" };
  return { label: "Error", className: "border border-rose-400/30 bg-rose-400/10 text-rose-300" };
}

function formatEventTime(value: string) {
  if (!value.includes("T")) return value;
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * Resolusi timestamp "diterima sistem" mentah (Date) untuk satu transaksi —
 * dipakai bersama oleh receivedTimeLabel/receivedDateLabel/receivedAtMs di
 * bawah supaya ketiganya selalu merujuk field yang SAMA untuk baris yang sama.
 * TransactionRow tidak punya field receivedAt/webhookReceivedAt terpisah (itu
 * hanya ada di log webhook), jadi prioritasnya: createdAt (booking.created_at
 * dari AYO, sudah lengkap tanggal+jam) → syncedAt (jam dokumen terakhir
 * ditulis ke DB kami) → null bila keduanya kosong/tidak valid. Tidak pernah
 * jatuh ke waktu render (Date.now()).
 */
function resolveReceivedAt(transaction: Pick<TransactionRow, "createdAt" | "syncedAt">): Date | null {
  for (const candidate of [transaction.createdAt, transaction.syncedAt]) {
    if (!candidate || candidate === "-") continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** Jam "diterima sistem" (HH:mm, Asia/Jakarta) — dipakai pada widget "Status Transaksi Terbaru". */
function receivedTimeLabel(transaction: Pick<TransactionRow, "createdAt" | "syncedAt">) {
  const date = resolveReceivedAt(transaction);
  if (!date) return "-";
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" }).format(date);
}

/**
 * Tanggal compact "diterima sistem" (mis. "18 Jul", Asia/Jakarta) — dipakai
 * berdampingan dengan receivedTimeLabel supaya urutan terbaru→terlama pada
 * "Status Transaksi Terbaru" tetap terlihat masuk akal walau data merentang
 * lebih dari satu hari (mis. filter Minggu/Bulan ini).
 */
function receivedDateLabel(transaction: Pick<TransactionRow, "createdAt" | "syncedAt">) {
  const date = resolveReceivedAt(transaction);
  if (!date) return "-";
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short" }).format(date);
}

/**
 * Nilai timestamp mentah (ms epoch) untuk SORTING "Status Transaksi Terbaru" —
 * bukan string jam/tanggal yang sudah diformat (string itu tidak valid untuk
 * sorting kronologis). Prioritas sama persis dengan resolveReceivedAt di
 * atas. Pemanggil menempatkan hasil null di posisi paling bawah, bukan
 * memakai waktu render sebagai pengganti.
 */
function receivedAtMs(transaction: Pick<TransactionRow, "createdAt" | "syncedAt">): number | null {
  return resolveReceivedAt(transaction)?.getTime() ?? null;
}
