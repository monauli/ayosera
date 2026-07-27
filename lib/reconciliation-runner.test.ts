// Test Runner Modul Rekonsiliasi (Phase 5B) — MongoDB DIGANTI koleksi tiruan
// in-memory (DI). TIDAK PERNAH menyentuh database sungguhan. Dijalankan via
// `tsx --conditions=react-server` karena reconciliation-runner.ts memakai
// "server-only".
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeFindingId,
  computeRunId,
  determineDraftCapReason,
  isPhase5BDomain,
  PHASE_5B_DOMAINS,
  ReconciliationRunnerError,
  runReconciliation,
  type MinimalFindingsCollection,
  type MinimalRunsCollection,
  type RunnerInput,
} from "./reconciliation-runner.ts";
import { jakartaCurrentPeriod } from "./olsera-financial-core.ts";
import type {
  OlseraInventoryMonthlySnapshotDocument,
  OlseraInventoryMovementDocument,
  OlseraInventoryProductDocument,
  OlseraOrderItemDocument,
  OlseraProductAliasDocument,
  ReconciliationFindingDocument,
  ReconciliationRunDocument,
} from "./mongodb.ts";
import type { MinimalReadCollection, ReconciliationSourceContext, SourceFinding } from "./reconciliation-sources.ts";

type Doc = Record<string, unknown>;

function matchesFilter(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Doc;
      const value = doc[key] as string | number | null;
      if ("$gte" in c && !((value as string | number) >= (c.$gte as string | number))) return false;
      if ("$lte" in c && !((value as string | number) <= (c.$lte as string | number))) return false;
      if ("$in" in c && !(c.$in as unknown[]).includes(value)) return false;
      return true;
    }
    return doc[key] === cond;
  });
}

/** Koleksi tiruan yang menerima objek fixture PARSIAL — cukup untuk field yang dipakai adapter. */
function fake<T>(docs: Array<Partial<T>>): MinimalReadCollection<T> {
  return {
    find(filter: Doc) {
      const filtered = (docs as Doc[]).filter((doc) => matchesFilter(doc, filter));
      return { toArray: async () => filtered as T[] };
    },
  };
}

function sourceContext(overrides: Partial<ReconciliationSourceContext> = {}): ReconciliationSourceContext {
  return {
    orderItems: fake<OlseraOrderItemDocument>([]),
    inventoryProducts: fake<OlseraInventoryProductDocument>([]),
    productAliases: fake<OlseraProductAliasDocument>([]),
    inventoryMovements: fake<OlseraInventoryMovementDocument>([]),
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([]),
    ...overrides,
  };
}

class FakeRunsCollection implements MinimalRunsCollection {
  docs = new Map<string, ReconciliationRunDocument>();
  async findOne(filter: Doc) {
    const id = filter._id as string;
    return this.docs.get(id) ?? null;
  }
  async updateOne(filter: Doc, update: Doc, options: { upsert: true }) {
    const id = filter._id as string;
    const existing = this.docs.get(id);
    if (!existing && !options.upsert) return { matchedCount: 0 };
    const base = (existing ?? {}) as Partial<ReconciliationRunDocument>;
    const set = (update.$set as Doc) ?? {};
    const setOnInsert = !existing ? ((update.$setOnInsert as Doc) ?? {}) : {};
    const addToSet = update.$addToSet as Doc | undefined;
    const merged: ReconciliationRunDocument = {
      ...(base as ReconciliationRunDocument),
      ...(setOnInsert as Partial<ReconciliationRunDocument>),
      ...(set as Partial<ReconciliationRunDocument>),
    };
    if (addToSet && "checkpoint.completedDomains" in addToSet) {
      const value = addToSet["checkpoint.completedDomains"];
      const current = merged.checkpoint ?? { cursor: null, stage: null, completedDomains: [] };
      if (!current.completedDomains.includes(value as never)) current.completedDomains.push(value as never);
      merged.checkpoint = current;
    }
    this.docs.set(id, merged);
    return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 };
  }
}

