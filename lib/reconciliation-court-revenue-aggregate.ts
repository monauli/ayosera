// Rollup Level 1 (Bulanan) & Level 2 (Harian) dari findings Level 3 (per
// tanggal+court) — lib/reconciliation-court-revenue-source.ts. MURNI (tanpa
// MongoDB), dipakai bersama oleh API dan Excel export supaya angka yang
// ditampilkan SELALU konsisten (satu jalur agregasi, bukan dihitung ulang
// beda cara di tiap tempat).
import { classifyCourtRevenueRootCause, type RootCauseResult } from "./reconciliation-root-cause.ts";
import type { CourtRevenueFinding } from "./reconciliation-court-revenue-source.ts";
import { statusSeverity, type ReconciliationStatus } from "./reconciliation-types.ts";

export type CourtRevenueFindingWithRootCause = CourtRevenueFinding & { rootCause: RootCauseResult | null };

/** Lampirkan klasifikasi root cause (Bagian E) ke tiap finding — tidak mengubah finding lain. */
export function attachRootCause(findings: CourtRevenueFinding[]): CourtRevenueFindingWithRootCause[] {
  return findings.map((finding) => ({
    ...finding,
    rootCause: classifyCourtRevenueRootCause(
      { status: finding.status, courtKey: finding.courtKey, diagnostics: finding.diagnostics },
      {
        // Source adapter sudah menghitung kedua sisi pada bucket yang sama.
        // Teruskan sinyal ini agar pola beberapa slot AYO yang dibayar dalam
        // lebih sedikit transaksi Olsera diklasifikasikan sebagai
        // BOOKING_MULTI_SLOT, bukan ditebak sebagai root cause generik.
        ayoBookingCount: finding.sourceRefs.ayoBookingCount,
        olseraOrderCount: finding.sourceRefs.olseraOrderCount,
      },
    ),
  }));
}

/** Status "terburuk" (severity tertinggi) di antara sekumpulan finding — dasar status level Harian/Bulanan. */
export function worstFindingStatus(findings: Array<Pick<CourtRevenueFinding, "status">>): ReconciliationStatus {
  if (findings.length === 0) return "NOT_CHECKED";
  return findings.reduce<ReconciliationStatus>((worst, f) => (statusSeverity(f.status) > statusSeverity(worst) ? f.status : worst), findings[0].status);
}

export type StatusCounts = Partial<Record<ReconciliationStatus, number>>;

function countByStatus(findings: Array<Pick<CourtRevenueFinding, "status">>): StatusCounts {
  const counts: StatusCounts = {};
  for (const f of findings) counts[f.status] = (counts[f.status] ?? 0) + 1;
  return counts;
}

export type DailyRollup = {
  date: string;
  ayoRevenue: number;
  olseraRevenue: number;
  difference: number;
  status: ReconciliationStatus;
  statusCounts: StatusCounts;
  courts: CourtRevenueFindingWithRootCause[];
};

/** Level 2 (Harian) — kelompokkan findings Level 3 per tanggal. */
export function buildDailyRollups(findings: CourtRevenueFindingWithRootCause[]): DailyRollup[] {
  const byDate = new Map<string, CourtRevenueFindingWithRootCause[]>();
  for (const f of findings) {
    const list = byDate.get(f.date) ?? [];
    list.push(f);
    byDate.set(f.date, list);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, courts]) => {
      const ayoRevenue = courts.reduce((sum, c) => sum + c.ayoRevenue, 0);
      const olseraRevenue = courts.reduce((sum, c) => sum + c.olseraRevenue, 0);
      return {
        date,
        ayoRevenue,
        olseraRevenue,
        difference: olseraRevenue - ayoRevenue,
        status: worstFindingStatus(courts),
        statusCounts: countByStatus(courts),
        courts: [...courts].sort((a, b) => a.courtKey.localeCompare(b.courtKey)),
      };
    });
}

export type MonthlyRollup = {
  period: string; // YYYY-MM
  ayoRevenue: number;
  olseraRevenue: number;
  difference: number;
  differencePercent: number | null; // null bila ayoRevenue 0 (hindari div/0)
  status: ReconciliationStatus;
  statusCounts: StatusCounts;
  matchCount: number;
  mismatchCount: number;
  manualReviewCount: number;
  auditedAt: Date;
};

/** Level 1 (Bulanan) — total dari seluruh findings Level 3 dalam satu periode. */
export function buildMonthlyRollup(period: string, findings: CourtRevenueFindingWithRootCause[], auditedAt: Date): MonthlyRollup {
  const ayoRevenue = findings.reduce((sum, f) => sum + f.ayoRevenue, 0);
  const olseraRevenue = findings.reduce((sum, f) => sum + f.olseraRevenue, 0);
  const difference = olseraRevenue - ayoRevenue;
  const statusCounts = countByStatus(findings);
  return {
    period,
    ayoRevenue,
    olseraRevenue,
    difference,
    differencePercent: ayoRevenue !== 0 ? (difference / ayoRevenue) * 100 : null,
    status: worstFindingStatus(findings),
    statusCounts,
    matchCount: (statusCounts.MATCH ?? 0) + (statusCounts.MINOR_DIFFERENCE ?? 0),
    mismatchCount: statusCounts.MISMATCH ?? 0,
    manualReviewCount: findings.filter((f) => f.status === "BUTUH_ADJUST_MANUAL" || f.status === "AMBIGUOUS").length,
    auditedAt,
  };
}

export type RootCauseSummaryRow = { rootCauseId: string; label: string; confidence: string; caseCount: number; totalAbsDifference: number; period: string };

/** Bagian E — ringkas root cause lintas seluruh finding non-match (evidence WAJIB: jumlah kasus + nominal, lihat docs). */
export function summarizeRootCauses(period: string, findings: CourtRevenueFindingWithRootCause[]): RootCauseSummaryRow[] {
  const byId = new Map<string, RootCauseSummaryRow>();
  for (const f of findings) {
    if (!f.rootCause) continue;
    const key = `${f.rootCause.rootCauseId}:${f.rootCause.confidence}`;
    const row = byId.get(key) ?? { rootCauseId: f.rootCause.rootCauseId, label: f.rootCause.label, confidence: f.rootCause.confidence, caseCount: 0, totalAbsDifference: 0, period };
    row.caseCount += 1;
    row.totalAbsDifference += Math.abs(f.olseraRevenue - f.ayoRevenue);
    byId.set(key, row);
  }
  return [...byId.values()].sort((a, b) => b.caseCount - a.caseCount);
}
