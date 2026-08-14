// Route-level test untuk POST /api/private/integration-monitor — fokus pada
// gap check/recovery BARU (Inventori/Financial, Phase 3-5) yang reuse
// computeInventoryValidation/computeFinancialValidation (SAMA persis dengan
// GET /api/audit/olsera-validation, lihat lib/olsera-validation-sections.ts)
// plus rebuild resmi (ensureMonthlySnapshotChain / startFinancialSync+
// stepFinancialSync). Semua dependency (auth/mongo/olsera/ayo) di-mock lewat
// --experimental-test-module-mocks SEBELUM route diimpor — TIDAK PERNAH
// menyentuh MongoDB/Olsera/AYO sungguhan.
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

function collectionStub(rows: unknown[]) {
  return { find: () => ({ toArray: async () => rows }) };
}

// ---- state dikendalikan test, dibaca oleh mock module di bawah ----
let storedInventoryRows: Array<{ productId: number; productName: string; closingQty: number | null }> = [];
let stockmovementResult: { ok: true; rows: Array<{ productId: number; sisa: number }> } | { ok: false; error: string } = { ok: true, rows: [] };
let storedFinancialReports: Array<{ reportType: string; normalizedPayload: unknown }> = [];
let liveBalanceSheetTotals: Record<string, number> = {};
let liveLedgerRows: Array<Record<string, unknown>> = [];
let ensureMonthlySnapshotChainResult: { ok: true; storeId: number; docs: unknown[] } | { ok: false; error: string } = { ok: true, storeId: 1, docs: [{ productId: 1 }] };
const ensureMonthlySnapshotChainCalls: Array<{ year: number; month: number }> = [];
// true = simulasikan rebuild BENAR-BENAR memperbaiki snapshot (stored disamakan
// dengan live, seperti rebuild sungguhan yang menulis ulang dari source Olsera).
// false = simulasikan bulan historis yang dilindungi (rebuild no-op, lihat
// isTrustedHistorical di lib/olsera-inventory-monthly-snapshot-store.ts) —
// mismatch TETAP ada setelah recovery, tidak boleh dipaksa Cocok.
let rebuildFixesStoredInventory = true;

// Dokumen "database" in-memory untuk collection generik (data_gap_audit_state/
// _runs/_locks) — cukup untuk membuktikan alur fresh-gap-required + lock,
// tanpa mock per-collection terpisah.
const genericDocs = new Map<string, Map<unknown, Record<string, unknown>>>();
function fakeCollection(name: string) {
  if (!genericDocs.has(name)) genericDocs.set(name, new Map());
  const store = genericDocs.get(name)!;
  return {
    findOne: async (filter: Record<string, unknown>) => store.get(filter._id) ?? null,
    updateOne: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => { store.set(filter._id, { ...(store.get(filter._id) ?? {}), ...update.$set }); return { acknowledged: true }; },
    insertOne: async (doc: Record<string, unknown>) => { store.set(Symbol(), doc); return { acknowledged: true }; },
    findOneAndUpdate: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => { const existing = store.get(filter._id); if (existing && typeof existing.lockedUntil === "object" && (existing.lockedUntil as Date).getTime() > Date.now()) return null; const next = { ...(existing ?? {}), ...update.$set }; store.set(filter._id, next); return next; },
  };
}

mock.module("@/lib/auth", { namedExports: { requireModule: mock.fn(async () => ({ id: "u1", role: "user" as const, allowedModules: ["audit"] })) } });
mock.module("@/lib/mongodb", {
  namedExports: {
    getDb: async () => ({ collection: (name: string) => fakeCollection(name) }),
    withMongo: async (handler: () => Promise<unknown>) => handler(),
    collections: async () => ({
      ayoPaymentEventSyncState: { findOne: async () => null },
      bookings: { find: () => ({ toArray: async () => [] }), bulkWrite: async () => ({}) },
      ayoPaymentEvents: { find: () => ({ toArray: async () => [] }), bulkWrite: async () => ({}) },
      olseraOrderItems: { find: () => ({ toArray: async () => [] }), bulkWrite: async () => ({}) },
      olseraInventoryMonthlySnapshots: collectionStub(storedInventoryRows),
      olseraFinancialMonthlyReports: collectionStub(storedFinancialReports),
    }),
  },
});
mock.module("@/lib/ayo", { namedExports: { fetchAyoBookingsByDateRange: async () => ({ data: [] }) } });
mock.module("@/lib/booking-mapper", { namedExports: { normalizeBooking: (row: unknown) => row } });
mock.module("@/lib/ayo-payment-events", { namedExports: { fetchAyoPaymentEvents: async () => ({ events: [] }), paymentEventIdentity: () => null } });
mock.module("@/lib/olsera-sync", {
  namedExports: {
    fetchOlseraSalesAuditSource: async () => ({ orders: [], items: [] }),
    OlseraSalesAuditSourceError: class OlseraSalesAuditSourceError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } },
  },
});
mock.module("@/lib/private-integration-monitor", { namedExports: { integrationTokenHealth: () => [], classifyAyoMobileToken: () => null } });
mock.module("@/lib/connection-health", { namedExports: { getConnectionHealthSummary: async () => null } });

