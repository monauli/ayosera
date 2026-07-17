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

type StatItem = { title: string; value: string; detail: string; icon: ElementType };
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
};

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
          <h2 className="text-[15px] font-semibold text-slate-100">Status Booking</h2>
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
              <h2 className="text-[15px] font-semibold text-slate-100">Transaksi Terbaru</h2>
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
          <div className="mt-3 overflow-x-auto">
            <table className="rd-table w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="h-9 px-2 font-medium">Tanggal</th>
                  <th className="h-9 px-2 font-medium">Jam</th>
                  <th className="h-9 px-2 font-medium">ID Booking</th>
                  <th className="h-9 px-2 font-medium">Court</th>
                  <th className="h-9 px-2 font-medium">Pelanggan</th>
                  <th className="h-9 px-2 text-right font-medium">Nominal</th>
                </tr>
              </thead>
              <tbody>
                {recentLoading && !recentRows.length ? (
                  <tr>
                    <td colSpan={6} className="h-[120px] text-center text-sm text-slate-400">
                      Memuat transaksi…
                    </td>
                  </tr>
                ) : recentRows.length ? (
                  recentRows.map((row) => (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap px-2 py-2 text-slate-300">{row.date}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-slate-400">{row.time}</td>
                      <td className="whitespace-nowrap px-2 py-2 font-medium text-slate-200">{row.id}</td>
                      <td className="max-w-[200px] truncate px-2 py-2 text-slate-300">{row.service}</td>
                      <td className="max-w-[160px] truncate px-2 py-2 text-slate-300">{row.customer}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-medium tabular-nums text-slate-100">
                        {row.amount}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="h-[120px] text-center text-sm text-slate-400">
                      Tidak ada transaksi pada filter ini.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="rd-card rd-enter relative min-w-0 rounded-2xl p-5" style={{ animationDelay: "480ms" }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold text-slate-100">Status Transaksi Terbaru</h2>
              <p className="text-xs text-slate-500">Ringkasan transaksi terbaru</p>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {recentRows.length ? recentRows.map((row) => (
              <div key={`status-${row.id}`} className="rd-row flex items-center justify-between gap-3 rounded-lg px-3 py-2">
                <span className="min-w-0 truncate text-sm text-slate-300">{row.customer}</span>
                <Badge variant={row.statusVariant}>{row.statusLabel}</Badge>
              </div>
            )) : <p className="py-8 text-center text-sm text-slate-500">Tidak ada transaksi.</p>}
          </div>
        </div>
      </section>

    </div>
  );
}
