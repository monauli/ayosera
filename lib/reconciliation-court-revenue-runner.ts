// Runner tulis — Rekonsiliasi AYO vs Olsera granular (Milestone 3,
// CROSS_SYSTEM_COURT_REVENUE, domain COURT_REVENUE, scope "daily").
//
// SENGAJA modul TERPISAH dari lib/reconciliation-runner.ts (Phase 5B,
// INTERNAL_OLSERA, scope "monthly") — bukan diperluas ke file yang sama.
// Alasan: reconciliation-runner.ts sudah teruji penuh (25 test) dan
// arsitekturnya (computeRunId/computeFindingId/write batching) menganut
// literal "monthly" di banyak tempat; menambal CROSS_SYSTEM ke situ berisiko
// meregresi jalur INTERNAL_OLSERA yang sudah production. Kedua modul menulis
// ke COLLECTION YANG SAMA (reconciliation_runs/reconciliation_findings,
// lib/mongodb.ts) dengan skema _id yang konsisten dengan dokumentasi field
// tsb ("daily" eksplisit disebut "dipakai CROSS_SYSTEM_COURT_REVENUE") —
// lib/reconciliation-store.ts dan lib/reconciliation-manual-resolution.ts
// SUDAH generik dan otomatis bisa membaca/menindaklanjuti finding dari modul
// ini tanpa perubahan (dikonfirmasi: keduanya tidak hardcode reconciliationType).
//
// dryRun: true  -> HANYA membaca (lewat loadCourtRevenueFindings), tidak menulis.
// dryRun: false -> upsert idempoten reconciliation_runs + reconciliation_findings
//                  untuk SATU tanggal, supersede (bukan hapus) finding lama
//                  tanggal itu yang tidak muncul lagi.
import "server-only";
import { loadCourtRevenueFindings, resolveCourtRevenueSourceContext, type CourtRevenueFinding, type CourtRevenueSourceContext } from "./reconciliation-court-revenue-source.ts";
import { summarizeRun, type FindingWithImpactConfidence, type RunSummary } from "./reconciliation-aggregate.ts";
import { capImpactForDraftPeriod, requiresManualAdjustment as statusRequiresManualAdjustment, type ReconciliationImpact } from "./reconciliation-types.ts";
import { isCurrentJakartaPeriod } from "./olsera-financial-core.ts";
import type { ReconciliationFindingDocument, ReconciliationRunDocument } from "./mongodb.ts";

export class CourtRevenueRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourtRevenueRunnerError";
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RULE_VERSION = 1;
const RULE_ID = "cross-system.court-revenue.v1";
const RECONCILIATION_TYPE = "CROSS_SYSTEM_COURT_REVENUE" as const;
const DOMAIN = "COURT_REVENUE" as const;

export type CourtRevenueRunnerInput = {
  storeId: number;
  /** YYYY-MM-DD — satu run selalu untuk SATU hari (lihat komentar file). */
  date: string;
  dryRun: boolean;
  triggeredBy: string;
  runVersion: number;
  minorToleranceIdr?: number;
};

function validateInput(input: CourtRevenueRunnerInput): void {
  if (!Number.isInteger(input.storeId) || input.storeId <= 0) throw new CourtRevenueRunnerError("storeId wajib diisi (integer positif).");
  if (typeof input.date !== "string" || !DATE_PATTERN.test(input.date)) throw new CourtRevenueRunnerError("date tidak valid (wajib format YYYY-MM-DD).");
  if (typeof input.triggeredBy !== "string" || !input.triggeredBy.trim()) throw new CourtRevenueRunnerError("triggeredBy wajib diisi.");
  if (!Number.isInteger(input.runVersion) || input.runVersion <= 0) throw new CourtRevenueRunnerError("runVersion wajib integer positif.");
}

export function computeCourtRevenueRunId(storeId: number, date: string, runVersion: number): string {
  return `${RECONCILIATION_TYPE}:${storeId}:daily:${date}:${DOMAIN}:v${runVersion}`;
}

export function computeCourtRevenueFindingId(storeId: number, date: string, courtKey: string, ruleVersion = RULE_VERSION): string {
  return `${RECONCILIATION_TYPE}:${storeId}:daily:${date}:${DOMAIN}:${RULE_ID}:${courtKey}:v${ruleVersion}`;
}

export type CourtRevenueRunnerFindingRecord = Omit<ReconciliationFindingDocument, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };

export type CourtRevenueRunnerResult = {
  runId: string;
  dryRun: boolean;
  status: "success" | "failed";
  findings: CourtRevenueRunnerFindingRecord[];
  summary: RunSummary;
  durationMs: number;
  docsRead: number;
};

