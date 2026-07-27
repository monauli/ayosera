import "server-only";
import { createHash } from "node:crypto";
import type { ReconciliationFindingDocument, ReconciliationManualResolutionDocument, ReconciliationRunDocument } from "./mongodb.ts";

const PERIOD = /^\d{4}-\d{2}$/;
export type ReconciliationWriteTarget = "RUNNER" | "MANUAL_RESOLUTION";
export type WriteActor = { id: string; role: "supervisor" | "user" };
type FeatureEnv = Readonly<Record<string, string | undefined>>;

type FindOne<T> = { findOne(filter: Record<string, unknown>): Promise<T | null> };
export type ReconciliationPreWriteContext = {
  findings: FindOne<ReconciliationFindingDocument>;
  runs: FindOne<ReconciliationRunDocument>;
  resolutions: FindOne<ReconciliationManualResolutionDocument>;
  auditLog: FindOne<{ findingId: string; metadata?: Record<string, unknown> }>;
};

export type PreWriteInput = {
  target: ReconciliationWriteTarget;
  actor: WriteActor;
  storeId: number;
  expectedStoreId: number;
  period: string;
  dryRun: boolean;
  explicitConfirmation: boolean;
  requestFingerprint: string;
  idempotencyKey: string;
  findingId?: string;
  runId?: string;
};
export type PreWriteResult = { allowed: boolean; blockers: string[]; warnings: string[]; fingerprint: string; finding: ReconciliationFindingDocument | null; run: ReconciliationRunDocument | null; currentResolution: ReconciliationManualResolutionDocument | null };

/** Strict opt-in: anything except literal "1" is disabled, including unset. */
export function isReconciliationWriteEnabled(env: FeatureEnv = process.env): boolean { return env.RECONCILIATION_WRITE_ENABLED === "1"; }
export function computeReconciliationRequestFingerprint(input: Pick<PreWriteInput, "target" | "storeId" | "period" | "findingId" | "runId" | "idempotencyKey">): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
export class ReconciliationWriteSafetyError extends Error { constructor(message: string) { super(message); this.name = "ReconciliationWriteSafetyError"; } }
export function assertReconciliationWriteEnabled(env: FeatureEnv = process.env): void { if (!isReconciliationWriteEnabled(env)) throw new ReconciliationWriteSafetyError("Controlled reconciliation write dinonaktifkan oleh feature flag RECONCILIATION_WRITE_ENABLED."); }

export async function validateReconciliationWrite(input: PreWriteInput, context: ReconciliationPreWriteContext, env: FeatureEnv = process.env): Promise<PreWriteResult> {
  const blockers: string[] = []; const warnings: string[] = [];
  if (input.actor.role !== "supervisor") blockers.push("Hanya supervisor dapat menjalankan controlled write.");
  if (!isReconciliationWriteEnabled(env)) blockers.push("Feature flag RECONCILIATION_WRITE_ENABLED belum aktif.");
  if (input.dryRun !== false) blockers.push("Controlled write harus menyatakan dryRun=false secara eksplisit.");
  if (!input.explicitConfirmation) blockers.push("Konfirmasi eksplisit belum diberikan.");
  if (!Number.isInteger(input.storeId) || input.storeId <= 0 || input.storeId !== input.expectedStoreId) blockers.push("Store tidak valid atau tidak sesuai isolasi server.");
  if (!PERIOD.test(input.period)) blockers.push("Period harus berformat YYYY-MM.");
  if (!/^[a-f0-9]{64}$/i.test(input.requestFingerprint)) blockers.push("Request fingerprint tidak valid.");
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) blockers.push("Idempotency key wajib dan tidak valid.");
  let finding: ReconciliationFindingDocument | null = null; let run: ReconciliationRunDocument | null = null; let currentResolution: ReconciliationManualResolutionDocument | null = null;
  try {
    if (input.findingId) {
      finding = await context.findings.findOne({ _id: input.findingId, storeId: input.expectedStoreId });
      if (!finding) blockers.push("Finding target tidak ditemukan pada store aktif.");
      else {
        if (finding.period !== input.period) blockers.push("Period tidak cocok dengan finding target.");
        if (input.runId && finding.runId !== input.runId) blockers.push("runId tidak cocok dengan finding target.");
        currentResolution = await context.resolutions.findOne({ findingId: finding._id, isCurrent: true });
      }
    }
    if (input.runId) {
      run = await context.runs.findOne({ _id: input.runId, storeId: input.expectedStoreId });
      if (!run) blockers.push("Run target tidak ditemukan pada store aktif.");
      else if (run.period !== input.period) blockers.push("Period tidak cocok dengan run target.");
    }
    const duplicate = await context.auditLog.findOne({ "metadata.requestFingerprint": input.requestFingerprint });
    if (duplicate) blockers.push("Request fingerprint sudah pernah diproses; gunakan status/audit yang ada, jangan ulang write.");
  } catch (error) {
    blockers.push(`Pre-write read gagal: ${error instanceof Error ? error.message.slice(0, 160) : "database tidak tersedia"}`);
  }
  if (input.target === "MANUAL_RESOLUTION" && !input.findingId) blockers.push("Manual resolution harus memiliki finding target.");
  if (input.target === "RUNNER" && !input.runId) warnings.push("Run deterministik akan dibuat oleh runner; preview belum menjalankan source adapter.");
  if (finding?.supersededAt) warnings.push("Finding sedang superseded oleh rerun; konfirmasi ulang sebelum write.");
  return { allowed: blockers.length === 0, blockers, warnings, fingerprint: input.requestFingerprint, finding, run, currentResolution };
}

export async function resolvePreWriteContext(context?: ReconciliationPreWriteContext): Promise<ReconciliationPreWriteContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts"); const c = await collections();
  return { findings: c.reconciliationFindings, runs: c.reconciliationRuns, resolutions: c.reconciliationManualResolutions, auditLog: c.reconciliationAuditLog };
}
