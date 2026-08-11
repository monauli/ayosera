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

// ---------------------------------------------------------------------------
// V10 test wajib #3/#4/#9: `beritaAcaraVerified` memaksa "Cocok" terlepas
// dari besar selisih mentahnya (selisih TIDAK berubah, hanya statusnya) —
// TAPI TIDAK melemahkan safety-net existing di atas (status "COCOK" tanpa
// beritaAcaraVerified TETAP bisa diturunkan ke PERLU_DICEK kalau selisih
// saat ini di luar toleransi — lihat test "di luar toleransi" di atas,
// masih PASS tanpa perubahan).
// ---------------------------------------------------------------------------
test("beritaAcaraVerified=true memaksa Cocok walau selisih jauh dari Rp0 (Maret +Rp740.000, April -Rp739.999)", () => {
  assert.equal(reconciliationOmzetUiStatus("PERLU_DICEK", 740_000, true), "COCOK");
  assert.equal(reconciliationOmzetUiStatus("PERLU_DICEK", -739_999, true), "COCOK");
});

test("beritaAcaraVerified default false -> perilaku lama TIDAK berubah (backward compatible, pemanggil 2-argumen tidak terpengaruh)", () => {
  assert.equal(reconciliationOmzetUiStatus("PERLU_DICEK", 740_000), "PERLU_DICEK");
  assert.equal(reconciliationOmzetUiStatus("PERLU_DICEK", 740_000, false), "PERLU_DICEK");
});