function buildRecord(params: {
  finding: CourtRevenueFinding;
  runId: string;
  storeId: number;
  date: string;
  now: Date;
  isDraftPeriod: boolean;
  existing?: Pick<ReconciliationFindingDocument, "manualResolutionId" | "firstDetectedAt" | "createdAt" | "occurrenceCount"> | null;
}): CourtRevenueRunnerFindingRecord {
  const { finding, runId, storeId, date, now, isDraftPeriod, existing } = params;
  const impact: ReconciliationImpact = isDraftPeriod && finding.status !== "MATCH" ? capImpactForDraftPeriod(finding.impact, true) : finding.impact;
  return {
    _id: computeCourtRevenueFindingId(storeId, date, finding.courtKey),
    reconciliationType: RECONCILIATION_TYPE,
    domain: DOMAIN,
    ruleId: finding.ruleId,
    runId,
    storeId,
    scope: "daily",
    period: date,
    status: finding.status,
    impact,
    confidence: finding.confidence,
    sourceRefs: { ...finding.sourceRefs, ayoRevenue: finding.ayoRevenue, olseraRevenue: finding.olseraRevenue },
    entityKey: finding.entityKey,
    expected: finding.expected,
    actual: finding.actual,
    difference: finding.difference,
    diagnostics: isDraftPeriod && finding.status !== "MATCH" ? { ...finding.diagnostics, draftPeriodCap: { applied: true, reason: "current-month" } } : finding.diagnostics,
    candidates: finding.candidates,
    knownCaseRef: finding.knownCaseRef,
    requiresManualAdjustment: statusRequiresManualAdjustment(finding.status),
    manualResolutionId: existing?.manualResolutionId ?? null,
    firstDetectedAt: existing?.firstDetectedAt ?? now,
    lastCheckedAt: now,
    occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
    supersededAt: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export type CourtRevenueFindingsCollection = {
  bulkWrite(operations: unknown[]): Promise<unknown>;
  find(filter: Record<string, unknown>): { project(p: Record<string, 1>): { toArray(): Promise<Array<Pick<ReconciliationFindingDocument, "_id" | "manualResolutionId" | "firstDetectedAt" | "createdAt" | "occurrenceCount">>> } };
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
};

export type CourtRevenueWriteContext = {
  runs: { updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options: { upsert: true }): Promise<unknown> };
  findings: CourtRevenueFindingsCollection;
};

async function resolveWriteContext(context?: CourtRevenueWriteContext): Promise<CourtRevenueWriteContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { reconciliationRuns, reconciliationFindings } = await collections();
  return { runs: reconciliationRuns, findings: reconciliationFindings as unknown as CourtRevenueFindingsCollection };
}

