import type { ElementType } from "react";
import { BorderBeam } from "@/components/redesign/border-beam";

// Kartu metrik gelap untuk Dashboard redesign. Presentasi murni — nilai dan
// detail datang dari state/fetch lama di app/page.tsx.
export function DashboardStatCard({
  title,
  value,
  detail,
  icon: Icon,
  beam = false,
  delay = 0,
}: {
  title: string;
  value: string;
  detail: string;
  icon: ElementType;
  /** Tampilkan border beam berjalan (untuk kartu paling penting saja). */
  beam?: boolean;
  /** Delay animasi masuk (ms), untuk efek stagger antar kartu. */
  delay?: number;
}) {
  return (
    <div className="rd-card rd-enter relative overflow-hidden rounded-2xl p-5" style={{ animationDelay: `${delay}ms` }}>
      {beam && <BorderBeam />}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-slate-400">{title}</p>
          <p className="mt-2 truncate text-2xl font-semibold tracking-tight text-slate-50">{value}</p>
          <p className="mt-1 truncate text-xs text-slate-500">{detail}</p>
        </div>
        <div className="rd-stat-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}
