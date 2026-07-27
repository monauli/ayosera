import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  RECONCILIATION_MANUAL_DECISIONS,
  RECONCILIATION_RESOLUTION_REASON_CODES,
  type ReconciliationAuditLogDocument,
  type ReconciliationFindingDocument,
  type ReconciliationManualDecision,
  type ReconciliationManualResolutionDocument,
  type ReconciliationResolutionReasonCode,
} from "./mongodb.ts";
import { isReconciliationDomain, type ReconciliationDomain } from "./reconciliation-types.ts";

const PERIOD = /^\d{4}-\d{2}(-\d{2})?$/;
const MAX_NOTE = 2_000;
const MAX_EVIDENCE = 10;
const MAX_EVIDENCE_ITEM = 500;
const MAX_RETRIES = 3;

export type EffectiveFindingStatus = "OPEN" | "CONFIRMED" | "DISMISSED" | "MANUAL_ACTION_REQUIRED" | "DEFERRED" | "RESOLVED";

export class ManualResolutionError extends Error {
  constructor(
    message: string,
    public readonly code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "INVALID_TRANSITION" = "VALIDATION",
  ) {
    super(message);
    this.name = "ManualResolutionError";
  }
}

type Cursor<T> = { sort(spec: Record<string, 1 | -1>): Cursor<T>; skip(n: number): Cursor<T>; limit(n: number): Cursor<T>; toArray(): Promise<T[]> };
type ResolutionCollection = {
  find(filter: Record<string, unknown>): Cursor<ReconciliationManualResolutionDocument>;
  findOne(filter: Record<string, unknown>): Promise<ReconciliationManualResolutionDocument | null>;
  insertOne(document: ReconciliationManualResolutionDocument): Promise<unknown>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ matchedCount?: number } | unknown>;
  countDocuments(filter: Record<string, unknown>): Promise<number>;
};
type AuditCollection = { insertOne(document: ReconciliationAuditLogDocument): Promise<unknown> };
type FindingsCollection = { findOne(filter: Record<string, unknown>): Promise<ReconciliationFindingDocument | null> };
export type ManualResolutionContext = { findings: FindingsCollection; resolutions: ResolutionCollection; auditLog: AuditCollection };

async function resolveContext(context?: ManualResolutionContext): Promise<ManualResolutionContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { reconciliationFindings, reconciliationManualResolutions, reconciliationAuditLog } = await collections();
  return {
    findings: reconciliationFindings,
    resolutions: reconciliationManualResolutions as unknown as ResolutionCollection,
    auditLog: reconciliationAuditLog,
  };
}

