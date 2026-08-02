import { test } from "node:test";
import assert from "node:assert/strict";
import { attachRootCause, buildDailyRollups, buildMonthlyRollup, summarizeRootCauses, worstFindingStatus } from "./reconciliation-court-revenue-aggregate.ts";
import type { CourtRevenueFinding } from "./reconciliation-court-revenue-source.ts";

function finding(overrides: Partial<CourtRevenueFinding>): CourtRevenueFinding {
  return {
    status: "MATCH",
    impact: "INFO",
    confidence: "HIGH",
    ruleId: "cross-system.court-revenue.v1",
    expected: {},
    actual: {},
    difference: null,
    diagnostics: {},
    candidates: [],
    knownCaseRef: null,
    domain: "COURT_REVENUE",
    date: "2026-07-01",
    courtKey: "Court No 1",
    entityKey: "Court No 1",
    ayoRevenue: 100000,
    olseraRevenue: 100000,
    sourceRefs: { ayoBookingIds: [], ayoBookingCount: 1, olseraOrderNos: [], olseraOrderCount: 1 },
    ...overrides,
  };
}

test("worstFindingStatus: MATCH kosong -> NOT_CHECKED; memilih severity tertinggi", () => {
  assert.equal(worstFindingStatus([]), "NOT_CHECKED");
  assert.equal(worstFindingStatus([finding({ status: "MATCH" }), finding({ status: "MISMATCH" }), finding({ status: "MINOR_DIFFERENCE" })]), "MISMATCH");
});

test("buildDailyRollups: menjumlahkan revenue per tanggal lintas court, tanpa double count", () => {
  const findings = attachRootCause([
    finding({ date: "2026-07-01", courtKey: "Court No 1", ayoRevenue: 100000, olseraRevenue: 100000 }),
    finding({ date: "2026-07-01", courtKey: "Court No 2", ayoRevenue: 50000, olseraRevenue: 60000, status: "MISMATCH" }),
    finding({ date: "2026-07-02", courtKey: "Court No 1", ayoRevenue: 20000, olseraRevenue: 20000 }),
  ]);
  const rollups = buildDailyRollups(findings);
  assert.equal(rollups.length, 2);
  assert.equal(rollups[0].date, "2026-07-01");
  assert.equal(rollups[0].ayoRevenue, 150000);
  assert.equal(rollups[0].olseraRevenue, 160000);
  assert.equal(rollups[0].difference, 10000);
  assert.equal(rollups[0].status, "MISMATCH");
  assert.equal(rollups[0].courts.length, 2);
  assert.equal(rollups[1].date, "2026-07-02");
});

test("buildMonthlyRollup: total = jumlah seluruh finding; differencePercent null bila AYO 0", () => {
  const findings = attachRootCause([finding({ ayoRevenue: 100000, olseraRevenue: 110000, status: "MISMATCH" }), finding({ date: "2026-07-02", ayoRevenue: 0, olseraRevenue: 0, status: "NOT_CHECKED" })]);
  const rollup = buildMonthlyRollup("2026-07", findings, new Date("2026-08-01T00:00:00Z"));
  assert.equal(rollup.ayoRevenue, 100000);
  assert.equal(rollup.olseraRevenue, 110000);
  assert.equal(rollup.difference, 10000);
  assert.equal(Math.round(rollup.differencePercent!), 10);
  assert.equal(rollup.mismatchCount, 1);

  const zeroAyo = buildMonthlyRollup("2026-07", attachRootCause([finding({ ayoRevenue: 0, olseraRevenue: 50000, status: "MISSING_IN_AYO" })]), new Date());
  assert.equal(zeroAyo.differencePercent, null);
});

test("buildMonthlyRollup: manualReviewCount menghitung BUTUH_ADJUST_MANUAL dan AMBIGUOUS", () => {
  const findings = attachRootCause([finding({ status: "BUTUH_ADJUST_MANUAL" }), finding({ status: "AMBIGUOUS", date: "2026-07-02" }), finding({ status: "MATCH", date: "2026-07-03" })]);
  const rollup = buildMonthlyRollup("2026-07", findings, new Date());
  assert.equal(rollup.manualReviewCount, 2);
});

test("summarizeRootCauses: mengelompokkan per rootCauseId+confidence dengan jumlah kasus dan total selisih absolut", () => {
  const findings = attachRootCause([
    finding({ status: "MISMATCH", ayoRevenue: 100000, olseraRevenue: 150000 }),
    finding({ status: "MISMATCH", ayoRevenue: 100000, olseraRevenue: 120000, date: "2026-07-02" }),
    finding({ status: "MATCH" }),
  ]);
  const summary = summarizeRootCauses("2026-07", findings);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].rootCauseId, "BELUM_BISA_DIPASTIKAN");
  assert.equal(summary[0].caseCount, 2);
  assert.equal(summary[0].totalAbsDifference, 50000 + 20000);
});

test("attachRootCause: meneruskan count source untuk mengenali pola booking multi-slot", () => {
  const [result] = attachRootCause([
    finding({
      status: "MISMATCH",
      ayoRevenue: 300000,
      olseraRevenue: 300000,
      sourceRefs: { ayoBookingIds: [], ayoBookingCount: 3, olseraOrderNos: [], olseraOrderCount: 1 },
    }),
  ]);

  assert.equal(result.rootCause?.rootCauseId, "BOOKING_MULTI_SLOT");
  assert.equal(result.rootCause?.confidence, "MEDIUM");
  assert.match(result.rootCause?.evidence ?? "", /3 booking AYO/);
});
