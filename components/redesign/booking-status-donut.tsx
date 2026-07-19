"use client";

import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

// Donut "Status Booking" — komponen presentasi murni. Menerima data siap
// pakai lewat props; tidak melakukan fetch sendiri, sehingga otomatis
// mengikuti filter Dashboard yang sudah mengubah `items`/`total` di pemanggil.
//
// Catatan desain: detail status aktif TIDAK ditampilkan lewat tooltip
// floating recharts (posisinya sulit dikontrol pada donut sekecil ini dan
// akan menimpa label tengah). Sebagai gantinya, hover/klik pada segmen atau
// baris daftar menampilkan detail pada panel tetap di bawah donut — bagian
// dari alur dokumen biasa, bukan elemen mengambang.
export type BookingStatusItem = {
  key: "reservation" | "ayo-order" | "cancelled";
  label: string;
  description: string;
  value: number;
  color: string;
};

const EMPTY_RING_COLOR = "rgba(255, 255, 255, 0.08)";

function safePercent(value: number, total: number) {
  if (!total || total <= 0) return 0;
  return Math.round((value / total) * 100);
}

export function BookingStatusDonut({ items, total }: { items: BookingStatusItem[]; total: number }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const isEmpty = !total || total <= 0;
  const active = activeIndex !== null ? items[activeIndex] : null;
  const chartData = isEmpty ? [{ key: "empty", label: "", description: "", value: 1, color: EMPTY_RING_COLOR }] : items;

  return (
    <div className="flex flex-col items-center">
      <div className="relative h-[210px] w-[210px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="label"
              innerRadius={66}
              outerRadius={98}
              paddingAngle={isEmpty ? 0 : 3}
              cornerRadius={isEmpty ? 0 : 6}
              stroke="none"
              isAnimationActive={!isEmpty}
              onMouseEnter={(_, index) => !isEmpty && setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              {chartData.map((item, index) => (
                <Cell
                  key={item.key}
                  fill={item.color}
                  className={isEmpty ? undefined : "cursor-pointer transition-opacity duration-150"}
                  opacity={!isEmpty && activeIndex !== null && activeIndex !== index ? 0.35 : 1}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div
          className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-4 text-center transition-opacity duration-150 ${
            active ? "opacity-40" : "opacity-100"
          }`}
        >
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {active ? active.label : "Total Booking"}
          </span>
          <span className="mt-1 text-3xl font-bold tabular-nums tracking-tight text-slate-50">
            {active ? active.value : total}
          </span>
          {active && (
            <span className="mt-0.5 text-xs tabular-nums text-slate-400">{safePercent(active.value, total)}%</span>
          )}
        </div>
      </div>

      {isEmpty ? (
        <p className="mt-3 flex h-20 items-center text-center text-sm text-slate-500">Belum ada booking pada periode ini.</p>
      ) : (
        // Tinggi TETAP (bukan min-h): baik state aktif (3 baris) maupun placeholder
        // (1-2 baris) harus selalu merender ke tinggi yang sama persis, supaya
        // card ini (yang jadi acuan tinggi baris grid analitik) tidak pernah
        // berubah tinggi saat hover — itu yang membuat card lain di baris yang
        // sama ikut "goyang" (grid default `align-items: stretch` mengikuti
        // tinggi cell tertinggi). overflow-hidden jadi jaring pengaman kalau
        // ada teks tak terduga, bukan mekanisme utama (baris sudah truncate/clamp).
        <div
          className="mt-4 flex h-20 w-full flex-col justify-center overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-xs"
          aria-live="polite"
        >
          {active ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="flex min-w-0 items-center gap-1.5 font-semibold text-slate-100">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: active.color }} />
                  <span className="truncate">{active.label}</span>
                </p>
                <p className="shrink-0 tabular-nums text-slate-200">
                  <span className="font-semibold">{active.value}</span> booking
                </p>
              </div>
              <p className="mt-1 truncate text-slate-400">{active.description}</p>
              <p className="mt-1 tabular-nums text-slate-500">{safePercent(active.value, total)}% dari total booking</p>
            </>
          ) : (
            <p className="line-clamp-2 text-slate-500">
              Arahkan kursor ke salah satu status di bawah untuk melihat detail lengkap.
            </p>
          )}
        </div>
      )}

      {!isEmpty && (
        <div className="mt-3 w-full space-y-1.5">
          {items.map((item, index) => {
            const pct = safePercent(item.value, total);
            return (
              <button
                key={item.key}
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex(null)}
                className={`rd-row flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  activeIndex === index ? "bg-white/[0.06]" : ""
                }`}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-200">{item.label}</span>
                  <span className="block truncate text-xs text-slate-500">{item.description}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-100">{item.value}</span>
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-slate-500">{pct}%</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
