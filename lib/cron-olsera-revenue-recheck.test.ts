// Test unit endpoint cron "revenue re-check mingguan"
// (app/api/cron/olsera/financial/revenue-recheck/route.ts,
// lib/cron-olsera-revenue-recheck.ts). Pola mocking modul SAMA persis dengan
// lib/cron-olsera-financial.test.ts (node:test module mocking).
// Jalankan: npm run test:cron-olsera-revenue-recheck
import assert from "node:assert/strict";
import { test, mock, before } from "node:test";

process.env.CRON_SECRET = "test-secret";
process.env.OLSERA_INTERNAL_STORE_ID = "324175";

const DAY_MS = 24 * 60 * 60 * 1000;

mock.module("@/lib/olsera-sync", {
  namedExports: { todayJakarta: () => "2026-09-02" },
});

// previousFinancialPeriod REAL-nya adalah math tanggal murni tanpa
// dependensi lain — di sini cukup satu pemetaan tetap (2026-09 -> 2026-08)
// karena todayJakarta di atas sudah dikunci ke "2026-09-02".
mock.module("@/lib/olsera-financial-core", {
  namedExports: {
    previousFinancialPeriod: (period: string) => (period === "2026-09" ? "2026-08" : null),
    // Pass-through murni — normalisasi PAYLOAD BUKAN yang diuji di sini
    // (sudah ada test tersendiri untuk itu); getLedgerDetail/getBalanceSheet/dst
    // di bawah langsung mengembalikan objek berbentuk "sudah ternormalisasi"
    // supaya setiap test bisa mengatur totalRecords/entries secara eksplisit.
    normalizeLedgerDetailPayload: (raw: unknown) => raw,
    normalizeBalanceSheetPayload: (raw: unknown) => raw,
    normalizeProfitLossPayload: (raw: unknown) => raw,
    normalizeCashFlowPayload: (raw: unknown) => raw,
    normalizeLedgerSummaryPayload: (raw: unknown) => raw,
  },
});

const getLedgerDetailMock = mock.fn(async (_period: string, _code: string) => ({ totalRecords: 0, entries: [] as unknown[] }));
const getBalanceSheetMock = mock.fn(async (_period: string) => ({}));
const getProfitLossMock = mock.fn(async (_period: string) => ({}));
const getCashFlowMock = mock.fn(async (_period: string) => ({}));
const getLedgerSummaryMock = mock.fn(async (_period: string) => ({}));
mock.module("@/lib/olsera-financial-client", {
  namedExports: {
    getLedgerDetail: getLedgerDetailMock,
    getBalanceSheet: getBalanceSheetMock,
    getProfitLoss: getProfitLossMock,
    getCashFlow: getCashFlowMock,
    getLedgerSummary: getLedgerSummaryMock,
  },
});

type FakeRevenueRecheckState = {
  accountCodes: string[];
  cursor: number;
  roundStartedAt: Date | null;
  roundFinishedAt: Date | null;
  attempts: number;
  changed: Array<{ code: string; rowsBefore: number; rowsAfter: number; at: Date }>;
};
type FakeSyncLog = {
  _id: string;
  status: string;
  period: string;
  revenueRecheck?: FakeRevenueRecheckState;
  [key: string]: unknown;
};
function fakeSyncLog(overrides: Partial<FakeSyncLog> = {}): FakeSyncLog {
  return {
    _id: "financial:324175:2026-08",
    storeId: 324175,
    period: "2026-08",
    status: "success",
    phase: "completed",
    accountCursor: 85,
    accountCodes: [],
    reportsCompleted: [],
    recordsProcessed: 0,
    accountsProcessed: 85,
    errorMessage: null,
    failedAccountCodes: [],
    recoveredAccountCodes: [],
    accountAttempts: [],
    finalized: true,
    startedAt: new Date(),
    updatedAt: new Date(),
    completedAt: new Date(),
    ...overrides,
  };
}

