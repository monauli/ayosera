import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInventoryReport,
  buildLedgerAndAccountReports,
  buildProductMappingReport,
  buildReconciliationReport,
  buildSalesReport,
  buildSnapshotReport,
  buildTransactionReport,
  combineHistoricalDataSummary,
} from "./historical-data-aggregate.ts";
import type { IdentityClassificationSummary } from "./historical-order-item-identity.ts";

function emptySummary(overrides: Partial<IdentityClassificationSummary["byClassification"]> = {}): IdentityClassificationSummary {
  const byClassification = {
    "Exact Match": 0, "Exact Product, Variant Ambiguous": 0, "Name Match Only": 0,
    "Historical Product": 0, "Product Missing": 0, "Duplicate Candidate": 0, "Butuh Adjust Manual": 0,
    ...overrides,
  } as IdentityClassificationSummary["byClassification"];
  const totalGapped = Object.values(byClassification).reduce((a, b) => a + b, 0);
  return {
    totalGapped, byClassification,
    exactMatchCount: byClassification["Exact Match"],
    ambiguousCount: byClassification["Exact Product, Variant Ambiguous"] + byClassification["Butuh Adjust Manual"],
    historicalProductCount: byClassification["Historical Product"],
    unresolvedCount: byClassification["Product Missing"] + byClassification["Duplicate Candidate"],
  };
}

test("buildProductMappingReport: HIGH confidence Exact Match -> canAutoFix true, status pending (bukan selesai) sebelum backfill dijalankan", () => {
  const summary = emptySummary({ "Exact Match": 5991, "Butuh Adjust Manual": 243, "Exact Product, Variant Ambiguous": 33, "Historical Product": 4 });
  const { category, issues } = buildProductMappingReport({ periode: "test", summary, resolvedCount: 0 });

  assert.equal(category.jumlahData, 6271);
  assert.equal(category.canAutoFix, true);
  const exactIssue = issues.find((i) => i.id.endsWith("exact-match"))!;
  assert.equal(exactIssue.status, "pending");
  assert.equal(exactIssue.confidence, "HIGH");
  assert.equal(exactIssue.jumlahData, 5991);
});

test("buildProductMappingReport: item ambigu/historical TIDAK PERNAH ditandai canAutoFix atau selesai — tetap manual", () => {
  const summary = emptySummary({ "Butuh Adjust Manual": 243, "Exact Product, Variant Ambiguous": 33, "Historical Product": 4 });
  const { issues } = buildProductMappingReport({ periode: "test", summary, resolvedCount: 0 });

  const ambiguousIssue = issues.find((i) => i.id.endsWith("ambiguous"))!;
  const historicalIssue = issues.find((i) => i.id.endsWith("historical-product"))!;
  assert.equal(ambiguousIssue.canAutoFix, false);
  assert.equal(ambiguousIssue.status, "manual");
  assert.equal(historicalIssue.canAutoFix, false);
  assert.equal(historicalIssue.status, "manual", "Historical Product tetap manual meski histori konsisten — butuh konfirmasi admin katalog, bukan auto-backfill");
});

test("buildProductMappingReport: setelah backfill dijalankan, baris yang sudah dibackfill muncul sebagai 'selesai', bukan 'pending' lagi", () => {
  const summary = emptySummary(); // live query sudah tidak melihat baris yang sudah dibackfill (identitas terisi)
  const { category, issues } = buildProductMappingReport({ periode: "test", summary, resolvedCount: 5991 });

  assert.equal(issues.some((i) => i.status === "pending"), false, "tidak ada baris exact-match yang masih terbuka");
  const resolvedIssue = issues.find((i) => i.id.endsWith("resolved"))!;
  assert.equal(resolvedIssue.status, "selesai");
  assert.equal(resolvedIssue.jumlahData, 5991);
  assert.equal(category.jumlahData, 5991);
});

test("buildLedgerAndAccountReports: TIDAK ADA isu -> status selesai, jumlahData 0 untuk ledger dan account", () => {
  const rows = [
    { period: "2026-02", accountCode: "11101", status: "Data Lengkap" },
    { period: "2026-02", accountCode: "11102", status: "Tidak Ada Transaksi" },
  ];
  const { ledger, account } = buildLedgerAndAccountReports(["2026-02"], rows);
  assert.equal(ledger.category.jumlahData, 0);
  assert.equal(ledger.issues[0].status, "selesai");
  assert.equal(account.category.jumlahData, 0);
  assert.equal(account.issues[0].status, "selesai");
});

test("buildLedgerAndAccountReports: 'Kandidat Data Lama' terdeteksi -> manual, TIDAK PERNAH auto-fix (tidak mengubah nominal otomatis)", () => {
  const rows = [
    { period: "2026-02", accountCode: "40004", status: "Kandidat Data Lama" },
    { period: "2026-03", accountCode: "40004", status: "Kandidat Data Lama" },
  ];
  const { ledger, account } = buildLedgerAndAccountReports(["2026-02", "2026-03"], rows);
  assert.equal(ledger.category.jumlahData, 2);
  assert.equal(ledger.category.canAutoFix, false);
  assert.equal(ledger.issues[0].status, "manual");
  assert.equal(account.category.jumlahData, 1, "hanya 1 akun unik (40004) meski muncul di 2 periode");
});

