"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { CoretaxRow } from "@/lib/coretax/types";

export function CoretaxValidationSummary({ rows, checked }: { rows: readonly CoretaxRow[]; checked: boolean }) {
  const validCount = rows.filter((r) => r.status === "benar").length;
  const invalidCount = rows.filter((r) => r.status === "perlu-diperbaiki").length;
  const allGood = checked && rows.length > 0 && invalidCount === 0;

  if (!checked) {
    return (
      <p className="text-sm text-slate-500">
        Data belum diperiksa. Klik <span className="font-medium text-slate-300">Periksa Data</span> untuk memvalidasi seluruh baris.
      </p>
    );
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
        allGood ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-amber-400/30 bg-amber-400/10 text-amber-300"
      }`}
    >
      {allGood ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
      <span className="font-medium">{allGood ? "Data Benar" : "Perlu Diperbaiki"}</span>
      <span className="text-slate-400">
        {validCount} baris benar · {invalidCount} baris bermasalah
      </span>
    </div>
  );
}