const getFinancialSyncLogForPeriodMock = mock.fn(async (_period: string) => null as FakeSyncLog | null);
const updateFinancialSyncRunMock = mock.fn(async (_id: string, _patch: Record<string, unknown>) => null);
const bulkUpsertLedgerEntriesMock = mock.fn(async (_code: string, _period: string, _entries: unknown[]) => undefined);
const reconcileLedgerSummarySnapshotMock = mock.fn(async (_period: string) => undefined);
const countLedgerEntriesForAccountMock = mock.fn(async (_period: string, _code: string) => 0);
const upsertMonthlyReportMock = mock.fn(async (_input: unknown) => undefined);
// Sengaja DISERTAKAN sebagai spy walau lib/cron-olsera-revenue-recheck.ts
// TIDAK PERNAH mengimpornya — pagar regresi: kalau suatu saat kode berubah
// dan mulai memanggilnya, test "respons kosong di-skip" di bawah akan gagal.
const recordLedgerEmptyObservationMock = mock.fn(async () => ({ status: "candidate" as const, deletedCount: 0 }));
mock.module("@/lib/olsera-financial-store", {
  namedExports: {
    getFinancialSyncLogForPeriod: getFinancialSyncLogForPeriodMock,
    updateFinancialSyncRun: updateFinancialSyncRunMock,
    bulkUpsertLedgerEntries: bulkUpsertLedgerEntriesMock,
    reconcileLedgerSummarySnapshot: reconcileLedgerSummarySnapshotMock,
    countLedgerEntriesForAccount: countLedgerEntriesForAccountMock,
    upsertMonthlyReport: upsertMonthlyReportMock,
    recordLedgerEmptyObservation: recordLedgerEmptyObservationMock,
  },
});

// FINANCIAL_INVOCATION_TIME_BUDGET_MS dan FINANCIAL_MIN_REMAINING_MS_TO_START_WORK
// harus SAMA dengan production (lib/olsera-financial-sync.ts) — modul ini
// di-mock UTUH, jadi tanpa entri ini deadlineAt/guard jadi NaN.
const FINANCIAL_INVOCATION_TIME_BUDGET_MS = 25_000;
const FINANCIAL_MIN_REMAINING_MS_TO_START_WORK = 13_000;
mock.module("@/lib/olsera-financial-sync", {
  namedExports: {
    FINANCIAL_INVOCATION_TIME_BUDGET_MS,
    FINANCIAL_MIN_REMAINING_MS_TO_START_WORK,
    periodParts: (period: string) => ({ year: Number(period.slice(0, 4)), month: Number(period.slice(5)) }),
    validateMonthlyReportPayload: () => ({ validated: true, note: null as string | null }),
    safeRecord: (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {}),
  },
});

const acquireOlseraSyncLockMock = mock.fn(async () => ({ ok: true, runId: "run-revenue-recheck-lock-1" }));
const releaseOlseraSyncLockMock = mock.fn(async (_runId: string) => true);
mock.module("@/lib/olsera-cron-lock", {
  namedExports: {
    acquireOlseraSyncLock: acquireOlseraSyncLockMock,
    releaseOlseraSyncLock: releaseOlseraSyncLockMock,
  },
});

// Class LOKAL (bukan kelas asli lib/reconciliation-omzet-period-lock.ts) —
// dipakai sebagai identitas `instanceof` YANG SAMA di kedua sisi (mock
// throw di sini, `instanceof` check di kode yang diuji) tanpa perlu memuat
// modul asli (yang mengimpor lib/mongodb.ts secara langsung).
class FakeOmzetPeriodLockError extends Error {
  constructor(message = "Periode terkunci.") {
    super(message);
    this.name = "OmzetPeriodLockError";
  }
}
const assertOmzetPeriodNotLockedMock = mock.fn(async (_storeId: number, _period: string) => undefined);
mock.module("@/lib/reconciliation-omzet-period-lock", {
  namedExports: {
    assertOmzetPeriodNotLocked: assertOmzetPeriodNotLockedMock,
    OmzetPeriodLockError: FakeOmzetPeriodLockError,
  },
});