/** Jalankan rekonsiliasi court-revenue untuk SATU tanggal. `dryRun: true` tidak pernah menulis Mongo. */
export async function runCourtRevenueReconciliation(
  input: CourtRevenueRunnerInput,
  context: { source?: CourtRevenueSourceContext; write?: CourtRevenueWriteContext } = {},
): Promise<CourtRevenueRunnerResult> {
  validateInput(input);
  const startedAt = Date.now();
  const sourceContext = await resolveCourtRevenueSourceContext(context.source);
  const runId = computeCourtRevenueRunId(input.storeId, input.date, input.runVersion);
  const now = new Date();
  const isDraftPeriod = isCurrentJakartaPeriod(input.date.slice(0, 7), now);

  const { findings, docsRead } = await loadCourtRevenueFindings(input.date, input.date, sourceContext, { minorToleranceIdr: input.minorToleranceIdr });

  if (input.dryRun) {
    const records = findings.map((finding) => buildRecord({ finding, runId, storeId: input.storeId, date: input.date, now, isDraftPeriod }));
    const summary = summarizeRun(
      records.map((r) => ({ reconciliationType: r.reconciliationType, domain: r.domain, status: r.status, impact: r.impact, confidence: r.confidence })),
      RECONCILIATION_TYPE,
      { isDraftPeriod },
    );
    return { runId, dryRun: true, status: "success", findings: records, summary, durationMs: Date.now() - startedAt, docsRead };
  }

  const writeContext = await resolveWriteContext(context.write);

  await writeContext.runs.updateOne(
    { _id: runId },
    {
      $set: {
        reconciliationType: RECONCILIATION_TYPE,
        storeId: input.storeId,
        scope: "daily",
        period: input.date,
        sourceSystems: ["ayo", "olsera"],
        status: "running",
        checkpoint: null,
        version: input.runVersion,
        errorMessage: null,
        updatedAt: now,
      },
      $setOnInsert: { startedAt: now, completedAt: null },
    },
    { upsert: true },
  );

  const findingIds = findings.map((f) => computeCourtRevenueFindingId(input.storeId, input.date, f.courtKey));
  const existingDocs = await writeContext.findings
    .find({ _id: { $in: findingIds } })
    .project({ _id: 1, manualResolutionId: 1, firstDetectedAt: 1, createdAt: 1, occurrenceCount: 1 })
    .toArray();
  const existingById = new Map(existingDocs.map((d) => [d._id, d]));

  const records = findings.map((finding) =>
    buildRecord({ finding, runId, storeId: input.storeId, date: input.date, now, isDraftPeriod, existing: existingById.get(computeCourtRevenueFindingId(input.storeId, input.date, finding.courtKey)) }),
  );

  if (records.length > 0) {
    await writeContext.findings.bulkWrite(
      records.map((record) => ({
        updateOne: {
          filter: { _id: record._id },
          update: {
            $set: {
              reconciliationType: record.reconciliationType,
              domain: record.domain,
              ruleId: record.ruleId,
              runId: record.runId,
              storeId: record.storeId,
              scope: record.scope,
              period: record.period,
              status: record.status,
              impact: record.impact,
              confidence: record.confidence,
              sourceRefs: record.sourceRefs,
              entityKey: record.entityKey,
              expected: record.expected,
              actual: record.actual,
              difference: record.difference,
              diagnostics: record.diagnostics,
              candidates: record.candidates,
              knownCaseRef: record.knownCaseRef,
              requiresManualAdjustment: record.requiresManualAdjustment,
              lastCheckedAt: record.lastCheckedAt,
              supersededAt: null,
              updatedAt: record.updatedAt,
            },
            $setOnInsert: { firstDetectedAt: record.firstDetectedAt, createdAt: record.createdAt, manualResolutionId: null, occurrenceCount: 0 },
            $inc: { occurrenceCount: 1 },
          },
          upsert: true,
        },
      })),
    );
  }

  // Superseded (bukan dihapus) — finding tanggal ini yang tidak muncul lagi pada run kali ini.
  await writeContext.findings.updateMany(
    { storeId: input.storeId, period: input.date, reconciliationType: RECONCILIATION_TYPE, domain: DOMAIN, scope: "daily", supersededAt: null, _id: { $nin: findingIds } },
    { $set: { supersededAt: now, updatedAt: now } },
  );

  const summary = summarizeRun(
    records.map((r) => ({ reconciliationType: r.reconciliationType, domain: r.domain, status: r.status, impact: r.impact, confidence: r.confidence })),
    RECONCILIATION_TYPE,
    { isDraftPeriod },
  );

  await writeContext.runs.updateOne(
    { _id: runId },
    {
      $set: {
        status: "success",
        summary: {
          totalFindings: summary.totalFindings,
          byStatus: summary.byStatus,
          byDomain: summary.byDomain,
          requiresManualAdjustmentCount: summary.requiresManualAdjustmentCount,
          matchLikeCount: summary.matchLikeCount,
          notCheckedCount: summary.notCheckedCount,
          finalCount: summary.finalCount,
          nonFinalCount: summary.nonFinalCount,
          isDraftPeriod: summary.isDraftPeriod,
          impactSummary: summary.impactSummary,
          highestImpact: summary.highestImpact,
          confidenceSummary: summary.confidenceSummary,
          overallConfidence: summary.overallConfidence,
        },
        errorMessage: null,
        completedAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  return { runId, dryRun: false, status: "success", findings: records, summary, durationMs: Date.now() - startedAt, docsRead };
}

/** Jalankan berurutan untuk setiap tanggal [startDate, endDate] (inklusif) — dipakai aksi "Audit Ulang" supervisor untuk satu bulan penuh. */
export async function runCourtRevenueReconciliationRange(
  input: Omit<CourtRevenueRunnerInput, "date"> & { startDate: string; endDate: string },
  context: { source?: CourtRevenueSourceContext; write?: CourtRevenueWriteContext } = {},
): Promise<CourtRevenueRunnerResult[]> {
  if (!DATE_PATTERN.test(input.startDate) || !DATE_PATTERN.test(input.endDate)) throw new CourtRevenueRunnerError("startDate/endDate tidak valid (wajib format YYYY-MM-DD).");
  if (input.startDate > input.endDate) throw new CourtRevenueRunnerError("startDate wajib <= endDate.");

  const results: CourtRevenueRunnerResult[] = [];
  let cursor = input.startDate;
  while (cursor <= input.endDate) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runCourtRevenueReconciliation({ ...input, date: cursor }, context);
    results.push(result);
    const next = new Date(`${cursor}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
  return results;
}
