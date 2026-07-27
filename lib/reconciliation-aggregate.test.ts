import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateByDomain,
  aggregateByStatus,
  assertHomogeneousReconciliationType,
  highestImpact,
  overallConfidence,
  summarizeRun,
  summaryConfidence,
  summaryImpact,
  type FindingLike,
  type FindingWithImpactConfidence,
} from "./reconciliation-aggregate.ts";
import { defaultConfidenceForStatus, defaultImpactForStatus } from "./reconciliation-types.ts";

function f(overrides: Partial<FindingLike> = {}): FindingLike {
  return { reconciliationType: "INTERNAL_OLSERA", domain: "CATEGORY", status: "MATCH", ...overrides };
}

/** Sama seperti f(), tapi menambahkan impact/confidence default dari status (dipakai summarizeRun & helper agregasi impact/confidence). */
function fic(overrides: Partial<FindingWithImpactConfidence> = {}): FindingWithImpactConfidence {
  const base = f(overrides);
  return {
    ...base,
    impact: overrides.impact ?? defaultImpactForStatus(base.status),
    confidence: overrides.confidence ?? defaultConfidenceForStatus(base.status),
  };
}

test("aggregateByStatus menghitung tiap status, NOT_CHECKED terhitung terpisah (bukan MATCH)", () => {
  const counts = aggregateByStatus([f({ status: "MATCH" }), f({ status: "MATCH" }), f({ status: "NOT_CHECKED" }), f({ status: "MISMATCH" })]);
  assert.equal(counts.MATCH, 2);
  assert.equal(counts.NOT_CHECKED, 1);
  assert.equal(counts.MISMATCH, 1);
});

test("aggregateByDomain mengelompokkan per domain (domain harus valid untuk reconciliationType)", () => {
  const counts = aggregateByDomain([
    f({ domain: "CATEGORY", status: "MATCH" }),
    f({ domain: "PRODUCT", status: "AMBIGUOUS" }),
    f({ domain: "PRODUCT", status: "MATCH" }),
  ]);
  assert.equal(counts.CATEGORY?.MATCH, 1);
  assert.equal(counts.PRODUCT?.AMBIGUOUS, 1);
  assert.equal(counts.PRODUCT?.MATCH, 1);
});

test("assertHomogeneousReconciliationType melempar error bila CROSS_SYSTEM_COURT_REVENUE tercampur dengan INTERNAL_OLSERA", () => {
  const mixed: FindingLike[] = [
    f({ reconciliationType: "INTERNAL_OLSERA", domain: "CATEGORY" }),
    f({ reconciliationType: "CROSS_SYSTEM_COURT_REVENUE", domain: "COURT_REVENUE" }),
  ];
  assert.throws(() => assertHomogeneousReconciliationType(mixed), /tidak boleh digabung/);
});

test("assertHomogeneousReconciliationType melempar error bila domain tidak valid untuk reconciliationType-nya", () => {
  const invalid: FindingLike[] = [f({ reconciliationType: "CROSS_SYSTEM_COURT_REVENUE", domain: "PRODUCT" })];
  assert.throws(() => assertHomogeneousReconciliationType(invalid), /tidak valid untuk reconciliationType/);
});

test("summarizeRun: ringkasan MATCH-like, requiresManualAdjustment, final/non-final terhitung benar", () => {
  const findings: FindingWithImpactConfidence[] = [
    fic({ status: "MATCH" }),
    fic({ status: "MINOR_DIFFERENCE" }),
    fic({ status: "AMBIGUOUS" }),
    fic({ status: "BUTUH_ADJUST_MANUAL" }),
    fic({ status: "NOT_CHECKED" }),
    fic({ status: "MISMATCH" }),
  ];
  const summary = summarizeRun(findings, "INTERNAL_OLSERA");
  assert.equal(summary.totalFindings, 6);
  assert.equal(summary.matchLikeCount, 2); // MATCH + MINOR_DIFFERENCE
  assert.equal(summary.requiresManualAdjustmentCount, 2); // AMBIGUOUS + BUTUH_ADJUST_MANUAL
  assert.equal(summary.notCheckedCount, 1);
  assert.equal(summary.finalCount, 2); // MATCH + MINOR_DIFFERENCE
  assert.equal(summary.nonFinalCount, 4);
  assert.equal(summary.isDraftPeriod, false);
});

test("summarizeRun: bulan berjalan ditandai non-final via isDraftPeriod, tanpa mengubah status individual", () => {
  const summary = summarizeRun([fic({ status: "MATCH" })], "INTERNAL_OLSERA", { isDraftPeriod: true });
  assert.equal(summary.isDraftPeriod, true);
  assert.equal(summary.byStatus.MATCH, 1); // status individual TETAP MATCH, hanya flag periode yang non-final
});

test("summarizeRun: menolak bila reconciliationType parameter tidak cocok dengan isi findings", () => {
  const findings: FindingWithImpactConfidence[] = [fic({ reconciliationType: "CROSS_SYSTEM_COURT_REVENUE", domain: "COURT_REVENUE" })];
  assert.throws(() => summarizeRun(findings, "INTERNAL_OLSERA"), /tidak cocok dengan reconciliationType run/);
});

