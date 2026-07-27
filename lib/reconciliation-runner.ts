// Runner Modul Rekonsiliasi (Phase 5B) — satu-satunya tempat yang menulis ke
// `reconciliation_runs`/`reconciliation_findings`. Menggabungkan source
// adapter (lib/reconciliation-sources.ts) + rule engine murni
// (lib/reconciliation-rules.ts) + aggregation (lib/reconciliation-aggregate.ts).
//
// dryRun: true  -> HANYA membaca, TIDAK PERNAH menulis Mongo apa pun.
// dryRun: false -> menulis reconciliation_run + reconciliation_findings,
//                  idempotent (rerun pada cakupan yang sama meng-upsert,
//                  tidak menduplikasi), TIDAK PERNAH menyentuh collection
//                  sumber (olsera_*), TIDAK PERNAH deleteMany finding lama.
//
// Entrypoint terkontrol SATU-SATUNYA untuk mode tulis: scripts/run-reconciliation-internal-olsera.ts
// (wajib --write eksplisit). Tidak ada cron/route publik yang memanggil mode tulis di Phase 5B.
import "server-only";
import { isCurrentJakartaPeriod } from "./olsera-financial-core.ts";
import {
  loadCategoryFindings,
  loadInventoryMovementFindings,
  loadProductIdentityFindings,
  loadSnapshotConsistencyFindings,
  periodToMonthRange,
  resolveSourceContext,
  type ReconciliationSourceContext,
  type SourceFinding,
} from "./reconciliation-sources.ts";
import { summarizeRun, type FindingWithImpactConfidence, type RunSummary } from "./reconciliation-aggregate.ts";
import {
  capImpactForDraftPeriod,
  KNOWN_CASE_REFS,
  requiresManualAdjustment as statusRequiresManualAdjustment,
  type ReconciliationDomain,
  type ReconciliationImpact,
  type ReconciliationType,
} from "./reconciliation-types.ts";
import type { ReconciliationFindingDocument, ReconciliationRunDocument } from "./mongodb.ts";

// ---------------------------------------------------------------------------
// Draft-period impact cap — lihat lib/reconciliation-types.ts capImpactForDraftPeriod().
// Fungsi itu SUDAH ADA sejak sebelum Phase 5B tapi belum pernah dipanggil di
// sini (temuan audit dry-run Feb-Jul 2026). WAJIB dipanggil di SINI (runner),
// bukan di rule engine — supaya rule engine tetap murni/deterministik
// terhadap input yang diberikan, dan cap hanya berlaku pada `impact` (TIDAK
// PERNAH mengubah status/confidence/requiresManualAdjustment).
// ---------------------------------------------------------------------------

export type DraftPeriodCapReason = "current-month" | "missing-next-month-snapshot" | "boundary-only" | "incomplete-current-period-snapshot";

/**
 * Tentukan APAKAH & KENAPA impact suatu finding layak di-cap karena periode
 * berjalan (draft) — HANYA 4 sebab spesifik di bawah, BUKAN "seluruh finding
 * di bulan berjalan". MISMATCH nyata yang tidak terkait boundary/incomplete
 * (mis. snapshot sudah "complete" tapi tetap beda) TIDAK di-cap — akar
 * masalahnya bukan bulan berjalan, jadi harus tetap terlihat penuh.
 */
export function determineDraftCapReason(finding: SourceFinding, isDraftPeriod: boolean): DraftPeriodCapReason | null {
  if (!isDraftPeriod) return null;
  if (finding.status === "MATCH") return null;

  if (finding.domain === "SNAPSHOT" && finding.status === "MISSING_IN_SNAPSHOT") {
    // HANYA bila sisi yang hilang adalah bulan BERIKUTNYA (wajar, belum ada saat bulan ini masih berjalan).
    // Sisi "current"/"both" hilang BUKAN sekadar konsekuensi bulan berjalan -> jangan di-cap.
    return finding.diagnostics?.missingSide === "next" ? "missing-next-month-snapshot" : null;
  }

  if (finding.domain === "INVENTORY") {
    if (finding.diagnostics?.hasSnapshotDoc === false) return "current-month";
    if (finding.diagnostics?.snapshotStatus === "boundary-only") return "boundary-only";
    if (finding.diagnostics?.snapshotStatus === "incomplete") return "incomplete-current-period-snapshot";
  }

  return null;
}

