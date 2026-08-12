"use client";

// Panel "Laporan Keuangan" Olsera — Tahap 4B. Baca-saja dari snapshot MongoDB
// (app/api/olsera/financial/snapshot*), TIDAK PERNAH mengakses Olsera live
// dari client. Tema visual dark graphite/rose mengikuti Kategori Penjualan
// & Inventori Olsera (kelas rd-* di globals.css) — lihat komponen
// components/olsera-inventory-panel.tsx sebagai referensi pola yang dipakai.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  FileSpreadsheet,
  FileText,
  Landmark,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  Wallet,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { acquireOlseraSyncLock, releaseOlseraSyncLock, subscribeOlseraSyncLock } from "@/lib/olsera-sync-lock";
import { isCurrentJakartaPeriod, jakartaCurrentPeriod as sharedJakartaCurrentPeriod } from "@/lib/olsera-financial-core";
import {
  describeFinancialResponse,
  parseLedgerResponse,
  parseSnapshotResponse,
  type FinancialResponseInput,
} from "@/lib/olsera-financial-response";
import {
  clampFinancialPeriod,
  readPeriodFromSearch,
  resolveInitialPeriod,
  shouldApplyPeriodResponse,
  writePeriodToSearch,
} from "@/lib/olsera-financial-period-state";
import { financialSourceWarningText, visibleFinancialSourceDiagnostics } from "@/lib/olsera-financial-diagnostics-ui";

const TITLE = "text-[16px] font-semibold tracking-tight text-slate-50";
const DESC = "mt-1 text-[13.5px] leading-relaxed text-slate-400";
const ICON_CHIP = "rd-stat-icon rounded-xl p-2.5";
const FIELD = "rd-field flex h-10 items-center gap-2 rounded-full px-3";
const PRIMARY_BTN =
  "rounded-lg bg-rose-600 font-medium text-white shadow-sm transition-colors hover:bg-rose-500 active:bg-rose-700";
const TH = "h-11 px-3 text-left text-[12px] font-semibold uppercase tracking-wider text-slate-400";
const PAGE_BTN = "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 hover:text-white";

/** Periode paling awal yang tersedia (baseline data Olsera) — sama dengan validatePeriod di server. */
const MIN_PERIOD = "2026-02";

function formatRupiah(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    value,
  );
}

function formatPeriodLabel(period: string) {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 1)));
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
    hour12: false,
  })
    .format(date)
    .replace(/\./g, ":");
}

function jakartaCurrentPeriod() {
  return sharedJakartaCurrentPeriod();
}

function clampPeriod(period: string) {
  return clampFinancialPeriod(period, MIN_PERIOD, jakartaCurrentPeriod());
}

async function redirectToLogin() {
  try {
    await fetch("/api/auth/sign-out", { method: "POST" });
  } catch {
    // tetap arahkan ke login
  }
  window.location.href = "/login";
}

/** Baca body sebagai teks (bukan langsung .json()) supaya parser bisa membedakan JSON rusak dari shape salah. */
async function readResponse(response: Response): Promise<FinancialResponseInput> {
  const bodyText = await response.text().catch(() => "");
  return { httpStatus: response.status, contentType: response.headers.get("content-type"), bodyText };
}

type NormalizedNode = { name: string | null; accountCode: string | null; amount: number; formattedAmount: string | null; children: NormalizedNode[]; subtotalMatches?: boolean; subtotalDiagnostic?: string | null };
type NormalizedSection = { amount: number; formattedAmount: string | null; children: NormalizedNode[]; subtotalMatches?: boolean; subtotalDiagnostic?: string | null };

type BalanceSheetPayload = {
  assets: NormalizedSection;
  liabilityCapital: NormalizedSection;
  totals: { totalAssets: number; totalLiabilityCapital: number; balanced: boolean; difference: number };
};

type ProfitLossPayload = {
  totals: {
    revenue: number;
    costOfGoodsSold: number;
    grossProfit: number;
    operatingExpenses: number;
    nonOperatingIncome: number;
    nonOperatingExpenses: number;
    netProfit: number;
    grossProfitValid: boolean;
    netProfitValid: boolean;
  };
};

type CashFlowPayload = {
  totals: {
    operational: number;
    investing: number;
    funding: number;
    cashIncrease: number;
    openingCash: number;
    endingCash: number;
    activityTotalValid: boolean;
    endingCashValid: boolean;
  };
};

type LedgerSummaryRow = {
  accountId: string | number | null;
  accountCode: string | null;
  accountName: string | null;
  classification: string | null;
  debit: number;
  credit: number;
  balance: number;
};

type SyncLogInfo = {
  runId: string;
  status: "running" | "success" | "partial" | "failed";
  phase: "monthly-reports" | "ledger-details" | "reconcile" | "completed";
  accountsProcessed: number;
  accountsTotal: number;
  recordsProcessed: number;
  errorMessage: string | null;
  failedAccountCodes?: string[];
  recoveredAccountCodes?: string[];
  accountAttempts?: Array<{ code: string; attempts: number }>;
  completedAt: string | null;
} | null;

type AccountRow = { accountCode: string | null; accountName: string | null; classification: string | null };

