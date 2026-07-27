import assert from "node:assert/strict";
import test from "node:test";
import {
  capImpactForDraftPeriod,
  DOMAINS_BY_TYPE,
  escalateImpactForDomain,
  isFinalStatus,
  isMatchLike,
  isReconciliationConfidence,
  isReconciliationDomain,
  isReconciliationImpact,
  isReconciliationStatus,
  isReconciliationType,
  RECONCILIATION_CONFIDENCES,
  RECONCILIATION_IMPACTS,
  requiresManualAdjustment,
  statusLabel,
  statusSeverity,
  validateDomainForType,
  RECONCILIATION_STATUSES,
} from "./reconciliation-types.ts";

test("seluruh 10 status baku terdaftar", () => {
  assert.deepEqual(
    [...RECONCILIATION_STATUSES].sort(),
    [
      "AMBIGUOUS",
      "BUTUH_ADJUST_MANUAL",
      "IN_PROGRESS",
      "MATCH",
      "MINOR_DIFFERENCE",
      "MISMATCH",
      "MISSING_IN_AYO",
      "MISSING_IN_OLSERA",
      "MISSING_IN_SNAPSHOT",
      "NOT_CHECKED",
    ].sort(),
  );
});

test("setiap status punya label Indonesia & severity", () => {
  for (const status of RECONCILIATION_STATUSES) {
    assert.ok(statusLabel(status).length > 0);
    assert.ok(statusSeverity(status) >= 0);
  }
});

test("NOT_CHECKED dan IN_PROGRESS bukan MATCH/final — tidak boleh dianggap aman", () => {
  assert.equal(isMatchLike("NOT_CHECKED"), false);
  assert.equal(isMatchLike("IN_PROGRESS"), false);
  assert.equal(isFinalStatus("NOT_CHECKED"), false);
  assert.equal(isFinalStatus("IN_PROGRESS"), false);
});

test("MATCH/MINOR_DIFFERENCE final dan match-like; MISMATCH/MISSING_*/AMBIGUOUS/BUTUH_ADJUST_MANUAL tidak final", () => {
  assert.equal(isFinalStatus("MATCH"), true);
  assert.equal(isFinalStatus("MINOR_DIFFERENCE"), true);
  assert.equal(isMatchLike("MATCH"), true);
  assert.equal(isMatchLike("MINOR_DIFFERENCE"), true);
  for (const status of ["MISMATCH", "MISSING_IN_AYO", "MISSING_IN_OLSERA", "MISSING_IN_SNAPSHOT", "AMBIGUOUS", "BUTUH_ADJUST_MANUAL"] as const) {
    assert.equal(isFinalStatus(status), false, status);
    assert.equal(isMatchLike(status), false, status);
  }
});

test("requiresManualAdjustment hanya untuk AMBIGUOUS & BUTUH_ADJUST_MANUAL", () => {
  assert.equal(requiresManualAdjustment("AMBIGUOUS"), true);
  assert.equal(requiresManualAdjustment("BUTUH_ADJUST_MANUAL"), true);
  assert.equal(requiresManualAdjustment("MATCH"), false);
  assert.equal(requiresManualAdjustment("MISMATCH"), false);
});

test("isReconciliationStatus menolak nilai bukan string/di luar daftar (pagar anti operator-injection)", () => {
  assert.equal(isReconciliationStatus("MATCH"), true);
  assert.equal(isReconciliationStatus("TIDAK_ADA"), false);
  assert.equal(isReconciliationStatus({ $ne: null }), false);
  assert.equal(isReconciliationStatus(null), false);
  assert.equal(isReconciliationStatus(undefined), false);
});

test("isReconciliationType & isReconciliationDomain menolak nilai tidak dikenal", () => {
  assert.equal(isReconciliationType("CROSS_SYSTEM_COURT_REVENUE"), true);
  assert.equal(isReconciliationType("INTERNAL_OLSERA"), true);
  assert.equal(isReconciliationType("SOMETHING_ELSE"), false);
  assert.equal(isReconciliationDomain("COURT_REVENUE"), true);
  assert.equal(isReconciliationDomain("PRODUCT"), true);
  assert.equal(isReconciliationDomain("NOT_A_DOMAIN"), false);
});