/** Terapkan cap (bila berlaku) — HANYA mengubah `impact`+`diagnostics.draftPeriodCap`, tidak pernah status/confidence. */
function applyDraftPeriodCap(finding: SourceFinding, isDraftPeriod: boolean): { impact: ReconciliationImpact; diagnostics: Record<string, unknown> } {
  const reason = determineDraftCapReason(finding, isDraftPeriod);
  if (!reason) return { impact: finding.impact, diagnostics: finding.diagnostics };
  return {
    impact: capImpactForDraftPeriod(finding.impact, true),
    diagnostics: { ...finding.diagnostics, draftPeriodCap: { applied: true, reason, originalImpact: finding.impact } },
  };
}

export class ReconciliationRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationRunnerError";
  }
}

/** Domain yang diterima Phase 5B — SEMPIT dari seluruh domain INTERNAL_OLSERA yang sah (lihat lib/reconciliation-types.ts DOMAINS_BY_TYPE); FINANCIAL/LEDGER DITUNDA (belum ada rule/adapter). */
export const PHASE_5B_DOMAINS = ["CATEGORY", "PRODUCT", "INVENTORY", "SNAPSHOT"] as const;
export type Phase5BDomain = (typeof PHASE_5B_DOMAINS)[number];

export function isPhase5BDomain(value: unknown): value is Phase5BDomain {
  return typeof value === "string" && (PHASE_5B_DOMAINS as readonly string[]).includes(value);
}

const RULE_VERSION = 1;
/** Run "running" lebih tua dari ini dianggap basi (proses pemegang kemungkinan mati) — boleh diambil alih, pola sama lib/olsera-cron-lock.ts. */
const ACTIVE_RUN_STALE_MS = 15 * 60 * 1000;
/** Ukuran batch bulkWrite/find agar tidak pernah satu operasi mencakup seluruh koleksi sekaligus. */
const WRITE_BATCH_SIZE = 200;

const DOMAIN_LOADERS: Record<
  Phase5BDomain,
  (storeId: number, period: string, context: ReconciliationSourceContext) => Promise<{ findings: SourceFinding[]; docsRead: number }>
> = {
  CATEGORY: (_storeId, period, context) => loadCategoryFindings(period, context),
  PRODUCT: (_storeId, period, context) => loadProductIdentityFindings(period, context),
  INVENTORY: (storeId, period, context) => loadInventoryMovementFindings(storeId, period, context),
  SNAPSHOT: (storeId, period, context) => loadSnapshotConsistencyFindings(storeId, period, context),
};

// ---------------------------------------------------------------------------
// Input & validasi
// ---------------------------------------------------------------------------

export type RunnerInput = {
  storeId: number;
  /** YYYY-MM */
  period: string;
  /** Phase 5B HANYA menerima INTERNAL_OLSERA — CROSS_SYSTEM_COURT_REVENUE ditolak (belum ada source adapter AYO). */
  reconciliationType: ReconciliationType;
  domains: readonly Phase5BDomain[];
  dryRun: boolean;
  /** identitas pemanggil untuk audit (mis. "cli:run-reconciliation-internal-olsera", "manual:<user>") — bukan credential. */
  triggeredBy: string;
  runVersion: number;
};

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

