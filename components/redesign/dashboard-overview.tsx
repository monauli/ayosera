import type { ElementType } from "react";
import { CalendarDays, CalendarRange, RotateCcw } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { BorderBeam } from "@/components/redesign/border-beam";
import { DashboardStatCard } from "@/components/redesign/dashboard-stat-card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

type StatItem = { title: string; value: string; detail: string; icon: ElementType };
type PaymentPoint = { name: string; value: number; color: string };
type ServicePoint = { name: string; branch: string; revenue: string; count: number; progress: number };
type EventItem = { label: string; detail: string; timeText: string; ok: boolean };

// Layout Dashboard redesign (presentasi murni). Semua data & handler berasal
// dari state/fetch lama di app/page.tsx — tidak ada fetch/logic baru di sini.
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
  paymentRows,
  serviceRows,
  syncStatusLabel,
  latestEventText,
  events,
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
  paymentRows: PaymentPoint[];
  serviceRows: ServicePoint[];
  syncStatusLabel: string;
  latestEventText: string;
  events: EventItem[];
}) {
  return (
    <div className="space-y-4">
      {/* Capsule tabs filter (Hero 195) — handler sama persis dengan filter lama. */}
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
        </div>
        <div className={`rd-field flex h-10 items-center gap-2 rounded-full px-3 ${activePreset === "manualMonth" ? "rd-field-active" : ""}`}>
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
        <div className={`rd-field flex h-10 items-center gap-2 rounded-full px-3 ${activePreset === "custom" ? "rd-field-active" : ""}`}>
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

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="rd-card rd-enter relative overflow-hidden rounded-2xl p-5" style={{ animationDelay: "180ms" }}>
          <h2 className="text-sm font-semibold text-slate-100">Rincian Pembayaran</h2>
          <p className="text-xs text-slate-500">Pembagian pendapatan per metode pembayaran</p>
          <div className="h-[236px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={paymentRows} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={4} stroke="none">
                  {paymentRows.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ borderRadius: 10, borderColor: "#252932", background: "#111318", color: "#e2e8f0" }}
                  formatter={(value) => [`${value}%`, "Porsi"]}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {paymentRows.map((item) => (
              <div key={item.name} className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                <span className="text-slate-400">{item.name}</span>
                <span className="ml-auto font-medium text-slate-200">{item.value}%</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rd-card rd-enter relative overflow-hidden rounded-2xl p-5" style={{ animationDelay: "260ms" }}>
          <BorderBeam />
          <h2 className="text-sm font-semibold text-slate-100">Layanan Terlaris</h2>
          <p className="text-xs text-slate-500">Diurutkan berdasarkan pendapatan pada filter</p>
          <div className="mt-4 space-y-4">
            {serviceRows.length ? (
              serviceRows.map((service) => (
                <div key={service.name} className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-200">{service.name}</p>
                      <p className="text-xs text-slate-500">
                        {service.branch} · {service.count} pesanan
                      </p>
                    </div>
                    <span className="text-sm font-semibold text-slate-100">{service.revenue}</span>
                  </div>
                  <Progress value={service.progress} className="bg-white/10" />
                </div>
              ))
            ) : (
              <p className="py-6 text-center text-sm text-slate-500">Belum ada data layanan pada filter ini.</p>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <div className="rd-card rd-enter relative overflow-hidden rounded-2xl p-5" style={{ animationDelay: "340ms" }}>
          <h2 className="text-sm font-semibold text-slate-100">Kesehatan Sinkronisasi</h2>
          <div className="mt-3 flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${syncStatusLabel === "Gagal" ? "bg-rose-400" : "bg-emerald-400"}`} />
            <span className={`rd-chip ${syncStatusLabel === "Gagal" ? "rd-chip-danger" : "rd-chip-ok"}`}>{syncStatusLabel}</span>
          </div>
          <p className="mt-2 text-xs text-slate-500">{latestEventText}</p>
        </div>

        <div className="rd-card rd-enter relative overflow-hidden rounded-2xl p-5 xl:col-span-2" style={{ animationDelay: "420ms" }}>
          <h2 className="text-sm font-semibold text-slate-100">Aktivitas Sinkronisasi Terbaru</h2>
          <p className="text-xs text-slate-500">Riwayat event sync dari data dashboard yang sama</p>
          {events.length ? (
            <ul className="mt-3 divide-y divide-white/5">
              {events.map((event, index) => (
                <li key={`${event.label}-${index}`} className="rd-row flex items-center gap-3 px-2 py-2.5 text-sm">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${event.ok ? "bg-emerald-400" : "bg-rose-400"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-slate-200">{event.label}</span>
                    <span className="block truncate text-xs text-slate-500">{event.detail}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-400">{event.timeText}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 py-4 text-center text-sm text-slate-500">Belum ada aktivitas sinkronisasi.</p>
          )}
        </div>
      </section>
    </div>
  );
}
