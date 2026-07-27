// Test rule engine murni Modul Rekonsiliasi (Phase 5A). Tidak ada MongoDB di
// sini — seluruh input dipasok langsung sebagai objek JS (lihat
// lib/reconciliation-rules.ts untuk kontrak input tiap rule).
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCategoryForCourtRevenue,
  evaluateCategory,
  evaluateCourtRevenue,
  evaluateInventoryMovement,
  evaluateProductIdentity,
  evaluateSnapshotConsistency,
  type CourtRevenueComparisonInput,
} from "./reconciliation-rules.ts";
import { KNOWN_CASE_REFS } from "./reconciliation-types.ts";

function courtInput(overrides: Partial<CourtRevenueComparisonInput> = {}): CourtRevenueComparisonInput {
  return {
    date: "2026-07-01",
    court: "Padel Court 1",
    ayo: { count: 5, revenue: 500000 },
    olsera: { count: 5, revenue: 500000 },
    olseraCourtCategoryConfident: true,
    courtMappingConfidence: "exact",
    ...overrides,
  };
}

// ---- A. CROSS_SYSTEM_COURT_REVENUE ----------------------------------------

test("cross-system: omzet lapangan cocok persis -> MATCH", () => {
  const result = evaluateCourtRevenue(courtInput());
  assert.equal(result.status, "MATCH");
  assert.equal(result.ruleId, "cross-system.court-revenue.v1");
});

test("cross-system: selisih kecil (di bawah toleransi) -> MINOR_DIFFERENCE", () => {
  const result = evaluateCourtRevenue(courtInput({ olsera: { count: 5, revenue: 503000 } }));
  assert.equal(result.status, "MINOR_DIFFERENCE");
  assert.equal((result.difference as { revenue: number }).revenue, 3000);
});

test("cross-system: selisih besar (di atas toleransi) -> MISMATCH", () => {
  const result = evaluateCourtRevenue(courtInput({ olsera: { count: 5, revenue: 650000 } }));
  assert.equal(result.status, "MISMATCH");
});

test("cross-system: tidak ada di AYO -> MISSING_IN_AYO", () => {
  const result = evaluateCourtRevenue(courtInput({ ayo: null }));
  assert.equal(result.status, "MISSING_IN_AYO");
});

test("cross-system: tidak ada di Olsera -> MISSING_IN_OLSERA", () => {
  const result = evaluateCourtRevenue(courtInput({ olsera: null }));
  assert.equal(result.status, "MISSING_IN_OLSERA");
});

test("cross-system: kategori Olsera non-lapangan (F&B/retail/LABERS/Jasa Host) SELALU diklasifikasikan excluded, tidak pernah 'court'", () => {
  assert.equal(classifyCategoryForCourtRevenue("F&B"), "excluded");
  assert.equal(classifyCategoryForCourtRevenue("Retail"), "excluded");
  assert.equal(classifyCategoryForCourtRevenue("LABERS"), "excluded");
  assert.equal(classifyCategoryForCourtRevenue("Jasa Host"), "excluded");
  assert.equal(classifyCategoryForCourtRevenue("Makanan"), "excluded");
  assert.equal(classifyCategoryForCourtRevenue("Minuman"), "excluded");
});

test("cross-system: kategori lapangan (court) diklasifikasikan 'court', bukan 'ambiguous'/'excluded'", () => {
  assert.equal(classifyCategoryForCourtRevenue("Sewa Lapangan Padel"), "court");
  assert.equal(classifyCategoryForCourtRevenue("Court Fee"), "court");
});

test("cross-system: transaksi dengan klasifikasi kategori tidak pasti (olseraCourtCategoryConfident=false) TIDAK dipaksakan dibandingkan -> AMBIGUOUS", () => {
  const result = evaluateCourtRevenue(courtInput({ olseraCourtCategoryConfident: false }));
  assert.equal(result.status, "AMBIGUOUS");
});

test("cross-system: court AYO cocok >1 court Olsera -> AMBIGUOUS, tidak dipaksakan salah satu", () => {
  const result = evaluateCourtRevenue(courtInput({ courtMappingConfidence: "ambiguous", courtCandidates: [{ label: "Court A", value: "A" }, { label: "Court B", value: "B" }] }));
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.candidates.length, 2);
});

test("cross-system: court Olsera belum dipetakan ke court AYO manapun -> BUTUH_ADJUST_MANUAL", () => {
  const result = evaluateCourtRevenue(courtInput({ courtMappingConfidence: "unmapped" }));
  assert.equal(result.status, "BUTUH_ADJUST_MANUAL");
});

