import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpnameId,
  computeDifferenceQty,
  computeFormulaClosingQty,
  determineOpnameStatus,
  hasFormulaMismatch,
  isValidIsoDate,
  needsManualAdjust,
  parseInventoryBaPeriodText,
  resolveCutoffQueryRange,
  resolveSystemClosingQty,
  summarizeOpname,
  validateCutoffPlausibility,
  verifyStockOpnameBa,
  CUTOFF_MAX_LOOKBACK_DAYS,
} from "./inventory-stock-opname.ts";

test("BA item selisih valid cocok dengan stok Olsera", () => {
  const result = verifyStockOpnameBa({ systemRows: [{ productId: 1, variantId: null, systemClosingQty: 10 }], baEntries: [{ productId: 1, variantId: null, physicalQty: 8, differenceQty: -2, note: "rusak", cutoff: "2026-08-13" }], expectedCutoff: "2026-08-13", baOnlyDifferencesConfirmed: true });
  assert.equal(result.rows[0].status, "COCOK");
  assert.equal(result.canFinalize, true);
});

test("item tidak ada di BA dianggap cocok", () => {
  const result = verifyStockOpnameBa({ systemRows: [{ productId: 1, variantId: null, systemClosingQty: 10 }, { productId: 2, variantId: null, systemClosingQty: 4 }], baEntries: [{ productId: 1, variantId: null, physicalQty: 8, differenceQty: -2, note: null, cutoff: "2026-08-13" }], expectedCutoff: "2026-08-13", baOnlyDifferencesConfirmed: true });
  assert.equal(result.canFinalize, true);
  assert.equal(result.rows.length, 1);
});

test("angka BA vs Olsera mismatch menjadi PERLU_DICEK", () => {
  const result = verifyStockOpnameBa({ systemRows: [{ productId: 1, variantId: null, systemClosingQty: 10 }], baEntries: [{ productId: 1, variantId: null, physicalQty: 8, differenceQty: -1, note: null, cutoff: "2026-08-13" }], expectedCutoff: "2026-08-13", baOnlyDifferencesConfirmed: true });
  assert.equal(result.rows[0].status, "PERLU_DICEK");
  assert.equal(result.canFinalize, false);
});

test("mapping produk ambigu/tidak ditemukan memblok finalisasi", () => {
  const result = verifyStockOpnameBa({ systemRows: [{ productId: 1, variantId: null, systemClosingQty: 10 }], baEntries: [{ productId: 99, variantId: null, physicalQty: 8, differenceQty: -2, note: null, cutoff: "2026-08-13" }], expectedCutoff: "2026-08-13", baOnlyDifferencesConfirmed: true });
  assert.equal(result.rows[0].mappingCertain, false);
  assert.equal(result.canFinalize, false);
});

test("confirmation BA belum dicentang memblok finalisasi", () => {
  const result = verifyStockOpnameBa({ systemRows: [], baEntries: [], expectedCutoff: "2026-08-13", baOnlyDifferencesConfirmed: false });
  assert.equal(result.canFinalize, false);
});

test("verifikasi tidak melakukan double stock adjustment", () => {
  const result = verifyStockOpnameBa({ systemRows: [{ productId: 1, variantId: null, systemClosingQty: 10 }], baEntries: [{ productId: 1, variantId: null, physicalQty: 8, differenceQty: -2, note: "koreksi", cutoff: "2026-08-13" }], expectedCutoff: "2026-08-13", baOnlyDifferencesConfirmed: true });
  assert.equal(result.rows[0].systemClosingQty, 10);
  assert.equal(result.rows[0].differenceQty, -2);
});

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

// ---------------------------------------------------------------------------
// Cutoff tanggal BA (basis BARU rekonsiliasi — bukan akhir bulan kalender).
// ---------------------------------------------------------------------------

test("isValidIsoDate: menerima YYYY-MM-DD kalender valid, menolak format lain/tanggal mustahil", () => {
  assert.equal(isValidIsoDate("2026-07-16"), true);
  assert.equal(isValidIsoDate("2026-02-29"), false, "2026 bukan tahun kabisat");
  assert.equal(isValidIsoDate("2024-02-29"), true, "2024 tahun kabisat");
  assert.equal(isValidIsoDate("2026-13-01"), false);
  assert.equal(isValidIsoDate("16-07-2026"), false);
  assert.equal(isValidIsoDate(""), false);
  assert.equal(isValidIsoDate(null), false);
  assert.equal(isValidIsoDate(20260716), false);
});

