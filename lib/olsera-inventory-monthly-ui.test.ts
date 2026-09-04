import assert from "node:assert/strict";
import test from "node:test";
import { computeMonthlyTabRowSets, filterRelevantMonthlyRows, hasNoPeriodMovement, isStagnantInactiveMonthlyRow, monthlyPeriodStatus, monthlyStockStatus, summarizeMonthlyInventory, type MonthlyRelevanceRow } from "./olsera-inventory-monthly-ui.ts";
import { hasInventoryActivity, type InventoryActivityRow } from "./olsera-inventory-ui.ts";

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

// ---------------------------------------------------------------------------
// Filter panel Inventori Olsera bulanan — investigasi Agustus 2026 (73 vs 40
// item dibanding menu "Pergerakan Stok" Olsera sendiri).
// ---------------------------------------------------------------------------

let monthlyRowIdCounter = 0;

function monthlyRow(overrides: Partial<MonthlyRelevanceRow & InventoryActivityRow & { category: unknown; id: string }> = {}): MonthlyRelevanceRow & InventoryActivityRow & { category: unknown; id: string } {
  return {
    id: `ROW-${monthlyRowIdCounter++}`,
    active: true,
    openingQty: 0,
    incomingQty: 0,
    returnQty: 0,
    salesQty: 0,
    outgoingQty: 0,
    closingQty: 0,
    snapshotStatus: "complete",
    category: "UMUM",
    ...overrides,
  };
}

test("hasNoPeriodMovement: true hanya bila incoming/retur/jual/keluar semua 0/null — opening/closing (saldo) TIDAK diperiksa", () => {
  assert.equal(hasNoPeriodMovement({ incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0 }), true);
  assert.equal(hasNoPeriodMovement({ incomingQty: null, returnQty: null, salesQty: null, outgoingQty: null }), true);
  assert.equal(hasNoPeriodMovement({ incomingQty: 1, returnQty: 0, salesQty: 0, outgoingQty: 0 }), false);
  assert.equal(hasNoPeriodMovement({ incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 2 }), false);
});

test("isStagnantInactiveMonthlyRow: active:false TANPA pergerakan -> true (harus dikecualikan), walau ada saldo tersisa (opening/closing bukan 0)", () => {
  assert.equal(isStagnantInactiveMonthlyRow(monthlyRow({ active: false })), true);
  assert.equal(isStagnantInactiveMonthlyRow(monthlyRow({ active: false, openingQty: 5, closingQty: 5 })), true, "saldo carry-forward yang tersisa BUKAN aktivitas periode ini");
});

test("isStagnantInactiveMonthlyRow: active:false DENGAN pergerakan riil -> false (tetap relevan, baru nonaktif setelah bertransaksi)", () => {
  assert.equal(isStagnantInactiveMonthlyRow(monthlyRow({ active: false, salesQty: 2 })), false);
  assert.equal(isStagnantInactiveMonthlyRow(monthlyRow({ active: false, incomingQty: 1 })), false);
});

test("isStagnantInactiveMonthlyRow: active:true TIDAK PERNAH dikecualikan oleh aturan ini, walau tidak bergerak sama sekali", () => {
  assert.equal(isStagnantInactiveMonthlyRow(monthlyRow({ active: true })), false);
});

test("filterRelevantMonthlyRows: produk active:false tanpa aktivitas dikecualikan, baris lain tidak berubah", () => {
  const bergerak = monthlyRow({ active: true, salesQty: 1 });
  const nonaktifBergerak = monthlyRow({ active: false, salesQty: 1 });
  const nonaktifDiam = monthlyRow({ active: false });
  const result = filterRelevantMonthlyRows([bergerak, nonaktifBergerak, nonaktifDiam]);
  assert.deepEqual(result, [bergerak, nonaktifBergerak]);
});

