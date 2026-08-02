import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildCourtRevenueAuditWorkbook } from "./reconciliation-court-revenue-export.ts";
import { attachRootCause, buildDailyRollups, buildMonthlyRollup, summarizeRootCauses } from "./reconciliation-court-revenue-aggregate.ts";
import type { CourtRevenueFinding } from "./reconciliation-court-revenue-source.ts";
import type { ManualReviewItem } from "./reconciliation-manual-review.ts";

function finding(overrides: Partial<CourtRevenueFinding>): CourtRevenueFinding {
  return {
    status: "MISMATCH",
    impact: "ERROR",
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
    olseraRevenue: 150000,
    sourceRefs: { ayoBookingIds: [], ayoBookingCount: 1, olseraOrderNos: [], olseraOrderCount: 1 },
    ...overrides,
  };
}

async function buildSampleWorkbookBuffer() {
  const findings = attachRootCause([
    finding({}),
    finding({ date: "2026-07-02", courtKey: "Court No 2", status: "MATCH", ayoRevenue: 100000, olseraRevenue: 100000 }),
  ]);
  const daily = buildDailyRollups(findings);
  const monthly = buildMonthlyRollup("2026-07", findings, new Date("2026-08-01T00:00:00Z"));
  const rootCauses = summarizeRootCauses("2026-07", findings);
  const manualReview: ManualReviewItem[] = [
    {
      source: "LEDGER",
      id: "omzet-ledger:2026-07",
      reconciliationType: null,
      domain: "LEDGER",
      domainLabel: "Ledger",
      period: "2026-07",
      status: "PERLU_DICEK",
      impact: null,
      confidence: null,
      reason: "Selisih belum dijelaskan.",
      canAutoResolve: false,
      recommendedAction: "Tambahkan bukti jurnal.",
      lastCheckedAt: null,
    },
  ];

  const buffer = await buildCourtRevenueAuditWorkbook({ period: "2026-07", monthly, daily, courtFindings: findings, manualReview, rootCauses, auditedAt: new Date("2026-08-02T00:00:00Z") });
  return buffer;
}

test("buildCourtRevenueAuditWorkbook: menghasilkan 6 sheet sesuai nama yang diwajibkan", async () => {
  const buffer = await buildSampleWorkbookBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const names = wb.worksheets.map((ws) => ws.name);
  assert.deepEqual(names, ["Ringkasan", "Per Hari", "Per Court", "Mismatch", "Manual Review", "Root Cause"]);
});

test("buildCourtRevenueAuditWorkbook: sheet Ringkasan berisi angka (bukan teks) untuk nominal", async () => {
  const buffer = await buildSampleWorkbookBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet("Ringkasan")!;
  const ayoRow = ws.getRow(2); // "Total Omzet AYO (IDR)"
  assert.equal(typeof ayoRow.getCell(2).value, "number");
});

test("buildCourtRevenueAuditWorkbook: sheet Mismatch HANYA memuat finding non-match", async () => {
  const buffer = await buildSampleWorkbookBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet("Mismatch")!;
  assert.equal(ws.rowCount, 2); // header + 1 mismatch (MATCH tidak masuk)
});

test("buildCourtRevenueAuditWorkbook: nama item yang diawali '=' diberi apostrof (anti formula injection)", async () => {
  const findings = attachRootCause([finding({ courtKey: "=CMD|'/c calc'!A1" })]);
  const buffer = await buildCourtRevenueAuditWorkbook({
    period: "2026-07",
    monthly: buildMonthlyRollup("2026-07", findings, new Date()),
    daily: buildDailyRollups(findings),
    courtFindings: findings,
    manualReview: [],
    rootCauses: [],
    auditedAt: new Date(),
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet("Per Court")!;
  const value = ws.getRow(2).getCell(2).value;
  assert.equal(typeof value, "string");
  assert.ok(String(value).startsWith("'="));
});

test("buildCourtRevenueAuditWorkbook: tidak ada payload mentah/token — hanya field yang eksplisit ditulis", async () => {
  const buffer = await buildSampleWorkbookBuffer();
  const text = Buffer.from(buffer).toString("latin1");
  assert.ok(!text.includes("AYO_API_TOKEN"));
  assert.ok(!text.includes("OLSERA_SECRET_KEY"));
});
