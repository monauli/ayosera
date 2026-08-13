import assert from "node:assert/strict";
import test from "node:test";
import { parseInventoryBaText } from "./inventory-ba-parser.ts";

test("BA Juli text layer: periode dan tujuh item terbaca dengan arithmetic selisih", () => {
  const result = parseInventoryBaText(`Periode 01 Juli 2026 sampai 16 Juli 2026\nKelompok Barang Deskripsi Barang Satuan Stock Sistem Stock Fisik Selisih\nYONEX AC102 pcs 10 9 -1\nNESTLE PURE LIFE 1500ML pcs 350 349 -1\nNESTLE PURE LIFE 600ML pcs 529 528 -1\nODEA RED pcs 45 47 +2\nODEA ROSE pcs 38 36 -2\nPOCARI SWEAT PET 500 ML pcs 342 341 -1\nPOCARI ION WATER 500ML pcs 202 201 -1\nDitandatangani 17 Juli 2026`);
  assert.equal(result.periodStart, "2026-07-01");
  assert.equal(result.cutoffDate, "2026-07-16");
  assert.equal(result.items.length, 7);
  assert.equal(result.items[3].differenceQty, 2);
  assert.equal(result.status, "OK");
});

test("BA parser fail-safe saat angka tidak konsisten", () => {
  const result = parseInventoryBaText("Periode 01 Juli 2026 sampai 16 Juli 2026\nODEA RED pcs 45 47 0");
  assert.equal(result.status, "PERLU_DICEK");
  assert.equal(result.items[0].status, "PERLU_DICEK");
});