mock.module("@/lib/olsera-inventory-stockmovement", { namedExports: { fetchStockMovementRange: async () => stockmovementResult } });
mock.module("@/lib/olsera-financial-client", {
  namedExports: { getBalanceSheet: async () => ({}), getProfitLoss: async () => ({}), getCashFlow: async () => ({}), getLedgerSummary: async () => ({}) },
});
mock.module("@/lib/olsera-financial-core", {
  namedExports: {
    normalizeBalanceSheetPayload: () => ({ totals: liveBalanceSheetTotals }),
    normalizeProfitLossPayload: () => ({ totals: {} }),
    normalizeCashFlowPayload: () => ({ totals: {} }),
    normalizeLedgerSummaryPayload: () => liveLedgerRows,
  },
});
// lib/olsera-validation-sections.ts itu sendiri TIDAK di-mock (real code,
// sama seperti dipakai GET /api/audit/olsera-validation) — hanya
// dependency-nya (mongodb/olsera-sync/dst di atas) yang di-mock. Ini
// membuktikan gap-check inventory/financial di route ini benar-benar reuse
// computeInventoryValidation/computeFinancialValidation, bukan implementasi
// paralel yang bisa drift.
mock.module("@/lib/olsera-inventory-monthly-snapshot-store", {
  namedExports: {
    ensureMonthlySnapshotChain: mock.fn(async (input: { year: number; month: number }) => {
      ensureMonthlySnapshotChainCalls.push(input);
      if (ensureMonthlySnapshotChainResult.ok && rebuildFixesStoredInventory && stockmovementResult.ok) {
        const live = new Map(stockmovementResult.rows.map((row) => [row.productId, row.sisa]));
        storedInventoryRows = storedInventoryRows.map((row) => ({ ...row, closingQty: live.get(row.productId) ?? row.closingQty }));
      }
      return ensureMonthlySnapshotChainResult;
    }),
  },
});
let financialRunStatus: { status: "running" | "partial" | "success"; progress: { accountsTotal: number; accountsProcessed: number } } = { status: "success", progress: { accountsTotal: 2, accountsProcessed: 2 } };
let financialStepCalls = 0;
// Simulasikan startFinancialSync menulis ulang ledger-summary (upsert resmi,
// lib/olsera-financial-store.ts upsertMonthlyReport) supaya stored == live
// setelah sync sukses — sama seperti test inventory di atas.
let rebuildFixesStoredFinancial = true;
mock.module("@/lib/olsera-financial-sync", {
  namedExports: {
    startFinancialSync: mock.fn(async () => {
      financialStepCalls = 0;
      if (financialRunStatus.status === "success" && rebuildFixesStoredFinancial) {
        storedFinancialReports = [
          { reportType: "balance-sheet", normalizedPayload: { totals: liveBalanceSheetTotals } },
          { reportType: "profit-loss", normalizedPayload: { totals: {} } },
          { reportType: "cash-flow", normalizedPayload: { totals: {} } },
          { reportType: "ledger-summary", normalizedPayload: liveLedgerRows },
        ];
      }
      return { _id: "run-1" };
    }),
    stepFinancialSync: mock.fn(async () => { financialStepCalls += 1; }),
    getFinancialSyncStatus: mock.fn(async () => financialRunStatus),
  },
});
mock.module("@/lib/olsera-financial-store", {
  namedExports: {
    financialSyncRunId: (period: string) => `financial:1:${period}`,
    getFinancialSyncRun: async () => null,
  },
});

let POST!: typeof import("./route.ts").POST;
before(async () => {
  ({ POST } = await import("./route.ts"));
});

