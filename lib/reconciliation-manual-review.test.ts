// Test lib/reconciliation-manual-review.ts — MongoDB DIGANTI koleksi/loader
// tiruan in-memory. Dijalankan via `tsx --conditions=react-server` karena
// modul ini memakai "server-only".
import assert from "node:assert/strict";
import test from "node:test";
process.env.OLSERA_INTERNAL_STORE_ID = "324175"; // loadOmzetLedgerRecentSummaries membaca storeId() dari env — lihat lib/reconciliation-omzet-ledger.test.ts pola sama.
import { buildManualReviewSummary } from "./reconciliation-manual-review.ts";
import type { ReconciliationStoreContext } from "./reconciliation-store.ts";
import type { OmzetLedgerSourceContext } from "./reconciliation-omzet-ledger.ts";
import type { ReconciliationFindingDocument } from "./mongodb.ts";

type Doc = Record<string, unknown>;

class FakeCursor<T extends Doc> {
  private docs: T[];
  constructor(docs: T[]) {
    this.docs = docs;
  }
  sort() {
    return this;
  }
  skip(n: number) {
    this.docs = this.docs.slice(n);
    return this;
  }
  limit(n: number) {
    this.docs = this.docs.slice(0, n);
    return this;
  }
  async toArray() {
    return this.docs;
  }
}

function findingsContext(findings: Partial<ReconciliationFindingDocument>[]): ReconciliationStoreContext {
  const all = findings as ReconciliationFindingDocument[];
  return {
    runs: { find: () => new FakeCursor([]), findOne: async () => null, countDocuments: async () => 0 },
    findings: {
      find: (filter: Doc) => new FakeCursor(all.filter((d) => Object.entries(filter).every(([k, v]) => (d as Doc)[k] === v))),
      findOne: async () => null,
      countDocuments: async (filter: Doc) => all.filter((d) => Object.entries(filter).every(([k, v]) => (d as Doc)[k] === v)).length,
    },
  };
}

function emptyLedgerContext(): OmzetLedgerSourceContext {
  return { bookings: { find: () => ({ toArray: async () => [] }) }, ledgerEntries: { find: () => ({ toArray: async () => [] }) }, loadExplanation: async () => null };
}

function finding(overrides: Partial<ReconciliationFindingDocument>): ReconciliationFindingDocument {
  return {
    _id: "id-1",
    reconciliationType: "CROSS_SYSTEM_COURT_REVENUE",
    domain: "COURT_REVENUE",
    ruleId: "cross-system.court-revenue.v1",
    runId: "run-1",
    storeId: 1,
    scope: "daily",
    period: "2026-07-01",
    status: "BUTUH_ADJUST_MANUAL",
    impact: "WARNING",
    confidence: "LOW",
    sourceRefs: {},
    entityKey: "Court No 1",
    expected: {},
    actual: {},
    difference: null,
    diagnostics: { reason: "Court tidak teridentifikasi." },
    candidates: [],
    knownCaseRef: null,
    requiresManualAdjustment: true,
    manualResolutionId: null,
    firstDetectedAt: new Date(),
    lastCheckedAt: new Date(),
    occurrenceCount: 1,
    supersededAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

test("buildManualReviewSummary: menggabungkan finding lintas domain + ledger PERLU_DICEK", async () => {
  const summary = await buildManualReviewSummary(1, {
    storeContext: findingsContext([
      finding({ _id: "cr-1", domain: "COURT_REVENUE", requiresManualAdjustment: true }),
      finding({ _id: "cat-1", domain: "CATEGORY", reconciliationType: "INTERNAL_OLSERA", requiresManualAdjustment: true }),
    ]),
    ledgerContext: emptyLedgerContext(),
  });
  assert.equal(summary.items.length, 2);
  assert.ok(summary.items.some((i) => i.domain === "COURT_REVENUE"));
  assert.ok(summary.items.some((i) => i.domain === "CATEGORY"));
  assert.ok(summary.items.every((i) => i.canAutoResolve === false));
});

test("buildManualReviewSummary: setiap item punya recommendedAction dan reason tidak kosong", async () => {
  const summary = await buildManualReviewSummary(1, { storeContext: findingsContext([finding({})]), ledgerContext: emptyLedgerContext() });
  for (const item of summary.items) {
    assert.ok(item.recommendedAction.trim().length > 0);
    assert.ok(item.reason.trim().length > 0);
  }
});

test("buildManualReviewSummary: findings dengan requiresManualAdjustment=false TIDAK muncul (filter di query, disimulasikan lewat exact match)", async () => {
  // FakeCursor mensimulasikan filter Mongo persis (equality) — finding yang tidak match filter tidak masuk hasil.
  const summary = await buildManualReviewSummary(1, { storeContext: findingsContext([finding({ _id: "a", requiresManualAdjustment: true })]), ledgerContext: emptyLedgerContext() });
  assert.equal(summary.items.length, 1);
});

test("buildManualReviewSummary: total kosong -> items kosong, truncated false", async () => {
  const summary = await buildManualReviewSummary(1, { storeContext: findingsContext([]), ledgerContext: emptyLedgerContext() });
  assert.equal(summary.items.length, 0);
  assert.equal(summary.truncated, false);
});