const financialInvocationInsertMock = mock.fn(async (_doc: Record<string, unknown>) => ({ acknowledged: true }));
mock.module("@/lib/mongodb", {
  namedExports: {
    withMongo: async <T>(handler: () => Promise<T>) => handler(),
    collections: async () => ({ olseraFinancialCronInvocations: { insertOne: financialInvocationInsertMock } }),
  },
});

let runOlseraRevenueRecheckCron: typeof import("./cron-olsera-revenue-recheck.ts").runOlseraRevenueRecheckCron;
let isRevenueRecheckRoundDue: typeof import("./cron-olsera-revenue-recheck.ts").isRevenueRecheckRoundDue;
let isRevenueRecheckRoundInProgress: typeof import("./cron-olsera-revenue-recheck.ts").isRevenueRecheckRoundInProgress;
let REVENUE_RECHECK_ACCOUNT_CODES: typeof import("./cron-olsera-revenue-recheck.ts").REVENUE_RECHECK_ACCOUNT_CODES;
let REVENUE_RECHECK_SLOTS_PER_INVOCATION: typeof import("./cron-olsera-revenue-recheck.ts").REVENUE_RECHECK_SLOTS_PER_INVOCATION;

before(async () => {
  const mod = await import("./cron-olsera-revenue-recheck.ts");
  runOlseraRevenueRecheckCron = mod.runOlseraRevenueRecheckCron;
  isRevenueRecheckRoundDue = mod.isRevenueRecheckRoundDue;
  isRevenueRecheckRoundInProgress = mod.isRevenueRecheckRoundInProgress;
  REVENUE_RECHECK_ACCOUNT_CODES = mod.REVENUE_RECHECK_ACCOUNT_CODES;
  REVENUE_RECHECK_SLOTS_PER_INVOCATION = mod.REVENUE_RECHECK_SLOTS_PER_INVOCATION;
});

function resetAll() {
  getFinancialSyncLogForPeriodMock.mock.resetCalls();
  updateFinancialSyncRunMock.mock.resetCalls();
  bulkUpsertLedgerEntriesMock.mock.resetCalls();
  reconcileLedgerSummarySnapshotMock.mock.resetCalls();
  countLedgerEntriesForAccountMock.mock.resetCalls();
  upsertMonthlyReportMock.mock.resetCalls();
  recordLedgerEmptyObservationMock.mock.resetCalls();
  getLedgerDetailMock.mock.resetCalls();
  getBalanceSheetMock.mock.resetCalls();
  getProfitLossMock.mock.resetCalls();
  getCashFlowMock.mock.resetCalls();
  getLedgerSummaryMock.mock.resetCalls();
  acquireOlseraSyncLockMock.mock.resetCalls();
  releaseOlseraSyncLockMock.mock.resetCalls();
  assertOmzetPeriodNotLockedMock.mock.resetCalls();
  financialInvocationInsertMock.mock.resetCalls();
  getLedgerDetailMock.mock.mockImplementation(async () => ({ totalRecords: 0, entries: [] }));
  countLedgerEntriesForAccountMock.mock.mockImplementation(async () => 0);
  assertOmzetPeriodNotLockedMock.mock.mockImplementation(async () => undefined);
  acquireOlseraSyncLockMock.mock.mockImplementation(async () => ({ ok: true, runId: "run-revenue-recheck-lock-1" }));
}

test("401 bila header Authorization salah", async () => {
  const res = await runOlseraRevenueRecheckCron("Bearer salah");
  assert.equal(res.status, 401);
});

test("409 sync-in-progress bila lock sedang dipegang modul lain", async () => {
  resetAll();
  acquireOlseraSyncLockMock.mock.mockImplementationOnce(async () => ({ ok: false, activeModule: "financial", runId: "other-run" }));
  const res = await runOlseraRevenueRecheckCron("Bearer test-secret");
  assert.equal(res.status, 409);
  assert.equal(res.body.status, "sync-in-progress");
});

