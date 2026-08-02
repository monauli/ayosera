// Test Runner tulis — Rekonsiliasi AYO vs Olsera granular. MongoDB DIGANTI
// koleksi tiruan in-memory. Dijalankan via `tsx --conditions=react-server`
// karena reconciliation-court-revenue-runner.ts memakai "server-only".
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCourtRevenueFindingId,
  computeCourtRevenueRunId,
  runCourtRevenueReconciliation,
  runCourtRevenueReconciliationRange,
  CourtRevenueRunnerError,
  type CourtRevenueFindingsCollection,
  type CourtRevenueWriteContext,
} from "./reconciliation-court-revenue-runner.ts";
import type { CourtRevenueSourceContext } from "./reconciliation-court-revenue-source.ts";
import type { BookingDocument, OlseraOrderItemDocument, ReconciliationFindingDocument, ReconciliationRunDocument } from "./mongodb.ts";

type Doc = Record<string, unknown>;

function matchesFilter(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Doc;
      const value = doc[key] as string | number | null;
      if ("$gte" in c && !((value as string | number) >= (c.$gte as string | number))) return false;
      if ("$lte" in c && !((value as string | number) <= (c.$lte as string | number))) return false;
      return true;
    }
    return doc[key] === cond;
  });
}

function fake<T>(docs: Array<Partial<T>>) {
  return { find: (filter: Doc) => ({ toArray: async () => (docs as Doc[]).filter((d) => matchesFilter(d, filter)) as T[] }) };
}

function sourceContext(bookings: Array<Partial<BookingDocument>> = [], items: Array<Partial<OlseraOrderItemDocument>> = []): CourtRevenueSourceContext {
  return { bookings: fake(bookings), orderItems: fake(items) };
}

class FakeRuns {
  docs = new Map<string, ReconciliationRunDocument>();
  async updateOne(filter: Doc, update: Doc, _options: { upsert: true }) {
    const id = filter._id as string;
    const existing = this.docs.get(id);
    const merged = { ...(existing ?? {}), ...((update.$setOnInsert as Doc) ?? (existing ? {} : {})), ...((update.$set as Doc) ?? {}) } as ReconciliationRunDocument;
    this.docs.set(id, merged);
    return { ok: 1 };
  }
}

class FakeFindings implements CourtRevenueFindingsCollection {
  docs = new Map<string, ReconciliationFindingDocument>();
  async bulkWrite(operations: unknown[]) {
    for (const op of operations as Array<{ updateOne: { filter: Doc; update: Doc } }>) {
      const { filter, update } = op.updateOne;
      const id = filter._id as string;
      const existing = this.docs.get(id);
      const set = (update.$set as Doc) ?? {};
      const setOnInsert = !existing ? ((update.$setOnInsert as Doc) ?? {}) : {};
      const inc = (update.$inc as Doc) ?? {};
      const merged = { ...(existing ?? {}), ...setOnInsert, ...set, _id: id } as ReconciliationFindingDocument;
      if ("occurrenceCount" in inc) merged.occurrenceCount = (existing?.occurrenceCount ?? 0) + (inc.occurrenceCount as number);
      this.docs.set(id, merged);
    }
    return { ok: 1 };
  }
  find(filter: Doc) {
    const idFilter = filter._id as { $in?: string[]; $nin?: string[] } | undefined;
    let docs = [...this.docs.values()];
    if (idFilter?.$in) docs = docs.filter((d) => idFilter.$in!.includes(d._id));
    else if (idFilter?.$nin) {
      docs = docs.filter((d) => {
        if (idFilter.$nin!.includes(d._id)) return false;
        return Object.entries(filter).every(([key, cond]) => (key === "_id" ? true : (d as Doc)[key] === cond));
      });
    }
    return { project: () => ({ toArray: async () => docs.map((d) => ({ _id: d._id, manualResolutionId: d.manualResolutionId, firstDetectedAt: d.firstDetectedAt, createdAt: d.createdAt, occurrenceCount: d.occurrenceCount })) }) };
  }
  async updateMany(filter: Doc, update: Doc) {
    const nin = (filter._id as { $nin?: string[] })?.$nin ?? [];
    for (const doc of this.docs.values()) {
      if (doc.storeId !== filter.storeId || doc.period !== filter.period || doc.reconciliationType !== filter.reconciliationType || doc.domain !== filter.domain) continue;
      if (doc.supersededAt !== null) continue;
      if (nin.includes(doc._id)) continue;
      Object.assign(doc, update.$set);
    }
    return { ok: 1 };
  }
}

function writeContext(): CourtRevenueWriteContext & { runs: FakeRuns; findings: FakeFindings } {
  return { runs: new FakeRuns(), findings: new FakeFindings() };
}

const PAST_DATE = "2026-06-15"; // bukan bulan berjalan relatif ke tanggal sistem manapun yang wajar untuk test ini

test("runCourtRevenueReconciliation: dryRun=true tidak menulis apa pun", async () => {
  const ctx = writeContext();
  const result = await runCourtRevenueReconciliation(
    { storeId: 1, date: PAST_DATE, dryRun: true, triggeredBy: "test", runVersion: 1 },
    { source: sourceContext([{ field_name: "Court No 1", date: PAST_DATE, total_price: 150000, status: "SUCCESS", booking_id: "BK-1" }], [{ date: PAST_DATE, itemName: "COURT FEES - 1", resolvedCategoryName: "LAPANGAN PADEL", amount: 150000, orderNo: "O-1" }]), write: ctx },
  );
  assert.equal(result.dryRun, true);
  assert.equal(ctx.runs.docs.size, 0);
  assert.equal(ctx.findings.docs.size, 0);
  assert.ok(result.findings.some((f) => f.entityKey === "Court No 1" && f.status === "MATCH"));
});