test("resolveCutoffQueryRange: default start_date = awal bulan cutoff, end_date = cutoffDate persis", () => {
  const range = resolveCutoffQueryRange("2026-07-16");
  assert.deepEqual(range, { startDate: "2026-07-01", endDate: "2026-07-16" });
});

test("resolveCutoffQueryRange: cutoff di awal bulan tetap end_date = cutoffDate (jendela 1 hari)", () => {
  const range = resolveCutoffQueryRange("2026-07-01");
  assert.deepEqual(range, { startDate: "2026-07-01", endDate: "2026-07-01" });
});

test("resolveCutoffQueryRange: desiredStartDate wajar (dalam batas) dipakai apa adanya", () => {
  const range = resolveCutoffQueryRange("2026-07-16", "2026-06-01");
  assert.deepEqual(range, { startDate: "2026-06-01", endDate: "2026-07-16" });
});

test("resolveCutoffQueryRange: desiredStartDate melebihi CUTOFF_MAX_LOOKBACK_DAYS DIKLEM, tidak pernah gagal 406 tanpa fallback", () => {
  const range = resolveCutoffQueryRange("2026-07-16", "2025-01-01"); // >75 hari sebelum cutoff
  assert.notEqual(range.startDate, "2025-01-01");
  const windowDays = Math.round((Date.parse(`${range.endDate}T00:00:00Z`) - Date.parse(`${range.startDate}T00:00:00Z`)) / 86_400_000);
  assert.ok(windowDays <= CUTOFF_MAX_LOOKBACK_DAYS, `jendela ${windowDays} hari harus <= ${CUTOFF_MAX_LOOKBACK_DAYS}`);
  assert.equal(range.endDate, "2026-07-16");
});

test("resolveCutoffQueryRange: cutoffDate tidak valid melempar error, bukan mengembalikan rentang menebak", () => {
  assert.throws(() => resolveCutoffQueryRange("16-07-2026"));
});

test("validateCutoffPlausibility: cutoff valid dalam periode & tidak di masa depan -> ok", () => {
  const result = validateCutoffPlausibility({ cutoffDate: "2026-07-16", year: 2026, month: 7, today: "2026-08-13" });
  assert.equal(result.ok, true);
});

test("validateCutoffPlausibility: cutoff null/tidak terbaca -> diblok (BA salah periode/ambigu)", () => {
  const result = validateCutoffPlausibility({ cutoffDate: null, year: 2026, month: 7, today: "2026-08-13" });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /tidak terbaca|tidak valid/i);
});

test("validateCutoffPlausibility: cutoff bulan berbeda dari filter yang dipilih -> diblok (SALAH PERIODE)", () => {
  const result = validateCutoffPlausibility({ cutoffDate: "2026-06-30", year: 2026, month: 7, today: "2026-08-13" });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /salah periode/i);
});

test("validateCutoffPlausibility: cutoff di masa depan -> diblok", () => {
  const result = validateCutoffPlausibility({ cutoffDate: "2026-08-20", year: 2026, month: 8, today: "2026-08-13" });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /masa depan/i);
});

test("parseInventoryBaPeriodText: 'Periode 01 Juli 2026 s/d 16 Juli 2026' -> cutoff akhir periode (16 Juli), BUKAN tanggal BA", () => {
  const result = parseInventoryBaPeriodText("Stock Opname Periode 01 Juli 2026 s/d 16 Juli 2026. Tanggal BA: 17 Juli 2026.");
  assert.equal(result.status, "OK");
  assert.equal(result.periodStartDate, "2026-07-01");
  assert.equal(result.periodEndDate, "2026-07-16");
});

test("parseInventoryBaPeriodText: '01 - 16 Juli 2026' (bulan ditulis sekali) tetap terbaca", () => {
  const result = parseInventoryBaPeriodText("Periode stock opname: 01 - 16 Juli 2026");
  assert.equal(result.status, "OK");
  assert.equal(result.periodStartDate, "2026-07-01");
  assert.equal(result.periodEndDate, "2026-07-16");
});

test("parseInventoryBaPeriodText: teks tanpa periode jelas -> PERLU_REVIEW, tidak menebak", () => {
  const result = parseInventoryBaPeriodText("Berita Acara Stock Opname toko cabang utama.");
  assert.equal(result.status, "PERLU_REVIEW");
  assert.equal(result.periodStartDate, null);
  assert.equal(result.periodEndDate, null);
});
