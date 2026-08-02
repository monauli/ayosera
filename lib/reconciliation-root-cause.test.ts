import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCourtRevenueRootCause } from "./reconciliation-root-cause.ts";
import { PADEL_UNIDENTIFIED_BUCKET } from "./court-mapping.ts";

test("classifyCourtRevenueRootCause: MATCH/MINOR_DIFFERENCE tidak butuh root cause (null)", () => {
  assert.equal(classifyCourtRevenueRootCause({ status: "MATCH", courtKey: "Court No 1", diagnostics: {} }), null);
  assert.equal(classifyCourtRevenueRootCause({ status: "MINOR_DIFFERENCE", courtKey: "Court No 1", diagnostics: {} }), null);
  assert.equal(classifyCourtRevenueRootCause({ status: "NOT_CHECKED", courtKey: "Court No 1", diagnostics: {} }), null);
});

test("classifyCourtRevenueRootCause: bucket 'Padel Tidak Teridentifikasi' -> KESALAHAN_INPUT_MANUAL, HIGH", () => {
  const result = classifyCourtRevenueRootCause({ status: "BUTUH_ADJUST_MANUAL", courtKey: PADEL_UNIDENTIFIED_BUCKET, diagnostics: {} });
  assert.equal(result?.rootCauseId, "KESALAHAN_INPUT_MANUAL");
  assert.equal(result?.confidence, "HIGH");
});

test("classifyCourtRevenueRootCause: BUTUH_ADJUST_MANUAL selain bucket tak teridentifikasi -> BELUM_BISA_DIPASTIKAN, LOW", () => {
  const result = classifyCourtRevenueRootCause({ status: "BUTUH_ADJUST_MANUAL", courtKey: "Court No 1", diagnostics: { reason: "lain-lain" } });
  assert.equal(result?.rootCauseId, "BELUM_BISA_DIPASTIKAN");
  assert.equal(result?.confidence, "LOW");
});

test("classifyCourtRevenueRootCause: AMBIGUOUS -> BUG_MAPPING_KATEGORI, MEDIUM", () => {
  const result = classifyCourtRevenueRootCause({ status: "AMBIGUOUS", courtKey: "Court No 1", diagnostics: { reason: "kategori tak dikenal" } });
  assert.equal(result?.rootCauseId, "BUG_MAPPING_KATEGORI");
  assert.equal(result?.confidence, "MEDIUM");
});

test("classifyCourtRevenueRootCause: MISSING_IN_OLSERA -> AYO_TIDAK_TERSEDIA_DI_OLSERA, MEDIUM", () => {
  const result = classifyCourtRevenueRootCause({ status: "MISSING_IN_OLSERA", courtKey: "Court No 1", diagnostics: {} });
  assert.equal(result?.rootCauseId, "AYO_TIDAK_TERSEDIA_DI_OLSERA");
});

test("classifyCourtRevenueRootCause: MISSING_IN_AYO tanpa sinyal -> OLSERA_TIDAK_PUNYA_PASANGAN_AYO, MEDIUM", () => {
  const result = classifyCourtRevenueRootCause({ status: "MISSING_IN_AYO", courtKey: "Court No 1", diagnostics: {} });
  assert.equal(result?.rootCauseId, "OLSERA_TIDAK_PUNYA_PASANGAN_AYO");
});

test("classifyCourtRevenueRootCause: MISSING_IN_AYO dengan sinyal manual entry -> TRANSAKSI_MANUAL_OLSERA", () => {
  const result = classifyCourtRevenueRootCause({ status: "MISSING_IN_AYO", courtKey: "Court No 1", diagnostics: {} }, { manualEntryIndicator: true });
  assert.equal(result?.rootCauseId, "TRANSAKSI_MANUAL_OLSERA");
});

test("classifyCourtRevenueRootCause: MISMATCH dengan refund keyword -> REFUND_CANCEL_REVERSAL, HIGH", () => {
  const result = classifyCourtRevenueRootCause({ status: "MISMATCH", courtKey: "Court No 1", diagnostics: {} }, { refundKeywordDetected: true });
  assert.equal(result?.rootCauseId, "REFUND_CANCEL_REVERSAL");
  assert.equal(result?.confidence, "HIGH");
});

test("classifyCourtRevenueRootCause: MISMATCH dengan lebih banyak booking AYO daripada transaksi Olsera -> BOOKING_MULTI_SLOT", () => {
  const result = classifyCourtRevenueRootCause({ status: "MISMATCH", courtKey: "Court No 1", diagnostics: {} }, { ayoBookingCount: 3, olseraOrderCount: 1 });
  assert.equal(result?.rootCauseId, "BOOKING_MULTI_SLOT");
});

test("classifyCourtRevenueRootCause: MISMATCH dengan identitas produk hilang -> PRODUK_HISTORIS_KEHILANGAN_ID", () => {
  const result = classifyCourtRevenueRootCause({ status: "MISMATCH", courtKey: "Court No 1", diagnostics: {} }, { unresolvedOrMissingIdentityCount: 2 });
  assert.equal(result?.rootCauseId, "PRODUK_HISTORIS_KEHILANGAN_ID");
});

test("classifyCourtRevenueRootCause: MISMATCH tanpa sinyal apa pun -> BELUM_BISA_DIPASTIKAN, LOW (tidak menebak)", () => {
  const result = classifyCourtRevenueRootCause({ status: "MISMATCH", courtKey: "Court No 1", diagnostics: {} });
  assert.equal(result?.rootCauseId, "BELUM_BISA_DIPASTIKAN");
  assert.equal(result?.confidence, "LOW");
});

test("classifyCourtRevenueRootCause: setiap hasil non-null WAJIB punya evidence teks tidak kosong", () => {
  const statuses = ["BUTUH_ADJUST_MANUAL", "AMBIGUOUS", "MISSING_IN_OLSERA", "MISSING_IN_AYO", "MISMATCH"] as const;
  for (const status of statuses) {
    const result = classifyCourtRevenueRootCause({ status, courtKey: "Court No 1", diagnostics: {} });
    assert.ok(result && result.evidence.trim().length > 0, `status ${status} harus punya evidence`);
  }
});