test("runCourtRevenueReconciliation: dryRun=false menulis run + findings idempoten (rerun tidak menduplikasi)", async () => {
  const ctx = writeContext();
  const source = sourceContext([{ field_name: "Court No 1", date: PAST_DATE, total_price: 150000, status: "SUCCESS", booking_id: "BK-1" }], [{ date: PAST_DATE, itemName: "COURT FEES - 1", resolvedCategoryName: "LAPANGAN PADEL", amount: 150000, orderNo: "O-1" }]);

  const first = await runCourtRevenueReconciliation({ storeId: 1, date: PAST_DATE, dryRun: false, triggeredBy: "test", runVersion: 1 }, { source, write: ctx });
  const countAfterFirst = ctx.findings.docs.size;
  const second = await runCourtRevenueReconciliation({ storeId: 1, date: PAST_DATE, dryRun: false, triggeredBy: "test", runVersion: 1 }, { source, write: ctx });

  assert.equal(first.runId, second.runId);
  assert.equal(ctx.findings.docs.size, countAfterFirst); // tidak bertambah -> upsert, bukan insert baru
  const runId = computeCourtRevenueRunId(1, PAST_DATE, 1);
  assert.equal(ctx.runs.docs.get(runId)?.status, "success");
  const findingId = computeCourtRevenueFindingId(1, PAST_DATE, "Court No 1");
  assert.equal(ctx.findings.docs.get(findingId)?.occurrenceCount, 2); // bertambah tiap rerun
});

test("runCourtRevenueReconciliation: finding lama yang tidak muncul lagi ditandai superseded, bukan dihapus", async () => {
  const ctx = writeContext();
  await runCourtRevenueReconciliation(
    { storeId: 1, date: PAST_DATE, dryRun: false, triggeredBy: "test", runVersion: 1 },
    { source: sourceContext([], [{ date: PAST_DATE, itemName: "COURT FEES - -", resolvedCategoryName: "LAPANGAN PADEL", amount: 150000, orderNo: "O-1" }]), write: ctx },
  );
  const unidentifiedId = [...ctx.findings.docs.keys()].find((k) => k.includes("Padel"));
  assert.ok(unidentifiedId);
  assert.equal(ctx.findings.docs.get(unidentifiedId!)?.supersededAt, null);

  // Rerun dengan sumber KOSONG total -> finding lama harus superseded, dokumennya TETAP ADA.
  await runCourtRevenueReconciliation({ storeId: 1, date: PAST_DATE, dryRun: false, triggeredBy: "test", runVersion: 1 }, { source: sourceContext([], []), write: ctx });
  assert.ok(ctx.findings.docs.get(unidentifiedId!)?.supersededAt instanceof Date);
});

test("runCourtRevenueReconciliation: requiresManualAdjustment true untuk BUTUH_ADJUST_MANUAL", async () => {
  const ctx = writeContext();
  await runCourtRevenueReconciliation(
    { storeId: 1, date: PAST_DATE, dryRun: false, triggeredBy: "test", runVersion: 1 },
    { source: sourceContext([], [{ date: PAST_DATE, itemName: "COURT FEES - -", resolvedCategoryName: "LAPANGAN PADEL", amount: 150000, orderNo: "O-1" }]), write: ctx },
  );
  const doc = [...ctx.findings.docs.values()].find((d) => d.status === "BUTUH_ADJUST_MANUAL");
  assert.equal(doc?.requiresManualAdjustment, true);
});

test("runCourtRevenueReconciliation: input tidak valid ditolak (storeId/date/triggeredBy/runVersion)", async () => {
  await assert.rejects(() => runCourtRevenueReconciliation({ storeId: 0, date: PAST_DATE, dryRun: true, triggeredBy: "t", runVersion: 1 }), CourtRevenueRunnerError);
  await assert.rejects(() => runCourtRevenueReconciliation({ storeId: 1, date: "not-a-date", dryRun: true, triggeredBy: "t", runVersion: 1 }), CourtRevenueRunnerError);
  await assert.rejects(() => runCourtRevenueReconciliation({ storeId: 1, date: PAST_DATE, dryRun: true, triggeredBy: "", runVersion: 1 }), CourtRevenueRunnerError);
  await assert.rejects(() => runCourtRevenueReconciliation({ storeId: 1, date: PAST_DATE, dryRun: true, triggeredBy: "t", runVersion: 0 }), CourtRevenueRunnerError);
});

test("runCourtRevenueReconciliationRange: menjalankan tiap tanggal dalam rentang secara berurutan", async () => {
  const ctx = writeContext();
  const results = await runCourtRevenueReconciliationRange(
    { storeId: 1, startDate: "2026-06-01", endDate: "2026-06-03", dryRun: false, triggeredBy: "test", runVersion: 1 },
    { source: sourceContext([], []), write: ctx },
  );
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((r) => r.runId),
    ["2026-06-01", "2026-06-02", "2026-06-03"].map((d) => computeCourtRevenueRunId(1, d, 1)),
  );
});
