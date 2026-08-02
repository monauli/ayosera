"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

type CourtRow = {
  date: string;
  courtKey: string;
  status: string;
  impact: string;
  confidence: string;
  ayoRevenue: number;
  olseraRevenue: number;
  difference: number;
  diagnostics: Record<string, unknown>;
  rootCause: { rootCauseId: string; label: string; confidence: string; evidence: string } | null;
};

type DailyRow = { date: string; ayoRevenue: number; olseraRevenue: number; difference: number; status: string; courts: CourtRow[] };

type Monthly = {
  ayoRevenue: number;
  olseraRevenue: number;
  difference: number;
  differencePercent: number | null;
  status: string;
  matchCount: number;
  mismatchCount: number;
  manualReviewCount: number;
};

type Summary = { monthly: Monthly; daily: DailyRow[]; court: CourtRow[]; rootCauses: Array<{ rootCauseId: string; label: string; confidence: string; caseCount: number; totalAbsDifference: number }> } | null;

type PersistedFinding = { _id: string; runId: string; domain: string; entityKey: string; period: string; status: string };

type ManualReviewItem = { source: string; id: string; domain: string; domainLabel: string; period: string; status: string; reason: string; recommendedAction: string };

type HourlyRow = { hour: number; ayoRevenue: number; ayoCount: number; olseraRevenue: number; olseraCount: number };
type Candidate = { bookingId: string | null; orderNo: string | null; amount: number | null; ayoTime: string | null; olseraTime: string | null; status: string; mappingConfidence: string | null };

const rupiah = (value: number) => `Rp${value.toLocaleString("id-ID")}`;
const STATUS_OPTIONS = ["MATCH", "MINOR_DIFFERENCE", "MISMATCH", "MISSING_IN_AYO", "MISSING_IN_OLSERA", "AMBIGUOUS", "BUTUH_ADJUST_MANUAL", "NOT_CHECKED"];
const CONFIDENCE_OPTIONS = ["HIGH", "MEDIUM", "LOW"];
const STATUS_TONE: Record<string, string> = {
  MATCH: "text-emerald-300",
  MINOR_DIFFERENCE: "text-emerald-300",
  MISMATCH: "text-rose-300",
  MISSING_IN_AYO: "text-amber-300",
  MISSING_IN_OLSERA: "text-amber-300",
  AMBIGUOUS: "text-sky-300",
  BUTUH_ADJUST_MANUAL: "text-sky-300",
  NOT_CHECKED: "text-slate-400",
};