function validateInput(input: RunnerInput): void {
  if (!Number.isInteger(input.storeId) || input.storeId <= 0) {
    throw new ReconciliationRunnerError("storeId wajib diisi (integer positif).");
  }
  if (typeof input.period !== "string" || !PERIOD_PATTERN.test(input.period)) {
    throw new ReconciliationRunnerError("period tidak valid (wajib format YYYY-MM).");
  }
  if (input.reconciliationType !== "INTERNAL_OLSERA") {
    throw new ReconciliationRunnerError(
      `Phase 5B hanya menerima reconciliationType INTERNAL_OLSERA (ditolak: ${String(input.reconciliationType)}) — CROSS_SYSTEM_COURT_REVENUE belum punya source adapter AYO.`,
    );
  }
  if (!Array.isArray(input.domains) || input.domains.length === 0) {
    throw new ReconciliationRunnerError("domains wajib diisi (minimal satu).");
  }
  for (const domain of input.domains) {
    if (!isPhase5BDomain(domain)) {
      throw new ReconciliationRunnerError(`Domain "${String(domain)}" ditolak — Phase 5B hanya menerima ${PHASE_5B_DOMAINS.join(", ")}.`);
    }
  }
  if (new Set(input.domains).size !== input.domains.length) {
    throw new ReconciliationRunnerError("domains tidak boleh mengandung duplikat.");
  }
  if (typeof input.triggeredBy !== "string" || !input.triggeredBy.trim()) {
    throw new ReconciliationRunnerError("triggeredBy wajib diisi.");
  }
  if (!Number.isInteger(input.runVersion) || input.runVersion <= 0) {
    throw new ReconciliationRunnerError("runVersion wajib integer positif.");
  }
}

// ---------------------------------------------------------------------------
// Identitas deterministik (idempotency key) — lihat lib/mongodb.ts komentar
// ReconciliationRunDocument._id (Phase 5B).
// ---------------------------------------------------------------------------

export function computeRunId(input: Pick<RunnerInput, "reconciliationType" | "storeId" | "period" | "domains" | "runVersion">): string {
  const sortedDomains = [...input.domains].sort().join(",");
  return `${input.reconciliationType}:${input.storeId}:monthly:${input.period}:${sortedDomains}:v${input.runVersion}`;
}

export function computeFindingId(params: {
  reconciliationType: ReconciliationType;
  storeId: number;
  period: string;
  domain: ReconciliationDomain;
  ruleId: string;
  entityKey: string;
  ruleVersion: number;
}): string {
  return `${params.reconciliationType}:${params.storeId}:monthly:${params.period}:${params.domain}:${params.ruleId}:${params.entityKey}:v${params.ruleVersion}`;
}

// ---------------------------------------------------------------------------
// Hasil
// ---------------------------------------------------------------------------

export type RunnerFindingRecord = Omit<ReconciliationFindingDocument, "createdAt" | "updatedAt"> & {
  createdAt: Date;
  updatedAt: Date;
};

export type RunnerResult = {
  runId: string;
  dryRun: boolean;
  status: "success" | "partial" | "failed";
  findings: RunnerFindingRecord[];
  summary: RunSummary;
  checkpoint: { completedDomains: Phase5BDomain[]; failedDomains: Phase5BDomain[] };
  /** Pesan error PER DOMAIN yang gagal — pesan saja (disanitasi, tanpa stack/payload mentah). */
  domainErrors: Partial<Record<Phase5BDomain, string>>;
  durationMs: number;
  docsRead: number;
  /** Jumlah finding terbanyak ditulis dalam satu batch bulkWrite (hanya diisi saat dryRun=false). */
  peakBatchSize: number;
};

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Jaga-jaga: potong pesan panjang & jangan pernah menyertakan payload mentah / stack trace.
  return message.slice(0, 500);
}

async function evaluateDomains(
  storeId: number,
  period: string,
  domains: readonly Phase5BDomain[],
  sourceContext: ReconciliationSourceContext,
): Promise<{
  perDomain: Record<Phase5BDomain, SourceFinding[]>;
  completedDomains: Phase5BDomain[];
  failedDomains: Phase5BDomain[];
  domainErrors: Partial<Record<Phase5BDomain, string>>;
  docsRead: number;
}> {
  const perDomain = {} as Record<Phase5BDomain, SourceFinding[]>;
  const completedDomains: Phase5BDomain[] = [];
  const failedDomains: Phase5BDomain[] = [];
  const domainErrors: Partial<Record<Phase5BDomain, string>> = {};
  let docsRead = 0;

  for (const domain of domains) {
    try {
      const { findings, docsRead: read } = await DOMAIN_LOADERS[domain](storeId, period, sourceContext);
      perDomain[domain] = findings;
      completedDomains.push(domain);
      docsRead += read;
    } catch (error) {
      // Domain gagal TIDAK BOLEH merusak domain lain yang sudah selesai, dan
      // TIDAK BOLEH menghasilkan finding kosong yang ditafsirkan sebagai "MATCH".
      perDomain[domain] = [];
      failedDomains.push(domain);
      domainErrors[domain] = sanitizeErrorMessage(error);
    }
  }

  return { perDomain, completedDomains, failedDomains, domainErrors, docsRead };
}

