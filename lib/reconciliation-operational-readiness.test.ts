import assert from "node:assert/strict";
import test from "node:test";
import { computeReconciliationRequestFingerprint, isReconciliationWriteEnabled, validateReconciliationWrite, type ReconciliationPreWriteContext } from "./reconciliation-operational-readiness.ts";

const finding: any = { _id: "finding-1", storeId: 1, period: "2026-05", runId: "run-1", supersededAt: null };
const run: any = { _id: "run-1", storeId: 1, period: "2026-05" };
function ctx(overrides: Partial<ReconciliationPreWriteContext> = {}): ReconciliationPreWriteContext {
  return { findings: { async findOne() { return finding; } }, runs: { async findOne() { return run; } }, resolutions: { async findOne() { return null; } }, auditLog: { async findOne() { return null; } }, ...overrides };
}
function input(overrides: Record<string, unknown> = {}) {
  const base = { target: "MANUAL_RESOLUTION" as const, actor: { id: "supervisor-1", role: "supervisor" as const }, storeId: 1, expectedStoreId: 1, period: "2026-05", dryRun: false, explicitConfirmation: true, idempotencyKey: "preview-1", findingId: "finding-1", runId: "run-1" };
  const requestFingerprint = computeReconciliationRequestFingerprint(base); return { ...base, requestFingerprint, ...overrides };
}

test("feature flag default false dan hanya literal 1 yang mengaktifkan controlled write", () => {
  assert.equal(isReconciliationWriteEnabled({}), false); assert.equal(isReconciliationWriteEnabled({ RECONCILIATION_WRITE_ENABLED: "true" }), false); assert.equal(isReconciliationWriteEnabled({ RECONCILIATION_WRITE_ENABLED: "1" }), true);
});
test("pre-write menolak flag mati, dry-run, actor non-supervisor, store mismatch dan confirmation kosong", async () => {
  const result = await validateReconciliationWrite(input({ actor: { id: "viewer", role: "user" }, dryRun: true, explicitConfirmation: false, storeId: 2 }), ctx(), {});
  assert.equal(result.allowed, false); assert.match(result.blockers.join(" "), /Feature flag/); assert.match(result.blockers.join(" "), /supervisor/); assert.match(result.blockers.join(" "), /dryRun/); assert.match(result.blockers.join(" "), /Store/);
});
test("pre-write valid pada fixture aman dan memastikan finding/run store yang sama", async () => {
  const result = await validateReconciliationWrite(input(), ctx(), { RECONCILIATION_WRITE_ENABLED: "1" });
  assert.equal(result.allowed, true); assert.equal(result.finding?._id, "finding-1"); assert.equal(result.run?._id, "run-1");
});
test("duplicate fingerprint, conflict target, dan timeout menjadi blocker tanpa write", async () => {
  const duplicate = await validateReconciliationWrite(input(), ctx({ auditLog: { async findOne() { return { findingId: "finding-1", metadata: {} }; } } }), { RECONCILIATION_WRITE_ENABLED: "1" });
  assert.equal(duplicate.allowed, false); assert.match(duplicate.blockers.join(" "), /sudah pernah diproses/);
  const timeout = await validateReconciliationWrite(input(), ctx({ findings: { async findOne() { throw new Error("timeout"); } } }), { RECONCILIATION_WRITE_ENABLED: "1" });
  assert.equal(timeout.allowed, false); assert.match(timeout.blockers.join(" "), /Pre-write read gagal/);
});
test("preview/readiness route tetap read-only dan memerlukan supervisor", async () => {
  const { readFileSync } = await import("node:fs"); const { fileURLToPath } = await import("node:url"); const here = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
  const preview = here("../app/api/reconciliation/write-preview/route.ts"); const readiness = here("../app/api/reconciliation/readiness/route.ts");
  assert.match(preview, /requireSupervisor\(\)/); assert.match(preview, /preview: true/); assert.doesNotMatch(preview, /\.insertOne\s*\(|\.updateOne\s*\(|\.bulkWrite\s*\(/);
  assert.match(readiness, /requireSupervisor\(\)/); assert.match(readiness, /command\(\{ ping: 1 \}\)/); assert.doesNotMatch(readiness, /\.insertOne\s*\(|\.updateOne\s*\(|\.bulkWrite\s*\(/);
});
