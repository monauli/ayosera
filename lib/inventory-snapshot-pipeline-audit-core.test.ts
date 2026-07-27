// Test unit murni untuk klasifikasi audit pipeline snapshot inventori bulanan
// (lib/inventory-snapshot-pipeline-audit-core.ts). Tidak menyentuh Mongo.
// Jalankan: node --no-warnings --experimental-strip-types --test lib/inventory-snapshot-pipeline-audit-core.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySnapshotEntity } from "./inventory-snapshot-pipeline-audit-core.ts";

test("classifySnapshotEntity: tidak ada dokumen, trackInventory:false (mis. LABERS/SEWA RAKET/COURT FEE) -> EXPECTED_NO_ACTION (bukan STALE_SNAPSHOT)", () => {
  const result = classifySnapshotEntity({ existingDoc: null, rawSalesActivity: 40, rawSalesActivityIncludesLegacyNullStore: false, isDraftPeriod: false, isTrackedInventory: false });
  assert.equal(result.classification, "EXPECTED_NO_ACTION");
});

test("classifySnapshotEntity: tidak ada dokumen, trackInventory:false, bulan berjalan -> tetap EXPECTED_NO_ACTION (bukan barang stok, bukan soal timing)", () => {
  const result = classifySnapshotEntity({ existingDoc: null, rawSalesActivity: 5, rawSalesActivityIncludesLegacyNullStore: false, isDraftPeriod: true, isTrackedInventory: false });
  assert.equal(result.classification, "EXPECTED_NO_ACTION");
});

test("classifySnapshotEntity: tidak ada dokumen, trackInventory:true, bulan berjalan -> BOUNDARY_CURRENT_MONTH", () => {
  const result = classifySnapshotEntity({ existingDoc: null, rawSalesActivity: 0, rawSalesActivityIncludesLegacyNullStore: false, isDraftPeriod: true, isTrackedInventory: true });
  assert.equal(result.classification, "BOUNDARY_CURRENT_MONTH");
});

test("classifySnapshotEntity: tidak ada dokumen, trackInventory:true, bulan SUDAH TUTUP -> STALE_SNAPSHOT", () => {
  const result = classifySnapshotEntity({ existingDoc: null, rawSalesActivity: 0, rawSalesActivityIncludesLegacyNullStore: false, isDraftPeriod: false, isTrackedInventory: true });
  assert.equal(result.classification, "STALE_SNAPSHOT");
});

test("classifySnapshotEntity: carry-forward status 'incomplete' (kasus movement-qty:116138490:0) -> PRODUCT_IDENTITY_AMBIGUOUS", () => {
  const result = classifySnapshotEntity({
    existingDoc: { source: "carry-forward", status: "incomplete", salesQty: 0 },
    rawSalesActivity: 51,
    rawSalesActivityIncludesLegacyNullStore: false,
    isDraftPeriod: false,
    isTrackedInventory: true,
  });
  assert.equal(result.classification, "PRODUCT_IDENTITY_AMBIGUOUS");
  assert.match(result.reason, /51/);
});

test("classifySnapshotEntity: carry-forward status LAMA 'complete' TAPI ada bukti (dokumen belum direbuild) -> STALE_SNAPSHOT", () => {
  const result = classifySnapshotEntity({
    existingDoc: { source: "carry-forward", status: "complete", salesQty: 0 },
    rawSalesActivity: 30,
    rawSalesActivityIncludesLegacyNullStore: false,
    isDraftPeriod: false,
    isTrackedInventory: true,
  });
  assert.equal(result.classification, "STALE_SNAPSHOT");
});

test("classifySnapshotEntity: carry-forward tanpa kontradiksi, bulan tutup -> EXPECTED_NO_ACTION", () => {
  const result = classifySnapshotEntity({
    existingDoc: { source: "carry-forward", status: "complete", salesQty: 0 },
    rawSalesActivity: 0,
    rawSalesActivityIncludesLegacyNullStore: false,
    isDraftPeriod: false,
    isTrackedInventory: true,
  });
  assert.equal(result.classification, "EXPECTED_NO_ACTION");
});

test("classifySnapshotEntity: carry-forward tanpa kontradiksi, bulan berjalan -> BOUNDARY_CURRENT_MONTH", () => {
  const result = classifySnapshotEntity({
    existingDoc: { source: "carry-forward", status: "complete", salesQty: 0 },
    rawSalesActivity: 0,
    rawSalesActivityIncludesLegacyNullStore: false,
    isDraftPeriod: true,
    isTrackedInventory: true,
  });
  assert.equal(result.classification, "BOUNDARY_CURRENT_MONTH");
});

test("classifySnapshotEntity: source matched (bukan carry-forward), salesQty cocok persis -> EXPECTED_NO_ACTION", () => {
  const result = classifySnapshotEntity({
    existingDoc: { source: "stockmovement-backward", status: "complete", salesQty: 46 },
    rawSalesActivity: 46,
    rawSalesActivityIncludesLegacyNullStore: false,
    isDraftPeriod: false,
    isTrackedInventory: true,
  });
  assert.equal(result.classification, "EXPECTED_NO_ACTION");
});

test("classifySnapshotEntity: source matched, beda di bulan berjalan -> BOUNDARY_CURRENT_MONTH (timing)", () => {
  const result = classifySnapshotEntity({
    existingDoc: { source: "stockmovement-forward", status: "complete", salesQty: 8 },
    rawSalesActivity: 10,
    rawSalesActivityIncludesLegacyNullStore: false,
    isDraftPeriod: true,
    isTrackedInventory: true,
  });
  assert.equal(result.classification, "BOUNDARY_CURRENT_MONTH");
});

test("classifySnapshotEntity: source matched, beda TAPI sebagian dari movement storeId:null -> LEGACY_STORE_ID_NULL", () => {
  const result = classifySnapshotEntity({
    existingDoc: { source: "stockmovement-backward", status: "complete", salesQty: 40 },
    rawSalesActivity: 55,
    rawSalesActivityIncludesLegacyNullStore: true,
    isDraftPeriod: false,
    isTrackedInventory: true,
  });
  assert.equal(result.classification, "LEGACY_STORE_ID_NULL");
});

test("classifySnapshotEntity: source matched, beda TANPA sebab lain -> SOURCE_DATA_INCOMPLETE (bukan bug kode)", () => {
  const result = classifySnapshotEntity({
    existingDoc: { source: "baseline-file", status: "complete", salesQty: 100 },
    rawSalesActivity: 90,
    rawSalesActivityIncludesLegacyNullStore: false,
    isDraftPeriod: false,
    isTrackedInventory: true,
  });
  assert.equal(result.classification, "SOURCE_DATA_INCOMPLETE");
});