function buildRunnerFindingRecord(params: {
  finding: SourceFinding;
  runId: string;
  storeId: number;
  period: string;
  reconciliationType: ReconciliationType;
  now: Date;
  isDraftPeriod: boolean;
  existing?: ReconciliationFindingDocument | null;
}): RunnerFindingRecord {
  const { finding, runId, storeId, period, reconciliationType, now, isDraftPeriod, existing } = params;
  const findingId = computeFindingId({
    reconciliationType,
    storeId,
    period,
    domain: finding.domain,
    ruleId: finding.ruleId,
    entityKey: finding.entityKey,
    ruleVersion: RULE_VERSION,
  });
  const { impact, diagnostics } = applyDraftPeriodCap(finding, isDraftPeriod);
  return {
    _id: findingId,
    reconciliationType,
    domain: finding.domain,
    ruleId: finding.ruleId,
    runId,
    storeId,
    scope: "monthly",
    period,
    // status TIDAK PERNAH diubah oleh cap periode draft — hanya impact (lihat applyDraftPeriodCap).
    status: finding.status,
    impact,
    // confidence TIDAK PERNAH dinaikkan/diturunkan oleh cap periode draft.
    confidence: finding.confidence,
    sourceRefs: finding.sourceRefs,
    entityKey: finding.entityKey,
    expected: finding.expected,
    actual: finding.actual,
    difference: finding.difference,
    diagnostics,
    candidates: finding.candidates,
    knownCaseRef: finding.knownCaseRef,
    // requiresManualAdjustment SELALU dari status asli (tidak pernah dihapus/diubah oleh cap impact).
    // Known Case 37 (movement productId null) SELALU butuh tinjauan manusia (tidak ada evidence
    // identitas sama sekali) walau status-nya MISSING_IN_SNAPSHOT (yang secara umum tidak requiresManualAdjustment) —
    // dikonfirmasi via scripts/audit-reconciliation-inventory-null-product.ts.
    requiresManualAdjustment: statusRequiresManualAdjustment(finding.status) || finding.knownCaseRef === KNOWN_CASE_REFS.PHASE3_MOVEMENT_37,
    // manualResolutionId TIDAK PERNAH direset di sini — dipertahankan dari dokumen lama saat upsert nyata (lihat writeFindings).
    manualResolutionId: existing?.manualResolutionId ?? null,
    firstDetectedAt: existing?.firstDetectedAt ?? now,
    lastCheckedAt: now,
    occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
    supersededAt: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function computeOverallStatus(completedDomains: Phase5BDomain[], failedDomains: Phase5BDomain[]): "success" | "partial" | "failed" {
  if (failedDomains.length === 0) return "success";
  if (completedDomains.length === 0) return "failed";
  return "partial";
}

// ---------------------------------------------------------------------------
// dryRun=true — baca + evaluasi, TIDAK ADA tulis Mongo sama sekali.
// ---------------------------------------------------------------------------

async function runDryRun(input: RunnerInput, sourceContext: ReconciliationSourceContext): Promise<RunnerResult> {
  const startedAt = Date.now();
  const runId = computeRunId(input);
  const now = new Date();
  const isDraftPeriod = isCurrentJakartaPeriod(input.period, now);

  const { perDomain, completedDomains, failedDomains, domainErrors, docsRead } = await evaluateDomains(input.storeId, input.period, input.domains, sourceContext);

  const allFindings = input.domains.flatMap((d) => perDomain[d]);
  const records: RunnerFindingRecord[] = allFindings.map((finding) =>
    buildRunnerFindingRecord({ finding, runId, storeId: input.storeId, period: input.period, reconciliationType: input.reconciliationType, now, isDraftPeriod }),
  );

  const summaryInput: FindingWithImpactConfidence[] = records.map((r) => ({ reconciliationType: r.reconciliationType, domain: r.domain, status: r.status, impact: r.impact, confidence: r.confidence }));
  const summary = summarizeRun(summaryInput, input.reconciliationType, { isDraftPeriod });

  return {
    runId,
    dryRun: true,
    status: computeOverallStatus(completedDomains, failedDomains),
    findings: records,
    summary,
    checkpoint: { completedDomains, failedDomains },
    domainErrors,
    durationMs: Date.now() - startedAt,
    docsRead,
    peakBatchSize: 0,
  };
}

// ---------------------------------------------------------------------------
// dryRun=false — menulis reconciliation_runs + reconciliation_findings.
// ---------------------------------------------------------------------------

export type MinimalRunsCollection = {
  findOne(filter: Record<string, unknown>): Promise<ReconciliationRunDocument | null>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options: { upsert: true }): Promise<unknown>;
};

export type MinimalFindingsCollection = {
  bulkWrite(operations: unknown[]): Promise<unknown>;
  find(filter: Record<string, unknown>): { project(p: Record<string, 1>): { toArray(): Promise<Array<Pick<ReconciliationFindingDocument, "_id" | "manualResolutionId" | "firstDetectedAt" | "createdAt" | "occurrenceCount">>> } };
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
};

export type ReconciliationWriteContext = { runs: MinimalRunsCollection; findings: MinimalFindingsCollection };

export async function resolveWriteContext(context?: ReconciliationWriteContext): Promise<ReconciliationWriteContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { reconciliationRuns, reconciliationFindings } = await collections();
  return { runs: reconciliationRuns, findings: reconciliationFindings as unknown as MinimalFindingsCollection };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function runWrite(input: RunnerInput, sourceContext: ReconciliationSourceContext, writeContext: ReconciliationWriteContext): Promise<RunnerResult> {
  const startedAt = Date.now();
  const runId = computeRunId(input);
  const now = new Date();
  const isDraftPeriod = isCurrentJakartaPeriod(input.period, now);

  // 2. Tolak dua eksekusi aktif yang sama (run "running" yang masih fresh, belum basi).
  const existingRun = await writeContext.runs.findOne({ _id: runId });
  if (existingRun && existingRun.status === "running" && now.getTime() - existingRun.updatedAt.getTime() < ACTIVE_RUN_STALE_MS) {
    throw new ReconciliationRunnerError(`Run "${runId}" sedang aktif (status=running, diperbarui ${existingRun.updatedAt.toISOString()}) — eksekusi paralel ditolak.`);
  }

  // 1/3. Tulis run IN_PROGRESS (upsert idempoten — _id deterministik).
  await writeContext.runs.updateOne(
    { _id: runId },
    {
      $set: {
        reconciliationType: input.reconciliationType,
        storeId: input.storeId,
        scope: "monthly",
        period: input.period,
        sourceSystems: ["olsera"],
        status: "running",
        checkpoint: { cursor: null, stage: null, completedDomains: [] },
        version: input.runVersion,
        errorMessage: null,
        updatedAt: now,
      },
      $setOnInsert: { startedAt: now, completedAt: null },
    },
    { upsert: true },
  );

  const { perDomain, completedDomains, failedDomains, domainErrors, docsRead } = await evaluateDomains(input.storeId, input.period, input.domains, sourceContext);

  let peakBatchSize = 0;
  const allRecords: RunnerFindingRecord[] = [];

  // Proses HANYA domain yang berhasil — domain gagal tidak menulis apa pun (finding lama domain itu dibiarkan apa adanya).
  for (const domain of completedDomains) {
    const domainFindings = perDomain[domain];
    const findingIds = domainFindings.map((f) =>
      computeFindingId({ reconciliationType: input.reconciliationType, storeId: input.storeId, period: input.period, domain: f.domain, ruleId: f.ruleId, entityKey: f.entityKey, ruleVersion: RULE_VERSION }),
    );

    // Baca dokumen lama (untuk mempertahankan manualResolutionId/firstDetectedAt/createdAt/occurrenceCount) — dibatasi per batch.
    const existingById = new Map<string, Pick<ReconciliationFindingDocument, "_id" | "manualResolutionId" | "firstDetectedAt" | "createdAt" | "occurrenceCount">>();
    for (const idBatch of chunk(findingIds, WRITE_BATCH_SIZE)) {
      const docs = await writeContext.findings
        .find({ _id: { $in: idBatch } })
        .project({ _id: 1, manualResolutionId: 1, firstDetectedAt: 1, createdAt: 1, occurrenceCount: 1 })
        .toArray();
      for (const doc of docs) existingById.set(doc._id, doc);
    }

    const records = domainFindings.map((finding) => {
      const findingId = computeFindingId({ reconciliationType: input.reconciliationType, storeId: input.storeId, period: input.period, domain: finding.domain, ruleId: finding.ruleId, entityKey: finding.entityKey, ruleVersion: RULE_VERSION });
      const existing = existingById.get(findingId) ?? null;
      return buildRunnerFindingRecord({
        finding,
        runId,
        storeId: input.storeId,
        period: input.period,
        reconciliationType: input.reconciliationType,
        now,
        isDraftPeriod,
        existing: existing as ReconciliationFindingDocument | null,
      });
    });
    allRecords.push(...records);

    for (const batch of chunk(records, WRITE_BATCH_SIZE)) {
      peakBatchSize = Math.max(peakBatchSize, batch.length);
      const ops = batch.map((record) => ({
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
            $setOnInsert: {
              firstDetectedAt: record.firstDetectedAt,
              createdAt: record.createdAt,
              manualResolutionId: null,
              occurrenceCount: 0,
            },
            $inc: { occurrenceCount: 1 },
          },
          upsert: true,
        },
      }));
      // eslint-disable-next-line no-await-in-loop
      await writeContext.findings.bulkWrite(ops);
    }

    // Tandai finding lama domain ini yang TIDAK muncul lagi pada run ini sebagai superseded (BUKAN dihapus).
    await writeContext.findings.updateMany(
      { storeId: input.storeId, period: input.period, reconciliationType: input.reconciliationType, domain, supersededAt: null, _id: { $nin: findingIds } },
      { $set: { supersededAt: now, updatedAt: now } },
    );

    // Checkpoint per domain selesai.
    await writeContext.runs.updateOne(
      { _id: runId },
      { $set: { updatedAt: now }, $addToSet: { "checkpoint.completedDomains": domain } },
      { upsert: true },
    );
  }

  const finalStatus = computeOverallStatus(completedDomains, failedDomains);
  const summaryInput: FindingWithImpactConfidence[] = allRecords.map((r) => ({ reconciliationType: r.reconciliationType, domain: r.domain, status: r.status, impact: r.impact, confidence: r.confidence }));
  const summary = summarizeRun(summaryInput, input.reconciliationType, { isDraftPeriod });

  const errorMessage = failedDomains.length > 0 ? failedDomains.map((d) => `${d}: ${domainErrors[d]}`).join("; ").slice(0, 1000) : null;

  await writeContext.runs.updateOne(
    { _id: runId },
    {
      $set: {
        status: finalStatus,
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
        errorMessage,
        completedAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  return {
    runId,
    dryRun: false,
    status: finalStatus,
    findings: allRecords,
    summary,
    checkpoint: { completedDomains, failedDomains },
    domainErrors,
    durationMs: Date.now() - startedAt,
    docsRead,
    peakBatchSize,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type RunReconciliationContext = { source?: ReconciliationSourceContext; write?: ReconciliationWriteContext };

export async function runReconciliation(input: RunnerInput, context: RunReconciliationContext = {}): Promise<RunnerResult> {
  validateInput(input);
  const sourceContext = await resolveSourceContext(context.source);

  if (input.dryRun) return runDryRun(input, sourceContext);

  const writeContext = await resolveWriteContext(context.write);
  return runWrite(input, sourceContext, writeContext);
}
