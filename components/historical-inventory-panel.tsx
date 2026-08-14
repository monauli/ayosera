"use client";

import { useState } from "react";

type Result = { ok?: boolean; counts?: { sold: number; unsold: number; overall: number }; changes?: { added: number; updated: number; unchanged: number }; incomplete?: Array<{ productName: string; diagnostics: string[] }>; error?: string };

export function HistoricalInventoryPanel() {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(mode: "dry-run" | "confirm") {
    setBusy(true);
    try {
      const response = await fetch("/api/supervisor/olsera/inventory/historical", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period: "2026-02", source: "built-in", mode }) });
      setResult(await response.json());
    } finally { setBusy(false); }
  }
  const valid = result?.counts?.sold === 31 && result.counts.unsold === 17 && result.counts.overall === 48 && result.ok === true;
  return <section className="rd-card mt-6 p-5"><h2 className="text-lg font-semibold text-slate-50">Proses Inventori Historical</h2><p className="mt-1 text-sm text-slate-400">Februari 2026 · sumber built-in terverifikasi</p><div className="mt-4 flex gap-2"><button className="rd-button" disabled={busy} onClick={() => void run("dry-run")}>Periksa Februari</button><button className="rd-button rd-button-primary" disabled={busy || !valid} onClick={() => void run("confirm")}>Proses Februari</button></div>{result && <div className="mt-4 text-sm text-slate-300"><p>{result.error ?? `Terjual ${result.counts?.sold ?? 0} · Tidak Terjual ${result.counts?.unsold ?? 0} · Keseluruhan ${result.counts?.overall ?? 0}`}</p>{result.changes && <p>Tambah {result.changes.added} · Perbarui {result.changes.updated} · Tetap {result.changes.unchanged}</p>}{result.incomplete?.map((item) => <p key={item.productName} className="text-amber-300">{item.productName}: {item.diagnostics.join(" ")}</p>)}</div>}</section>;
}
