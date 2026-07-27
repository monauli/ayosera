import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ReconciliationAuditLogDocument, ReconciliationFindingDocument, ReconciliationManualResolutionDocument } from "./mongodb.ts";
import {
  createManualResolution,
  getCurrentResolutionForFinding,
  getResolutionHistoryForFinding,
  listManualResolutions,
  ManualResolutionError,
  revokeManualResolution,
  type ManualResolutionContext,
} from "./reconciliation-manual-resolution.ts";

const finding = (): ReconciliationFindingDocument => ({
  _id: "INTERNAL_OLSERA:1:monthly:2026-05:PRODUCT:rule:product:106817649:v1", reconciliationType: "INTERNAL_OLSERA", domain: "PRODUCT", ruleId: "internal.product-identity.v1", runId: "run-1", storeId: 1, scope: "monthly", period: "2026-05", status: "AMBIGUOUS", impact: "WARNING", confidence: "LOW", sourceRefs: {}, entityKey: "product:106817649->116138490", expected: {}, actual: {}, difference: null, diagnostics: {}, candidates: [], knownCaseRef: null, requiresManualAdjustment: true, manualResolutionId: null, firstDetectedAt: new Date("2026-05-01"), lastCheckedAt: new Date("2026-05-02"), occurrenceCount: 1, supersededAt: null, createdAt: new Date("2026-05-01"), updatedAt: new Date("2026-05-02"),
});

function matches(value: Record<string, unknown>, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = value[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected) && ("$gte" in expected || "$lte" in expected)) {
      const range = expected as { $gte?: Date; $lte?: Date };
      return (!range.$gte || actual instanceof Date && actual >= range.$gte) && (!range.$lte || actual instanceof Date && actual <= range.$lte);
    }
    return actual === expected;
  });
}
function cursor<T extends Record<string, unknown>>(source: T[]) {
  let values = [...source];
  return {
    sort(spec: Record<string, 1 | -1>) { const [key, direction] = Object.entries(spec)[0]; values.sort((a, b) => ((a[key] as Date)?.valueOf?.() ?? String(a[key])) > ((b[key] as Date)?.valueOf?.() ?? String(b[key])) ? direction : -direction); return this; },
    skip(n: number) { values = values.slice(n); return this; },
    limit(n: number) { values = values.slice(0, n); return this; },
    async toArray() { return values; },
  };
}
function fixture(): { context: ManualResolutionContext; resolutions: ReconciliationManualResolutionDocument[]; audit: ReconciliationAuditLogDocument[]; source: ReconciliationFindingDocument } {
  const source = finding(); const resolutions: ReconciliationManualResolutionDocument[] = []; const audit: ReconciliationAuditLogDocument[] = [];
  return {
    source, resolutions, audit,
    context: {
      findings: { async findOne(filter) { return matches(source as unknown as Record<string, unknown>, filter) ? source : null; } },
      resolutions: {
        find(filter) { return cursor(resolutions.filter((item) => matches(item as unknown as Record<string, unknown>, filter)) as unknown as Record<string, unknown>[]) as never; },
        async findOne(filter) { return resolutions.find((item) => matches(item as unknown as Record<string, unknown>, filter)) ?? null; },
        async insertOne(document) { if (resolutions.some((item) => item._id === document._id || (item.findingId === document.findingId && item.isCurrent && document.isCurrent))) throw { code: 11000 }; resolutions.push(structuredClone(document)); },
        async updateOne(filter, update) { const item = resolutions.find((entry) => matches(entry as unknown as Record<string, unknown>, filter)); if (!item) return { matchedCount: 0 }; Object.assign(item, (update.$set ?? {}) as object); return { matchedCount: 1 }; },
        async countDocuments(filter) { return resolutions.filter((item) => matches(item as unknown as Record<string, unknown>, filter)).length; },
      },
      auditLog: { async insertOne(document) { audit.push(document); } },
    },
  };
}
function input(overrides: Partial<Parameters<typeof createManualResolution>[0]> = {}) {
  return { findingId: finding()._id, storeId: 1, runId: "run-1", domain: "PRODUCT" as const, entityKey: "product:106817649->116138490", decision: "REQUIRES_MANUAL_ADJUSTMENT" as const, reasonCode: "PRODUCT_IDENTITY_AMBIGUOUS" as const, note: "Dua product ID belum terbukti identik.", evidence: ["fixture:evidence"], actor: "admin-1", idempotencyKey: "request-1", ...overrides };
}

