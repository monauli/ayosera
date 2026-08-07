"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, Download } from "lucide-react";
import type { CoretaxFieldDef, CoretaxRow } from "@/lib/coretax/types";

export type CoretaxStatusLabel = "belum-ada-data" | "belum-diperiksa" | "perlu-diperbaiki" | "benar" | "siap-diunduh";

const STATUS_META: Record<CoretaxStatusLabel, { text: string; className: string; icon: typeof CheckCircle2 }> = {
  "belum-ada-data": { text: "Belum Ada Data", className: "border-white/10 bg-white/5 text-slate-400", icon: CircleDashed },
  "belum-diperiksa": { text: "Belum Diperiksa", className: "border-white/10 bg-white/5 text-slate-300", icon: CircleDashed },
  "perlu-diperbaiki": { text: "Perlu Diperbaiki", className: "border-amber-400/30 bg-amber-400/10 text-amber-300", icon: AlertTriangle },
  benar: { text: "Data Sudah Benar", className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300", icon: CheckCircle2 },
  "siap-diunduh": { text: "Siap Diunduh", className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300", icon: Download },
};

const MAX_ERROR_ITEMS = 6;

export function CoretaxValidationSummary({
  rows,
  checked,
  statusLabel,
  fields,
  onJumpToError,
}: {
  rows: readonly CoretaxRow[];
  checked: boolean;
  statusLabel: CoretaxStatusLabel;
  fields: readonly CoretaxFieldDef[];
  onJumpToError: (rowIndex: number, fieldKey: string) => void;
}) {
  const validCount = rows.filter((r) => r.status === "benar").length;
  const invalidCount = rows.filter((r) => r.status === "perlu-diperbaiki").length;
  const meta = STATUS_META[statusLabel];
  const Icon = meta.icon;

  const errorItems: { rowIndex: number; fieldKey: string; label: string; message: string }[] = [];
  rows.forEach((row, index) => {
    for (const error of row.errors) {
      const field = fields.find((f) => f.key === error.field);
      errorItems.push({ rowIndex: index, fieldKey: error.field, label: field?.label ?? error.field, message: error.message });
    }
  });

  return (
    <div className="flex flex-col gap-2">
      <div className={`flex flex-wrap items-center gap-2.5 rounded-lg border px-3 py-2 text-sm ${meta.className}`}>
        <Icon className="h-4 w-4 shrink-0" />
        <span className="font-medium">{meta.text}</span>
        {checked && rows.length > 0 && (
          <span className="text-slate-400">
            {rows.length} baris · {validCount} benar · {invalidCount} perlu diperbaiki
          </span>
        )}
      </div>
      {!checked && rows.length > 0 && (
        <p className="text-xs text-slate-500">
          Klik <span className="font-medium text-slate-300">Periksa Data</span> untuk memvalidasi seluruh baris.
        </p>
      )}
      {errorItems.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {errorItems.slice(0, MAX_ERROR_ITEMS).map((item, i) => (
            <button
              key={`${item.rowIndex}-${item.fieldKey}-${i}`}
              type="button"
              onClick={() => onJumpToError(item.rowIndex, item.fieldKey)}
              className="rd-chip cursor-pointer border-rose-400/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20"
              title={item.message}
            >
              Baris {item.rowIndex + 1} · {item.label}
            </button>
          ))}
          {errorItems.length > MAX_ERROR_ITEMS && (
            <span className="self-center text-[11px] text-slate-500">+{errorItems.length - MAX_ERROR_ITEMS} lainnya</span>
          )}
        </div>
      )}
    </div>
  );
}
