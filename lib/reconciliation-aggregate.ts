// Helper agregasi status Modul Rekonsiliasi (Phase 5A) — murni, tanpa MongoDB.
// Dipakai untuk menghitung ringkasan (reconciliation_runs.summary) dari daftar
// finding, dan untuk validasi keras bahwa CROSS_SYSTEM_COURT_REVENUE tidak
// pernah tercampur dengan INTERNAL_OLSERA dalam satu run/agregat.
import {
  confidenceRank,
  impactRank,
  isFinalStatus,
  isMatchLike,
  requiresManualAdjustment,
  validateDomainForType,
  type ReconciliationConfidence,
  type ReconciliationDomain,
  type ReconciliationImpact,
  type ReconciliationStatus,
  type ReconciliationType,
} from "./reconciliation-types.ts";

export type FindingLike = {
  reconciliationType: ReconciliationType;
  domain: ReconciliationDomain;
  status: ReconciliationStatus;
};

/** Finding + impact/confidence (WAJIB pada finding sungguhan) — dipakai helper agregasi Impact/Confidence & summarizeRun. */
export type FindingWithImpactConfidence = FindingLike & {
  impact: ReconciliationImpact;
  confidence: ReconciliationConfidence;
};

export type StatusCounts = Partial<Record<ReconciliationStatus, number>>;

export function emptyStatusCounts(): StatusCounts {
  return {};
}

export function tallyStatus(counts: StatusCounts, status: ReconciliationStatus): StatusCounts {
  return { ...counts, [status]: (counts[status] ?? 0) + 1 };
}

/**
 * Pagar keras: lempar error bila ada finding yang domain-nya TIDAK VALID untuk
 * reconciliationType yang dinyatakan, atau bila daftar finding mencampur lebih
 * dari satu reconciliationType sekaligus (CROSS_SYSTEM_COURT_REVENUE dan
 * INTERNAL_OLSERA WAJIB diagregasi terpisah, tidak pernah dalam satu panggilan).
 */
export function assertHomogeneousReconciliationType(findings: FindingLike[]): ReconciliationType | null {
  if (findings.length === 0) return null;
  const type = findings[0].reconciliationType;
  for (const finding of findings) {
    if (finding.reconciliationType !== type) {
      throw new Error(
        `reconciliation-aggregate: ditemukan campuran reconciliationType (${type} vs ${finding.reconciliationType}) dalam satu agregat — CROSS_SYSTEM_COURT_REVENUE dan INTERNAL_OLSERA tidak boleh digabung.`,
      );
    }
    if (!validateDomainForType(finding.reconciliationType, finding.domain)) {
      throw new Error(`reconciliation-aggregate: domain "${finding.domain}" tidak valid untuk reconciliationType "${finding.reconciliationType}".`);
    }
  }
  return type;
}

export function aggregateByDomain(findings: FindingLike[]): Partial<Record<ReconciliationDomain, StatusCounts>> {
  assertHomogeneousReconciliationType(findings);
  const result: Partial<Record<ReconciliationDomain, StatusCounts>> = {};
  for (const finding of findings) {
    result[finding.domain] = tallyStatus(result[finding.domain] ?? {}, finding.status);
  }
  return result;
}

export function aggregateByStatus(findings: FindingLike[]): StatusCounts {
  assertHomogeneousReconciliationType(findings);
  let counts: StatusCounts = {};
  for (const finding of findings) counts = tallyStatus(counts, finding.status);
  return counts;
}

export type ImpactCounts = Partial<Record<ReconciliationImpact, number>>;
export type ConfidenceCounts = Partial<Record<ReconciliationConfidence, number>>;

/**
 * Impact TERTINGGI di antara sekumpulan finding (CRITICAL > ERROR > WARNING >
 * INFO). Dashboard memakai ini untuk menyorot yang paling butuh perhatian.
 * Daftar kosong -> INFO (tidak ada apa-apa untuk disorot).
 */
export function highestImpact(impacts: ReconciliationImpact[]): ReconciliationImpact {
  return impacts.reduce<ReconciliationImpact>((worst, current) => (impactRank(current) > impactRank(worst) ? current : worst), "INFO");
}

/**
 * Confidence keseluruhan = confidence PALING LEMAH di antara sekumpulan
 * finding (LOW < MEDIUM < HIGH) — satu finding LOW TIDAK PERNAH "tertutupi"
 * oleh finding lain yang HIGH. Daftar kosong -> HIGH (tidak ada yang meragukan).
 */
