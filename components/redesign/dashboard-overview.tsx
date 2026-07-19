import type { ElementType } from "react";
import { ArrowRight, CalendarDays, CalendarRange, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  AnnualRevenueChart,
  type MonthlyRevenuePoint,
  type MonthlyRevenueSummaryItem,
} from "@/components/redesign/annual-revenue-chart";
import { BookingStatusDonut, type BookingStatusItem } from "@/components/redesign/booking-status-donut";
import { BorderBeam } from "@/components/redesign/border-beam";
import { CourtPerformance, type CourtPerformanceItem } from "@/components/redesign/court-performance";
import { DashboardStatCard } from "@/components/redesign/dashboard-stat-card";
import { Input } from "@/components/ui/input";

type StatItem = {
  title: string;
  value: string;
  detail: string;
  icon: ElementType;
  /** Bila diisi, seluruh card jadi interaktif (klik/Enter/Space). Opsional — dua stat lain tetap statis. */
  onClick?: () => void;
};
type EventItem = { label: string; detail: string; timeText: string; ok: boolean };
type RecentRow = {
  date: string;
  time: string;
  id: string;
  service: string;
  customer: string;
  amount: string;
  statusVariant: "success" | "warning" | "danger";
  statusLabel: string;
  /** Tanggal diterima sistem, compact (mis. "18 Jul", Asia/Jakarta) — lihat receivedDateLabel di app/page.tsx. */
  receivedDate: string;
  /** Jam diterima sistem (HH:mm, Asia/Jakarta) — lihat receivedTimeLabel di app/page.tsx. */
  receivedTime: string;
  /** Nilai timestamp mentah (ms epoch) untuk sorting — lihat receivedAtMs di app/page.tsx. null bila tidak tersedia. */
  receivedAtMs: number | null;
};

/**
 * Urutkan "Status Transaksi Terbaru" dari timestamp diterima sistem paling
 * baru ke paling lama, memakai nilai ms mentah (receivedAtMs) — bukan string
 * jam "HH:mm" yang sudah diformat (string itu tidak membawa info tanggal,
 * jadi tidak valid untuk sorting kronologis). Baris tanpa timestamp valid
 * (null) selalu diletakkan paling bawah, di antara sesama baris null urutan
 * relatif aslinya dipertahankan (Array.prototype.sort stabil di V8/Node).
 */
function sortByReceivedAtDesc(rows: RecentRow[]): RecentRow[] {
  return [...rows].sort((a, b) => {
    if (a.receivedAtMs == null && b.receivedAtMs == null) return 0;
    if (a.receivedAtMs == null) return 1;
    if (b.receivedAtMs == null) return -1;
    return b.receivedAtMs - a.receivedAtMs;
  });
}