class FakeFindingsCollection implements MinimalFindingsCollection {
  docs = new Map<string, ReconciliationFindingDocument>();
  bulkWriteCalls: unknown[][] = [];
  async bulkWrite(operations: unknown[]) {
    this.bulkWriteCalls.push(operations);
    for (const op of operations as Array<{ updateOne: { filter: Doc; update: Doc; upsert: boolean } }>) {
      const { filter, update } = op.updateOne;
      const id = filter._id as string;
      const existing = this.docs.get(id);
      const set = (update.$set as Doc) ?? {};
      const setOnInsert = !existing ? ((update.$setOnInsert as Doc) ?? {}) : {};
      const inc = update.$inc as Doc | undefined;
      const merged: ReconciliationFindingDocument = {
        ...(existing as ReconciliationFindingDocument),
        ...(setOnInsert as Partial<ReconciliationFindingDocument>),
        ...(set as Partial<ReconciliationFindingDocument>),
        _id: id,
      };
      if (inc && "occurrenceCount" in inc) {
        merged.occurrenceCount = (existing?.occurrenceCount ?? 0) + (inc.occurrenceCount as number);
      }
      this.docs.set(id, merged);
    }
    return { ok: 1 };
  }
  find(filter: Doc) {
    const idFilter = filter._id as { $in: string[] } | undefined;
    const nin = filter._id as { $nin: string[] } | undefined;
    let docs = [...this.docs.values()];
    if (idFilter?.$in) docs = docs.filter((d) => idFilter.$in.includes(d._id));
    if (nin?.$nin) {
      docs = [...this.docs.values()].filter((d) => {
        return Object.entries(filter).every(([key, cond]) => {
          if (key === "_id") return !nin.$nin.includes(d._id);
          if (cond && typeof cond === "object" && "$nin" in (cond as Doc)) return true;
          return (d as Doc)[key] === cond;
        });
      });
    } else if (!idFilter?.$in) {
      docs = docs.filter((d) => Object.entries(filter).every(([key, cond]) => (d as Doc)[key] === cond));
    }
    return { project: () => ({ toArray: async () => docs.map((d) => ({ _id: d._id, manualResolutionId: d.manualResolutionId, firstDetectedAt: d.firstDetectedAt, createdAt: d.createdAt, occurrenceCount: d.occurrenceCount })) }) };
  }
  async updateMany(filter: Doc, update: Doc) {
    const nin = (filter._id as { $nin: string[] } | undefined)?.$nin ?? [];
    const set = update.$set as Partial<ReconciliationFindingDocument>;
    let count = 0;
    for (const doc of this.docs.values()) {
      if (doc.storeId !== filter.storeId || doc.period !== filter.period || doc.reconciliationType !== filter.reconciliationType || doc.domain !== filter.domain) continue;
      if (doc.supersededAt !== null) continue;
      if (nin.includes(doc._id)) continue;
      Object.assign(doc, set);
      count++;
    }
    return { modifiedCount: count };
  }
}

function baseInput(overrides: Partial<RunnerInput> = {}): RunnerInput {
  return {
    storeId: 1,
    period: "2026-05",
    reconciliationType: "INTERNAL_OLSERA",
    domains: ["CATEGORY"],
    dryRun: true,
    triggeredBy: "test",
    runVersion: 1,
    ...overrides,
  };
}

// ---- validasi input -----------------------------------------------------------

test("runReconciliation menolak reconciliationType selain INTERNAL_OLSERA (CROSS_SYSTEM belum punya source adapter)", async () => {
  await assert.rejects(
    () => runReconciliation(baseInput({ reconciliationType: "CROSS_SYSTEM_COURT_REVENUE" }), { source: sourceContext() }),
    ReconciliationRunnerError,
  );
});

test("runReconciliation menolak domain di luar Phase 5B", async () => {
  await assert.rejects(() => runReconciliation(baseInput({ domains: ["FINANCIAL"] as never }), { source: sourceContext() }), ReconciliationRunnerError);
  await assert.rejects(() => runReconciliation(baseInput({ domains: ["LEDGER"] as never }), { source: sourceContext() }), ReconciliationRunnerError);
});

test("isPhase5BDomain: hanya menerima CATEGORY/PRODUCT/INVENTORY/SNAPSHOT", () => {
  for (const d of PHASE_5B_DOMAINS) assert.equal(isPhase5BDomain(d), true);
  assert.equal(isPhase5BDomain("FINANCIAL"), false);
  assert.equal(isPhase5BDomain("COURT_REVENUE"), false);
});

test("runReconciliation menolak storeId/period tidak valid", async () => {
  await assert.rejects(() => runReconciliation(baseInput({ storeId: 0 }), { source: sourceContext() }), ReconciliationRunnerError);
  await assert.rejects(() => runReconciliation(baseInput({ period: "2026/05" }), { source: sourceContext() }), ReconciliationRunnerError);
});

// ---- dry-run --------------------------------------------------------------------