test("summarizeRun: CROSS_SYSTEM_COURT_REVENUE diringkas terpisah dari INTERNAL_OLSERA (tidak pernah dalam satu panggilan)", () => {
  const crossSystem: FindingWithImpactConfidence[] = [fic({ reconciliationType: "CROSS_SYSTEM_COURT_REVENUE", domain: "COURT_REVENUE", status: "MATCH" })];
  const internal: FindingWithImpactConfidence[] = [fic({ reconciliationType: "INTERNAL_OLSERA", domain: "PRODUCT", status: "MATCH" })];
  const crossSummary = summarizeRun(crossSystem, "CROSS_SYSTEM_COURT_REVENUE");
  const internalSummary = summarizeRun(internal, "INTERNAL_OLSERA");
  assert.equal(crossSummary.reconciliationType, "CROSS_SYSTEM_COURT_REVENUE");
  assert.equal(internalSummary.reconciliationType, "INTERNAL_OLSERA");
});

// ---- Impact/Confidence: mapping status->impact/confidence -------------------

test("defaultImpactForStatus/defaultConfidenceForStatus: mapping baku sesuai tabel status->impact/confidence", () => {
  assert.equal(defaultImpactForStatus("MATCH"), "INFO");
  assert.equal(defaultConfidenceForStatus("MATCH"), "HIGH");
  assert.equal(defaultImpactForStatus("MINOR_DIFFERENCE"), "WARNING");
  assert.equal(defaultConfidenceForStatus("MINOR_DIFFERENCE"), "HIGH");
  assert.equal(defaultImpactForStatus("MISMATCH"), "ERROR");
  assert.equal(defaultConfidenceForStatus("MISMATCH"), "HIGH");
  assert.equal(defaultImpactForStatus("MISSING_IN_AYO"), "ERROR");
  assert.equal(defaultImpactForStatus("MISSING_IN_OLSERA"), "ERROR");
  assert.equal(defaultImpactForStatus("AMBIGUOUS"), "WARNING");
  assert.equal(defaultConfidenceForStatus("AMBIGUOUS"), "LOW");
  assert.equal(defaultImpactForStatus("BUTUH_ADJUST_MANUAL"), "WARNING");
  assert.equal(defaultConfidenceForStatus("BUTUH_ADJUST_MANUAL"), "LOW");
  assert.equal(defaultImpactForStatus("NOT_CHECKED"), "INFO");
  assert.equal(defaultConfidenceForStatus("NOT_CHECKED"), "LOW");
});

// ---- Impact/Confidence: aggregation -----------------------------------------

test("summaryImpact: menghitung tally per impact dan impact tertinggi (highestImpact)", () => {
  const findings = [fic({ impact: "INFO" }), fic({ impact: "WARNING" }), fic({ impact: "ERROR" }), fic({ impact: "WARNING" })];
  const result = summaryImpact(findings);
  assert.equal(result.counts.INFO, 1);
  assert.equal(result.counts.WARNING, 2);
  assert.equal(result.counts.ERROR, 1);
  assert.equal(result.highest, "ERROR");
});

test("summaryConfidence: menghitung tally per confidence dan confidence keseluruhan (overallConfidence)", () => {
  const findings = [fic({ confidence: "HIGH" }), fic({ confidence: "HIGH" }), fic({ confidence: "MEDIUM" })];
  const result = summaryConfidence(findings);
  assert.equal(result.counts.HIGH, 2);
  assert.equal(result.counts.MEDIUM, 1);
  assert.equal(result.overall, "MEDIUM");
});

test("highestImpact: HIGH (impact) tidak pernah turun menjadi LOW/INFO — CRITICAL selalu mengalahkan ERROR", () => {
  assert.equal(highestImpact(["INFO", "WARNING"]), "WARNING");
  assert.equal(highestImpact(["ERROR", "CRITICAL", "INFO"]), "CRITICAL");
  assert.equal(highestImpact(["CRITICAL", "ERROR"]), "CRITICAL");
  assert.equal(highestImpact([]), "INFO");
});

test("overallConfidence: satu finding LOW tidak pernah dianggap HIGH walau mayoritas HIGH (mixed finding aggregation)", () => {
  assert.equal(overallConfidence(["HIGH", "HIGH", "HIGH", "LOW"]), "LOW");
  assert.equal(overallConfidence(["HIGH", "MEDIUM"]), "MEDIUM");
  assert.equal(overallConfidence(["HIGH", "HIGH"]), "HIGH");
  assert.equal(overallConfidence([]), "HIGH");
});

test("summarizeRun: impactSummary/confidenceSummary/highestImpact/overallConfidence terisi dari campuran finding (mixed aggregation)", () => {
  const findings: FindingWithImpactConfidence[] = [
    fic({ status: "MATCH" }), // INFO/HIGH
    fic({ status: "MISMATCH" }), // ERROR/HIGH
    fic({ status: "AMBIGUOUS" }), // WARNING/LOW
  ];
  const summary = summarizeRun(findings, "INTERNAL_OLSERA");
  assert.equal(summary.impactSummary.INFO, 1);
  assert.equal(summary.impactSummary.ERROR, 1);
  assert.equal(summary.impactSummary.WARNING, 1);
  assert.equal(summary.highestImpact, "ERROR");
  assert.equal(summary.confidenceSummary.HIGH, 2);
  assert.equal(summary.confidenceSummary.LOW, 1);
  assert.equal(summary.overallConfidence, "LOW");
});
