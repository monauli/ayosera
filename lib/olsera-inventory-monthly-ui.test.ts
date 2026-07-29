import assert from "node:assert/strict";
import test from "node:test";
import { monthlyPeriodStatus, monthlyStockStatus, summarizeMonthlyInventory } from "./olsera-inventory-monthly-ui.ts";

const rows = [
  { closingQty: 10, unitCost: 100, minimumStock: 5, trackInventory: true, hidden: false, snapshotStatus: "complete" as const },
  { closingQty: 3, unitCost: 200, minimumStock: 5, trackInventory: true, hidden: false, snapshotStatus: "complete" as const },
  { closingQty: 0, unitCost: 300, minimumStock: 5, trackInventory: true, hidden: false, snapshotStatus: "complete" as const },
  { closingQty: 4, unitCost: 100, minimumStock: 5, trackInventory: true, hidden: true, snapshotStatus: "complete" as const },
];

test("summary bulanan memakai closingQty dan closingQty * unitCost, bukan current stock", () => {
  const summary = summarizeMonthlyInventory(rows);
  assert.equal(summary.totalProducts, 3);
  assert.equal(summary.productsWithStock, 2);
  assert.equal(summary.outOfStock, 1);
  assert.equal(summary.lowStock, 1);
  assert.equal(summary.totalStock, 13);
  assert.equal(summary.totalValue, 1600);
});

test("status stok bulanan dan fallback minimum 5", () => {
  assert.equal(monthlyStockStatus({ closingQty: 10, minimumStock: 5 }), "Aman");
  assert.equal(monthlyStockStatus({ closingQty: 5, minimumStock: 5 }), "Hampir Habis");
  assert.equal(monthlyStockStatus({ closingQty: 0, minimumStock: 5 }), "Habis");
  assert.equal(monthlyStockStatus({ closingQty: null, minimumStock: 5 }), "Butuh Adjust Manual");
  assert.equal(summarizeMonthlyInventory([{ ...rows[0], minimumStock: 5 }]).usesDefaultThreshold, true);
});

test("status periode berjalan/historis dan empty snapshot", () => {
  assert.equal(monthlyPeriodStatus("2026-07", "2026-07", rows), "Bulan Berjalan / Belum Final");
  assert.equal(monthlyPeriodStatus("2026-06", "2026-07", rows), "Final");
  assert.equal(monthlyPeriodStatus("2026-06", "2026-07", []), "Snapshot Tidak Tersedia");
  assert.equal(monthlyPeriodStatus("2026-06", "2026-07", [{ snapshotStatus: "incomplete" }]), "Menunggu Validasi");
});