test("dry-run: tidak menulis Mongo apa pun (write context tidak pernah dipanggil)", async () => {
  const ctx = sourceContext({
    orderItems: fake<OlseraOrderItemDocument>([{ _id: 1, date: "2026-05-10", itemName: "X", normalizedItemName: "X", categoryResolutionStatus: "resolved", resolvedCategoryName: "Lapangan" }]),
  });
  const result = await runReconciliation(baseInput({ dryRun: true }), { source: ctx });
  assert.equal(result.dryRun, true);
  assert.equal(result.status, "success");
  assert.equal(result.findings.length, 1);
});

test("runId deterministik — sama untuk input sama, beda bila domain set/version beda", () => {
  const id1 = computeRunId({ reconciliationType: "INTERNAL_OLSERA", storeId: 1, period: "2026-05", domains: ["CATEGORY", "PRODUCT"], runVersion: 1 });
  const id2 = computeRunId({ reconciliationType: "INTERNAL_OLSERA", storeId: 1, period: "2026-05", domains: ["PRODUCT", "CATEGORY"], runVersion: 1 });
  const id3 = computeRunId({ reconciliationType: "INTERNAL_OLSERA", storeId: 1, period: "2026-05", domains: ["CATEGORY"], runVersion: 1 });
  const id4 = computeRunId({ reconciliationType: "INTERNAL_OLSERA", storeId: 1, period: "2026-05", domains: ["CATEGORY", "PRODUCT"], runVersion: 2 });
  assert.equal(id1, id2, "urutan domain tidak memengaruhi runId (disortir)");
  assert.notEqual(id1, id3);
  assert.notEqual(id1, id4);
});

test("findingId deterministik dari storeId+period+type+domain+ruleId+entityKey+ruleVersion", () => {
  const id1 = computeFindingId({ reconciliationType: "INTERNAL_OLSERA", storeId: 1, period: "2026-05", domain: "CATEGORY", ruleId: "internal.category.v1", entityKey: "X", ruleVersion: 1 });
  const id2 = computeFindingId({ reconciliationType: "INTERNAL_OLSERA", storeId: 1, period: "2026-05", domain: "CATEGORY", ruleId: "internal.category.v1", entityKey: "X", ruleVersion: 1 });
  const id3 = computeFindingId({ reconciliationType: "INTERNAL_OLSERA", storeId: 1, period: "2026-05", domain: "CATEGORY", ruleId: "internal.category.v1", entityKey: "Y", ruleVersion: 1 });
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
});

// ---- write mode: idempotency, checkpoint, partial failure --------------------

function writeContextFixtures() {
  return { runs: new FakeRunsCollection(), findings: new FakeFindingsCollection() };
}

test("write mode: rerun pada cakupan sama TIDAK menduplikasi finding (upsert berdasarkan findingId)", async () => {
  const ctx = sourceContext({
    orderItems: fake<OlseraOrderItemDocument>([{ _id: 1, date: "2026-05-10", itemName: "X", normalizedItemName: "X", categoryResolutionStatus: "resolved", resolvedCategoryName: "Lapangan" }]),
  });
  const write = writeContextFixtures();

  const r1 = await runReconciliation(baseInput({ dryRun: false }), { source: ctx, write });
  assert.equal(r1.status, "success");
  assert.equal(write.findings.docs.size, 1);
  const firstOccurrence = [...write.findings.docs.values()][0].occurrenceCount;

  const r2 = await runReconciliation(baseInput({ dryRun: false }), { source: ctx, write });
  assert.equal(r2.status, "success");
  assert.equal(write.findings.docs.size, 1, "rerun tidak boleh menduplikasi dokumen finding");
  const secondOccurrence = [...write.findings.docs.values()][0].occurrenceCount;
  assert.equal(secondOccurrence, firstOccurrence + 1, "occurrenceCount naik tiap kali finding terlihat lagi");
  assert.equal(r1.runId, r2.runId, "runId sama (idempotent) untuk cakupan yang sama");
  assert.equal(write.runs.docs.size, 1, "rerun tidak membuat dokumen run baru");
});