function req(body: unknown) {
  return new Request("http://localhost/api/private/integration-monitor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test.beforeEach(() => {
  genericDocs.clear();
  storedInventoryRows = [{ productId: 1, productName: "Produk A", closingQty: 10 }];
  stockmovementResult = { ok: true, rows: [{ productId: 1, sisa: 10 }] };
  storedFinancialReports = [];
  liveBalanceSheetTotals = {};
  liveLedgerRows = [];
  ensureMonthlySnapshotChainResult = { ok: true, storeId: 1, docs: [{ productId: 1 }] };
  ensureMonthlySnapshotChainCalls.length = 0;
  rebuildFixesStoredInventory = true;
  financialRunStatus = { status: "success", progress: { accountsTotal: 2, accountsProcessed: 2 } };
  financialStepCalls = 0;
  rebuildFixesStoredFinancial = true;
});

test("dropdown period source: startDate/endDate beda bulan ditolak 400", async () => {
  const res = await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-03-28", action: "check" }));
  assert.equal(res.status, 400);
});

test("inventory check: 1/1 cocok -> status Cocok, period diteruskan benar ke computeInventoryValidation", async () => {
  const res = await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "check" }));
  const body = await res.json();
  assert.equal(body.status, "Cocok");
  assert.equal(body.period, "2026-02");
  assert.equal(body.checked, 1);
});

test("inventory check: 2 dari 3 mismatch -> status Selisih dengan detail produk", async () => {
  storedInventoryRows = [
    { productId: 1, productName: "Produk A", closingQty: 10 },
    { productId: 2, productName: "Produk B", closingQty: 5 },
    { productId: 3, productName: "Produk C", closingQty: 7 },
  ];
  stockmovementResult = { ok: true, rows: [{ productId: 1, sisa: 10 }, { productId: 2, sisa: 8 }, { productId: 3, sisa: 9 }] };
  const res = await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "check" }));
  const body = await res.json();
  assert.equal(body.status, "Selisih");
  assert.equal(body.differences.length, 2);
});

test("inventory repair TANPA fresh gap check -> MANUAL_REVIEW_REQUIRED, ensureMonthlySnapshotChain TIDAK dipanggil", async () => {
  const res = await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "repair" }));
  const body = await res.json();
  assert.equal(body.status, "MANUAL_REVIEW_REQUIRED");
  assert.equal(ensureMonthlySnapshotChainCalls.length, 0, "recovery tidak boleh jalan tanpa Cek Gap segar (Selisih) terlebih dahulu");
});

test("inventory repair: pakai rebuild resmi (ensureMonthlySnapshotChain), lalu auto-rerun validator, period benar", async () => {
  storedInventoryRows = [{ productId: 1, productName: "Produk A", closingQty: 5 }];
  stockmovementResult = { ok: true, rows: [{ productId: 1, sisa: 10 }] };
  await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "check" }));
  const res = await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "repair" }));
  const body = await res.json();
  assert.deepEqual(ensureMonthlySnapshotChainCalls, [{ year: 2026, month: 2 }]);
  assert.equal(body.status, "Cocok", "setelah rebuild berhasil menyamakan stored dengan live, re-run computeInventoryValidation melaporkan Cocok apa adanya");
  assert.ok(body.repaired > 0);
});

test("inventory repair: bulan historis dilindungi (rebuild no-op) -> mismatch TETAP Selisih, tidak dipaksa Cocok", async () => {
  storedInventoryRows = [{ productId: 1, productName: "Produk A", closingQty: 5 }];
  stockmovementResult = { ok: true, rows: [{ productId: 1, sisa: 10 }] };
  rebuildFixesStoredInventory = false;
  await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "check" }));
  const res = await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "repair" }));
  const body = await res.json();
  assert.equal(ensureMonthlySnapshotChainCalls.length, 1, "recovery tetap dijalankan (bukan diskip)");
  assert.equal(body.status, "Selisih", "hasil recovery yang tidak benar-benar mengubah data historis dilindungi HARUS tetap Selisih, bukan dipaksa Cocok");
});

