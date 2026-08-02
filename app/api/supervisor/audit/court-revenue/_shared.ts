// Helper bersama — GET rekonsiliasi AYO vs Olsera (Milestone 3). SATU jalur
// komputasi dipakai oleh route ringkasan DAN export Excel supaya angka yang
// ditampilkan dan yang diexport SELALU identik (pola sama
// lib/reconciliation-omzet-ledger.ts loadOmzetLedgerMonthSummary/-Detail).
import { NextResponse } from "next/server";
import { loadCourtRevenueFindings } from "@/lib/reconciliation-court-revenue-source";
import { attachRootCause, buildDailyRollups, buildMonthlyRollup, summarizeRootCauses } from "@/lib/reconciliation-court-revenue-aggregate";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

export function jsonError(message: string, status: number) {
  return NextResponse.json({ status: "failed", message }, { status, headers: NO_CACHE_HEADERS });
}

export function parsePeriod(url: URL): string | null {
  const period = url.searchParams.get("period");
  if (!period || !PERIOD_PATTERN.test(period)) return null;
  return period;
}

export function periodToMonthRange(period: string): { start: string; end: string } {
  const [year, month] = period.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return { start: `${period}-01`, end: `${period}-${String(lastDay).padStart(2, "0")}` };
}

/** Bangun seluruh data rekonsiliasi (Level 1-3 + root cause) untuk SATU periode — read-only, live compute. */
export async function buildCourtRevenuePeriodData(period: string) {
  const { start, end } = periodToMonthRange(period);
  const { findings: rawFindings } = await loadCourtRevenueFindings(start, end);
  const findings = attachRootCause(rawFindings);
  const monthly = buildMonthlyRollup(period, findings, new Date());
  const daily = buildDailyRollups(findings);
  const rootCauses = summarizeRootCauses(period, findings);
  return { findings, monthly, daily, rootCauses };
}