test("write mode: finding lama yang tidak muncul lagi ditandai supersededAt, BUKAN dihapus", async () => {
  const write = writeContextFixtures();
  const ctxWithItem = sourceContext({
    orderItems: fake<OlseraOrderItemDocument>([{ _id: 1, date: "2026-05-10", itemName: "X", normalizedItemName: "X", categoryResolutionStatus: "resolved", resolvedCategoryName: "Lapangan" }]),
  });
  await runReconciliation(baseInput({ dryRun: false }), { source: ctxWithItem, write });
  assert.equal(write.findings.docs.size, 1);
  const [firstDoc] = [...write.findings.docs.values()];
  assert.equal(firstDoc.supersededAt, null);

  // Rerun TANPA item tsb lagi (mis. item sudah tidak muncul di periode ini).
  const ctxWithoutItem = sourceContext({ orderItems: fake<OlseraOrderItemDocument>([]) });
  await runReconciliation(baseInput({ dryRun: false }), { source: ctxWithoutItem, write });
  assert.equal(write.findings.docs.size, 1, "dokumen TIDAK dihapus");
  const [stillThere] = [...write.findings.docs.values()];
  assert.notEqual(stillThere.supersededAt, null, "ditandai superseded, bukan dihapus");
});

test("write mode: menolak dua eksekusi aktif yang sama (run masih 'running' & belum basi)", async () => {
  const write = writeContextFixtures();
  const now = new Date();
  write.runs.docs.set("INTERNAL_OLSERA:1:monthly:2026-05:CATEGORY:v1", {
    _id: "INTERNAL_OLSERA:1:monthly:2026-05:CATEGORY:v1",
    reconciliationType: "INTERNAL_OLSERA",
    storeId: 1,
    scope: "monthly",
    period: "2026-05",
    sourceSystems: ["olsera"],
    status: "running",
    summary: {} as never,
    checkpoint: { cursor: null, stage: null, completedDomains: [] },
    version: 1,
    errorMessage: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
  });
  await assert.rejects(() => runReconciliation(baseInput({ dryRun: false }), { source: sourceContext(), write }), ReconciliationRunnerError);
});

test("write mode: partial failure (satu domain gagal) tidak menghasilkan status success/MATCH palsu, domain lain tetap tersimpan", async () => {
  const write = writeContextFixtures();
  const failingOrderItems: MinimalReadCollection<Doc> = {
    find() {
      throw new Error("simulasi kegagalan baca sumber data");
    },
  };
  const ctx = sourceContext({
    orderItems: failingOrderItems as never,
    inventoryMovements: fake<OlseraInventoryMovementDocument>([{ _id: "sale:1", storeId: 1, date: "2026-05-10", productId: null, variantId: null, productName: "A", qtyChange: -1 }]),
  });
  const result = await runReconciliation(baseInput({ dryRun: false, domains: ["CATEGORY", "INVENTORY"] }), { source: ctx, write });
  assert.equal(result.status, "partial");
  assert.ok(result.domainErrors.CATEGORY, "domain yang gagal harus tercatat pesan errornya");
  assert.equal(result.checkpoint.completedDomains.includes("INVENTORY"), true);
  assert.equal(result.checkpoint.failedDomains.includes("CATEGORY"), true);
  // Finding domain yang berhasil (INVENTORY) tetap ditulis walau CATEGORY gagal.
  const invFindings = [...write.findings.docs.values()].filter((d) => d.domain === "INVENTORY");
  assert.equal(invFindings.length, 1);
});

test("write mode: seluruh domain gagal -> status failed, tidak ada finding ditulis", async () => {
  const write = writeContextFixtures();
  const failing: MinimalReadCollection<Doc> = {
    find() {
      throw new Error("gagal total");
    },
  };
  const ctx = sourceContext({ orderItems: failing as never, inventoryMovements: failing as never });
  const result = await runReconciliation(baseInput({ dryRun: false, domains: ["CATEGORY", "INVENTORY"] }), { source: ctx, write });
  assert.equal(result.status, "failed");
  assert.equal(write.findings.docs.size, 0);
});

test("write mode: checkpoint.completedDomains bertambah per domain yang berhasil diproses", async () => {
  const write = writeContextFixtures();
  const ctx = sourceContext({
    orderItems: fake<OlseraOrderItemDocument>([{ _id: 1, date: "2026-05-10", itemName: "X", normalizedItemName: "X", categoryResolutionStatus: "resolved", resolvedCategoryName: "Lapangan" }]),
  });
  await runReconciliation(baseInput({ dryRun: false, domains: ["CATEGORY"] }), { source: ctx, write });
  const runDoc = write.runs.docs.get("INTERNAL_OLSERA:1:monthly:2026-05:CATEGORY:v1")!;
  assert.deepEqual(runDoc.checkpoint?.completedDomains, ["CATEGORY"]);
  assert.equal(runDoc.status, "success");
});