test("cross-system: agregasi per tanggal & court — findings independen per (date, court)", () => {
  const day1CourtA = evaluateCourtRevenue(courtInput({ date: "2026-07-01", court: "Court A" }));
  const day1CourtB = evaluateCourtRevenue(courtInput({ date: "2026-07-01", court: "Court B", olsera: { count: 5, revenue: 999999 } }));
  const day2CourtA = evaluateCourtRevenue(courtInput({ date: "2026-07-02", court: "Court A", ayo: null }));
  assert.equal(day1CourtA.status, "MATCH");
  assert.equal(day1CourtB.status, "MISMATCH");
  assert.equal(day2CourtA.status, "MISSING_IN_AYO");
  assert.equal(day1CourtA.diagnostics.date, "2026-07-01");
  assert.equal(day1CourtB.diagnostics.court, "Court B");
});

test("cross-system: jumlah booking vs transaksi beda besar ikut mempengaruhi status walau omzet cocok", () => {
  const result = evaluateCourtRevenue(courtInput({ ayo: { count: 1, revenue: 500000 }, olsera: { count: 10, revenue: 500000 } }));
  assert.equal(result.status, "MISMATCH");
  assert.equal(result.diagnostics.countStatus, "MISMATCH");
  assert.equal(result.diagnostics.revenueStatus, "MATCH");
});

test("cross-system: status pembayaran dibandingkan HANYA bila tersedia di kedua sisi", () => {
  const bothMissing = evaluateCourtRevenue(courtInput());
  assert.equal(bothMissing.diagnostics.paymentStatus, null);
  const mismatchPayment = evaluateCourtRevenue(courtInput({ ayo: { count: 5, revenue: 500000, paymentStatus: "paid" }, olsera: { count: 5, revenue: 500000, paymentStatus: "unpaid" } }));
  assert.equal(mismatchPayment.status, "MISMATCH");
  assert.equal(mismatchPayment.diagnostics.paymentStatus, "MISMATCH");
});

// ---- B. INTERNAL_OLSERA — Kategori ------------------------------------------

test("internal category: resolved -> MATCH", () => {
  const result = evaluateCategory({ itemName: "Kopi Susu", categoryResolutionStatus: "resolved", categoryResolutionMethod: "name-exact", categoryResolutionReason: null, resolvedCategoryName: "Minuman" });
  assert.equal(result.status, "MATCH");
});

test("internal category: berbeda dari sumber independen -> MISMATCH", () => {
  const result = evaluateCategory({
    itemName: "Kopi Susu",
    categoryResolutionStatus: "resolved",
    categoryResolutionMethod: "name-exact",
    categoryResolutionReason: null,
    resolvedCategoryName: "Minuman",
    expectedCategoryName: "Makanan",
  });
  assert.equal(result.status, "MISMATCH");
});

test("internal category: kandidat ambigu -> AMBIGUOUS", () => {
  const result = evaluateCategory({ itemName: "X", categoryResolutionStatus: "resolved", categoryResolutionMethod: "name-exact", categoryResolutionReason: null, resolvedCategoryName: "A", isAmbiguousCandidate: true });
  assert.equal(result.status, "AMBIGUOUS");
});

test("internal category: unresolved -> BUTUH_ADJUST_MANUAL", () => {
  const result = evaluateCategory({ itemName: "X", categoryResolutionStatus: "unresolved", categoryResolutionMethod: "none", categoryResolutionReason: "tidak cocok", resolvedCategoryName: null });
  assert.equal(result.status, "BUTUH_ADJUST_MANUAL");
});

test("internal category: manual_override selalu MATCH (keputusan manusia final)", () => {
  const result = evaluateCategory({ itemName: "X", categoryResolutionStatus: "resolved", categoryResolutionMethod: "manual_override", categoryResolutionReason: null, resolvedCategoryName: "Y", expectedCategoryName: "Z" });
  assert.equal(result.status, "MATCH");
});

test("internal category: item 'hidden' di UI TETAP dihitung penuh — rule tidak mengenal konsep hidden sama sekali", () => {
  // Toggle "Hidden Item" murni preferensi tampilan (lib/olsera-inventory-ui.ts),
  // TIDAK ADA field terkait di CategoryRuleInput — item yang disembunyikan di
  // UI tetap dievaluasi dengan hasil yang SAMA seperti item yang tidak disembunyikan.
  const visible = evaluateCategory({ itemName: "Bola Padel", categoryResolutionStatus: "resolved", categoryResolutionMethod: "name-exact", categoryResolutionReason: null, resolvedCategoryName: "Retail" });
  const sameItemConceptuallyHidden = evaluateCategory({ itemName: "Bola Padel", categoryResolutionStatus: "resolved", categoryResolutionMethod: "name-exact", categoryResolutionReason: null, resolvedCategoryName: "Retail" });
  assert.deepEqual(visible, sameItemConceptuallyHidden);
  assert.equal(visible.status, "MATCH");
});

