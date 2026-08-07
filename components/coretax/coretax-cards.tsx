"use client";

import { FileSpreadsheet } from "lucide-react";
import { CORETAX_MODULE_LIST } from "@/lib/coretax/modules";

export type CoretaxCardStats = { draftCount: number; lastSavedAt: string | null };

function formatLastSaved(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

/** Empat kartu modul Coretax pada halaman /coretax. Murni presentasi — statistik draft diambil dari luar (lihat app/coretax/page.tsx). */
export function CoretaxCards({ stats }: { stats: Record<string, CoretaxCardStats> }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {CORETAX_MODULE_LIST.map((module, index) => {
        const stat = stats[module.id];
        const lastSaved = formatLastSaved(stat?.lastSavedAt ?? null);
        return (
          <a
            key={module.id}
            href={`/coretax/${module.id}`}
            className="rd-card rd-enter group relative flex flex-col rounded-2xl p-5 no-underline"
            style={{ animationDelay: `${index * 60}ms` }}
          >
            <div className="flex items-start gap-3">
              <span className="rd-stat-icon shrink-0 rounded-xl p-2.5">
                <FileSpreadsheet className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-slate-100">{module.code}</p>
                <p className="mt-0.5 text-xs text-slate-500">{module.title}</p>
              </div>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-slate-400">{module.shortDescription}</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>{stat?.draftCount ? `${stat.draftCount} draft tersimpan` : "Belum ada draft"}</span>
              {lastSaved && <span>Terakhir disimpan {lastSaved}</span>}
            </div>
            <span className="mt-4 inline-flex w-fit items-center rounded-lg bg-rose-600 px-3.5 py-1.5 text-[13px] font-medium text-white shadow-sm transition-colors group-hover:bg-rose-500">
              Buka
            </span>
          </a>
        );
      })}
    </div>
  );
}
