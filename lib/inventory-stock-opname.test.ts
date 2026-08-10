import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpnameId,
  computeDifferenceQty,
  computeFormulaClosingQty,
  determineOpnameStatus,
  hasFormulaMismatch,
  needsManualAdjust,
  resolveSystemClosingQty,
  summarizeOpname,
} from "./inventory-stock-opname.ts";

// 1. stok sistem 10, berita acara 10 -> Cocok
test("status: stok sistem 10 dan berita acara 10 -> COCOK", () => {
  const status = determineOpnameStatus({ physicalQty: 10, systemClosingQty: 10, manualAdjust: false });
  assert.equal(status, "COCOK");
  assert.equal(computeDifferenceQty(10, 10), 0);
});

// 2. stok sistem 10, berita acara 8 -> selisih -2, Perlu Dicek
test("status: stok sistem 10 dan berita acara 8 -> selisih -2, PERLU_DICEK", () => {
  const status = determineOpnameStatus({ physicalQty: 8, systemClosingQty: 10, manualAdjust: false });
  assert.equal(status, "PERLU_DICEK");
  assert.equal(computeDifferenceQty(8, 10), -2);
});

// 3. stok sistem 10, berita acara 12 -> selisih +2, Perlu Dicek
test("status: stok sistem 10 dan berita acara 12 -> selisih +2, PERLU_DICEK", () => {
  const status = determineOpnameStatus({ physicalQty: 12, systemClosingQty: 10, manualAdjust: false });
  assert.equal(status, "PERLU_DICEK");
  assert.equal(computeDifferenceQty(12, 10), 2);
});

// 4. belum ada berita acara -> Belum Diisi
test("status: physicalQty belum diisi (null) -> BELUM_DIISI", () => {
  const status = determineOpnameStatus({ physicalQty: null, systemClosingQty: 10, manualAdjust: false });
  assert.equal(status, "BELUM_DIISI");
  assert.equal(computeDifferenceQty(null, 10), null);
});

// 5. snapshot status manual -> Butuh Adjust Manual (tidak dipaksakan Cocok/Perlu Dicek)
test("status: snapshot incomplete -> BUTUH_ADJUST_MANUAL walau physicalQty sama dengan systemClosingQty", () => {
  const manualAdjust = needsManualAdjust({ status: "incomplete", canonicalProductId: null });
  assert.equal(manualAdjust, true);
  assert.equal(determineOpnameStatus({ physicalQty: 10, systemClosingQty: 10, manualAdjust }), "BUTUH_ADJUST_MANUAL");
});

test("status: canonicalProductId terisi (productId berubah) -> BUTUH_ADJUST_MANUAL walau belum diisi", () => {
  const manualAdjust = needsManualAdjust({ status: "complete", canonicalProductId: 999 });
  assert.equal(manualAdjust, true);
  assert.equal(determineOpnameStatus({ physicalQty: null, systemClosingQty: 10, manualAdjust }), "BUTUH_ADJUST_MANUAL");
});

test("status: boundary-only TIDAK dianggap manual adjust (angka tetap dipakai apa adanya)", () => {
  assert.equal(needsManualAdjust({ status: "boundary-only", canonicalProductId: null }), false);
});

test("formula: Stok Akhir Sistem = awal + masuk + retur - jual - keluar", () => {
  const flow = { openingQty: 10, incomingQty: 5, returnQty: 2, salesQty: 4, outgoingQty: 1, closingQty: null };
  assert.equal(computeFormulaClosingQty(flow), 10 + 5 + 2 - 4 - 1);
  assert.equal(resolveSystemClosingQty(flow), computeFormulaClosingQty(flow));
});

test("formula: closingQty snapshot adalah sumber utama (dipakai walau beda dari rumus)", () => {
  const flow = { openingQty: 10, incomingQty: 5, returnQty: 0, salesQty: 0, outgoingQty: 0, closingQty: 999 };
  assert.equal(resolveSystemClosingQty(flow), 999);
  assert.equal(hasFormulaMismatch(flow), true);
});

test("formula: tidak ada mismatch bila closingQty snapshot null atau sama dengan rumus", () => {
  assert.equal(hasFormulaMismatch({ openingQty: 10, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0, closingQty: null }), false);
  assert.equal(hasFormulaMismatch({ openingQty: 10, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0, closingQty: 10 }), false);
});

test("summarizeOpname: menghitung tally status dan total selisih positif/negatif", () => {
  const summary = summarizeOpname([
    { status: "COCOK", differenceQty: 0 },
    { status: "PERLU_DICEK", differenceQty: -2 },
    { status: "PERLU_DICEK", differenceQty: 5 },
    { status: "BELUM_DIISI", differenceQty: null },
    { status: "BUTUH_ADJUST_MANUAL", differenceQty: null },
  ]);
  assert.deepEqual(summary, {
    totalProduk: 5,
    cocok: 1,
    perluDicek: 2,
    belumDiisi: 1,
    butuhAdjustManual: 1,
    totalSelisihPositif: 5,
    totalSelisihNegatif: -2,
  });
});

test("buildOpnameId: deterministik dan konsisten dengan pola _id snapshot", () => {
  assert.equal(buildOpnameId({ storeId: 324175, year: 2026, month: 5, productId: 111, variantId: null }), "324175:2026:05:111:0");
  assert.equal(buildOpnameId({ storeId: 324175, year: 2026, month: 5, productId: 111, variantId: 7 }), "324175:2026:05:111:7");
});