export function overallConfidence(confidences: ReconciliationConfidence[]): ReconciliationConfidence {
  if (confidences.length === 0) return "HIGH";
  return confidences.reduce((weakest, current) => (confidenceRank(current) < confidenceRank(weakest) ? current : weakest));
}

export function summaryImpact(findings: Array<{ impact: ReconciliationImpact }>): { counts: ImpactCounts; highest: ReconciliationImpact } {
  let counts: ImpactCounts = {};
  for (const finding of findings) counts = { ...counts, [finding.impact]: (counts[finding.impact] ?? 0) + 1 };
  return { counts, highest: highestImpact(findings.map((f) => f.impact)) };
}

export function summaryConfidence(findings: Array<{ confidence: ReconciliationConfidence }>): { counts: ConfidenceCounts; overall: ReconciliationConfidence } {
  let counts: ConfidenceCounts = {};
  for (const finding of findings) counts = { ...counts, [finding.confidence]: (counts[finding.confidence] ?? 0) + 1 };
  return { counts, overall: overallConfidence(findings.map((f) => f.confidence)) };
}

export type RunSummary = {
  reconciliationType: ReconciliationType;
  totalFindings: number;
  byStatus: StatusCounts;
  byDomain: Partial<Record<ReconciliationDomain, StatusCounts>>;
  /** AMBIGUOUS + BUTUH_ADJUST_MANUAL — butuh tinjauan manusia. */
  requiresManualAdjustmentCount: number;
  /** MATCH + MINOR_DIFFERENCE. */
  matchLikeCount: number;
  /** NOT_CHECKED — BUKAN bagian dari matchLikeCount, ditampilkan terpisah supaya tidak disalahartikan "aman". */
  notCheckedCount: number;
  /** Status yang sudah "settled" (final=true di STATUS_META). */
  finalCount: number;
  /** Status yang masih butuh perhatian/proses (final=false). */
  nonFinalCount: number;
  /** true bila periode/run ini adalah bulan berjalan (Asia/Jakarta) — hasil BISA berubah sampai bulan ditutup, ditandai non-final di UI. */
  isDraftPeriod: boolean;
  /** Ringkasan impact seluruh finding di run ini — dasar Dashboard/Priority (lihat summaryImpact). */
  impactSummary: ImpactCounts;
  /** Impact tertinggi di run ini (lihat highestImpact) — dipakai menyorot run yang paling butuh perhatian. */
  highestImpact: ReconciliationImpact;
  /** Ringkasan confidence seluruh finding di run ini (lihat summaryConfidence). */
  confidenceSummary: ConfidenceCounts;
  /** Confidence keseluruhan run ini (lihat overallConfidence — paling lemah menang). */
  overallConfidence: ReconciliationConfidence;
};

/**
 * Ringkasan satu run — dipakai mengisi `reconciliation_runs.summary` (bukan
 * dihitung ulang oleh dashboard, lihat docs/reconciliation-design.md §9).
 * Melempar error bila `findings` mencampur reconciliationType (lihat
 * assertHomogeneousReconciliationType).
 */
export function summarizeRun(
  findings: FindingWithImpactConfidence[],
  reconciliationType: ReconciliationType,
  options: { isDraftPeriod?: boolean } = {},
): RunSummary {
  const actualType = assertHomogeneousReconciliationType(findings);
  if (actualType !== null && actualType !== reconciliationType) {
    throw new Error(`reconciliation-aggregate: findings bertipe "${actualType}" tidak cocok dengan reconciliationType run "${reconciliationType}".`);
  }

  const byStatus = aggregateByStatus(findings);
  const byDomain = aggregateByDomain(findings);
  const impact = summaryImpact(findings);
  const confidence = summaryConfidence(findings);

  let requiresManualAdjustmentCount = 0;
  let matchLikeCount = 0;
  let notCheckedCount = 0;
  let finalCount = 0;
  let nonFinalCount = 0;

  for (const finding of findings) {
    if (requiresManualAdjustment(finding.status)) requiresManualAdjustmentCount++;
    if (isMatchLike(finding.status)) matchLikeCount++;
    if (finding.status === "NOT_CHECKED") notCheckedCount++;
    if (isFinalStatus(finding.status)) finalCount++;
    else nonFinalCount++;
  }

  return {
    reconciliationType,
    totalFindings: findings.length,
    byStatus,
    byDomain,
    requiresManualAdjustmentCount,
    matchLikeCount,
    notCheckedCount,
    finalCount,
    nonFinalCount,
    isDraftPeriod: options.isDraftPeriod ?? false,
    impactSummary: impact.counts,
    highestImpact: impact.highest,
    confidenceSummary: confidence.counts,
    overallConfidence: confidence.overall,
  };
}
