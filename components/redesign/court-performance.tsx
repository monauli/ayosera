import { ClipboardList, Trophy } from "lucide-react";
import { Progress } from "@/components/ui/progress";

// Card "Performa Lapangan" — presentasi murni. `items` sudah dinormalisasi ke
// keenam lapangan Ayosera (termasuk yang Rp0/0 pesanan) oleh app/page.tsx dari
// data topServices existing; komponen ini tidak fetch atau mengagregasi data.
export type CourtPerformanceItem = {
  key: string;
  label: string;
  revenueValue: number;
  revenue: string;
  count: number;
  progress: number;
};

export function CourtPerformance({
  items,
  topLabel,
  totalOrders,
  totalRevenue,
}: {
  items: CourtPerformanceItem[];
  topLabel: string;
  totalOrders: number;
  totalRevenue: string;
  topContributionPercent: number;
}) {
  return (
    <div className="flex h-full flex-col">
      <h2 className="text-base font-semibold text-slate-100">Performa Lapangan</h2>
      <p className="text-xs text-slate-500">Pendapatan dan jumlah pesanan berdasarkan filter aktif</p>

      <div className="mt-4 space-y-3.5">
        {items.map((item) => (
          <div key={item.key} className="space-y-1.5">
            <div className="flex items-start justify-between gap-3 text-[15px]">
              <span className="font-medium text-slate-200">{item.label}</span>
              <span className="shrink-0 text-right">
                <span className="font-semibold tabular-nums text-slate-100">{item.revenue}</span>
                <span className="ml-1.5 text-xs tabular-nums text-slate-500">{item.count} pesanan</span>
              </span>
            </div>
            <Progress value={item.progress} className="bg-white/10" />
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-white/10 pt-3.5 text-[13px]">
        <div className="flex items-start gap-2">
          <span className="rd-stat-icon mt-0.5 shrink-0 rounded-lg p-1.5">
            <Trophy className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block text-slate-500">Lapangan Teratas</span>
            <span className="block truncate font-medium text-slate-200">{topLabel}</span>
          </span>
        </div>
        <div className="flex items-start gap-2">
          <span className="rd-stat-icon mt-0.5 shrink-0 rounded-lg p-1.5">
            <ClipboardList className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block text-slate-500">Total Pesanan</span>
            <span className="block truncate font-medium tabular-nums text-slate-200">{totalOrders}</span>
          </span>
        </div>
      </div>

      {/* Total Pendapatan Lapangan — SUM item di atas (Court No 1-4 + Pickleball
          1-2), bukan angka terpisah. Dipisah dari "Total Pesanan" (jumlah,
          bukan nominal) supaya kedua satuan tidak tercampur. */}
      <div className="mt-3 flex items-baseline justify-between border-t border-white/10 pt-3">
        <span className="text-[13px] font-medium text-slate-400">Total Pendapatan Lapangan</span>
        <span className="text-base font-semibold tabular-nums text-slate-100">{totalRevenue}</span>
      </div>
    </div>
  );
}