// ---- B. INTERNAL_OLSERA — Identitas Produk ---------------------------------

test("product identity: sudah punya identitas lengkap -> MATCH", () => {
  const result = evaluateProductIdentity({ itemName: "Kopi Susu", hasIdentity: true, catalogFullNameMatches: [], catalogBaseNameMatches: [], historicalMatches: [], aliasMatches: [] });
  assert.equal(result.status, "MATCH");
});

test("product identity: nama lengkap cocok tepat satu produk+varian -> MATCH (exact product+variant)", () => {
  const result = evaluateProductIdentity({
    itemName: "Sewa Raket - Premium",
    hasIdentity: false,
    catalogFullNameMatches: [{ productId: 1, variantId: 10 }],
    catalogBaseNameMatches: [],
    historicalMatches: [],
    aliasMatches: [],
  });
  assert.equal(result.status, "MATCH");
  assert.equal((result.actual as { variantId: number }).variantId, 10);
});

test("product identity: produk pasti tapi >1 varian tanpa info pembeda -> AMBIGUOUS (variant ambiguous), variantId TIDAK diisi", () => {
  const result = evaluateProductIdentity({
    itemName: "Sewa Raket",
    hasIdentity: false,
    catalogFullNameMatches: [],
    catalogBaseNameMatches: [{ productId: 1, variantId: 10 }, { productId: 1, variantId: 11 }],
    historicalMatches: [],
    aliasMatches: [],
  });
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.diagnostics.subCase, "variant-ambiguous");
  assert.equal((result.actual as { variantId?: number }).variantId, undefined);
  assert.equal(result.knownCaseRef, KNOWN_CASE_REFS.PHASE2_AMBIGUOUS_276);
});

test("product identity: tidak di katalog aktif tapi histori konsisten -> MISSING_IN_SNAPSHOT (historical product)", () => {
  const result = evaluateProductIdentity({
    itemName: "Yonex Shorts Men",
    hasIdentity: false,
    catalogFullNameMatches: [],
    catalogBaseNameMatches: [],
    historicalMatches: [{ productId: 5, variantId: null }, { productId: 5, variantId: null }],
    aliasMatches: [],
  });
  assert.equal(result.status, "MISSING_IN_SNAPSHOT");
  assert.equal(result.knownCaseRef, KNOWN_CASE_REFS.PHASE3_HISTORICAL_PRODUCT_4);
});

test("product identity: tidak ada kandidat sama sekali -> BUTUH_ADJUST_MANUAL (missing product)", () => {
  const result = evaluateProductIdentity({ itemName: "Produk Asing", hasIdentity: false, catalogFullNameMatches: [], catalogBaseNameMatches: [], historicalMatches: [], aliasMatches: [] });
  assert.equal(result.status, "BUTUH_ADJUST_MANUAL");
  assert.equal(result.diagnostics.subCase, "missing-product");
});

test("product identity: nama lengkap cocok >1 kombinasi produk berbeda -> AMBIGUOUS, tidak menebak", () => {
  const result = evaluateProductIdentity({
    itemName: "Nama Bentrok",
    hasIdentity: false,
    catalogFullNameMatches: [{ productId: 1, variantId: null }, { productId: 2, variantId: null }],
    catalogBaseNameMatches: [],
    historicalMatches: [],
    aliasMatches: [],
  });
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.diagnostics.subCase, "name-multi-product");
});

// ---- B. INTERNAL_OLSERA — Inventory Movement -------------------------------

test("inventory movement: productId null -> MISSING_IN_SNAPSHOT, tag Known Case 37, TIDAK berdampak ke produk lain", () => {
  const result = evaluateInventoryMovement({ productId: null, hasSnapshotDoc: true, expectedQty: 10, actualQty: 10 });
  assert.equal(result.status, "MISSING_IN_SNAPSHOT");
  assert.equal(result.knownCaseRef, KNOWN_CASE_REFS.PHASE3_MOVEMENT_37);
  assert.match(String((result.diagnostics as { potentialImpact: string }).potentialImpact), /TIDAK mengubah closingQty produk manapun/i);
});