test("membuat resolution pertama tanpa memutasi finding; product identity ambiguous tidak membuat alias/snapshot", async () => {
  const f = fixture(); const before = structuredClone(f.source);
  const result = await createManualResolution(input(), f.context);
  assert.equal(result.effectiveStatus, "MANUAL_ACTION_REQUIRED"); assert.equal(f.resolutions.length, 1); assert.deepEqual(f.source, before);
  assert.equal(f.audit.some((entry) => entry.action === "CREATE_RESOLUTION"), true);
  assert.equal(JSON.stringify(f.context).includes("olsera_product_aliases"), false);
});
test("retry idempotent tidak membuat duplikat", async () => {
  const f = fixture(); await createManualResolution(input(), f.context); const repeat = await createManualResolution(input(), f.context);
  assert.equal(repeat.idempotent, true); assert.equal(f.resolutions.length, 1);
});
test("supersede menyimpan histori dan hanya satu current", async () => {
  const f = fixture(); const first = await createManualResolution(input(), f.context);
  await createManualResolution(input({ decision: "FALSE_POSITIVE", reasonCode: "VERIFIED_FALSE_POSITIVE", idempotencyKey: "request-2" }), f.context);
  assert.equal(f.resolutions.filter((entry) => entry.isCurrent).length, 1); assert.equal(f.resolutions[1].previousResolutionId, first.resolution._id);
  assert.equal((await getResolutionHistoryForFinding({ findingId: f.source._id, storeId: 1 }, f.context)).length, 2);
});
test("revoke append-only mengembalikan OPEN bila tidak ada resolution sebelumnya", async () => {
  const f = fixture(); await createManualResolution(input({ decision: "FALSE_POSITIVE", reasonCode: "VERIFIED_FALSE_POSITIVE" }), f.context);
  const result = await revokeManualResolution({ findingId: f.source._id, storeId: 1, actor: "admin-1", idempotencyKey: "revoke-1", note: "verifikasi dibuka kembali" }, f.context);
  assert.equal(result.effectiveStatus, "OPEN"); assert.equal(f.resolutions.length, 2); assert.equal(f.audit.some((entry) => entry.action === "REVOKE_RESOLUTION"), true);
});
test("request paralel dengan idempotency key sama menghasilkan satu resolution current", async () => {
  const f = fixture(); await Promise.all([createManualResolution(input(), f.context), createManualResolution(input(), f.context)]);
  assert.equal(f.resolutions.length, 1); assert.equal(f.resolutions.filter((entry) => entry.isCurrent).length, 1);
});
test("request paralel berbeda menghasilkan satu current winner dan histori utuh", async () => {
  const f = fixture(); await Promise.all([createManualResolution(input({ idempotencyKey: "parallel-1" }), f.context), createManualResolution(input({ decision: "DEFERRED", reasonCode: "SOURCE_DATA_INCOMPLETE", idempotencyKey: "parallel-2" }), f.context)]);
  assert.equal(f.resolutions.filter((entry) => entry.isCurrent).length, 1); assert.equal(f.resolutions.length, 2);
});
test("validasi menolak finding tidak ada, run/entity tidak cocok, cross-store dan OTHER tanpa note", async () => {
  const f = fixture();
  await assert.rejects(() => createManualResolution(input({ findingId: "missing" }), f.context), (error: unknown) => error instanceof ManualResolutionError && error.code === "NOT_FOUND");
  await assert.rejects(() => createManualResolution(input({ runId: "other" }), f.context));
  await assert.rejects(() => createManualResolution(input({ entityKey: "other" }), f.context));
  await assert.rejects(() => createManualResolution(input({ storeId: 2 }), f.context));
  await assert.rejects(() => createManualResolution(input({ reasonCode: "OTHER", note: null }), f.context));
  await assert.rejects(() => createManualResolution(input({ decision: "INVALID" as never }), f.context));
});
test("filter dan pagination resolution bekerja", async () => {
  const f = fixture(); await createManualResolution(input(), f.context); await createManualResolution(input({ decision: "DEFERRED", reasonCode: "SOURCE_DATA_INCOMPLETE", idempotencyKey: "request-2" }), f.context);
  const result = await listManualResolutions({ storeId: 1, decision: "DEFERRED", page: 1, limit: 1 }, f.context);
  assert.equal(result.total, 1); assert.equal(result.items[0].decision, "DEFERRED");
});
test("legacy resolution tetap terbaca", async () => {
  const f = fixture(); f.resolutions.push({ _id: "legacy-1", findingId: f.source._id, decision: "needs-source-fix", chosenCandidateEntityKey: null, reason: "legacy", userId: "legacy-user", createdAt: new Date(), supersededBy: null });
  const current = await getCurrentResolutionForFinding({ findingId: f.source._id, storeId: 1 }, f.context);
  assert.equal(current?.decision, "REQUIRES_MANUAL_ADJUSTMENT"); assert.equal(current?.schemaVersion, 1);
});
test("route write menegakkan supervisor, JSON/content-size, allow-list, dan Idempotency-Key", () => {
  const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const resolutionRoute = readFileSync(here("../app/api/reconciliation/findings/[findingId]/resolution/route.ts"), "utf8");
  const revokeRoute = readFileSync(here("../app/api/reconciliation/findings/[findingId]/resolution/revoke/route.ts"), "utf8");
  assert.match(resolutionRoute, /requireSupervisor\(\)/); assert.match(resolutionRoute, /application\/json/); assert.match(resolutionRoute, /MAX_BODY_BYTES/); assert.match(resolutionRoute, /Field tidak didukung/); assert.match(resolutionRoute, /idempotency-key/);
  assert.match(revokeRoute, /requireSupervisor\(\)/); assert.match(revokeRoute, /idempotency-key/); assert.match(revokeRoute, /Object\.keys\(payload\)/);
});