test("buildInventoryReport: movement unmatched -> manual, TIDAK auto-fix (risiko salah tautkan produk)", () => {
  const { category, issues } = buildInventoryReport({ periode: "test", movementUnmatchedCount: 37, movementMissingDocCount: 0 });
  assert.equal(category.jumlahData, 37);
  assert.equal(category.canAutoFix, false);
  assert.equal(issues[0].status, "manual");
});

test("buildSnapshotReport: boundary-only adalah status selesai (bukan error), incomplete adalah manual", () => {
  const { issues } = buildSnapshotReport({ periode: "test", boundaryOnlyCount: 21, incompleteCount: 0 });
  assert.equal(issues.find((i) => i.id.endsWith("boundary"))!.status, "selesai");

  const withIncomplete = buildSnapshotReport({ periode: "test", boundaryOnlyCount: 0, incompleteCount: 3 });
  assert.equal(withIncomplete.issues.find((i) => i.id.endsWith("incomplete"))!.status, "manual");
});

test("buildSalesReport / buildTransactionReport: selalu 'selesai' (aman secara struktural), tidak pernah canAutoFix (tidak ada yang perlu diperbaiki)", () => {
  const sales = buildSalesReport("test", 6271);
  assert.equal(sales.issues[0].status, "selesai");
  assert.equal(sales.category.canAutoFix, false);

  const transaction = buildTransactionReport("test", 8542);
  assert.equal(transaction.issues[0].status, "selesai");
});

test("buildReconciliationReport: finding requiresManualAdjustment -> selalu manual (reuse buildManualReviewSummary, canAutoResolve selalu false)", () => {
  const { issues, category } = buildReconciliationReport("test", {
    items: [{ source: "FINDING", id: "x", reconciliationType: "CROSS_SYSTEM_COURT_REVENUE", domain: "COURT_REVENUE", domainLabel: "Omzet Lapangan", period: "2026-05-01", status: "BUTUH_ADJUST_MANUAL", impact: "MEDIUM", confidence: "LOW", reason: "test", canAutoResolve: false, recommendedAction: "cek manual", lastCheckedAt: null }],
    totalFindings: 1,
  });
  assert.equal(issues[0].status, "manual");
  assert.equal(category.jumlahData, 1);
});

test("buildReconciliationReport: jumlahData kategori memakai items.length, BUKAN totalFindings — regresi Milestone 5 (ditemukan saat verifikasi production: kartu kategori menampilkan 0 padahal Issue Detail memuat 4 baris ledger PERLU_DICEK nyata)", () => {
  // totalFindings HANYA menghitung sumber 'FINDING' (reconciliation_findings);
  // item sumber 'LEDGER' (loadOmzetLedgerRecentSummaries, PERLU_DICEK) tidak
  // pernah masuk totalFindings meski tetap ada di items — buildManualReviewSummary
  // memang menggabungkan dua sumber tsb (lihat reconciliation-manual-review.ts).
  const { issues, category } = buildReconciliationReport("test", {
    items: [
      { source: "LEDGER", id: "omzet-ledger:2026-07", reconciliationType: null, domain: "LEDGER", domainLabel: "Ledger", period: "2026-07", status: "PERLU_DICEK", impact: null, confidence: null, reason: "test", canAutoResolve: false, recommendedAction: "cek manual", lastCheckedAt: null },
      { source: "LEDGER", id: "omzet-ledger:2026-06", reconciliationType: null, domain: "LEDGER", domainLabel: "Ledger", period: "2026-06", status: "PERLU_DICEK", impact: null, confidence: null, reason: "test", canAutoResolve: false, recommendedAction: "cek manual", lastCheckedAt: null },
    ],
    totalFindings: 0, // sengaja 0 — tidak ada finding di reconciliation_findings, tapi tetap ada 2 item ledger
  });
  assert.equal(issues.length, 2, "kedua item ledger harus tetap muncul di Issue Detail");
  assert.equal(category.jumlahData, 2, "kartu kategori HARUS mencerminkan items.length (2), bukan totalFindings (0)");
});

test("combineHistoricalDataSummary: bucket auto fixable/manual/selesai/pending dihitung konsisten dari seluruh kategori", () => {
  const summary = emptySummary({ "Exact Match": 10, "Butuh Adjust Manual": 2 });
  const productMapping = buildProductMappingReport({ periode: "test", summary, resolvedCount: 0 });
  const clean = buildTransactionReport("test", 100);

  const result = combineHistoricalDataSummary([productMapping, clean]);

  assert.equal(result.autoFixable, 1, "1 issue-group HIGH confidence berstatus pending (exact-match)");
  assert.equal(result.manual, 1, "1 issue-group butuh-adjust-manual berstatus manual");
  assert.equal(result.selesai, 1, "1 issue-group transaction berstatus selesai");
  assert.equal(result.pending, 2, "pending = manual + auto-fixable yang masih terbuka");
  assert.equal(result.totalIssues, 2, "totalIssues = seluruh yang belum selesai");
});