test("inventory movement: qty cocok -> MATCH", () => {
  const result = evaluateInventoryMovement({ productId: 1, hasSnapshotDoc: true, expectedQty: 10, actualQty: 10 });
  assert.equal(result.status, "MATCH");
});

test("inventory movement: qty berbeda melampaui toleransi -> MISMATCH", () => {
  const result = evaluateInventoryMovement({ productId: 1, hasSnapshotDoc: true, expectedQty: 10, actualQty: 25 });
  assert.equal(result.status, "MISMATCH");
});

test("inventory movement: belum ada dokumen snapshot -> MISSING_IN_SNAPSHOT", () => {
  const result = evaluateInventoryMovement({ productId: 1, hasSnapshotDoc: false, expectedQty: 10, actualQty: 0 });
  assert.equal(result.status, "MISSING_IN_SNAPSHOT");
  assert.equal(result.knownCaseRef, null);
});

test("inventory movement: selisih kecil TEPAT di batas periode -> MINOR_DIFFERENCE (boundary-only), Known Case snapshot-boundary", () => {
  const result = evaluateInventoryMovement({ productId: 1, hasSnapshotDoc: true, expectedQty: 10, actualQty: 11, isBoundaryPeriod: true });
  assert.equal(result.status, "MINOR_DIFFERENCE");
  assert.equal(result.knownCaseRef, KNOWN_CASE_REFS.SNAPSHOT_BOUNDARY);
});

test("inventory movement: selisih besar di batas periode TETAP MISMATCH (boundary tidak menutupi selisih besar)", () => {
  const result = evaluateInventoryMovement({ productId: 1, hasSnapshotDoc: true, expectedQty: 10, actualQty: 100, isBoundaryPeriod: true });
  assert.equal(result.status, "MISMATCH");
});

// ---- B. INTERNAL_OLSERA — Snapshot Consistency -----------------------------

test("snapshot consistency: rantai closing->opening berkelanjutan -> MATCH", () => {
  const result = evaluateSnapshotConsistency({ productId: 1, variantId: null, closingPrev: 50, openingNext: 50 });
  assert.equal(result.status, "MATCH");
});

test("snapshot consistency: rantai terputus -> MISMATCH", () => {
  const result = evaluateSnapshotConsistency({ productId: 1, variantId: null, closingPrev: 50, openingNext: 30 });
  assert.equal(result.status, "MISMATCH");
});

test("snapshot consistency: salah satu sisi belum ada -> MISSING_IN_SNAPSHOT", () => {
  const result = evaluateSnapshotConsistency({ productId: 1, variantId: null, closingPrev: null, openingNext: 50 });
  assert.equal(result.status, "MISSING_IN_SNAPSHOT");
});

test("snapshot consistency: selisih kecil di batas bulan -> MINOR_DIFFERENCE (boundary-only)", () => {
  const result = evaluateSnapshotConsistency({ productId: 1, variantId: null, closingPrev: 50, openingNext: 51, isBoundaryPeriod: true });
  assert.equal(result.status, "MINOR_DIFFERENCE");
  assert.equal(result.knownCaseRef, KNOWN_CASE_REFS.SNAPSHOT_BOUNDARY);
});

// ---- Impact/Confidence: rule mapping ---------------------------------------

test("rule mapping: setiap RuleEvaluation WAJIB punya impact & confidence yang valid", () => {
  const results = [
    evaluateCategory({ itemName: "X", categoryResolutionStatus: "resolved", categoryResolutionMethod: null, categoryResolutionReason: null, resolvedCategoryName: "Lapangan" }),
    evaluateInventoryMovement({ productId: null, hasSnapshotDoc: true, expectedQty: 1, actualQty: 1 }),
    evaluateSnapshotConsistency({ productId: 1, variantId: null, closingPrev: 50, openingNext: 50 }),
  ];
  for (const r of results) {
    assert.ok(["INFO", "WARNING", "ERROR", "CRITICAL"].includes(r.impact), `impact tidak valid: ${r.impact}`);
    assert.ok(["HIGH", "MEDIUM", "LOW"].includes(r.confidence), `confidence tidak valid: ${r.confidence}`);
  }
});

