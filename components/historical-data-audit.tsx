"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2, PlayCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

type IssueStatus = "selesai" | "pending" | "manual";
type Confidence = "HIGH" | "MEDIUM" | "LOW";

type HistoricalIssue = {
  id: string;
  category: string;
  categoryLabel: string;
  period: string;
  issue: string;
  penyebab: string;
  confidence: Confidence;
  canAutoFix: boolean;
  tindakan: string;
  status: IssueStatus;
  jumlahData: number;
};

type HistoricalCategory = { category: string; categoryLabel: string; periode: string; jumlahData: number; penyebab: string; dampak: string; canAutoFix: boolean; confidence: Confidence };

type Summary = {
  generatedAt: string;
  totalIssues: number;
  autoFixable: number;
  manual: number;
  selesai: number;
  pending: number;
  categories: HistoricalCategory[];
  issues: HistoricalIssue[];
} | null;

type BackfillResult = { runId: string; dryRun: boolean; planned: number; updated: number; skippedAlreadyFilled: number; sample: Array<{ orderItemId: number; before: unknown; after: unknown }> };

const STATUS_TONE: Record<IssueStatus, string> = { selesai: "text-emerald-300", pending: "text-sky-300", manual: "text-amber-300" };
const STATUS_LABEL: Record<IssueStatus, string> = { selesai: "Selesai", pending: "Pending", manual: "Manual" };

export function HistoricalDataAudit() {
  const [summary, setSummary] = useState<Summary>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<BackfillResult | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [confidenceFilter, setConfidenceFilter] = useState("");

  const loadSummary = useCallback(async () => {
    const response = await fetch("/api/supervisor/audit/historical-data", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? "Gagal memuat audit data historis.");
    setSummary(payload);
  }, []);

  useEffect(() => {
    void loadSummary().catch((error) => setMessage(error instanceof Error ? error.message : "Gagal memuat."));
  }, [loadSummary]);

  const categories = useMemo(() => Array.from(new Set((summary?.issues ?? []).map((i) => i.categoryLabel))).sort(), [summary]);

  const filteredIssues = useMemo(() => {
    if (!summary) return [];
    return summary.issues.filter((i) => {
      if (categoryFilter && i.categoryLabel !== categoryFilter) return false;
      if (statusFilter && i.status !== statusFilter) return false;
      if (confidenceFilter && i.confidence !== confidenceFilter) return false;
      return true;
    });
  }, [summary, categoryFilter, statusFilter, confidenceFilter]);

  async function previewBackfill() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/supervisor/audit/historical-data/backfill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Preview backfill gagal.");
      setPreview(payload);
      setMessage(`Preview: ${payload.planned} baris HIGH CONFIDENCE (Exact Match) siap dibackfill. Tinjau contoh di bawah sebelum menjalankan.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Preview backfill gagal.");
    } finally {
      setBusy(false);
    }
  }

  async function runBackfill() {
    if (!preview || preview.planned === 0) return;
    if (!window.confirm(`Jalankan backfill untuk ${preview.planned} baris HIGH CONFIDENCE (Exact Match)? Hanya productId/variantId/sku yang diisi — TIDAK mengubah amount/qty/formula, dan reversibel lewat audit log.`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/supervisor/audit/historical-data/backfill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: false, confirmed: true }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Backfill gagal.");
      setMessage(`Backfill selesai: ${payload.updated} baris diperbarui, ${payload.skippedAlreadyFilled} dilewati (sudah terisi sebelumnya).`);
      setPreview(null);
      await loadSummary();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Backfill gagal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-slate-950/30 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-100">Historical Data</h3>
          <p className="mt-1 text-sm text-slate-400">Audit 8 kategori data historis (Milestone 4) — read-only, dihitung langsung dari data terkini.</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void previewBackfill()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}Preview Backfill (Dry Run)
          </Button>
          <Button type="button" variant="outline" onClick={() => window.open("/api/supervisor/audit/historical-data/export", "_blank")}>
            <Download className="mr-2 h-4 w-4" />Export Historical Audit
          </Button>
        </div>
      </div>

      {message && <p className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-sm text-slate-300">{message}</p>}

      {preview && preview.planned > 0 && (
        <div className="rounded-xl border border-sky-400/30 bg-sky-400/5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-slate-200">
              {preview.planned} baris siap dibackfill (HIGH CONFIDENCE, Exact Match saja). Contoh {Math.min(preview.sample.length, 5)} dari {preview.planned}:
            </div>
            <Button type="button" disabled={busy} onClick={() => void runBackfill()}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}Jalankan Backfill
            </Button>
          </div>
          <ul className="mt-2 space-y-1 text-xs text-slate-400">
            {preview.sample.slice(0, 5).map((s) => (
              <li key={s.orderItemId}>orderItemId {s.orderItemId}: {JSON.stringify(s.before)} → {JSON.stringify(s.after)}</li>
            ))}
          </ul>
        </div>
      )}

      {summary && (
        <>
          <div className="grid gap-2 sm:grid-cols-5">
            <SummaryCard label="Total Issue" value={String(summary.totalIssues)} />
            <SummaryCard label="Auto Fixable" value={String(summary.autoFixable)} tone="text-sky-300" />
            <SummaryCard label="Manual" value={String(summary.manual)} tone="text-amber-300" />
            <SummaryCard label="Selesai" value={String(summary.selesai)} tone="text-emerald-300" />
            <SummaryCard label="Pending" value={String(summary.pending)} tone="text-sky-300" />
          </div>

          <div className="grid gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 md:grid-cols-3">
            <label className="text-xs text-slate-400">
              Kategori
              <select className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-slate-200" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                <option value="">Semua</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="text-xs text-slate-400">
              Status
              <select className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-slate-200" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">Semua</option>
                <option value="pending">Pending</option>
                <option value="manual">Manual</option>
                <option value="selesai">Selesai</option>
              </select>
            </label>
            <label className="text-xs text-slate-400">
              Confidence
              <select className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-slate-200" value={confidenceFilter} onChange={(e) => setConfidenceFilter(e.target.value)}>
                <option value="">Semua</option>
                <option value="HIGH">HIGH</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="LOW">LOW</option>
              </select>
            </label>
          </div>

          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-white/[0.04] text-xs uppercase text-slate-500">
                <tr>
                  <th className="p-3">Kategori</th>
                  <th className="p-3">Issue</th>
                  <th className="p-3">Penyebab</th>
                  <th className="p-3">Confidence</th>
                  <th className="p-3">Tindakan</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredIssues.map((issue) => (
                  <tr key={issue.id} className="border-t border-white/5">
                    <td className="p-3 text-slate-300">{issue.categoryLabel}</td>
                    <td className="p-3 text-slate-200">{issue.issue}</td>
                    <td className="p-3 text-slate-400">{issue.penyebab}</td>
                    <td className="p-3 text-slate-400">{issue.confidence}</td>
                    <td className="p-3 text-slate-400">{issue.tindakan}</td>
                    <td className={`p-3 font-medium ${STATUS_TONE[issue.status]}`}>{STATUS_LABEL[issue.status]}</td>
                  </tr>
                ))}
                {filteredIssues.length === 0 && (
                  <tr><td colSpan={6} className="p-4 text-center text-slate-500">Tidak ada data untuk filter ini.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-white/10 p-3">
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${tone ?? "text-slate-100"}`}>{value}</div>
    </div>
  );
}