test("filterRelevantMonthlyRows: produk active:true dengan saldo idle (tanpa pergerakan periode ini) TETAP tampil — regresi check, aturan nonaktif tidak pernah menyentuh produk aktif", () => {
  const bergerak = monthlyRow({ active: true, salesQty: 4 });
  const idleAktifBersaldo = monthlyRow({ active: true, openingQty: 2, closingQty: 2 });
  const result = filterRelevantMonthlyRows([bergerak, idleAktifBersaldo]);
  assert.equal(result.length, 2, "produk aktif dengan saldo tersisa tetap tampil walau tidak bergerak periode ini");
});

test("filterRelevantMonthlyRows: baris active:true yang BENAR-BENAR nol total (opening=closing=0, tidak pernah eksis periode ini) tetap disingkirkan lewat hasInventoryActivity — badge tabCounts jadi konsisten dengan baris yang benar-benar dirender di tabel", () => {
  const takPernahAda = monthlyRow({ active: true });
  const nyata = monthlyRow({ active: true, salesQty: 5, openingQty: 5 });
  const result = filterRelevantMonthlyRows([takPernahAda, nyata]);
  assert.deepEqual(result, [nyata]);
});

test("Regresi nyata Agustus 2026: tabCounts overall 73->40, unsold 36->3, sold tetap 37 setelah filterRelevantMonthlyRows (verified live query, lihat investigasi)", () => {
  const activeSold = Array.from({ length: 7 }, (_, i) => monthlyRow({ active: true, salesQty: 3, category: `AKTIF-${i}` }));
  const inactiveMovedSold = Array.from({ length: 30 }, (_, i) => monthlyRow({ active: false, salesQty: 2, category: `NONAKTIF-JUAL-${i}` }));
  const inactiveMovedUnsold = Array.from({ length: 3 }, (_, i) => monthlyRow({ active: false, salesQty: 0, incomingQty: 1, category: `NONAKTIF-MASUK-${i}` }));
  // openingQty/closingQty SENGAJA bervariasi (sebagian bersaldo, sebagian 0) —
  // meniru temuan live query nyata: 23 dari 33 baris carry-forward Agustus
  // 2026 punya openingQty bukan nol (stok idle tersisa), TETAP harus
  // dikecualikan karena TIDAK ada pergerakan (incoming/return/sales/outgoing).
  const inactiveStagnant = Array.from({ length: 33 }, (_, i) => monthlyRow({ active: false, openingQty: i % 2 === 0 ? 0 : 5, closingQty: i % 2 === 0 ? 0 : 5, category: `NONAKTIF-DIAM-${i}` }));
  const allRows = [...activeSold, ...inactiveMovedSold, ...inactiveMovedUnsold, ...inactiveStagnant];

  const tabCountsBefore = {
    sold: allRows.filter((r) => (r.salesQty ?? 0) > 0).length,
    unsold: allRows.filter((r) => (r.salesQty ?? 0) <= 0).length,
    overall: allRows.length,
  };
  assert.deepEqual(tabCountsBefore, { sold: 37, unsold: 36, overall: 73 }, "reproduksi persis angka bug Agustus 2026 sebelum fix");

  const relevant = filterRelevantMonthlyRows(allRows);
  const tabCountsAfter = {
    sold: relevant.filter((r) => (r.salesQty ?? 0) > 0).length,
    unsold: relevant.filter((r) => (r.salesQty ?? 0) <= 0).length,
    overall: relevant.length,
  };
  assert.deepEqual(tabCountsAfter, { sold: 37, unsold: 3, overall: 40 }, "setelah fix: cocok persis dengan angka Olsera Backoffice sendiri (40 item)");
});

// ---------------------------------------------------------------------------
// computeMonthlyTabRowSets — tab "Tidak Ada Pergerakan" (stagnant) & "Total
// Keseluruhan" (grandTotal), tambahan di samping "Pergerakan Stok" (moved,
// = filterRelevantMonthlyRows apa adanya). Investigasi lanjutan: export
// "Laporan Stock Opname Bulanan" menghasilkan 63 (hasInventoryActivity saja,
// tanpa filter active), sementara tab UI "Pergerakan Stok" 40 — selisih 23
// adalah produk active:false yang tidak bergerak TAPI masih bersaldo.
// ---------------------------------------------------------------------------