// ---- Draft-period impact cap (determineDraftCapReason) -----------------------

function sourceFinding(overrides: Partial<SourceFinding> = {}): SourceFinding {
  return {
    status: "MISMATCH",
    impact: "ERROR",
    confidence: "HIGH",
    ruleId: "internal.inventory-movement.v1",
    expected: {},
    actual: {},
    difference: null,
    diagnostics: {},
    candidates: [],
    knownCaseRef: null,
    domain: "INVENTORY",
    entityKey: "movement-qty:1:0",
    sourceRefs: {},
    ...overrides,
  };
}

test("determineDraftCapReason: bulan tertutup (isDraftPeriod=false) TIDAK PERNAH di-cap, apa pun kondisinya", () => {
  assert.equal(determineDraftCapReason(sourceFinding({ diagnostics: { hasSnapshotDoc: false } }), false), null);
  assert.equal(determineDraftCapReason(sourceFinding({ domain: "SNAPSHOT", status: "MISSING_IN_SNAPSHOT", diagnostics: { missingSide: "next" } }), false), null);
  assert.equal(determineDraftCapReason(sourceFinding({ impact: "CRITICAL" }), false), null);
});

test("determineDraftCapReason: SNAPSHOT missingSide 'next' pada draft period -> missing-next-month-snapshot", () => {
  const f = sourceFinding({ domain: "SNAPSHOT", status: "MISSING_IN_SNAPSHOT", diagnostics: { missingSide: "next" } });
  assert.equal(determineDraftCapReason(f, true), "missing-next-month-snapshot");
});

test("determineDraftCapReason: SNAPSHOT missingSide 'current'/'both' TIDAK di-cap (bukan sekadar bulan berjalan)", () => {
  assert.equal(determineDraftCapReason(sourceFinding({ domain: "SNAPSHOT", status: "MISSING_IN_SNAPSHOT", diagnostics: { missingSide: "current" } }), true), null);
  assert.equal(determineDraftCapReason(sourceFinding({ domain: "SNAPSHOT", status: "MISSING_IN_SNAPSHOT", diagnostics: { missingSide: "both" } }), true), null);
});

test("determineDraftCapReason: INVENTORY tanpa dokumen snapshot sama sekali di draft period -> current-month", () => {
  const f = sourceFinding({ status: "MISSING_IN_SNAPSHOT", diagnostics: { hasSnapshotDoc: false } });
  assert.equal(determineDraftCapReason(f, true), "current-month");
});

test("determineDraftCapReason: INVENTORY snapshotStatus boundary-only/incomplete -> di-cap sesuai reason", () => {
  assert.equal(determineDraftCapReason(sourceFinding({ diagnostics: { hasSnapshotDoc: true, snapshotStatus: "boundary-only" } }), true), "boundary-only");
  assert.equal(determineDraftCapReason(sourceFinding({ diagnostics: { hasSnapshotDoc: true, snapshotStatus: "incomplete" } }), true), "incomplete-current-period-snapshot");
});

test("determineDraftCapReason: MISMATCH nyata (snapshotStatus 'complete') di draft period TIDAK di-cap tanpa alasan", () => {
  const f = sourceFinding({ diagnostics: { hasSnapshotDoc: true, snapshotStatus: "complete" } });
  assert.equal(determineDraftCapReason(f, true), null);
});

test("determineDraftCapReason: status MATCH tidak pernah dievaluasi untuk cap (tidak relevan)", () => {
  assert.equal(determineDraftCapReason(sourceFinding({ status: "MATCH", impact: "INFO" }), true), null);
});

test("integration: ERROR current-month boundary (INVENTORY tanpa snapshot doc) -> impact ter-cap ke INFO, status/confidence/requiresManualAdjustment tidak berubah", async () => {
  const currentPeriod = jakartaCurrentPeriod();
  const ctx = sourceContext({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([{ _id: "sale:1", storeId: 1, date: `${currentPeriod}-05`, productId: 200, variantId: null, productName: "Produk Baru", qtyChange: -5 }]),
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([]), // sengaja kosong -> hasSnapshotDoc=false
  });
  const result = await runReconciliation(baseInput({ period: currentPeriod, domains: ["INVENTORY"], dryRun: true }), { source: ctx });
  const finding = result.findings.find((f) => f.entityKey === "movement-qty:200:0")!;
  assert.ok(finding, "finding harus ada");
  assert.equal(finding.status, "MISSING_IN_SNAPSHOT", "status tidak boleh berubah oleh cap");
  assert.equal(finding.confidence, "HIGH", "confidence tidak boleh dinaikkan/diturunkan oleh cap");
  assert.equal(finding.impact, "INFO", "impact harus ter-cap ke INFO (default MISSING_IN_SNAPSHOT adalah ERROR)");
  assert.equal((finding.diagnostics as Record<string, unknown>).draftPeriodCap && (finding.diagnostics as any).draftPeriodCap.reason, "current-month");
  assert.equal(result.summary.isDraftPeriod, true);
});

