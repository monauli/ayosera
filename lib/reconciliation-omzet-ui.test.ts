import assert from "node:assert/strict";
import test from "node:test";
import { reconciliationOmzetUiStatus } from "./reconciliation-omzet-ui.ts";

test("rekonsiliasi selisih Rp0 adalah Cocok walau status laporan keuangan menunggu validasi", () => {
  assert.equal(reconciliationOmzetUiStatus("PERLU_DICEK", 0), "COCOK");
});

test("rekonsiliasi dalam toleransi existing adalah Cocok", () => {
  assert.equal(reconciliationOmzetUiStatus("PERLU_DICEK", 1), "COCOK");
  assert.equal(reconciliationOmzetUiStatus("PERLU_DICEK", -1), "COCOK");
});

test("rekonsiliasi di luar toleransi adalah Perlu Dicek", () => {
  assert.equal(reconciliationOmzetUiStatus("COCOK", 2), "PERLU_DICEK");
});

test("bulan berjalan mempertahankan konteksnya saat selisih di luar toleransi", () => {
  assert.equal(reconciliationOmzetUiStatus("BULAN_BERJALAN", 2), "BULAN_BERJALAN");
  assert.equal(reconciliationOmzetUiStatus("BULAN_BERJALAN", 0), "COCOK");
});