test("CROSS_SYSTEM_COURT_REVENUE dan INTERNAL_OLSERA punya domain terpisah, tidak tumpang tindih", () => {
  const crossDomains = new Set(DOMAINS_BY_TYPE.CROSS_SYSTEM_COURT_REVENUE);
  const internalDomains = new Set(DOMAINS_BY_TYPE.INTERNAL_OLSERA);
  for (const domain of crossDomains) assert.equal(internalDomains.has(domain), false, `${domain} tidak boleh ada di kedua sisi`);
  assert.ok(crossDomains.has("COURT_REVENUE"));
  assert.ok(crossDomains.has("BOOKING"));
  assert.ok(crossDomains.has("COURT"));
  assert.ok(crossDomains.has("PAYMENT"));
  assert.ok(internalDomains.has("CATEGORY"));
  assert.ok(internalDomains.has("PRODUCT"));
  assert.ok(internalDomains.has("INVENTORY"));
  assert.ok(internalDomains.has("SNAPSHOT"));
  assert.ok(internalDomains.has("FINANCIAL"));
  assert.ok(internalDomains.has("LEDGER"));
});

test("validateDomainForType menolak domain internal dipakai di CROSS_SYSTEM dan sebaliknya", () => {
  assert.equal(validateDomainForType("CROSS_SYSTEM_COURT_REVENUE", "COURT_REVENUE"), true);
  assert.equal(validateDomainForType("CROSS_SYSTEM_COURT_REVENUE", "PRODUCT"), false);
  assert.equal(validateDomainForType("INTERNAL_OLSERA", "PRODUCT"), true);
  assert.equal(validateDomainForType("INTERNAL_OLSERA", "COURT_REVENUE"), false);
});

// ---- Impact ------------------------------------------------------------------

test("seluruh 4 impact baku terdaftar (INFO/WARNING/ERROR/CRITICAL)", () => {
  assert.deepEqual([...RECONCILIATION_IMPACTS].sort(), ["CRITICAL", "ERROR", "INFO", "WARNING"]);
});

test("isReconciliationImpact menolak nilai tidak dikenal / operator injection", () => {
  assert.equal(isReconciliationImpact("ERROR"), true);
  assert.equal(isReconciliationImpact("TIDAK_ADA"), false);
  assert.equal(isReconciliationImpact({ $ne: null }), false);
});

test("escalateImpactForDomain: ERROR pada domain FINANCIAL/LEDGER dieskalasi menjadi CRITICAL, domain lain tidak berubah", () => {
  assert.equal(escalateImpactForDomain("FINANCIAL", "ERROR"), "CRITICAL");
  assert.equal(escalateImpactForDomain("LEDGER", "ERROR"), "CRITICAL");
  assert.equal(escalateImpactForDomain("PRODUCT", "ERROR"), "ERROR");
  assert.equal(escalateImpactForDomain("FINANCIAL", "WARNING"), "WARNING");
  assert.equal(escalateImpactForDomain("FINANCIAL", "INFO"), "INFO");
});

test("capImpactForDraftPeriod: bulan berjalan (draft) selalu tampil INFO, bulan tertutup tidak berubah", () => {
  assert.equal(capImpactForDraftPeriod("ERROR", true), "INFO");
  assert.equal(capImpactForDraftPeriod("CRITICAL", true), "INFO");
  assert.equal(capImpactForDraftPeriod("ERROR", false), "ERROR");
});

// ---- Confidence ----------------------------------------------------------------

test("seluruh 3 confidence baku terdaftar (HIGH/MEDIUM/LOW)", () => {
  assert.deepEqual([...RECONCILIATION_CONFIDENCES].sort(), ["HIGH", "LOW", "MEDIUM"]);
});

test("isReconciliationConfidence menolak nilai tidak dikenal / operator injection — LOW tidak pernah dianggap HIGH", () => {
  assert.equal(isReconciliationConfidence("LOW"), true);
  assert.equal(isReconciliationConfidence("TIDAK_ADA"), false);
  assert.equal(isReconciliationConfidence({ $gt: "" }), false);
});