// Layout modul Transaksi Real-Time (presentasi murni). Semua data & handler
// berasal dari state/fetch lama di app/page.tsx — tidak ada fetch/logic baru di sini.
export function DashboardOverview({
  presets,
  activePreset,
  onPreset,
  filterMonth,
  onMonthFilter,
  customRangeStart,
  customRangeEnd,
  onCustomRangeChange,
  onResetFilters,
  customRangeInvalid,
  stats,
  bookingStatusItems,
  totalBookings,
  annualRevenueData,
  annualRevenueYear,
  onAnnualRevenueYearChange,
  annualRevenueYearOptions,
  annualRevenueLoading,
  annualRevenueHighest,
  annualRevenueLowest,
  annualRevenueTotal,
  annualRevenueAverage,
  courtPerformance,
  courtTopLabel,
  courtTotalOrders,
  courtTopContributionPercent,
  syncStatusLabel,
  latestEventText,
  events,
  recentRows,
  recentLoading,
  onViewAll,
}: {
  presets: { label: string; value: string }[];
  activePreset: string;
  onPreset: (value: string) => void;
  filterMonth: string;
  onMonthFilter: (value: string) => void;
  customRangeStart: string;
  customRangeEnd: string;
  onCustomRangeChange: (start: string, end: string) => void;
  onResetFilters: () => void;
  customRangeInvalid: boolean;
  stats: StatItem[];
  bookingStatusItems: BookingStatusItem[];
  totalBookings: number;
  annualRevenueData: MonthlyRevenuePoint[];
  annualRevenueYear: string;
  onAnnualRevenueYearChange: (value: string) => void;
  annualRevenueYearOptions: string[];
  annualRevenueLoading: boolean;
  annualRevenueHighest: MonthlyRevenueSummaryItem;
  annualRevenueLowest: MonthlyRevenueSummaryItem;
  annualRevenueTotal: number;
  annualRevenueAverage: number;
  courtPerformance: CourtPerformanceItem[];
  courtTopLabel: string;
  courtTotalOrders: number;
  courtTopContributionPercent: number;
  syncStatusLabel: string;
  latestEventText: string;
  events: EventItem[];
  recentRows: RecentRow[];
  recentLoading: boolean;
  onViewAll: () => void;
}) {
  // Hanya untuk widget "Status Transaksi Terbaru" — tabel "Transaksi Terbaru"
  // di atas tetap memakai urutan `recentRows` apa adanya (tidak diubah).
  const sortedStatusRows = sortByReceivedAtDesc(recentRows);

  return (
    <div className="space-y-4">
      {/* Filter ringkas: Hari / Minggu / Bulan / Rentang khusus. Input bulan
          dan rentang hanya tampil saat modenya aktif — handler tetap yang lama. */}
      <div className="rd-enter flex flex-wrap items-center gap-2">
        <div className="rd-capsule-group inline-flex flex-wrap items-center gap-1 rounded-full p-1">
          {presets.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => onPreset(preset.value)}
              className={`rd-capsule ${activePreset === preset.value ? "rd-capsule-active" : ""}`}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onMonthFilter(filterMonth)}
            className={`rd-capsule inline-flex items-center gap-1.5 ${
              activePreset === "manualMonth" ? "rd-capsule-active" : ""
            }`}
          >
            <CalendarDays className="h-4 w-4" />
            Bulan
          </button>
          <button
            type="button"
            onClick={() => onCustomRangeChange(customRangeStart, customRangeEnd)}
            className={`rd-capsule inline-flex items-center gap-1.5 ${
              activePreset === "custom" ? "rd-capsule-active" : ""
            }`}
          >
            <CalendarRange className="h-4 w-4" />
            Rentang khusus
          </button>
        </div>
        {activePreset === "manualMonth" && (
          <div className="rd-field rd-field-active flex h-10 items-center gap-2 rounded-full px-3">
            <CalendarDays className="h-4 w-4 text-slate-400" />
            <Input
              type="month"
              aria-label="Filter bulan tertentu"
              value={filterMonth}
              className="h-8 w-[150px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
              onClick={(event) => event.currentTarget.showPicker?.()}
              onChange={(event) => onMonthFilter(event.target.value)}
            />
          </div>
        )}
        {activePreset === "custom" && (
          <div className="rd-field rd-field-active flex h-10 items-center gap-2 rounded-full px-3">
            <CalendarRange className="h-4 w-4 text-slate-400" />
            <Input
              type="date"
              aria-label="Tanggal mulai filter custom"
              value={customRangeStart}
              className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
              onClick={(event) => event.currentTarget.showPicker?.()}
              onChange={(event) => onCustomRangeChange(event.target.value, customRangeEnd)}
            />
            <span className="text-xs text-slate-500">s/d</span>
            <Input
              type="date"
              aria-label="Tanggal selesai filter custom"
              value={customRangeEnd}
              className="h-8 w-[140px] cursor-pointer border-0 bg-transparent px-1 text-slate-200 shadow-none focus-visible:ring-0"
              onClick={(event) => event.currentTarget.showPicker?.()}
              onChange={(event) => onCustomRangeChange(customRangeStart, event.target.value)}
            />
          </div>
        )}
        <button type="button" onClick={onResetFilters} className="rd-capsule inline-flex items-center gap-1.5">
          <RotateCcw className="h-4 w-4" />
          Reset
        </button>
        {activePreset === "custom" && customRangeInvalid && (
          <span className="text-sm text-rose-400">Tanggal selesai tidak boleh sebelum tanggal mulai.</span>
        )}
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        {stats.map((stat, index) => (
          <DashboardStatCard key={stat.title} {...stat} beam={index === 0} delay={index * 90} />
        ))}
      </section>

      {/* Susunan analitik: Status Booking (1fr) | Perbandingan Pendapatan Bulanan
          (1.6fr, lebih lebar) | Performa Lapangan (1fr). Turun ke 2 kolom pada
          tablet, 1 kolom pada mobile — tidak ada horizontal overflow. */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1fr_1.6fr_1fr]">
        <div className="rd-card rd-enter relative overflow-hidden rounded-2xl p-5" style={{ animationDelay: "180ms" }}>
          <BorderBeam />
          <h2 className="text-base font-semibold text-slate-100">Status Booking</h2>
          <p className="text-xs text-slate-500">Reservation, AYO Order, dan Cancelled pada filter aktif</p>
          <div className="mt-3">
            <BookingStatusDonut items={bookingStatusItems} total={totalBookings} />
          </div>
        </div>

        <div
          className="rd-card rd-enter relative overflow-hidden rounded-2xl p-5 md:col-span-2 xl:col-span-1"
          style={{ animationDelay: "260ms" }}
        >
          <AnnualRevenueChart
            data={annualRevenueData}
            year={annualRevenueYear}
            onYearChange={onAnnualRevenueYearChange}
            yearOptions={annualRevenueYearOptions}
            loading={annualRevenueLoading}
            highest={annualRevenueHighest}
            lowest={annualRevenueLowest}
            total={annualRevenueTotal}
            average={annualRevenueAverage}
          />
        </div>

        <div className="rd-card rd-enter relative overflow-hidden rounded-2xl p-5" style={{ animationDelay: "340ms" }}>
          <CourtPerformance
            items={courtPerformance}
            topLabel={courtTopLabel}
            totalOrders={courtTotalOrders}
            topContributionPercent={courtTopContributionPercent}
          />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.8fr_1fr]">
        <div className="rd-card rd-enter relative min-w-0 rounded-2xl p-5" style={{ animationDelay: "420ms" }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-100">Transaksi Terbaru</h2>
              <p className="text-xs text-slate-500">Transaksi paling baru pada filter aktif</p>
            </div>
            <button
              type="button"
              onClick={onViewAll}
              className="rd-capsule inline-flex items-center gap-1.5"
            >
              Lihat Semua
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
          {/* Desktop/laptop (lg+): tabel compact. Di bawah lg, lebar kolom tidak
              cukup untuk enam kolom secara nyaman, jadi tablet/mobile memakai
              daftar card di bawah — bukan sekadar scroll horizontal. */}
          <div className="mt-3 hidden overflow-x-auto lg:block">
            <table className="rd-table w-full text-sm">
              <thead>
                <tr className="text-left text-[13px] uppercase tracking-wide text-slate-400">
                  <th className="h-8 px-2 font-medium">Tanggal &amp; Jam</th>
                  <th className="h-8 px-2 font-medium">ID Booking</th>
                  <th className="h-8 px-2 font-medium">Court</th>
                  <th className="h-8 px-2 font-medium">Pelanggan</th>
                  <th className="h-8 px-2 text-right font-medium">Nominal</th>
                </tr>
              </thead>
              <tbody>
                {recentLoading && !recentRows.length ? (
                  <tr>
                    <td colSpan={5} className="h-[120px] text-center text-sm text-slate-400">
                      Memuat transaksi…
                    </td>
                  </tr>
                ) : recentRows.length ? (
                  recentRows.map((row) => (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap px-2 py-1.5 text-sm text-slate-400">
                        {row.date} <span className="text-slate-600">·</span> {row.time}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-sm font-medium text-slate-200">{row.id}</td>
                      <td className="max-w-[160px] truncate px-2 py-1.5 text-sm text-slate-300">{row.service}</td>
                      <td className="max-w-[140px] truncate px-2 py-1.5 text-sm text-slate-300">{row.customer}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right text-sm font-medium tabular-nums text-slate-100">
                        {row.amount}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="h-[120px] text-center text-sm text-slate-400">
                      Tidak ada transaksi pada filter ini.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Tablet/mobile (di bawah lg): card/list compact, bukan tabel sempit. */}
          <div className="mt-3 space-y-1.5 lg:hidden">
            {recentLoading && !recentRows.length ? (
              <p className="py-8 text-center text-sm text-slate-400">Memuat transaksi…</p>
            ) : recentRows.length ? (
              recentRows.map((row) => (
                <div key={row.id} className="rd-row rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[15px] font-medium text-slate-200">{row.customer}</span>
                    <span className="shrink-0 text-[15px] font-semibold tabular-nums text-slate-100">{row.amount}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
                    <span className="min-w-0 truncate">
                      {row.date} · {row.time} · {row.service}
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-400">{row.id}</span>
                  </div>
                </div>
              ))
            ) : (
              <p className="py-8 text-center text-sm text-slate-500">Tidak ada transaksi pada filter ini.</p>
            )}
          </div>
        </div>
        <div className="rd-card rd-enter relative min-w-0 rounded-2xl p-5" style={{ animationDelay: "480ms" }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-100">Status Transaksi Terbaru</h2>
              <p className="text-xs text-slate-500">Diurutkan dari waktu diterima paling baru</p>
            </div>
          </div>
          {sortedStatusRows.length > 0 && (
            <div className="mt-3 flex items-center gap-2.5 px-3 text-[13px] font-medium uppercase tracking-wide text-slate-400">
              <span className="w-24 shrink-0">Tanggal &amp; Jam</span>
              <span className="min-w-0 flex-1">Nama</span>
              <span className="shrink-0">Status</span>
            </div>
          )}
          <div className="mt-1.5 space-y-1.5">
            {sortedStatusRows.length ? sortedStatusRows.map((row) => (
              <div key={`status-${row.id}`} className="rd-row flex items-center gap-2.5 rounded-lg px-3 py-2">
                <span className="w-24 shrink-0 whitespace-nowrap tabular-nums text-[13px] text-slate-400">
                  {row.receivedDate} <span className="text-slate-600">·</span> {row.receivedTime}
                </span>
                <span className="min-w-0 flex-1 truncate text-[15px] text-slate-300">{row.customer}</span>
                <Badge variant={row.statusVariant}>{row.statusLabel}</Badge>
              </div>
            )) : <p className="py-8 text-center text-sm text-slate-500">Tidak ada transaksi.</p>}
          </div>
        </div>
      </section>

    </div>
  );
}