test("computeMonthlyTabRowSets: produk active:true TIDAK PERNAH masuk 'stagnant' — bergerak masuk 'moved', idle bersaldo tetap 'moved' (hasInventoryActivity true), bukan 'stagnant'", () => {
  const movedActive = monthlyRow({ active: true, salesQty: 3 });
  const idleActiveWithBalance = monthlyRow({ active: true, openingQty: 2, closingQty: 2 });
  const result = computeMonthlyTabRowSets([movedActive, idleActiveWithBalance]);
  assert.deepEqual(result.stagnant, []);
  assert.equal(result.moved.length, 2);
  assert.equal(result.grandTotal.length, 2);
});

test("computeMonthlyTabRowSets: produk active:false tak bergerak TANPA saldo sama sekali TIDAK masuk manapun (bukan moved, bukan stagnant, bukan grandTotal)", () => {
  const trulyZero = monthlyRow({ active: false });
  const result = computeMonthlyTabRowSets([trulyZero]);
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.stagnant, []);
  assert.deepEqual(result.grandTotal, []);
});

test("Regresi nyata Agustus 2026: moved=40, stagnant=23, grandTotal=63 — grandTotal identik dengan filter hasInventoryActivity yang dipakai export (satu sumber, tidak drift)", () => {
  const movedActive = Array.from({ length: 7 }, (_, i) => monthlyRow({ active: true, salesQty: 3, category: `AKTIF-${i}` }));
  const movedInactive = Array.from({ length: 33 }, (_, i) =>
    monthlyRow({ active: false, salesQty: i < 30 ? 2 : 0, incomingQty: i < 30 ? 0 : 1, category: `NONAKTIF-GERAK-${i}` }),
  );
  // 23 produk nonaktif TANPA pergerakan periode ini TAPI masih bersaldo
  // (opening/closing != 0) — kelompok yang dikecualikan dari "moved" (7828bd9)
  // tapi tetap lolos hasInventoryActivity (bersaldo = "beraktivitas").
  const stagnantWithBalance = Array.from({ length: 23 }, (_, i) => monthlyRow({ active: false, openingQty: 5, closingQty: 5, category: `NONAKTIF-SALDO-${i}` }));
  // 10 produk nonaktif tanpa pergerakan DAN tanpa saldo sama sekali — inilah
  // yang membedakan 63 (grandTotal, hasInventoryActivity) dari 73 (total snapshot mentah).
  const trulyZero = Array.from({ length: 10 }, (_, i) => monthlyRow({ active: false, category: `NONAKTIF-KOSONG-${i}` }));
  const allRows = [...movedActive, ...movedInactive, ...stagnantWithBalance, ...trulyZero];
  assert.equal(allRows.length, 73, "total baris snapshot mentah Agustus 2026");

  const result = computeMonthlyTabRowSets(allRows);
  assert.equal(result.moved.length, 40, "Pergerakan Stok — cocok Olsera Backoffice 'Pergerakan Stok'");
  assert.equal(result.stagnant.length, 23, "Tidak Ada Pergerakan — nonaktif bersaldo tanpa pergerakan periode ini");
  assert.equal(result.grandTotal.length, 63, "Total Keseluruhan — cocok file export Laporan Stock Opname Bulanan");
  assert.equal(result.moved.length + result.stagnant.length, result.grandTotal.length, "partisi himpunan: moved+stagnant harus = grandTotal secara matematis");

  // grandTotal HARUS identik (bukan cuma sama jumlah) dengan hasil
  // memanggil hasInventoryActivity langsung — fungsi yang SAMA PERSIS
  // dipakai buildMonthlyRowsFromMonthlySnapshots di export, bukan
  // reimplementasi terpisah yang bisa drift.
  assert.deepEqual(result.grandTotal, allRows.filter(hasInventoryActivity));
});