test("integration: ERROR closed month (bukan draft) TETAP ERROR — tidak ter-cap", async () => {
  const ctx = sourceContext({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([{ _id: "sale:1", storeId: 1, date: "2020-01-05", productId: 200, variantId: null, productName: "Produk Lama", qtyChange: -5 }]),
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([]),
  });
  const result = await runReconciliation(baseInput({ period: "2020-01", domains: ["INVENTORY"], dryRun: true }), { source: ctx });
  const finding = result.findings.find((f) => f.entityKey === "movement-qty:200:0")!;
  assert.equal(finding.status, "MISSING_IN_SNAPSHOT");
  assert.equal(finding.impact, "ERROR", "bulan tertutup tidak boleh ter-cap");
  assert.equal(result.summary.isDraftPeriod, false);
});

test("integration: MISMATCH nyata di current month (snapshot berstatus 'complete') TIDAK diturunkan tanpa alasan", async () => {
  const currentPeriod = jakartaCurrentPeriod();
  const ctx = sourceContext({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([{ _id: "sale:1", storeId: 1, date: `${currentPeriod}-05`, productId: 300, variantId: null, productName: "Produk C", qtyChange: -50 }]),
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([{ storeId: 1, year: Number(currentPeriod.slice(0, 4)), month: Number(currentPeriod.slice(5, 7)), productId: 300, variantId: null, salesQty: 5, status: "complete" }]),
  });
  const result = await runReconciliation(baseInput({ period: currentPeriod, domains: ["INVENTORY"], dryRun: true }), { source: ctx });
  const finding = result.findings.find((f) => f.entityKey === "movement-qty:300:0")!;
  assert.equal(finding.status, "MISMATCH");
  assert.equal(finding.impact, "ERROR", "snapshot 'complete' berarti bukan akibat boundary/incomplete -> tidak boleh di-cap");
});

test("integration: summary.highestImpact memakai impact FINAL setelah cap (bukan impact mentah sebelum cap)", async () => {
  const currentPeriod = jakartaCurrentPeriod();
  const ctx = sourceContext({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([{ _id: "sale:1", storeId: 1, date: `${currentPeriod}-05`, productId: 400, variantId: null, productName: "Produk D", qtyChange: -5 }]),
    inventoryMonthlySnapshots: fake<OlseraInventoryMonthlySnapshotDocument>([]), // hasSnapshotDoc=false -> di-cap ke INFO
  });
  const result = await runReconciliation(baseInput({ period: currentPeriod, domains: ["INVENTORY"], dryRun: true }), { source: ctx });
  assert.equal(result.summary.highestImpact, "INFO", "satu-satunya finding sudah di-cap ke INFO, highestImpact tidak boleh melaporkan ERROR mentah");
});

// ---- Verifikasi Known Case 37 (movement productId null, storeId legacy null) --

test("integration: movement productId null (storeId:null legacy) -> requiresManualAdjustment=true, confidence bukan HIGH, entityKey deterministik", async () => {
  const ctx = sourceContext({
    inventoryMovements: fake<OlseraInventoryMovementDocument>([{ _id: "sale:legacy-37", storeId: null, date: "2026-05-10", productId: null, variantId: null, productName: "Legacy", qtyChange: -3 }]),
  });
  const result = await runReconciliation(baseInput({ period: "2026-05", domains: ["INVENTORY"], dryRun: true }), { source: ctx });
  const finding = result.findings.find((f) => f.entityKey === "movement-null:sale:legacy-37")!;
  assert.ok(finding, "finding Known Case 37 harus muncul walau movement storeId:null (bukan storeId toko yang diminta)");
  assert.equal(finding.requiresManualAdjustment, true, "Known Case 37 SELALU requiresManualAdjustment=true");
  assert.notEqual(finding.confidence, "HIGH");
  assert.equal(finding.entityKey, "movement-null:sale:legacy-37");
  assert.equal((finding.actual as Record<string, unknown>).productId, null, "productId TIDAK PERNAH diisi otomatis");
});