export function CourtRevenueReconciliation({ period }: { period: string }) {
  const [summary, setSummary] = useState<Summary>(null);
  const [persisted, setPersisted] = useState<Map<string, PersistedFinding>>(new Map());
  const [manualReview, setManualReview] = useState<ManualReviewItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [drilldownKey, setDrilldownKey] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<{ hourly: HourlyRow[]; candidates: Candidate[] } | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [courtFilter, setCourtFilter] = useState("");
  const [confidenceFilter, setConfidenceFilter] = useState("");
  const [mismatchOnly, setMismatchOnly] = useState(false);

  const loadSummary = useCallback(async () => {
    if (!/^\d{4}-\d{2}$/.test(period)) return;
    const response = await fetch(`/api/supervisor/audit/court-revenue?period=${period}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? "Gagal memuat rekonsiliasi AYO vs Olsera.");
    setSummary({ monthly: payload.monthly, daily: payload.daily, court: payload.court, rootCauses: payload.rootCauses });
  }, [period]);

  const loadPersisted = useCallback(async () => {
    if (!/^\d{4}-\d{2}$/.test(period)) return;
    const response = await fetch(`/api/reconciliation/findings?reconciliationType=CROSS_SYSTEM_COURT_REVENUE&limit=200&sort=period&sortDir=desc`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    const map = new Map<string, PersistedFinding>();
    for (const f of (payload.data ?? []) as PersistedFinding[]) {
      if (!f.period.startsWith(period)) continue;
      map.set(`${f.period}|${f.entityKey}`, f);
    }
    setPersisted(map);
  }, [period]);

  const loadManualReview = useCallback(async () => {
    const response = await fetch("/api/supervisor/audit/court-revenue/manual-review", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    setManualReview(payload.items ?? []);
  }, []);

  useEffect(() => {
    void loadSummary().catch((error) => setMessage(error instanceof Error ? error.message : "Gagal memuat."));
    void loadPersisted();
  }, [loadSummary, loadPersisted]);

  useEffect(() => {
    void loadManualReview();
  }, [loadManualReview]);

  async function runAuditUlang() {
    if (!window.confirm(`Jalankan Audit Ulang rekonsiliasi AYO vs Olsera untuk periode ${period}? Ini akan menyimpan hasil finding (read-only terhadap data sumber).`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/supervisor/audit/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "court-revenue-audit-run", period, confirmed: true }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Audit ulang gagal.");
      setMessage(`Audit ulang selesai: ${payload.result.daysAudited} hari diperiksa, ${payload.result.totalFindings} finding.`);
      await Promise.all([loadSummary(), loadPersisted(), loadManualReview()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Audit ulang gagal.");
    } finally {
      setBusy(false);
    }
  }

  async function markFinding(finding: PersistedFinding, action: "checked" | "manual-adjust") {
    const decision = action === "checked" ? "CONFIRMED_FINDING" : "REQUIRES_MANUAL_ADJUSTMENT";
    const reasonCode = action === "checked" ? "VERIFIED_CORRECT" : "OTHER";
    let note: string | null = null;
    if (action === "manual-adjust") {
      note = window.prompt("Catatan wajib: kenapa item ini butuh adjust manual?");
      if (!note || !note.trim()) return;
    }
    if (!window.confirm(`Konfirmasi: tandai finding ini "${action === "checked" ? "Sudah Dicek" : "Butuh Adjust Manual"}"?`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/reconciliation/findings/${finding._id}/resolution`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ runId: finding.runId, domain: finding.domain, entityKey: finding.entityKey, decision, reasonCode, note }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Aksi gagal.");
      setMessage("Status finding diperbarui dan dicatat di audit log.");
      await loadManualReview();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Aksi gagal.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleDrilldown(date: string, court: string) {
    const key = `${date}|${court}`;
    if (drilldownKey === key) {
      setDrilldownKey(null);
      setDrilldown(null);
      return;
    }
    setDrilldownKey(key);
    setDrilldown(null);
    const response = await fetch(`/api/supervisor/audit/court-revenue/drilldown?date=${date}&court=${encodeURIComponent(court)}`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    setDrilldown({ hourly: payload.hourly ?? [], candidates: payload.candidates ?? [] });
  }

  const courtKeys = useMemo(() => Array.from(new Set((summary?.court ?? []).map((c) => c.courtKey))).sort(), [summary]);

  const filteredDaily = useMemo(() => {
    if (!summary) return [];
    return summary.daily
      .map((day) => ({
        ...day,
        courts: day.courts.filter((c) => {
          if (statusFilter && c.status !== statusFilter) return false;
          if (courtFilter && c.courtKey !== courtFilter) return false;
          if (confidenceFilter && c.confidence !== confidenceFilter) return false;
          if (mismatchOnly && (c.status === "MATCH" || c.status === "MINOR_DIFFERENCE" || c.status === "NOT_CHECKED")) return false;
          return true;
        }),
      }))
      .filter((day) => day.courts.length > 0);
  }, [summary, statusFilter, courtFilter, confidenceFilter, mismatchOnly]);

  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-slate-950/30 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-100">Rekonsiliasi AYO vs Olsera</h3>
          <p className="mt-1 text-sm text-slate-400">Omzet lapangan (court fee) — hari/court dihitung langsung dari data terkini. Periode: {period || "-"}</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={busy || !period} onClick={() => void runAuditUlang()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}Audit Ulang
          </Button>
          <Button type="button" variant="outline" disabled={!period} onClick={() => window.open(`/api/supervisor/audit/court-revenue/export?period=${period}`, "_blank")}>
            <Download className="mr-2 h-4 w-4" />Export Hasil Audit
          </Button>
        </div>
      </div>

      {message && <p className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-sm text-slate-300">{message}</p>}

      {summary && (
        <>
          <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <SummaryCard label="Total AYO" value={rupiah(summary.monthly.ayoRevenue)} />
            <SummaryCard label="Total Olsera" value={rupiah(summary.monthly.olseraRevenue)} />
            <SummaryCard label="Selisih" value={rupiah(summary.monthly.difference)} />
            <SummaryCard label="Selisih %" value={summary.monthly.differencePercent === null ? "-" : `${summary.monthly.differencePercent.toFixed(2)}%`} />
            <SummaryCard label="MATCH" value={String(summary.monthly.matchCount)} tone="text-emerald-300" />
            <SummaryCard label="MISMATCH" value={String(summary.monthly.mismatchCount)} tone="text-rose-300" />
            <SummaryCard label="Butuh Tinjauan" value={String(summary.monthly.manualReviewCount)} tone="text-sky-300" />
          </div>

          <div className="grid gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 md:grid-cols-4">
            <label className="text-xs text-slate-400">
              Status
              <select className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-slate-200" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">Semua</option>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="text-xs text-slate-400">
              Court
              <select className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-slate-200" value={courtFilter} onChange={(e) => setCourtFilter(e.target.value)}>
                <option value="">Semua</option>
                {courtKeys.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="text-xs text-slate-400">
              Confidence
              <select className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-slate-200" value={confidenceFilter} onChange={(e) => setConfidenceFilter(e.target.value)}>
                <option value="">Semua</option>
                {CONFIDENCE_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="mt-5 flex items-center gap-2 text-xs text-slate-400">
              <input type="checkbox" checked={mismatchOnly} onChange={(e) => setMismatchOnly(e.target.checked)} />
              Hanya mismatch/butuh tinjauan
            </label>
          </div>

          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-white/[0.04] text-xs uppercase text-slate-500">
                <tr>
                  <th className="p-3" />
                  <th className="p-3">Tanggal</th>
                  <th className="p-3">Omzet AYO</th>
                  <th className="p-3">Omzet Olsera</th>
                  <th className="p-3">Selisih</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredDaily.map((day) => (
                  <>
                    <tr key={day.date} className="cursor-pointer border-t border-white/5 hover:bg-white/[0.02]" onClick={() => setExpandedDate(expandedDate === day.date ? null : day.date)}>
                      <td className="p-3 text-slate-500">{expandedDate === day.date ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                      <td className="p-3 text-slate-200">{day.date}</td>
                      <td className="p-3 text-slate-300">{rupiah(day.ayoRevenue)}</td>
                      <td className="p-3 text-slate-300">{rupiah(day.olseraRevenue)}</td>
                      <td className="p-3 text-slate-300">{rupiah(day.difference)}</td>
                      <td className={`p-3 font-medium ${STATUS_TONE[day.status] ?? "text-slate-300"}`}>{day.status}</td>
                    </tr>
                    {expandedDate === day.date &&
                      day.courts.map((c) => {
                        const finding = persisted.get(`${c.date}|${c.courtKey}`);
                        const key = `${c.date}|${c.courtKey}`;
                        return (
                          <>
                            <tr key={key} className="border-t border-white/5 bg-white/[0.015] text-xs">
                              <td className="p-2" />
                              <td className="p-2 pl-6 text-slate-400">{c.courtKey}</td>
                              <td className="p-2 text-slate-400">{rupiah(c.ayoRevenue)}</td>
                              <td className="p-2 text-slate-400">{rupiah(c.olseraRevenue)}</td>
                              <td className="p-2 text-slate-400">{rupiah(c.difference)}</td>
                              <td className={`p-2 font-medium ${STATUS_TONE[c.status] ?? "text-slate-400"}`}>
                                {c.status}
                                {c.rootCause && <div className="mt-0.5 text-[11px] font-normal text-slate-500">{c.rootCause.label} ({c.rootCause.confidence})</div>}
                                <div className="mt-1 flex flex-wrap gap-1">
                                  <button type="button" className="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-white/5" onClick={() => void toggleDrilldown(c.date, c.courtKey)}>
                                    Detail Jam/Booking
                                  </button>
                                  {finding ? (
                                    <>
                                      <button type="button" disabled={busy} className="rounded border border-emerald-400/30 px-1.5 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-400/10" onClick={() => void markFinding(finding, "checked")}>
                                        Tandai Sudah Dicek
                                      </button>
                                      <button type="button" disabled={busy} className="rounded border border-sky-400/30 px-1.5 py-0.5 text-[11px] text-sky-300 hover:bg-sky-400/10" onClick={() => void markFinding(finding, "manual-adjust")}>
                                        Tandai Butuh Adjust Manual
                                      </button>
                                    </>
                                  ) : (
                                    <span className="text-[11px] text-slate-600">Jalankan Audit Ulang untuk mengaktifkan aksi.</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {drilldownKey === key && drilldown && (
                              <tr key={`${key}-drilldown`} className="border-t border-white/5 bg-black/20">
                                <td colSpan={6} className="p-3">
                                  <div className="grid gap-3 md:grid-cols-2">
                                    <div>
                                      <div className="mb-1 text-[11px] uppercase text-slate-500">Level 4 — Per Jam (AYO=jam mulai, Olsera=jam order)</div>
                                      <table className="w-full text-[11px]">
                                        <thead className="text-slate-500"><tr><th className="p-1 text-left">Jam</th><th className="p-1 text-right">AYO</th><th className="p-1 text-right">Olsera</th></tr></thead>
                                        <tbody>
                                          {drilldown.hourly.map((h) => (
                                            <tr key={h.hour} className="border-t border-white/5"><td className="p-1">{h.hour}:00</td><td className="p-1 text-right text-slate-400">{rupiah(h.ayoRevenue)} ({h.ayoCount})</td><td className="p-1 text-right text-slate-400">{rupiah(h.olseraRevenue)} ({h.olseraCount})</td></tr>
                                          ))}
                                          {drilldown.hourly.length === 0 && <tr><td colSpan={3} className="p-1 text-slate-600">Tidak ada data.</td></tr>}
                                        </tbody>
                                      </table>
                                    </div>
                                    <div>
                                      <div className="mb-1 text-[11px] uppercase text-slate-500">Level 5 — Kandidat Booking/Transaksi (bukan match pasti)</div>
                                      <table className="w-full text-[11px]">
                                        <thead className="text-slate-500"><tr><th className="p-1 text-left">Booking</th><th className="p-1 text-left">Order Olsera</th><th className="p-1 text-right">Nominal</th><th className="p-1">Status</th><th className="p-1">Confidence</th></tr></thead>
                                        <tbody>
                                          {drilldown.candidates.map((c2, i) => (
                                            <tr key={i} className="border-t border-white/5">
                                              <td className="p-1 text-slate-400">{c2.bookingId ?? "-"}</td>
                                              <td className="p-1 text-slate-400">{c2.orderNo ?? "-"}</td>
                                              <td className="p-1 text-right text-slate-400">{c2.amount === null ? "-" : rupiah(c2.amount)}</td>
                                              <td className="p-1 text-slate-400">{c2.status}</td>
                                              <td className="p-1 text-slate-400">{c2.mappingConfidence ?? "-"}</td>
                                            </tr>
                                          ))}
                                          {drilldown.candidates.length === 0 && <tr><td colSpan={5} className="p-1 text-slate-600">Tidak ada data.</td></tr>}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })}
                  </>
                ))}
                {filteredDaily.length === 0 && (
                  <tr><td colSpan={6} className="p-4 text-center text-slate-500">Tidak ada data untuk filter ini.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {manualReview && manualReview.length > 0 && (
        <div className="rounded-xl border border-white/10">
          <div className="border-b border-white/10 p-3 text-sm font-semibold text-slate-200">Butuh Adjust Manual — Lintas Domain ({manualReview.length})</div>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full min-w-[700px] text-left text-xs">
              <thead className="bg-white/[0.04] uppercase text-slate-500"><tr><th className="p-2">Domain</th><th className="p-2">Periode</th><th className="p-2">Status</th><th className="p-2">Alasan</th><th className="p-2">Rekomendasi</th></tr></thead>
              <tbody>
                {manualReview.map((item) => (
                  <tr key={item.id} className="border-t border-white/5">
                    <td className="p-2 text-slate-300">{item.domainLabel}</td>
                    <td className="p-2 text-slate-400">{item.period}</td>
                    <td className="p-2 text-slate-400">{item.status}</td>
                    <td className="p-2 text-slate-400">{item.reason}</td>
                    <td className="p-2 text-slate-400">{item.recommendedAction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-white/10 p-3">
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className={`mt-1 text-base font-semibold ${tone ?? "text-slate-100"}`}>{value}</div>
    </div>
  );
}
