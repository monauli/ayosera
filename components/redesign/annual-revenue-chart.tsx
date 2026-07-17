"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CalendarRange } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Card "Pendapatan Bulanan" — presentasi murni. Data 12 bulan (Jan–Des) dan
// handler tahun berasal dari app/page.tsx (agregasi & fetch di sana);
// komponen ini tidak fetch sendiri.
export type MonthlyRevenueStatus = "complete" | "running" | "partial" | "unavailable" | "future";

export type MonthlyRevenuePoint = {
  monthIndex: number;
  label: string;
  fullLabel: string;
  amount: number | null;
  transactionCount: number | null;
  status: MonthlyRevenueStatus;
};

export type MonthlyRevenueSummaryItem = { label: string; amount: number; status: MonthlyRevenueStatus } | null;

const STATUS_LABEL: Record<MonthlyRevenueStatus, string> = {
  complete: "Lengkap",
  running: "Berjalan",
  partial: "Data parsial",
  unavailable: "Belum tersedia",
  future: "Belum terjadi",
};

function statusSuffix(status: MonthlyRevenueStatus) {
  return status === "running" || status === "partial" ? ` (${STATUS_LABEL[status]})` : "";
}

function formatRupiahFull(value: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 })
    .format(value)
    .replace(/\s/g, "");
}

function formatRupiahCompact(value: number) {
  if (value >= 1_000_000_000) return `Rp${(value / 1_000_000_000).toFixed(1)}M`;
  if (value >= 1_000_000) return `Rp${Math.round(value / 1_000_000)}jt`;
  if (value >= 1_000) return `Rp${Math.round(value / 1000)}rb`;
  return `Rp${Math.round(value)}`;
}

function barFill(status: MonthlyRevenueStatus) {
  if (status === "running") return "#f472b6"; // rose lebih terang — bulan berjalan (belum penuh)
  if (status === "partial") return "#fda4af"; // rose muda — cakupan data parsial
  return "#e11d48"; // rose/pink utama Ayosera — bulan lengkap
}

function RevenueTooltip({ active, payload }: { active?: boolean; payload?: { payload: MonthlyRevenuePoint }[] }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rd-panel rounded-lg px-3 py-2.5 text-xs">
      <p className="font-semibold text-slate-100">{point.fullLabel}</p>
      {point.amount === null ? (
        <p className="mt-1 text-slate-500">{STATUS_LABEL[point.status]}</p>
      ) : (
        <div className="mt-1 space-y-0.5 text-slate-300">
          <p className="tabular-nums">{formatRupiahFull(point.amount)}</p>
          <p className="tabular-nums text-slate-400">{point.transactionCount ?? 0} transaksi</p>
          <p className="text-slate-500">{STATUS_LABEL[point.status]}</p>
        </div>
      )}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold tabular-nums tracking-tight text-slate-100">{value}</p>
      {detail && <p className="truncate text-[11px] text-slate-500">{detail}</p>}
    </div>
  );
}

export function AnnualRevenueChart({
  data,
  year,
  onYearChange,
  yearOptions,
  loading,
  highest,
  lowest,
  total,
  average,
}: {
  data: MonthlyRevenuePoint[];
  year: string;
  onYearChange: (value: string) => void;
  yearOptions: string[];
  loading: boolean;
  highest: MonthlyRevenueSummaryItem;
  lowest: MonthlyRevenueSummaryItem;
  total: number;
  average: number;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-slate-100">Pendapatan Bulanan</h2>
          <p className="text-xs text-slate-500">Perbandingan total pendapatan setiap bulan pada tahun yang dipilih</p>
        </div>
        <Select value={year} onValueChange={onYearChange}>
          <SelectTrigger className="rd-field h-9 w-[104px] gap-1.5 rounded-full border-0 bg-transparent px-3 text-xs text-slate-200 shadow-none focus:ring-0">
            <CalendarRange className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <SelectValue aria-label="Tahun pendapatan" />
          </SelectTrigger>
          <SelectContent>
            {yearOptions.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 h-[220px] flex-1">
        {loading && !data.some((point) => point.amount !== null) ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">Memuat pendapatan bulanan…</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
              <CartesianGrid stroke="#ffffff14" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="label" stroke="#64748b" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
              <YAxis
                stroke="#64748b"
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(value: number) => formatRupiahCompact(value)}
              />
              <Tooltip content={<RevenueTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
              <Bar dataKey="amount" radius={[5, 5, 0, 0]} maxBarSize={34} isAnimationActive={!loading}>
                {data.map((point) => (
                  <Cell key={point.monthIndex} fill={barFill(point.status)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-white/10 pt-3 sm:grid-cols-4">
        <SummaryTile
          label="Pendapatan Tertinggi"
          value={highest ? formatRupiahFull(highest.amount) : "-"}
          detail={highest ? `${highest.label}${statusSuffix(highest.status)}` : "Belum ada data"}
        />
        <SummaryTile
          label="Pendapatan Terendah"
          value={lowest ? formatRupiahFull(lowest.amount) : "-"}
          detail={lowest ? `${lowest.label}${statusSuffix(lowest.status)}` : "Belum ada data"}
        />
        <SummaryTile label={`Total Pendapatan ${year}`} value={formatRupiahFull(total)} />
        <SummaryTile label="Rata-rata Bulanan" value={formatRupiahFull(average)} />
      </div>
    </div>
  );
}