test("ronde TIDAK jalan kalau sync log periode belum 'success' -> status not-ready, TIDAK ada request Olsera/pengecekan lock", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => fakeSyncLog({ status: "running" }));
  const res = await runOlseraRevenueRecheckCron("Bearer test-secret");
  assert.equal(res.body.status, "not-ready");
  assert.equal(res.body.period, "2026-08");
  assert.equal(getLedgerDetailMock.mock.callCount(), 0);
  assert.equal(assertOmzetPeriodNotLockedMock.mock.callCount(), 0, "cek lock periode tidak perlu dilakukan kalau sync log belum success sama sekali");
  assert.equal(releaseOlseraSyncLockMock.mock.callCount(), 1, "lock cron tetap dilepas walau no-op");
});

test("ronde TIDAK jalan kalau periode locked (Kunci Periode Rekonsiliasi Omzet) -> status period-locked, TIDAK ada request Olsera", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => fakeSyncLog({ status: "success" }));
  assertOmzetPeriodNotLockedMock.mock.mockImplementationOnce(async () => {
    throw new FakeOmzetPeriodLockError("Periode terkunci.");
  });
  const res = await runOlseraRevenueRecheckCron("Bearer test-secret");
  assert.equal(res.body.status, "period-locked");
  assert.equal(getLedgerDetailMock.mock.callCount(), 0);
});

test("ronde TIDAK jalan kalau roundFinishedAt belum 7 hari lalu -> status round-not-due", async () => {
  resetAll();
  const threeDaysAgo = new Date(Date.now() - 3 * DAY_MS);
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () =>
    fakeSyncLog({
      status: "success",
      revenueRecheck: { accountCodes: ["40000"], cursor: 1, roundStartedAt: new Date(threeDaysAgo.getTime() - 60_000), roundFinishedAt: threeDaysAgo, attempts: 0, changed: [] },
    }),
  );
  const res = await runOlseraRevenueRecheckCron("Bearer test-secret");
  assert.equal(res.body.status, "round-not-due");
  assert.equal(getLedgerDetailMock.mock.callCount(), 0);
});

test("ronde jalan dan maju cursor-nya saat semua syarat terpenuhi (ronde baru, belum pernah ada revenueRecheck)", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => fakeSyncLog({ status: "success", revenueRecheck: undefined }));
  countLedgerEntriesForAccountMock.mock.mockImplementation(async () => 5);
  getLedgerDetailMock.mock.mockImplementation(async () => ({ totalRecords: 5, entries: [{ debit: 1 }] }));

  const res = await runOlseraRevenueRecheckCron("Bearer test-secret");

  assert.equal(res.body.status, "in-progress");
  assert.equal(res.body.period, "2026-08");
  assert.equal(res.body.cursor, REVENUE_RECHECK_SLOTS_PER_INVOCATION);
  assert.equal(getLedgerDetailMock.mock.callCount(), REVENUE_RECHECK_SLOTS_PER_INVOCATION);
  assert.equal(bulkUpsertLedgerEntriesMock.mock.callCount(), REVENUE_RECHECK_SLOTS_PER_INVOCATION);
  assert.equal(updateFinancialSyncRunMock.mock.callCount(), 1);
  const [runId, patch] = updateFinancialSyncRunMock.mock.calls[0].arguments;
  assert.equal(runId, "financial:324175:2026-08");
  const revenueRecheck = (patch as { revenueRecheck: FakeRevenueRecheckState }).revenueRecheck;
  assert.equal(revenueRecheck.cursor, REVENUE_RECHECK_SLOTS_PER_INVOCATION);
  assert.deepEqual(revenueRecheck.accountCodes, [...REVENUE_RECHECK_ACCOUNT_CODES]);
  assert.equal(revenueRecheck.roundFinishedAt, null, "ronde belum selesai -> roundFinishedAt tetap null");
});

