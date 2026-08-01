"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Download, Loader2, Play, ShieldAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type Check = { id: string; module: string; period?: string | null; subject?: string | null; status: "pass" | "warning" | "manual" | "failed" | "unavailable"; difference?: Record<string, unknown> | null; recommendation: string };
type Audit = { runId: string; scope: string; status: string; startedAt: string; completedAt: string; checks: Check[]; summary: Record<string, number> } | null;
type Action = "sync-period" | "retry-failed" | "reconcile" | "cleanup-stale";

const statusLabel: Record<Check["status"], string> = { pass: "PASS", warning: "Perlu Dicek", manual: "Butuh Adjust Manual", failed: "Gagal", unavailable: "Tidak Tersedia" };
const statusClass: Record<Check["status"], string> = { pass: "text-emerald-300", warning: "text-amber-300", manual: "text-sky-300", failed: "text-rose-300", unavailable: "text-slate-400" };

function safeDifference(value: Record<string, unknown> | null | undefined) {
  if (!value) return "";
  return Object.entries(value).slice(0, 4).map(([key, item]) => `${key}: ${typeof item === "object" ? "tersedia" : String(item)}`).join(" · ");
}

export function SupervisorAuditPanel() {
  const [period, setPeriod] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [runId, setRunId] = useState("");
  const [audit, setAudit] = useState<Audit>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/supervisor/audit", { cache: "no-store" });
    if (!response.ok) throw new Error("Audit supervisor tidak tersedia.");
    setAudit((await response.json()).audit ?? null);
  }, []);

  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : "Gagal memuat audit.")); }, [load]);

  async function runAudit() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/supervisor/audit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(period ? { period } : {}) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Audit gagal.");
      setAudit(payload); setMessage("Audit selesai. Output hanya berisi diagnostic aman.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Audit gagal."); } finally { setBusy(false); }
  }

  async function runAction(action: Action) {
    if (!period) { setMessage("Periode wajib untuk aksi scoped."); return; }
    if (!window.confirm(`Konfirmasi aksi supervisor: ${action} untuk ${period}?`)) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/supervisor/audit/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, period, accountCode: accountCode || undefined, runId: runId || undefined, confirmed: true }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Aksi diblokir.");
      setMessage(`Aksi ${action} berhasil dicatat pada audit log.`); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Aksi gagal."); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-5 rounded-2xl border border-white/10 bg-slate-950/30 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-base font-semibold text-slate-100">Audit & Sinkronisasi</h2><p className="mt-1 text-sm text-slate-400">Pemeriksaan read-only lintas modul. Write selalu scoped dan membutuhkan konfirmasi.</p></div>
        <div className="flex gap-2"><Button type="button" variant="outline" onClick={() => void runAudit()} disabled={busy}><Play className="mr-2 h-4 w-4" />Cek Semua Data</Button><Button type="button" variant="outline" onClick={() => window.open("/api/supervisor/audit/export", "_blank")}><Download className="mr-2 h-4 w-4" />Export Audit</Button></div>
      </div>
      <div className="grid gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 md:grid-cols-4">
        <label className="text-xs text-slate-400">Periode<input className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-slate-200" placeholder="2026-07" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
        <label className="text-xs text-slate-400">Akun (cleanup/retry)<input className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-slate-200" placeholder="opsional" value={accountCode} onChange={(event) => setAccountCode(event.target.value)} /></label>
        <label className="text-xs text-slate-400">Run ID (retry)<input className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-slate-200" placeholder="opsional" value={runId} onChange={(event) => setRunId(event.target.value)} /></label>
        <div className="flex items-end"><Button type="button" className="w-full" disabled={busy || !period} onClick={() => void runAction("reconcile")}>Reconcile Ulang</Button></div>
      </div>
      <div className="flex flex-wrap gap-2">
        {(["sync-period", "retry-failed", "cleanup-stale"] as Action[]).map((action) => <Button key={action} type="button" variant="outline" disabled={busy || !period} onClick={() => void runAction(action)}>{action === "sync-period" ? "Sync Ulang Periode" : action === "retry-failed" ? "Retry Akun Gagal" : "Cleanup Confirmed Stale"}</Button>)}
      </div>
      {message && <p className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-sm text-slate-300">{message}</p>}
      {audit && <>
        <div className="grid gap-2 sm:grid-cols-5">{(["pass", "warning", "manual", "failed", "unavailable"] as Check["status"][]).map((status) => <div key={status} className="rounded-lg border border-white/10 p-3"><div className={`text-xs font-semibold ${statusClass[status]}`}>{statusLabel[status]}</div><div className="mt-1 text-xl font-semibold text-slate-100">{audit.summary[status] ?? 0}</div></div>)}</div>
        <div className="overflow-x-auto rounded-xl border border-white/10"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-white/[0.04] text-xs uppercase text-slate-500"><tr><th className="p-3">Modul</th><th className="p-3">Pemeriksaan</th><th className="p-3">Status</th><th className="p-3">Diagnostic aman</th></tr></thead><tbody>{audit.checks.map((check) => <tr key={check.id} className="border-t border-white/5"><td className="p-3 text-slate-400">{check.module}</td><td className="p-3 text-slate-200">{check.subject ?? check.id}</td><td className={`p-3 font-medium ${statusClass[check.status]}`}>{check.status === "pass" ? <CheckCircle2 className="mr-1 inline h-4 w-4" /> : check.status === "failed" ? <XCircle className="mr-1 inline h-4 w-4" /> : <ShieldAlert className="mr-1 inline h-4 w-4" />}{statusLabel[check.status]}</td><td className="p-3 text-slate-400">{safeDifference(check.difference) || check.recommendation}</td></tr>)}</tbody></table></div>
      </>}
    </div>
  );
}