type SnapshotResponse = {
  status: string;
  message?: string;
  period: string;
  latestSyncedPeriod: string | null;
  hasData: boolean;
  syncLog: SyncLogInfo;
  reports: {
    balanceSheet: BalanceSheetPayload | null;
    profitLoss: ProfitLossPayload | null;
    cashFlow: CashFlowPayload | null;
    ledgerSummary: LedgerSummaryRow[] | null;
  };
  accounts: AccountRow[];
  periodStatus?: { code: string; label: string };
  summaryDiagnostics?: Array<{ accountCode: string; accountName: string | null; status: string; summaryDebit: number; summaryCredit: number; detailDebit: number; detailCredit: number }>;
};

type LedgerEntryRow = {
  transactionDate: string | null;
  formattedTransactionDate: string | null;
  transactionNo: string | null;
  description: string | null;
  debit: number;
  credit: number;
  balance: number | null;
  isOpeningBalance: boolean;
};

type LedgerResponse = {
  status: string;
  message?: string;
  period: string;
  accountCode: string;
  accountName: string | null;
  data: LedgerEntryRow[];
  total: number;
  totalPages: number;
  totals: { debit: number; credit: number; movement: number };
};

const TABS = [
  { key: "summary", label: "Ringkasan" },
  { key: "cashflow", label: "Arus Kas" },
  { key: "profitloss", label: "Laba Rugi" },
  { key: "balance", label: "Neraca" },
  { key: "ledger", label: "Buku Besar" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function SummaryLine({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/5 py-2.5 last:border-0">
      <dt className="text-[13.5px] text-slate-400">{label}</dt>
      <dd className={`tabular-nums ${emphasis ? "text-[15px] font-semibold text-slate-50" : "text-[13.5px] text-slate-200"}`}>{value}</dd>
    </div>
  );
}

function hasSubtotalMismatch(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSubtotalMismatch);
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.subtotalMatches === false || Object.values(row).some(hasSubtotalMismatch);
}

function Pagination({
  page,
  totalPages,
  total,
  unit,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  unit: string;
  onPage: (page: number) => void;
}) {
  const currentPage = Math.min(page, Math.max(1, totalPages));
  return (
    <div className="mt-4 flex flex-col items-center justify-between gap-3 border-t border-white/10 pt-4 text-sm sm:flex-row">
      <span className="text-slate-400">
        {total} {unit}
      </span>
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" className={PAGE_BTN} onClick={() => onPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1}>
          Sebelumnya
        </Button>
        <span className="text-slate-400">
          Halaman {currentPage} / {Math.max(1, totalPages)}
        </span>
        <Button
          type="button"
          variant="outline"
          className={PAGE_BTN}
          onClick={() => onPage(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage >= totalPages}
        >
          Berikutnya
        </Button>
      </div>
    </div>
  );
}

export function OlseraFinancialPanel() {
  // Satu sumber kebenaran period aktif = query string URL (?financialPeriod=YYYY-MM)
  // — bertahan lintas reload halaman MAUPUN remount komponen (app/page.tsx
  // melepas panel ini dari tree setiap pindah tab navigasi lalu me-mount
  // ulang saat kembali, yang sebelumnya mereset period ke default). Lihat
  // lib/olsera-financial-period-state.ts untuk detail akar bug.
  const [period, setPeriod] = useState(() =>
    resolveInitialPeriod({
      periodFromUrl: typeof window === "undefined" ? null : readPeriodFromSearch(window.location.search),
      currentPeriod: jakartaCurrentPeriod(),
      minPeriod: MIN_PERIOD,
    }),
  );
  // Cermin `period` yang selalu terbaru (dibaca di dalam callback fetch,
  // BUKAN lewat closure `period` yang bisa "beku" ke nilai lama) — dipakai
  // shouldApplyPeriodResponse untuk menolak response basi (lihat requirement
  // "response lama tidak boleh menimpa response bulan terbaru").
  const periodRef = useRef(period);
  useEffect(() => {
    periodRef.current = period;
  }, [period]);

  // Sinkronkan period aktif ke URL setiap berubah (reload mempertahankan
  // pilihan pengguna) — replaceState supaya tidak membanjiri histori browser.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const newSearch = writePeriodToSearch(window.location.search, period);
    if (newSearch === window.location.search.replace(/^\?/, "")) return;
    const url = `${window.location.pathname}?${newSearch}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", url);
  }, [period]);

  // Dukung tombol back/forward browser mengubah period (URL tetap sumber kebenaran).
  useEffect(() => {
    const onPopState = () => {
      const fromUrl = readPeriodFromSearch(window.location.search);
      if (fromUrl) setPeriod(clampPeriod(fromUrl));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);

  const [tab, setTab] = useState<TabKey>("summary");

  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncProgress, setSyncProgress] = useState<{ phase: string; accountsProcessed: number; accountsTotal: number; recordsProcessed: number } | null>(
    null,
  );
  const [connectionExpired, setConnectionExpired] = useState(false);
  const syncRunningRef = useRef(false);
  // "Sync Semua Olsera" (orkestrator di app/page.tsx) berbagi lock ini agar
  // tombol modul ini tidak bisa jalan bersamaan dengan sync modul lain.
  const [externallyLocked, setExternallyLocked] = useState(false);
  useEffect(() => subscribeOlseraSyncLock(setExternallyLocked), []);

  const [ledgerSearch, setLedgerSearch] = useState("");
  const [selectedAccountCode, setSelectedAccountCode] = useState<string | null>(null);
  const [ledgerData, setLedgerData] = useState<LedgerResponse | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerPage, setLedgerPage] = useState(1);

  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  // Snapshot MongoDB untuk periode aktif — satu-satunya sumber data laporan.
  // `requestedPeriod` dikunci dari closure saat request dikirim; setiap kali
  // response tiba, DIBANDINGKAN ke periodRef.current (period TERKINI, bukan
  // closure) lewat shouldApplyPeriodResponse — response utk period yang
  // sudah ditinggalkan pengguna TIDAK PERNAH diterapkan ke state, walau
  // datang belakangan (mencegah "response lama menimpa bulan terbaru").
  // TIDAK ADA LAGI sisi-efek yang diam-diam mengganti `period` — bila bulan
  // yang diminta belum ada datanya, itu ditampilkan lewat snapshot.hasData
  // (lihat render di bawah), bukan dengan mengganti period aktif.
  useEffect(() => {
    const requestedPeriod = period;
    let cancelled = false;
    setSnapshotLoading(true);
    setSnapshotError("");
    fetch(`/api/olsera/financial/snapshot?period=${requestedPeriod}&_t=${Date.now()}`, { cache: "no-store" })
      .then(readResponse)
      .then(async (input) => {
        if (cancelled || !shouldApplyPeriodResponse(requestedPeriod, periodRef.current)) return;
        const result = parseSnapshotResponse<SnapshotResponse>(input);
        if (result.kind === "unauthorized") {
          if (result.httpStatus === 401) {
            await redirectToLogin();
            return;
          }
          setSnapshotError(result.message);
          setSnapshot(null);
          return;
        }
        if (result.kind !== "success") {
          // Diagnostic aman: hanya status/content-type/panjang/nama key — tanpa nilai laporan.
          console.info("[financial-snapshot-ui]", result.kind, describeFinancialResponse(input));
          setSnapshotError(result.message);
          setSnapshot(null);
          return;
        }
        setSnapshot(result.payload);
      })
      .catch(() => {
        if (!cancelled && shouldApplyPeriodResponse(requestedPeriod, periodRef.current)) setSnapshotError("Tidak dapat terhubung ke server.");
      })
      .finally(() => {
        if (!cancelled && shouldApplyPeriodResponse(requestedPeriod, periodRef.current)) setSnapshotLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, refreshTick]);

  const accounts = snapshot?.accounts ?? [];
  const filteredAccounts = useMemo(() => {
    const q = ledgerSearch.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((row) => (row.accountCode ?? "").toLowerCase().includes(q) || (row.accountName ?? "").toLowerCase().includes(q));
  }, [accounts, ledgerSearch]);

  // Buku Besar: baris per akun terpilih, untuk periode aktif. Sama seperti
  // efek snapshot — response utk period yang sudah ditinggalkan tidak pernah diterapkan.
  useEffect(() => {
    if (tab !== "ledger" || !selectedAccountCode) return;
    const requestedPeriod = period;
    let cancelled = false;
    setLedgerLoading(true);
    const params = new URLSearchParams({ period: requestedPeriod, accountCode: selectedAccountCode, page: String(ledgerPage), limit: "50", _t: String(Date.now()) });
    fetch(`/api/olsera/financial/snapshot/ledger?${params.toString()}`, { cache: "no-store" })
      .then(readResponse)
      .then(async (input) => {
        if (cancelled || !shouldApplyPeriodResponse(requestedPeriod, periodRef.current)) return;
        const result = parseLedgerResponse<LedgerResponse>(input);
        if (result.kind === "unauthorized" && result.httpStatus === 401) {
          await redirectToLogin();
          return;
        }
        if (result.kind !== "success") {
          console.info("[financial-ledger-ui]", result.kind, describeFinancialResponse(input));
          setLedgerData(null);
          return;
        }
        setLedgerData(result.payload);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled && shouldApplyPeriodResponse(requestedPeriod, periodRef.current)) setLedgerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, period, selectedAccountCode, ledgerPage, refreshTick]);

  useEffect(() => {
    setLedgerPage(1);
  }, [selectedAccountCode, period]);

  // Sync bertahap: start (atau lanjutkan run "running" yang sudah ada) → step
  // berulang sampai selesai → baca status kanonis → refresh snapshot periode aktif.
  const handleSync = useCallback(async () => {
    if (syncRunningRef.current || !acquireOlseraSyncLock()) return;
    syncRunningRef.current = true;
    setSyncing(true);
    setConnectionExpired(false);
    try {
      let runId: string;
      let accountsTotal: number;
      if (snapshot?.syncLog?.status === "running") {
        runId = snapshot.syncLog.runId;
        accountsTotal = snapshot.syncLog.accountsTotal;
        setSyncMessage("Melanjutkan sync yang belum selesai...");
      } else {
        setSyncMessage("Memulai sync laporan keuangan...");
        const [year, month] = period.split("-");
        const startResponse = await fetch("/api/olsera/financial/sync/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ year: Number(year), month: Number(month) }),
        });
        if (startResponse.status === 401) {
          await redirectToLogin();
          return;
        }
        const startPayload = (await startResponse.json().catch(() => null)) as
          | { status?: string; message?: string; runId?: string; accounts?: number }
          | null;
        if (startPayload?.status === "connection-expired") {
          setConnectionExpired(true);
          setSyncMessage(startPayload.message || "Koneksi Olsera kedaluwarsa.");
          return;
        }
        if (!startResponse.ok || !startPayload?.runId) {
          setSyncMessage(startPayload?.message || "Gagal memulai sync laporan keuangan.");
          return;
        }
        runId = startPayload.runId;
        accountsTotal = startPayload.accounts ?? 0;
      }
      setSyncProgress({ phase: "monthly-reports", accountsProcessed: 0, accountsTotal, recordsProcessed: 0 });

      let status = "running";
      for (;;) {
        const stepResponse = await fetch("/api/olsera/financial/sync/step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId }),
        });
        if (stepResponse.status === 401) {
          await redirectToLogin();
          return;
        }
        const stepPayload = (await stepResponse.json().catch(() => null)) as
          | { status?: string; message?: string; phase?: string; accountsProcessed?: number; recordsProcessed?: number }
          | null;
        if (stepPayload?.status === "connection-expired") {
          setConnectionExpired(true);
          setSyncMessage(stepPayload.message || "Koneksi Olsera kedaluwarsa.");
          return;
        }
        if (!stepResponse.ok || !stepPayload?.status) {
          setSyncMessage(stepPayload?.message || "Sync terputus — klik Sync lagi untuk melanjutkan.");
          return;
        }
        status = stepPayload.status;
        setSyncProgress({
          phase: stepPayload.phase ?? "ledger-details",
          accountsProcessed: stepPayload.accountsProcessed ?? 0,
          accountsTotal,
          recordsProcessed: stepPayload.recordsProcessed ?? 0,
        });
        if (status !== "running") break;
      }

      // Baca status kanonis (sync/status) sebagai konfirmasi akhir.
      const statusResponse = await fetch(`/api/olsera/financial/sync/status?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
      if (statusResponse.status === 401) {
        await redirectToLogin();
        return;
      }
      const statusPayload = (await statusResponse.json().catch(() => null)) as { message?: string } | null;

      if (status === "success") {
        setSyncMessage(`Sync selesai — ${accountsTotal} akun diproses.`);
      } else if (status === "partial") {
        setSyncMessage("Sync sebagian selesai — sebagian Buku Besar Detail gagal. Klik Sync lagi untuk mengulang.");
      } else {
        setSyncMessage(statusPayload?.message || "Sync laporan keuangan gagal.");
      }
    } catch {
      setSyncMessage("Tidak dapat terhubung ke server — klik Sync lagi untuk melanjutkan.");
    } finally {
      syncRunningRef.current = false;
      releaseOlseraSyncLock();
      setSyncing(false);
      setRefreshTick((value) => value + 1);
    }
  }, [period, snapshot?.syncLog]);

  // Download export (Excel gabungan / PDF per laporan) — mengikuti periode aktif.
  // Selalu memakai snapshot MongoDB (endpoint export baca-only), tidak menyentuh
  // Olsera live. Respons error dikembalikan sebagai JSON aman oleh server.
  const DOWNLOAD_OPTIONS = useMemo(
    () =>
      [
        { key: "excel", label: "Excel Semua Laporan", desc: "5 sheet dalam satu berkas", icon: "excel" as const, url: `/api/olsera/financial/export/excel?period=${period}` },
        { key: "neraca", label: "PDF Neraca", desc: "Total Aset = Kewajiban dan Modal", icon: "pdf" as const, url: `/api/olsera/financial/export/pdf?period=${period}&report=neraca` },
        { key: "laba-rugi", label: "PDF Laba Rugi", desc: "Pendapatan hingga Laba Bersih", icon: "pdf" as const, url: `/api/olsera/financial/export/pdf?period=${period}&report=laba-rugi` },
        { key: "arus-kas", label: "PDF Arus Kas", desc: "Operasional, Investasi, Pendanaan", icon: "pdf" as const, url: `/api/olsera/financial/export/pdf?period=${period}&report=arus-kas` },
        { key: "ringkasan-buku-besar", label: "PDF Ringkasan Buku Besar", desc: "Debit/Kredit/Saldo per akun", icon: "pdf" as const, url: `/api/olsera/financial/export/pdf?period=${period}&report=ringkasan-buku-besar` },
        { key: "buku-besar-detail", label: "PDF Buku Besar Detail", desc: "Seluruh jurnal periode (multi-halaman)", icon: "pdf" as const, url: `/api/olsera/financial/export/pdf?period=${period}&report=buku-besar-detail` },
      ] as const,
    [period],
  );

  // "Download Akun Ini" — Buku Besar Detail SATU akun (buku besar per akun),
  // memakai endpoint export yang sama dengan `accountCode` tambahan sehingga
  // server-side hanya mengambil transaksi akun terpilih (bukan hasil filter
  // client dari data yang sudah dipaginasi).
  const ACCOUNT_DOWNLOAD_OPTIONS = useMemo(
    () =>
      selectedAccountCode
        ? ([
            { key: "account-pdf", label: "PDF", url: `/api/olsera/financial/export/pdf?period=${period}&report=buku-besar-detail&accountCode=${selectedAccountCode}` },
            { key: "account-excel", label: "Excel", url: `/api/olsera/financial/export/excel?period=${period}&accountCode=${selectedAccountCode}` },
          ] as const)
        : [],
    [period, selectedAccountCode],
  );

  const handleDownload = useCallback(async (option: { key: string; url: string }) => {
    setDownloadMenuOpen(false);
    setAccountMenuOpen(false);
    setDownloadError("");
    setDownloading(option.key);
    try {
      const response = await fetch(option.url, { cache: "no-store" });
      if (response.status === 401) {
        await redirectToLogin();
        return;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || contentType.includes("application/json")) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        setDownloadError(payload?.message || "Gagal mengunduh laporan. Coba lagi.");
        return;
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      const match = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/);
      link.download = match?.[1] ?? `laporan-keuangan-${period}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch {
      setDownloadError("Tidak dapat terhubung ke server untuk mengunduh laporan.");
    } finally {
      setDownloading(null);
    }
  }, [period]);

  const isSyncRunningRemotely = snapshot?.syncLog?.status === "running";
  const bs = snapshot?.reports.balanceSheet ?? null;
  const pl = snapshot?.reports.profitLoss ?? null;
  const cf = snapshot?.reports.cashFlow ?? null;
  const summaryWarnings = visibleFinancialSourceDiagnostics(snapshot?.summaryDiagnostics ?? []);
  const subtotalWarning = hasSubtotalMismatch(bs) || hasSubtotalMismatch(pl) || hasSubtotalMismatch(cf);
  const isCurrentPeriod = isCurrentJakartaPeriod(period);

  return (
    <div>
      {/* Koneksi Olsera kedaluwarsa — tidak pernah redirect/logout, tidak menampilkan token/URI. */}
      {connectionExpired && (
        <section className="rd-enter mb-4">
          <div className="flex items-start gap-3 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
            <div>
              <p className="text-[14px] font-semibold text-amber-200">Koneksi Olsera kedaluwarsa</p>
              <p className="mt-1 text-[13px] text-amber-100/80">
                Sinkronisasi tidak dapat melanjutkan. Hubungi administrator untuk memperbarui kredensial Olsera. Data yang sudah tersinkron
                sebelumnya tetap dapat dilihat di bawah.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Sync Laporan Keuangan */}
      <section className="rd-enter mb-4">
        <div className="rd-card relative rounded-2xl p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3.5">
              <div className={ICON_CHIP}>
                <RefreshCw className="h-5 w-5" />
              </div>
              <div>
                <p className={TITLE}>
                  Sync Laporan Keuangan
                  {isCurrentJakartaPeriod(period) && (
                    <span className="ml-2 rd-chip border-amber-400/40 bg-amber-400/10 align-middle text-[11px] font-semibold text-amber-300">
                      Bulan Berjalan / Belum Final
                    </span>
                  )}
                </p>
                {snapshot?.periodStatus && <span className={`mt-1 inline-flex rd-chip ${snapshot.periodStatus.code === "final" ? "rd-chip-ok" : snapshot.periodStatus.code === "current" ? "border-amber-400/40 bg-amber-400/10 text-amber-300" : "border-sky-400/30 bg-sky-400/10 text-sky-200"}`}>{snapshot.periodStatus.label}</span>}
                <p className={DESC}>
                  Periode{" "}
                  <span className="font-medium text-slate-200">{formatPeriodLabel(period)}</span>
                  {snapshot?.syncLog?.completedAt && (
                    <>
                      {" · "}
                      terakhir sync {formatDateTime(snapshot.syncLog.completedAt)}
                    </>
                  )}
                </p>
                {isCurrentJakartaPeriod(period) && (
                  <p className="mt-1 text-[12.5px] text-amber-300/90">Data sementara sampai tanggal sinkron terakhir</p>
                )}
              </div>
            </div>
            {syncing || isSyncRunningRemotely ? (
              <span className="rd-chip">
                <Loader2 className="h-3 w-3 animate-spin" />
                Running
              </span>
            ) : snapshot?.syncLog?.status === "success" ? (
              <span className="rd-chip rd-chip-ok">Success</span>
            ) : snapshot?.syncLog?.status === "partial" ? (
              <span className="rd-chip border-amber-400/40 bg-amber-400/10 text-amber-300">Partial</span>
            ) : snapshot?.syncLog?.status === "failed" ? (
              <span className="rd-chip rd-chip-danger">Failed</span>
            ) : (
              <span className="rd-chip">Idle</span>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className={FIELD}>
              <CalendarClock className="h-4 w-4 shrink-0 text-slate-400" />
              <Input
                type="month"
                aria-label="Pilih periode laporan keuangan"
                min={MIN_PERIOD}
                max={jakartaCurrentPeriod()}
                value={period}
                className="h-8 w-[150px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
                onClick={(event) => event.currentTarget.showPicker?.()}
                onChange={(event) => {
                  setPeriod(clampPeriod(event.target.value));
                }}
              />
            </div>
            <Button
              type="button"
              className={PRIMARY_BTN}
              onClick={() => void handleSync()}
              disabled={syncing || externallyLocked}
            >
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {syncing ? "Menyinkronkan..." : isSyncRunningRemotely ? "Lanjutkan Sync" : "Sync Sekarang"}
            </Button>
          </div>
          {externallyLocked && !syncing ? (
            <p className="mt-3 text-sm text-amber-400">Sinkronisasi Olsera lain sedang berjalan (mis. Sync Semua Olsera) — tunggu hingga selesai.</p>
          ) : null}
          {(syncMessage || syncProgress) && (
            <p className="mt-3 text-sm text-slate-300" aria-live="polite">
              {syncProgress && (syncing || isSyncRunningRemotely)
                ? `Fase ${syncProgress.phase === "monthly-reports" ? "laporan bulanan" : syncProgress.phase === "ledger-details" ? "buku besar detail" : syncProgress.phase === "reconcile" ? "rekonsiliasi" : "selesai"} — ${syncProgress.accountsProcessed}/${syncProgress.accountsTotal} akun, ${syncProgress.recordsProcessed} baris diproses.`
                : syncMessage}
            </p>
          )}
          {snapshot?.syncLog?.failedAccountCodes?.length ? <p className="mt-2 text-[12.5px] text-rose-300">Akun gagal disinkronkan: {snapshot.syncLog.failedAccountCodes.join(", ")}</p> : null}
        </div>
      </section>

      {/* P0 fix: text-amber-100 di atas bg-amber-400/10 nyaris tidak
          terbaca di Light Mode (pucat-di-atas-pucat) — warna ini didesain
          untuk latar gelap. `fin-diagnostic-warning` menambahkan override
          khusus Light Mode di globals.css (pola sama seperti
          [data-mode="light"] .rd-shell .inv-panel .text-amber-300 yang
          sudah ada), tanpa mengubah wording atau makna status warning. */}
      {isCurrentPeriod && (summaryWarnings.length > 0 || subtotalWarning) && (
        <section className="fin-diagnostic-warning rd-enter mb-4 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 text-[13px] text-amber-100">
          <p className="font-semibold">{financialSourceWarningText(true)}</p>
        </section>
      )}
      {!isCurrentPeriod && (summaryWarnings.length > 0 || subtotalWarning) && (
        <section className="fin-diagnostic-warning rd-enter mb-4 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 text-[13px] text-amber-100">
          <p className="font-semibold">Perlu Dicek — diagnostic sumber</p>
          {subtotalWarning && <p className="mt-1">Subtotal sumber Olsera tidak cocok dengan jumlah detail. Angka sumber tidak diubah otomatis.</p>}
          {summaryWarnings.slice(0, 5).map((row) => <p key={row.accountCode} className="mt-1">Akun {row.accountCode}: {row.status} (summary {row.summaryDebit}/{row.summaryCredit}, detail {row.detailDebit}/{row.detailCredit}).</p>)}
        </section>
      )}

      {snapshotError && (
        <section className="rd-enter mb-4">
          <div className="flex items-start gap-3 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-4">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
            <p className="text-[13.5px] text-rose-100/80">{snapshotError}</p>
          </div>
        </section>
      )}

      {snapshotLoading && !snapshot ? (
        <section className="rd-enter">
          <div className="rd-card flex items-center justify-center rounded-2xl p-10 text-slate-400">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Memuat data laporan keuangan...
          </div>
        </section>
      ) : snapshot && !snapshot.hasData ? (
        <section className="rd-enter">
          <div className="rd-card flex flex-col items-center gap-3 rounded-2xl p-10 text-center">
            <div className={ICON_CHIP}>
              <ScrollText className="h-5 w-5" />
            </div>
            <p className={TITLE}>Belum ada data untuk {formatPeriodLabel(period)}</p>
            <p className={`${DESC} max-w-md`}>
              Laporan keuangan periode ini belum pernah disinkronkan. Klik &quot;Sync Sekarang&quot; di atas untuk menarik data dari Olsera dan
              menyimpannya sebagai snapshot.
            </p>
          </div>
        </section>
      ) : (
        snapshot && (
          <section className="rd-enter" style={{ animationDelay: "80ms" }}>
            <div className="rd-card relative rounded-2xl p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div
                  role="tablist"
                  aria-label="Bagian laporan keuangan"
                  className="rd-capsule-group inline-flex flex-wrap items-center gap-1 rounded-full p-1"
                >
                  {TABS.map((item) => (
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

                {/* Download export — mengikuti periode aktif, dari snapshot MongoDB. */}
                <div className="relative">
                  <Button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={downloadMenuOpen}
                    disabled={downloading !== null}
                    onClick={() => setDownloadMenuOpen((open) => !open)}
                    className={PRIMARY_BTN}
                  >
                    {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
                    {downloading ? "Menyiapkan..." : "Download"}
                    <ChevronDown className={`h-4 w-4 transition-transform ${downloadMenuOpen ? "rotate-180" : ""}`} />
                  </Button>
                  {downloadMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-[9998]" aria-hidden="true" onClick={() => setDownloadMenuOpen(false)} />
                      <div
                        role="menu"
                        aria-label="Pilihan download laporan keuangan"
                        className="rd-panel absolute right-0 z-[9999] mt-2 w-80 rounded-lg p-1.5"
                      >
                        {DOWNLOAD_OPTIONS.map((option) => (
                          <button
                            key={option.key}
                            type="button"
                            role="menuitem"
                            onClick={() => void handleDownload(option)}
                            className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left text-[13px] text-slate-200 transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
                          >
                            <span className="mt-0.5 shrink-0 rounded-md border border-white/10 bg-white/5 p-1.5 text-slate-300">
                              {option.icon === "excel" ? <FileSpreadsheet className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block font-medium">{option.label}</span>
                              <span className="block text-[11px] font-normal text-slate-500">{option.desc}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {downloadError && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3.5 py-2.5">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                  <p className="text-[13px] text-rose-100/80">{downloadError}</p>
                </div>
              )}

              {tab === "summary" && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="mb-1 flex items-center gap-2.5">
                      <div className={ICON_CHIP}>
                        <Wallet className="h-4 w-4" />
                      </div>
                      <p className={TITLE}>Laba Rugi &amp; Kas</p>
                    </div>
                    <dl className="mt-2">
                      <SummaryLine label="Pendapatan" value={formatRupiah(pl?.totals.revenue)} />
                      <SummaryLine label="Laba Kotor" value={formatRupiah(pl?.totals.grossProfit)} />
                      <SummaryLine label="Laba Bersih" value={formatRupiah(pl?.totals.netProfit)} emphasis />
                      <SummaryLine label="Saldo Kas Akhir" value={formatRupiah(cf?.totals.endingCash)} emphasis />
                    </dl>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="mb-1 flex items-center gap-2.5">
                      <div className={ICON_CHIP}>
                        <Landmark className="h-4 w-4" />
                      </div>
                      <p className={TITLE}>Neraca</p>
                    </div>
                    <dl className="mt-2">
                      <SummaryLine label="Total Aset" value={formatRupiah(bs?.totals.totalAssets)} emphasis />
                      <SummaryLine label="Total Kewajiban dan Modal" value={formatRupiah(bs?.totals.totalLiabilityCapital)} emphasis />
                    </dl>
                    {bs && (
                      <p className={`mt-3 flex items-center gap-1.5 text-[13px] ${bs.totals.balanced ? "text-emerald-300" : "text-rose-300"}`}>
                        {bs.totals.balanced ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                        {bs.totals.balanced ? "Neraca seimbang" : `Neraca TIDAK seimbang — selisih ${formatRupiah(bs.totals.difference)}`}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {tab === "cashflow" && (
                <div className="max-w-xl rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <dl>
                    <SummaryLine label="Aktivitas Operasional" value={formatRupiah(cf?.totals.operational)} />
                    <SummaryLine label="Aktivitas Investasi" value={formatRupiah(cf?.totals.investing)} />
                    <SummaryLine label="Aktivitas Pendanaan" value={formatRupiah(cf?.totals.funding)} />
                    <SummaryLine label="Kenaikan/Penurunan Kas" value={formatRupiah(cf?.totals.cashIncrease)} emphasis />
                    <SummaryLine label="Kas Awal" value={formatRupiah(cf?.totals.openingCash)} />
                    <SummaryLine label="Kas Akhir" value={formatRupiah(cf?.totals.endingCash)} emphasis />
                  </dl>
                  {cf && !cf.totals.endingCashValid && (
                    <p className="mt-3 flex items-center gap-1.5 text-[13px] text-amber-300">
                      <AlertTriangle className="h-4 w-4" />
                      Kas Akhir tidak sama dengan Kas Awal + Kenaikan/Penurunan Kas pada data sumber.
                    </p>
                  )}
                </div>
              )}

              {tab === "profitloss" && (
                <div className="max-w-xl rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <dl>
                    <SummaryLine label="Pendapatan" value={formatRupiah(pl?.totals.revenue)} />
                    <SummaryLine label="HPP" value={formatRupiah(pl?.totals.costOfGoodsSold)} />
                    <SummaryLine label="Laba Kotor" value={formatRupiah(pl?.totals.grossProfit)} emphasis />
                    <SummaryLine label="Biaya Operasional" value={formatRupiah(pl?.totals.operatingExpenses)} />
                    <SummaryLine label="Pendapatan Nonoperasional" value={formatRupiah(pl?.totals.nonOperatingIncome)} />
                    <SummaryLine label="Beban Nonoperasional" value={formatRupiah(pl?.totals.nonOperatingExpenses)} />
                    <SummaryLine label="Laba Bersih" value={formatRupiah(pl?.totals.netProfit)} emphasis />
                  </dl>
                  {pl && (!pl.totals.grossProfitValid || !pl.totals.netProfitValid) && (
                    <p className="mt-3 flex items-center gap-1.5 text-[13px] text-amber-300">
                      <AlertTriangle className="h-4 w-4" />
                      Formula Laba Rugi tidak konsisten pada data sumber.
                    </p>
                  )}
                </div>
              )}

              {tab === "balance" && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <p className={TITLE}>Aset</p>
                    <dl className="mt-2">
                      {(bs?.assets.children ?? []).map((node, index) => (
                        <SummaryLine key={`${node.name}-${index}`} label={node.name || "-"} value={formatRupiah(node.amount)} />
                      ))}
                      <SummaryLine label="Total Aset" value={formatRupiah(bs?.totals.totalAssets)} emphasis />
                    </dl>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <p className={TITLE}>Kewajiban &amp; Modal</p>
                    <dl className="mt-2">
                      {(bs?.liabilityCapital.children ?? []).map((node, index) => (
                        <SummaryLine key={`${node.name}-${index}`} label={node.name || "-"} value={formatRupiah(node.amount)} />
                      ))}
                      <SummaryLine label="Total Kewajiban dan Modal" value={formatRupiah(bs?.totals.totalLiabilityCapital)} emphasis />
                    </dl>
                  </div>
                  {bs && (
                    <div
                      className={`md:col-span-2 flex items-center gap-2 rounded-xl border px-4 py-3 text-[13.5px] ${
                        bs.totals.balanced ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-rose-400/30 bg-rose-400/10 text-rose-300"
                      }`}
                    >
                      {bs.totals.balanced ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
                      {bs.totals.balanced
                        ? "Neraca seimbang — Total Aset = Total Kewajiban dan Modal."
                        : `Neraca TIDAK seimbang — selisih ${formatRupiah(bs.totals.difference)}.`}
                    </div>
                  )}
                </div>
              )}

              {tab === "ledger" && (
                <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                    <div className={`${FIELD} mb-3 w-full`}>
                      <Search className="h-4 w-4 shrink-0 text-slate-400" />
                      <Input
                        aria-label="Cari kode atau nama akun"
                        placeholder="Cari kode / nama akun"
                        value={ledgerSearch}
                        className="h-8 border-0 bg-transparent px-1 text-slate-200 shadow-none placeholder:text-slate-500 focus-visible:ring-0"
                        onChange={(event) => setLedgerSearch(event.target.value)}
                      />
                    </div>
                    <div className="max-h-[420px] overflow-y-auto">
                      {filteredAccounts.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">Tidak ada akun yang cocok.</p>}
                      {filteredAccounts.map((row) => {
                        const code = row.accountCode ?? "";
                        const active = code === selectedAccountCode;
                        return (
                          <button
                            key={code || row.accountName}
                            type="button"
                            onClick={() => setSelectedAccountCode(code)}
                            className={`mb-1 flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors ${
                              active ? "bg-rose-500/15 text-rose-100" : "text-slate-300 hover:bg-white/[0.06]"
                            }`}
                          >
                            <span className="text-[13px] font-medium">{row.accountCode ?? "-"}</span>
                            <span className="truncate text-[12px] text-slate-400">{row.accountName ?? "-"}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    {!selectedAccountCode ? (
                      <div className="flex h-40 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-sm text-slate-500">
                        Pilih akun di daftar sebelah kiri untuk melihat buku besar.
                      </div>
                    ) : ledgerLoading && !ledgerData ? (
                      <div className="flex h-40 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-sm text-slate-400">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Memuat buku besar...
                      </div>
                    ) : !ledgerData || ledgerData.total === 0 ? (
                      <div className="flex h-40 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-center text-sm text-slate-500">
                        Tidak ada data buku besar untuk akun ini pada {formatPeriodLabel(period)}.
                      </div>
                    ) : (
                      <>
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-[13.5px] font-medium text-slate-200">
                              {selectedAccountCode} — {ledgerData.accountName ?? "-"}
                            </p>
                            <div className="relative">
                              <Button
                                type="button"
                                variant="outline"
                                aria-haspopup="menu"
                                aria-expanded={accountMenuOpen}
                                disabled={downloading !== null}
                                onClick={() => setAccountMenuOpen((open) => !open)}
                                className="h-7 gap-1.5 border-white/10 bg-white/5 px-2.5 text-[12px] text-slate-200 hover:bg-white/10"
                              >
                                {downloading === "account-pdf" || downloading === "account-excel" ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <ArrowDownToLine className="h-3.5 w-3.5" />
                                )}
                                Download Akun Ini
                                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${accountMenuOpen ? "rotate-180" : ""}`} />
                              </Button>
                              {accountMenuOpen && (
                                <>
                                  <div className="fixed inset-0 z-[9998]" aria-hidden="true" onClick={() => setAccountMenuOpen(false)} />
                                  <div
                                    role="menu"
                                    aria-label="Unduh buku besar akun ini"
                                    className="rd-panel absolute left-0 z-[9999] mt-2 w-36 rounded-lg p-1.5"
                                  >
                                    {ACCOUNT_DOWNLOAD_OPTIONS.map((option) => (
                                      <button
                                        key={option.key}
                                        type="button"
                                        role="menuitem"
                                        onClick={() => void handleDownload(option)}
                                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-slate-200 transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
                                      >
                                        {option.key === "account-excel" ? <FileSpreadsheet className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                                        {option.label}
                                      </button>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                          <p className="text-[13px] text-slate-400">
                            Pergerakan Periode:{" "}
                            <span className={`font-semibold tabular-nums ${ledgerData.totals.movement >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                              {formatRupiah(ledgerData.totals.movement)}
                            </span>
                          </p>
                        </div>
                        <div className="overflow-x-auto rounded-xl border border-white/10">
                          <table className="rd-table w-full min-w-[860px] text-sm">
                            <thead>
                              <tr>
                                <th className={TH}>Tanggal</th>
                                <th className={TH}>No. Jurnal</th>
                                <th className={TH}>Deskripsi</th>
                                <th className={`${TH} text-right`}>Debit</th>
                                <th className={`${TH} text-right`}>Kredit</th>
                                <th className={`${TH} text-right`}>Saldo</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ledgerData.data.map((row, index) => (
                                <tr key={`${row.transactionNo ?? "row"}-${index}`}>
                                  <td className="px-3 py-2.5 text-slate-300">
                                    {row.isOpeningBalance ? "Saldo Awal" : row.formattedTransactionDate || row.transactionDate || "-"}
                                  </td>
                                  <td className="px-3 py-2.5 text-slate-300">{row.transactionNo ?? "-"}</td>
                                  <td className="px-3 py-2.5 text-slate-300">{row.description ?? "-"}</td>
                                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-200">
                                    {row.debit ? formatRupiah(row.debit) : "-"}
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-200">
                                    {row.credit ? formatRupiah(row.credit) : "-"}
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-200">
                                    {row.balance == null ? "-" : formatRupiah(row.balance)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <Pagination page={ledgerPage} totalPages={ledgerData.totalPages} total={ledgerData.total} unit="baris" onPage={setLedgerPage} />
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        )
      )}
    </div>
  );
}