test("ronde MID-CURSOR (belum 7 hari sejak roundStartedAt) TETAP dilanjutkan — gerbang 7 hari hanya berlaku untuk MULAI ronde baru, bukan melanjutkan yang sudah berjalan", async () => {
  resetAll();
  const midRound: FakeRevenueRecheckState = { accountCodes: [...REVENUE_RECHECK_ACCOUNT_CODES], cursor: 4, roundStartedAt: new Date(Date.now() - 60 * 60 * 1000), roundFinishedAt: null, attempts: 0, changed: [] };
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => fakeSyncLog({ status: "success", revenueRecheck: midRound }));
  countLedgerEntriesForAccountMock.mock.mockImplementation(async () => 1);
  getLedgerDetailMock.mock.mockImplementation(async () => ({ totalRecords: 1, entries: [] }));

  const res = await runOlseraRevenueRecheckCron("Bearer test-secret");

  assert.equal(res.body.status, "in-progress");
  assert.equal(res.body.cursor, 4 + REVENUE_RECHECK_SLOTS_PER_INVOCATION);
});

test("respons KOSONG dari getLedgerDetail() DI-SKIP sepenuhnya — TIDAK ada upsert, TIDAK memicu recordLedgerEmptyObservation, cursor tetap maju", async () => {
  resetAll();
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => fakeSyncLog({ status: "success", revenueRecheck: undefined }));
  countLedgerEntriesForAccountMock.mock.mockImplementation(async () => 0);
  getLedgerDetailMock.mock.mockImplementation(async () => ({ totalRecords: 0, entries: [] }));

  const res = await runOlseraRevenueRecheckCron("Bearer test-secret");

  assert.equal(res.body.cursor, REVENUE_RECHECK_SLOTS_PER_INVOCATION, "cursor tetap maju walau seluruh respons kosong");
  assert.equal(getLedgerDetailMock.mock.callCount(), REVENUE_RECHECK_SLOTS_PER_INVOCATION);
  assert.equal(bulkUpsertLedgerEntriesMock.mock.callCount(), 0, "respons kosong -> TIDAK ada upsert sama sekali");
  assert.equal(recordLedgerEmptyObservationMock.mock.callCount(), 0, "TIDAK PERNAH memanggil recordLedgerEmptyObservation — ambangnya (2 observasi kosong >=60 detik) bisa menghapus data akun yang sebenarnya baik-baik saja");
});

test("reconcileLedgerSummarySnapshot dipanggil di akhir ronde; laporan bulanan TIDAK disegarkan bila changed kosong", async () => {
  resetAll();
  const almostDone: FakeRevenueRecheckState = { accountCodes: [...REVENUE_RECHECK_ACCOUNT_CODES], cursor: REVENUE_RECHECK_ACCOUNT_CODES.length - 1, roundStartedAt: new Date(Date.now() - 60_000), roundFinishedAt: null, attempts: 0, changed: [] };
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => fakeSyncLog({ status: "success", revenueRecheck: almostDone }));
  countLedgerEntriesForAccountMock.mock.mockImplementation(async () => 3);
  getLedgerDetailMock.mock.mockImplementation(async () => ({ totalRecords: 3, entries: [] })); // rowsBefore === rowsAfter -> tidak berubah

  const res = await runOlseraRevenueRecheckCron("Bearer test-secret");

  assert.equal(res.body.status, "round-complete");
  assert.equal(res.body.changedCount, 0);
  assert.equal(reconcileLedgerSummarySnapshotMock.mock.callCount(), 1);
  assert.equal(getBalanceSheetMock.mock.callCount(), 0, "changed kosong -> 4 laporan bulanan TIDAK disegarkan");
  assert.equal(upsertMonthlyReportMock.mock.callCount(), 0);
  const [, patch] = updateFinancialSyncRunMock.mock.calls.at(-1)!.arguments;
  const revenueRecheck = (patch as { revenueRecheck: FakeRevenueRecheckState }).revenueRecheck;
  assert.ok(revenueRecheck.roundFinishedAt instanceof Date, "ronde selesai -> roundFinishedAt terisi");
});