test("rule mapping: MATCH -> INFO/HIGH, MISMATCH -> ERROR/HIGH, AMBIGUOUS -> WARNING/LOW (kategori)", () => {
  const match = evaluateCategory({ itemName: "X", categoryResolutionStatus: "resolved", categoryResolutionMethod: null, categoryResolutionReason: null, resolvedCategoryName: "Lapangan" });
  assert.equal(match.status, "MATCH");
  assert.equal(match.impact, "INFO");
  assert.equal(match.confidence, "HIGH");

  const mismatch = evaluateCategory({ itemName: "X", categoryResolutionStatus: "resolved", categoryResolutionMethod: null, categoryResolutionReason: null, resolvedCategoryName: "Lapangan", expectedCategoryName: "F&B" });
  assert.equal(mismatch.status, "MISMATCH");
  assert.equal(mismatch.impact, "ERROR");
  assert.equal(mismatch.confidence, "HIGH");

  const ambiguous = evaluateCategory({ itemName: "X", categoryResolutionStatus: "unresolved", categoryResolutionMethod: null, categoryResolutionReason: null, resolvedCategoryName: null, isAmbiguousCandidate: true });
  assert.equal(ambiguous.status, "AMBIGUOUS");
  assert.equal(ambiguous.impact, "WARNING");
  assert.equal(ambiguous.confidence, "LOW");
});

test("rule mapping: inventory productId null -> MISSING_IN_SNAPSHOT tapi WARNING/MEDIUM (override, bukan default ERROR/HIGH)", () => {
  const result = evaluateInventoryMovement({ productId: null, hasSnapshotDoc: true, expectedQty: 5, actualQty: 5 });
  assert.equal(result.status, "MISSING_IN_SNAPSHOT");
  assert.equal(result.impact, "WARNING");
  assert.equal(result.confidence, "MEDIUM");
});

test("rule mapping: inventory tanpa dokumen snapshot -> MISSING_IN_SNAPSHOT dengan default ERROR/HIGH (bukan override)", () => {
  const result = evaluateInventoryMovement({ productId: 1, hasSnapshotDoc: false, expectedQty: 5, actualQty: 0 });
  assert.equal(result.status, "MISSING_IN_SNAPSHOT");
  assert.equal(result.impact, "ERROR");
  assert.equal(result.confidence, "HIGH");
});

test("rule mapping: product identity historical product -> MISSING_IN_SNAPSHOT tapi WARNING/MEDIUM (fallback historis)", () => {
  const result = evaluateProductIdentity({
    itemName: "Produk Lama",
    hasIdentity: false,
    catalogFullNameMatches: [],
    catalogBaseNameMatches: [],
    historicalMatches: [{ productId: 10, variantId: null }],
    aliasMatches: [],
  });
  assert.equal(result.status, "MISSING_IN_SNAPSHOT");
  assert.equal(result.impact, "WARNING");
  assert.equal(result.confidence, "MEDIUM");
  assert.equal(result.knownCaseRef, KNOWN_CASE_REFS.PHASE3_HISTORICAL_PRODUCT_4);
});

test("rule mapping: product identity variant-ambiguous -> AMBIGUOUS WARNING/LOW (butuh tinjauan manual, bukan MEDIUM)", () => {
  const result = evaluateProductIdentity({
    itemName: "Sewa Lapangan",
    hasIdentity: false,
    catalogFullNameMatches: [],
    catalogBaseNameMatches: [
      { productId: 20, variantId: 1 },
      { productId: 20, variantId: 2 },
    ],
    historicalMatches: [],
    aliasMatches: [],
  });
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.impact, "WARNING");
  assert.equal(result.confidence, "LOW");
});

test("rule mapping: snapshot missing (bukan boundary/historis) -> ERROR/HIGH, sesuai 'Snapshot Missing -> ERROR'", () => {
  const result = evaluateSnapshotConsistency({ productId: 1, variantId: null, closingPrev: null, openingNext: 50 });
  assert.equal(result.status, "MISSING_IN_SNAPSHOT");
  assert.equal(result.impact, "ERROR");
});

test("rule mapping cross-system: MATCH omzet lapangan -> INFO/HIGH, MISMATCH -> ERROR/HIGH", () => {
  const base: CourtRevenueComparisonInput = {
    date: "2026-07-01",
    court: "Lapangan A",
    ayo: { count: 2, revenue: 200000 },
    olsera: { count: 2, revenue: 200000 },
    olseraCourtCategoryConfident: true,
    courtMappingConfidence: "exact",
  };
  const match = evaluateCourtRevenue(base);
  assert.equal(match.status, "MATCH");
  assert.equal(match.impact, "INFO");
  assert.equal(match.confidence, "HIGH");

  const mismatch = evaluateCourtRevenue({ ...base, olsera: { count: 2, revenue: 500000 } });
  assert.equal(mismatch.status, "MISMATCH");
  assert.equal(mismatch.impact, "ERROR");
  assert.equal(mismatch.confidence, "HIGH");
});
