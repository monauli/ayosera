// Test service read-only Modul Rekonsiliasi (Phase 5A) — MongoDB DIGANTI
// koleksi palsu in-memory (dependency injection, pola sama
// lib/olsera-financial-di.test.ts) supaya TIDAK PERNAH menyentuh database
// sungguhan. Fokus: storeId wajib, paginasi dibatasi, filter tervalidasi,
// operator Mongo dari client ditolak, isolasi lintas toko.
import assert from "node:assert/strict";
import test from "node:test";
import {
  currentStoreId,
  getRunDetail,
  listFindings,
  listRuns,
  ReconciliationValidationError,
  validateStoreId,
  type ReconciliationStoreContext,
} from "./reconciliation-store.ts";

type Doc = Record<string, unknown>;

class FakeCursor<T extends Doc> {
  private docs: T[];
  constructor(docs: T[]) {
    this.docs = docs;
  }
  sort(spec: Record<string, 1 | -1>) {
    const [key, dir] = Object.entries(spec)[0] ?? ["_id", 1];
    this.docs = [...this.docs].sort((a, b) => {
      const av = a[key] as string | number | Date;
      const bv = b[key] as string | number | Date;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
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

class FakeCollection<T extends Doc> {
  private all: T[];
  constructor(all: T[]) {
    this.all = all;
  }
  private matches(doc: T, filter: Record<string, unknown>) {
    return Object.entries(filter).every(([key, value]) => (doc as Doc)[key] === value);
  }
  find(filter: Record<string, unknown>) {
    return new FakeCursor(this.all.filter((doc) => this.matches(doc, filter)));
  }
  async findOne(filter: Record<string, unknown>) {
    return this.all.find((doc) => this.matches(doc, filter)) ?? null;
  }
  async countDocuments(filter: Record<string, unknown>) {
    return this.all.filter((doc) => this.matches(doc, filter)).length;
  }
}

function makeRun(overrides: Partial<Doc> = {}): Doc {
  return {
    _id: `run-${Math.random()}`,
    reconciliationType: "INTERNAL_OLSERA",
    storeId: 1,
    scope: "monthly",
    period: "2026-07",
    startedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Doc> = {}): Doc {
  return {
    _id: `find-${Math.random()}`,
    reconciliationType: "INTERNAL_OLSERA",
    domain: "CATEGORY",
    status: "MATCH",
    storeId: 1,
    period: "2026-07",
    runId: "run-1",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    requiresManualAdjustment: false,
    ...overrides,
  };
}

function context(runs: Doc[], findings: Doc[]): ReconciliationStoreContext {
  return { runs: new FakeCollection(runs) as never, findings: new FakeCollection(findings) as never };
}

// ---- storeId wajib ----------------------------------------------------------

test("validateStoreId menolak nilai kosong/negatif/bukan angka", () => {
  assert.throws(() => validateStoreId(undefined), ReconciliationValidationError);
  assert.throws(() => validateStoreId(0), ReconciliationValidationError);
  assert.throws(() => validateStoreId(-1), ReconciliationValidationError);
  assert.throws(() => validateStoreId("abc"), ReconciliationValidationError);
  assert.equal(validateStoreId("42"), 42);
});

test("listRuns/listFindings/getRunDetail menolak storeId tidak valid", async () => {
  const ctx = context([], []);
  await assert.rejects(() => listRuns({ storeId: 0 }, ctx), ReconciliationValidationError);
  await assert.rejects(() => listFindings({ storeId: NaN }, ctx), ReconciliationValidationError);
  await assert.rejects(() => getRunDetail({ runId: "x", storeId: -5 }, ctx), ReconciliationValidationError);
});

test("currentStoreId membaca dari OLSERA_INTERNAL_STORE_ID (server), tidak menerima parameter", () => {
  const prev = process.env.OLSERA_INTERNAL_STORE_ID;
  process.env.OLSERA_INTERNAL_STORE_ID = "324175";
  assert.equal(currentStoreId(), 324175);
  process.env.OLSERA_INTERNAL_STORE_ID = prev;
});

// ---- pagination dibatasi -----------------------------------------------------

test("listFindings: limit di atas batas (200) dipangkas, tidak diteruskan mentah ke query", async () => {
  const findings = Array.from({ length: 250 }, (_, i) => makeFinding({ _id: `f${i}`, createdAt: new Date(2026, 6, 1 + (i % 28)) }));
  const ctx = context([], findings);
  const result = await listFindings({ storeId: 1, limit: 100000 }, ctx);
  assert.equal(result.limit, 200);
  assert.equal(result.items.length, 200);
  assert.equal(result.total, 250);
});

test("listRuns: page negatif/nol dianggap 1, bukan skip negatif", async () => {
  const runs = [makeRun({ _id: "a", startedAt: new Date("2026-07-01") }), makeRun({ _id: "b", startedAt: new Date("2026-07-02") })];
  const ctx = context(runs, []);
  const result = await listRuns({ storeId: 1, page: -5 }, ctx);
  assert.equal(result.page, 1);
  assert.equal(result.items.length, 2);
});

// ---- filter invalid ditolak ---------------------------------------------------

test("listFindings menolak status/domain/reconciliationType tidak dikenal", async () => {
  const ctx = context([], []);
  await assert.rejects(() => listFindings({ storeId: 1, status: "TIDAK_ADA" }, ctx), ReconciliationValidationError);
  await assert.rejects(() => listFindings({ storeId: 1, domain: "TIDAK_ADA" }, ctx), ReconciliationValidationError);
  await assert.rejects(() => listFindings({ storeId: 1, reconciliationType: "TIDAK_ADA" }, ctx), ReconciliationValidationError);
});

test("listFindings menolak format period tidak valid", async () => {
  const ctx = context([], []);
  await assert.rejects(() => listFindings({ storeId: 1, period: "bukan-periode" }, ctx), ReconciliationValidationError);
  await assert.rejects(() => listFindings({ storeId: 1, period: "2026/07" }, ctx), ReconciliationValidationError);
});

test("listFindings menolak sort field di luar allow-list", async () => {
  const ctx = context([], []);
  await assert.rejects(() => listFindings({ storeId: 1, sort: "$where" }, ctx), ReconciliationValidationError);
});

test("listFindings menolak requiresManualAdjustment yang bukan boolean", async () => {
  const ctx = context([], []);
  await assert.rejects(() => listFindings({ storeId: 1, requiresManualAdjustment: "true" }, ctx), ReconciliationValidationError);
});

// ---- operator injection ditolak ----------------------------------------------

test("listFindings menolak operator MongoDB mentah pada status/domain (bukan string valid)", async () => {
  const ctx = context([], []);
  await assert.rejects(() => listFindings({ storeId: 1, status: { $ne: null } }, ctx), ReconciliationValidationError);
  await assert.rejects(() => listFindings({ storeId: 1, domain: { $regex: ".*" } }, ctx), ReconciliationValidationError);
  await assert.rejects(() => listFindings({ storeId: 1, period: { $gt: "" } }, ctx), ReconciliationValidationError);
});

test("listFindings dapat difilter berdasarkan impact/confidence yang valid, menolak nilai tidak dikenal/operator", async () => {
  const findings = [
    makeFinding({ _id: "f1", impact: "ERROR", confidence: "HIGH" }),
    makeFinding({ _id: "f2", impact: "WARNING", confidence: "LOW" }),
  ];
  const ctx = context([], findings);
  const errorOnly = await listFindings({ storeId: 1, impact: "ERROR" }, ctx);
  assert.equal(errorOnly.items.length, 1);
  assert.equal((errorOnly.items[0] as Doc)._id, "f1");

  const lowConfidence = await listFindings({ storeId: 1, confidence: "LOW" }, ctx);
  assert.equal(lowConfidence.items.length, 1);
  assert.equal((lowConfidence.items[0] as Doc)._id, "f2");

  await assert.rejects(() => listFindings({ storeId: 1, impact: "TIDAK_ADA" }, ctx), ReconciliationValidationError);
  await assert.rejects(() => listFindings({ storeId: 1, confidence: { $ne: null } }, ctx), ReconciliationValidationError);
});

test("listRuns menolak object sebagai reconciliationType (bukan hanya string tidak dikenal)", async () => {
  const ctx = context([], []);
  await assert.rejects(() => listRuns({ storeId: 1, reconciliationType: { $ne: null } }, ctx), ReconciliationValidationError);
});

// ---- cross-store tidak terbaca ------------------------------------------------

test("listRuns hanya mengembalikan run milik storeId yang diminta, toko lain tidak ikut", async () => {
  const runs = [makeRun({ _id: "store1-run", storeId: 1 }), makeRun({ _id: "store2-run", storeId: 2 })];
  const ctx = context(runs, []);
  const result = await listRuns({ storeId: 1 }, ctx);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]._id, "store1-run");
});

test("listFindings hanya mengembalikan finding milik storeId yang diminta", async () => {
  const findings = [makeFinding({ _id: "f1", storeId: 1 }), makeFinding({ _id: "f2", storeId: 2 })];
  const ctx = context([], findings);
  const result = await listFindings({ storeId: 1 }, ctx);
  assert.equal(result.total, 1);
  assert.equal(result.items[0]._id, "f1");
});

test("getRunDetail: run milik toko lain diperlakukan seperti tidak ada (null), bukan error/terbaca", async () => {
  const runs = [makeRun({ _id: "run-x", storeId: 2 })];
  const ctx = context(runs, []);
  const result = await getRunDetail({ runId: "run-x", storeId: 1 }, ctx);
  assert.equal(result, null);
});

test("getRunDetail: run milik toko yang benar terbaca normal", async () => {
  const runs = [makeRun({ _id: "run-y", storeId: 1 })];
  const ctx = context(runs, []);
  const result = await getRunDetail({ runId: "run-y", storeId: 1 }, ctx);
  assert.ok(result);
  assert.equal((result as Doc)._id, "run-y");
});