test("laporan bulanan DISEGARKAN via Promise.all HANYA saat changed tidak kosong (ada akun yang row count-nya berubah)", async () => {
  resetAll();
  const almostDone: FakeRevenueRecheckState = { accountCodes: [...REVENUE_RECHECK_ACCOUNT_CODES], cursor: REVENUE_RECHECK_ACCOUNT_CODES.length - 1, roundStartedAt: new Date(Date.now() - 60_000), roundFinishedAt: null, attempts: 0, changed: [] };
  getFinancialSyncLogForPeriodMock.mock.mockImplementationOnce(async () => fakeSyncLog({ status: "success", revenueRecheck: almostDone }));
  countLedgerEntriesForAccountMock.mock.mockImplementation(async () => 3);
  getLedgerDetailMock.mock.mockImplementation(async () => ({ totalRecords: 5, entries: [] })); // rowsBefore 3 != rowsAfter 5 -> berubah

  const res = await runOlseraRevenueRecheckCron("Bearer test-secret");

  assert.equal(res.body.status, "round-complete");
  assert.equal(res.body.changedCount, 1);
  assert.equal(reconcileLedgerSummarySnapshotMock.mock.callCount(), 1);
  assert.equal(getBalanceSheetMock.mock.callCount(), 1);
  assert.equal(getProfitLossMock.mock.callCount(), 1);
  assert.equal(getCashFlowMock.mock.callCount(), 1);
  assert.equal(getLedgerSummaryMock.mock.callCount(), 1);
  assert.equal(upsertMonthlyReportMock.mock.callCount(), 4);
});

test("isRevenueRecheckRoundDue: belum pernah ada ronde (undefined) -> due", () => {
  assert.equal(isRevenueRecheckRoundDue(undefined, new Date()), true);
});

test("isRevenueRecheckRoundDue: ronde terakhir selesai < 7 hari lalu -> belum due", () => {
  const now = new Date("2026-09-02T00:00:00Z");
  const state: FakeRevenueRecheckState = { accountCodes: [], cursor: 9, roundStartedAt: new Date(now.getTime() - 4 * DAY_MS), roundFinishedAt: new Date(now.getTime() - 3 * DAY_MS), attempts: 0, changed: [] };
  assert.equal(isRevenueRecheckRoundDue(state, now), false);
});

test("isRevenueRecheckRoundDue: ronde terakhir selesai >= 7 hari lalu -> due", () => {
  const now = new Date("2026-09-02T00:00:00Z");
  const state: FakeRevenueRecheckState = { accountCodes: [], cursor: 9, roundStartedAt: new Date(now.getTime() - 8 * DAY_MS), roundFinishedAt: new Date(now.getTime() - 7 * DAY_MS), attempts: 0, changed: [] };
  assert.equal(isRevenueRecheckRoundDue(state, now), true);
});

test("isRevenueRecheckRoundInProgress: roundStartedAt terisi, roundFinishedAt masih null -> true (harus resume)", () => {
  const state: FakeRevenueRecheckState = { accountCodes: [], cursor: 3, roundStartedAt: new Date(), roundFinishedAt: null, attempts: 0, changed: [] };
  assert.equal(isRevenueRecheckRoundInProgress(state), true);
});

test("isRevenueRecheckRoundInProgress: ronde sudah finalized (roundFinishedAt terisi) -> false", () => {
  const state: FakeRevenueRecheckState = { accountCodes: [], cursor: 9, roundStartedAt: new Date(), roundFinishedAt: new Date(), attempts: 0, changed: [] };
  assert.equal(isRevenueRecheckRoundInProgress(state), false);
});