function string(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new ManualResolutionError(`${field} wajib diisi dan valid.`);
  return value.trim();
}
function storeId(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new ManualResolutionError("storeId tidak valid.");
  return value as number;
}
function period(value: unknown): string {
  if (typeof value !== "string" || !PERIOD.test(value)) throw new ManualResolutionError("period tidak valid.");
  return value;
}
function decision(value: unknown, allowRevoked = false): ReconciliationManualDecision {
  if (typeof value !== "string" || !(RECONCILIATION_MANUAL_DECISIONS as readonly string[]).includes(value) || (!allowRevoked && value === "REVOKED")) {
    throw new ManualResolutionError("decision tidak valid.", "INVALID_TRANSITION");
  }
  return value as ReconciliationManualDecision;
}
function reasonCode(value: unknown): ReconciliationResolutionReasonCode {
  if (typeof value !== "string" || !(RECONCILIATION_RESOLUTION_REASON_CODES as readonly string[]).includes(value)) throw new ManualResolutionError("reasonCode tidak valid.");
  return value as ReconciliationResolutionReasonCode;
}
function note(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ManualResolutionError("note wajib diisi untuk reasonCode OTHER.");
    return null;
  }
  return string(value, "note", MAX_NOTE);
}
function evidence(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) throw new ManualResolutionError("evidence tidak valid.");
  return value.map((item) => string(item, "evidence", MAX_EVIDENCE_ITEM));
}
function isDuplicateKey(error: unknown): boolean {
  return !!error && typeof error === "object" && ("code" in error && (error as { code?: unknown }).code === 11000);
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function resolutionId(findingId: string, actor: string, idempotencyKey: string): string {
  return `resolution:v1:${fingerprint({ findingId, actor, idempotencyKey }).slice(0, 32)}`;
}

export type ResolutionView = Omit<ReconciliationManualResolutionDocument, "decision" | "isCurrent" | "createdBy" | "reasonCode" | "note" | "evidence" | "schemaVersion"> & {
  decision: ReconciliationManualDecision;
  isCurrent: boolean;
  createdBy: string;
  reasonCode: ReconciliationResolutionReasonCode;
  note: string | null;
  evidence: string[];
  schemaVersion: number;
};

function legacyDecision(value: ReconciliationManualResolutionDocument["decision"]): ReconciliationManualDecision {
  if ((RECONCILIATION_MANUAL_DECISIONS as readonly string[]).includes(value)) return value as ReconciliationManualDecision;
  if (value === "needs-source-fix") return "REQUIRES_MANUAL_ADJUSTMENT";
  if (value === "acknowledged-known-case") return "DEFERRED";
  return "CONFIRMED_FINDING";
}
function toView(document: ReconciliationManualResolutionDocument): ResolutionView {
  return {
    ...document,
    decision: legacyDecision(document.decision),
    isCurrent: document.isCurrent ?? !document.supersededBy,
    createdBy: document.createdBy ?? document.userId ?? "legacy:unknown",
    reasonCode: document.reasonCode ?? "OTHER",
    note: document.note ?? document.reason ?? null,
    evidence: document.evidence ?? [],
    schemaVersion: document.schemaVersion ?? 1,
  } as ResolutionView;
}
function effectiveFromDecision(current: ResolutionView | null, byId: Map<string, ResolutionView>): EffectiveFindingStatus {
  if (!current) return "OPEN";
  if (current.decision === "REVOKED") return effectiveFromDecision(current.previousResolutionId ? byId.get(current.previousResolutionId) ?? null : null, byId);
  return ({ CONFIRMED_FINDING: "CONFIRMED", FALSE_POSITIVE: "DISMISSED", REQUIRES_MANUAL_ADJUSTMENT: "MANUAL_ACTION_REQUIRED", DEFERRED: "DEFERRED", RESOLVED: "RESOLVED" } as const)[current.decision];
}
export function resolveFindingStatus(current: ReconciliationManualResolutionDocument | null, history: ReconciliationManualResolutionDocument[] = []): EffectiveFindingStatus {
  const views = history.map(toView);
  return effectiveFromDecision(current ? toView(current) : null, new Map(views.map((entry) => [entry._id, entry])));
}

async function findingForStore(findingId: unknown, requestedStoreId: unknown, context: ManualResolutionContext): Promise<ReconciliationFindingDocument> {
  const id = string(findingId, "findingId");
  const finding = await context.findings.findOne({ _id: id });
  if (!finding) throw new ManualResolutionError("Finding tidak ditemukan.", "NOT_FOUND");
  if (finding.storeId !== storeId(requestedStoreId)) throw new ManualResolutionError("Finding tidak ditemukan.", "NOT_FOUND");
  return finding;
}
function assertFindingBinding(finding: ReconciliationFindingDocument, input: { runId: unknown; domain: unknown; entityKey: unknown }): void {
  if (string(input.runId, "runId") !== finding.runId) throw new ManualResolutionError("runId tidak cocok dengan finding.");
  if (!isReconciliationDomain(input.domain) || input.domain !== finding.domain) throw new ManualResolutionError("domain tidak cocok dengan finding.");
  if (string(input.entityKey, "entityKey") !== finding.entityKey) throw new ManualResolutionError("entityKey tidak cocok dengan finding.");
}
async function historyForFinding(findingId: string, context: ManualResolutionContext): Promise<ResolutionView[]> {
  const documents = await context.resolutions.find({ findingId }).sort({ createdAt: -1 }).skip(0).limit(500).toArray();
  return documents.map(toView);
}
function currentFromHistory(history: ResolutionView[]): ResolutionView | null {
  return history.find((entry) => entry.isCurrent) ?? null;
}
async function writeAudit(context: ManualResolutionContext, input: Omit<ReconciliationAuditLogDocument, "_id" | "createdAt" | "schemaVersion">): Promise<void> {
  const auditId = `reconciliation-audit:v1:${randomUUID()}`;
  await context.auditLog.insertOne({ _id: auditId, auditId, createdAt: new Date(), schemaVersion: 2, ...input });
}

export type CreateManualResolutionInput = {
  findingId: string; storeId: number; runId: string; domain: ReconciliationDomain; entityKey: string;
  decision: ReconciliationManualDecision; reasonCode: ReconciliationResolutionReasonCode; note?: string | null; evidence?: string[];
  actor: string; idempotencyKey: string; requestId?: string | null;
  /** Internal revoke path only; endpoint create tidak mengekspos field ini. */
  previousResolutionIdOverride?: string | null;
  /** Metadata internal non-sensitif (mis. status efektif yang dipulihkan revoke). */
  metadata?: Record<string, unknown>;
};
export type CreateManualResolutionResult = { resolution: ResolutionView; idempotent: boolean; effectiveStatus: EffectiveFindingStatus };

export async function createManualResolution(input: CreateManualResolutionInput, suppliedContext?: ManualResolutionContext): Promise<CreateManualResolutionResult> {
  const context = await resolveContext(suppliedContext);
  const finding = await findingForStore(input.findingId, input.storeId, context);
  assertFindingBinding(finding, input);
  const actor = string(input.actor, "actor");
  const key = string(input.idempotencyKey, "Idempotency-Key", 200);
  let chosenDecision: ReconciliationManualDecision;
  let chosenReason: ReconciliationResolutionReasonCode;
  let chosenNote: string | null;
  let chosenEvidence: string[];
  try {
    // REVOKED hanya dipakai oleh revokeManualResolution; route POST tidak
    // menerimanya dalam schema body-nya.
    chosenDecision = decision(input.decision, input.decision === "REVOKED");
    chosenReason = reasonCode(input.reasonCode);
    chosenNote = note(input.note, chosenReason === "OTHER");
    chosenEvidence = evidence(input.evidence);
  } catch (error) {
    if (error instanceof ManualResolutionError) {
      await writeAudit(context, { action: "INVALID_RESOLUTION_TRANSITION", actor, storeId: finding.storeId, findingId: finding._id, runId: finding.runId, resolutionId: null, previousResolutionId: null, before: null, after: null, requestId: input.requestId ?? null, metadata: {} });
    }
    throw error;
  }
  const id = resolutionId(finding._id, actor, key);
  const requestFingerprint = fingerprint({ findingId: finding._id, actor, decision: chosenDecision, reasonCode: chosenReason, note: chosenNote, evidence: chosenEvidence });
  const existingSameRequest = await context.resolutions.findOne({ _id: id });
  if (existingSameRequest) {
    const existing = toView(existingSameRequest);
    if (existing.metadata?.requestFingerprint !== requestFingerprint) throw new ManualResolutionError("Idempotency-Key sudah dipakai untuk request lain.", "CONFLICT");
    const history = await historyForFinding(finding._id, context);
    return { resolution: existing, idempotent: true, effectiveStatus: resolveFindingStatus(existing, history) };
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const history = await historyForFinding(finding._id, context);
    const current = currentFromHistory(history);
    const now = new Date();
    const document: ReconciliationManualResolutionDocument = {
      _id: id, resolutionId: id, findingId: finding._id, runId: finding.runId, domain: finding.domain, storeId: finding.storeId, period: period(finding.period), entityKey: finding.entityKey,
      decision: chosenDecision, reasonCode: chosenReason, note: chosenNote, evidence: chosenEvidence, previousResolutionId: input.previousResolutionIdOverride !== undefined ? input.previousResolutionIdOverride : current?._id ?? null,
      isCurrent: true, createdBy: actor, createdAt: now, supersededAt: null, metadata: { ...input.metadata, requestFingerprint }, schemaVersion: 2, supersededBy: null,
    };
    if (current) {
      const result = await context.resolutions.updateOne({ _id: current._id, isCurrent: true }, { $set: { isCurrent: false, supersededAt: now, supersededBy: id } });
      if (typeof result === "object" && result && "matchedCount" in result && result.matchedCount === 0) continue;
    }
    try {
      await context.resolutions.insertOne(document);
    } catch (error) {
      if (isDuplicateKey(error)) {
        const already = await context.resolutions.findOne({ _id: id });
        if (already && toView(already).metadata?.requestFingerprint === requestFingerprint) {
          const latestHistory = await historyForFinding(finding._id, context);
          return { resolution: toView(already), idempotent: true, effectiveStatus: resolveFindingStatus(toView(already), latestHistory) };
        }
        continue;
      }
      throw error;
    }
    await writeAudit(context, { action: "CREATE_RESOLUTION", actor, storeId: finding.storeId, findingId: finding._id, runId: finding.runId, resolutionId: id, previousResolutionId: current?._id ?? null, before: current ? { decision: current.decision } : null, after: { decision: chosenDecision, reasonCode: chosenReason }, requestId: input.requestId ?? null, metadata: {} });
    if (current) await writeAudit(context, { action: "SUPERSEDE_RESOLUTION", actor, storeId: finding.storeId, findingId: finding._id, runId: finding.runId, resolutionId: id, previousResolutionId: current._id, before: { decision: current.decision }, after: { decision: chosenDecision }, requestId: input.requestId ?? null, metadata: {} });
    return { resolution: toView(document), idempotent: false, effectiveStatus: resolveFindingStatus(document, [...history, toView(document)]) };
  }
  await writeAudit(context, { action: "RESOLUTION_CONFLICT", actor, storeId: finding.storeId, findingId: finding._id, runId: finding.runId, resolutionId: null, previousResolutionId: null, before: null, after: null, requestId: input.requestId ?? null, metadata: {} });
  throw new ManualResolutionError("Konflik update resolution; silakan coba lagi.", "CONFLICT");
}

export async function getCurrentResolutionForFinding(input: { findingId: string; storeId: number }, suppliedContext?: ManualResolutionContext): Promise<ResolutionView | null> {
  const context = await resolveContext(suppliedContext);
  const finding = await findingForStore(input.findingId, input.storeId, context);
  return currentFromHistory(await historyForFinding(finding._id, context));
}
export async function getManualResolutionDetail(input: { findingId: string; storeId: number }, suppliedContext?: ManualResolutionContext): Promise<{ finding: ReconciliationFindingDocument; currentResolution: ResolutionView | null; history: ResolutionView[]; effectiveStatus: EffectiveFindingStatus }> {
  const context = await resolveContext(suppliedContext);
  const finding = await findingForStore(input.findingId, input.storeId, context);
  const history = await historyForFinding(finding._id, context);
  const currentResolution = currentFromHistory(history);
  return { finding, currentResolution, history, effectiveStatus: resolveFindingStatus(currentResolution, history) };
}
export async function getResolutionHistoryForFinding(input: { findingId: string; storeId: number }, suppliedContext?: ManualResolutionContext): Promise<ResolutionView[]> {
  const context = await resolveContext(suppliedContext);
  const finding = await findingForStore(input.findingId, input.storeId, context);
  return historyForFinding(finding._id, context);
}

export type ListManualResolutionsFilter = { storeId: number; period?: string; domain?: ReconciliationDomain; decision?: ReconciliationManualDecision; reasonCode?: ReconciliationResolutionReasonCode; createdBy?: string; dateFrom?: string; dateTo?: string; page?: number; limit?: number };
export async function listManualResolutions(filter: ListManualResolutionsFilter, suppliedContext?: ManualResolutionContext): Promise<{ items: ResolutionView[]; total: number; page: number; limit: number }> {
  const context = await resolveContext(suppliedContext);
  const query: Record<string, unknown> = { storeId: storeId(filter.storeId) };
  if (filter.period !== undefined) query.period = period(filter.period);
  if (filter.domain !== undefined) { if (!isReconciliationDomain(filter.domain)) throw new ManualResolutionError("domain tidak valid."); query.domain = filter.domain; }
  if (filter.decision !== undefined) query.decision = decision(filter.decision, true);
  if (filter.reasonCode !== undefined) query.reasonCode = reasonCode(filter.reasonCode);
  if (filter.createdBy !== undefined) query.createdBy = string(filter.createdBy, "createdBy");
  if (filter.dateFrom !== undefined || filter.dateTo !== undefined) {
    const range: Record<string, Date> = {};
    if (filter.dateFrom !== undefined) range.$gte = new Date(`${string(filter.dateFrom, "dateFrom", 10)}T00:00:00.000Z`);
    if (filter.dateTo !== undefined) range.$lte = new Date(`${string(filter.dateTo, "dateTo", 10)}T23:59:59.999Z`);
    if (Object.values(range).some((date) => Number.isNaN(date.getTime()))) throw new ManualResolutionError("date range tidak valid.");
    query.createdAt = range;
  }
  const page = Number.isInteger(filter.page) && (filter.page as number) > 0 ? filter.page as number : 1;
  const limit = Number.isInteger(filter.limit) && (filter.limit as number) > 0 ? Math.min(filter.limit as number, 200) : 50;
  const [items, total] = await Promise.all([context.resolutions.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(), context.resolutions.countDocuments(query)]);
  return { items: items.map(toView), total, page, limit };
}

export async function supersedeManualResolution(input: CreateManualResolutionInput, context?: ManualResolutionContext) { return createManualResolution(input, context); }

export async function revokeManualResolution(input: { findingId: string; storeId: number; actor: string; idempotencyKey: string; note: string; requestId?: string | null }, suppliedContext?: ManualResolutionContext): Promise<CreateManualResolutionResult> {
  const context = await resolveContext(suppliedContext);
  const finding = await findingForStore(input.findingId, input.storeId, context);
  const history = await historyForFinding(finding._id, context);
  const current = currentFromHistory(history);
  if (!current) throw new ManualResolutionError("Tidak ada resolution aktif untuk dibatalkan.", "INVALID_TRANSITION");
  const restored = current.previousResolutionId ? history.find((item) => item._id === current.previousResolutionId) ?? null : null;
  const restoredStatus = resolveFindingStatus(restored, history);
  return createManualResolution({ findingId: finding._id, storeId: finding.storeId, runId: finding.runId, domain: finding.domain, entityKey: finding.entityKey, decision: "REVOKED", reasonCode: "OTHER", note: input.note, evidence: [], actor: input.actor, idempotencyKey: input.idempotencyKey, requestId: input.requestId, previousResolutionIdOverride: current.previousResolutionId ?? null, metadata: { effectiveStatus: restoredStatus } }, context).then(async (result) => {
    await writeAudit(context, { action: "REVOKE_RESOLUTION", actor: string(input.actor, "actor"), storeId: finding.storeId, findingId: finding._id, runId: finding.runId, resolutionId: result.resolution._id, previousResolutionId: current._id, before: { decision: current.decision }, after: { effectiveStatus: result.effectiveStatus }, requestId: input.requestId ?? null, metadata: {} });
    return result;
  });
}

/** Audit aman untuk rute yang ditolak sebelum actor tervalidasi. Tidak pernah menyimpan credential atau body request. */
export async function recordUnauthorizedResolutionAttempt(input: { findingId: string; storeId: number; requestId?: string | null }, suppliedContext?: ManualResolutionContext): Promise<void> {
  const context = await resolveContext(suppliedContext);
  try {
    const finding = await findingForStore(input.findingId, input.storeId, context);
    await writeAudit(context, { action: "UNAUTHORIZED_RESOLUTION_ATTEMPT", actor: "unauthenticated", storeId: finding.storeId, findingId: finding._id, runId: finding.runId, resolutionId: null, previousResolutionId: null, before: null, after: null, requestId: input.requestId ?? null, metadata: {} });
  } catch {
    // Jangan pernah mengubah respons 401/403 menjadi error database atau
    // mengungkap apakah finding lintas toko ada.
  }
}