test("inventory repair: rebuild gagal (identity belum verified/anchor tidak ada) -> Gagal Dicek, BUKAN dipaksa Cocok", async () => {
  storedInventoryRows = [{ productId: 1, productName: "Produk A", closingQty: 5 }];
  stockmovementResult = { ok: true, rows: [{ productId: 1, sisa: 10 }] };
  await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "check" }));
  ensureMonthlySnapshotChainResult = { ok: false, error: "Tidak ada snapshot bulanan ter-anchor." };
  const res = await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "repair" }));
  const body = await res.json();
  assert.equal(body.status, "Gagal Dicek");
  assert.match(body.detail, /anchor/);
});

test("inventory repair: recovery TIDAK membuat movement palsu — ensureMonthlySnapshotChain dipanggil TANPA payload movement/angka manual", async () => {
  storedInventoryRows = [{ productId: 1, productName: "Produk A", closingQty: 5 }];
  stockmovementResult = { ok: true, rows: [{ productId: 1, sisa: 10 }] };
  await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "check" }));
  await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "repair" }));
  assert.deepEqual(Object.keys(ensureMonthlySnapshotChainCalls[0]).sort(), ["month", "year"]);
});

test("financial check: 32/85-style mismatch terdeteksi (contoh kecil) via computeFinancialValidation yang sama dengan validator", async () => {
  storedFinancialReports = [{ reportType: "ledger-summary", normalizedPayload: [{ accountCode: "100", accountName: "Kas", debit: 10, credit: 0, balance: 100 }, { accountCode: "200", accountName: "Bank", debit: 5, credit: 0, balance: 50 }] }];
  liveLedgerRows = [{ accountCode: "100", accountName: "Kas", debit: 10, credit: 0, balance: 150 }, { accountCode: "200", accountName: "Bank", debit: 5, credit: 0, balance: 50 }];
  const res = await POST(req({ source: "olsera-financial", startDate: "2026-02-01", endDate: "2026-02-28", action: "check" }));
  const body = await res.json();
  assert.equal(body.status, "Selisih");
  assert.equal(body.ledgerAccounts.checked, 2);
  assert.equal(body.ledgerAccounts.matching, 1);
  assert.equal(body.ledgerAccounts.differences.length, 1);
  assert.equal(body.ledgerAccounts.differences[0].accountCode, "100");
});

test("financial repair: drive startFinancialSync + stepFinancialSync sampai success, lalu auto-rerun validator", async () => {
  storedFinancialReports = [];
  await POST(req({ source: "olsera-financial", startDate: "2026-02-01", endDate: "2026-02-28", action: "check" }));
  const res = await POST(req({ source: "olsera-financial", startDate: "2026-02-01", endDate: "2026-02-28", action: "repair" }));
  const body = await res.json();
  assert.equal(body.status, "Cocok");
  assert.ok(body.repaired > 0);
});

test("financial repair: sync belum selesai (timeout/in-progress) -> status Gagal Dicek dengan progress, snapshot lama TIDAK disebut rusak/dihapus", async () => {
  storedFinancialReports = [{ reportType: "ledger-summary", normalizedPayload: [{ accountCode: "100", accountName: "Kas", debit: 1, credit: 0, balance: 1 }] }];
  liveLedgerRows = [{ accountCode: "100", accountName: "Kas", debit: 2, credit: 0, balance: 2 }];
  await POST(req({ source: "olsera-financial", startDate: "2026-02-01", endDate: "2026-02-28", action: "check" }));
  financialRunStatus = { status: "partial", progress: { accountsTotal: 85, accountsProcessed: 40 } };
  const res = await POST(req({ source: "olsera-financial", startDate: "2026-02-01", endDate: "2026-02-28", action: "repair" }));
  const body = await res.json();
  assert.equal(body.status, "Gagal Dicek");
  assert.match(body.detail, /belum selesai/);
  assert.match(body.detail, /40\/85/);
});

test("AYO Booking (existing behavior) tetap MANUAL_REVIEW_REQUIRED bila repair dipanggil tanpa Cek Gap dulu — regresi", async () => {
  const res = await POST(req({ source: "ayo-booking", startDate: "2026-02-01", endDate: "2026-02-05", action: "repair" }));
  const body = await res.json();
  assert.equal(body.status, "MANUAL_REVIEW_REQUIRED");
});

test("no secret leak: response gagal tidak pernah menyertakan token/authorization", async () => {
  const res = await POST(req({ source: "olsera-inventory", startDate: "2026-02-01", endDate: "2026-02-28", action: "repair" }));
  const text = await res.text();
  assert.doesNotMatch(text.toLowerCase(), /bearer |authorization|"token"/);
});
