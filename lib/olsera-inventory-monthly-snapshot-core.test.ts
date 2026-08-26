// Test unit murni untuk ledger stok bulanan (lib/olsera-inventory-monthly-snapshot-core.ts)
// — aritmetika bulan, formula opening/closing, alias productId, langkah
// backfill mundur/maju (termasuk carry-forward, produk belum eksis TIDAK
// dipaksa, produk baru HANYA masuk bila ada bukti nyata), stripDuplicateSuffix,
// dan pemulihan movement productId:null. Tidak menyentuh Mongo/HTTP.
// Jalankan: node --no-warnings --experimental-strip-types --test lib/olsera-inventory-monthly-snapshot-core.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProductIdentityIndex, productKey, type InventoryProductInput, type MatchedMovement, type StockMovementApiRow } from "./olsera-inventory-monthly-core.ts";
import {
  buildMatchingContext,
  computeClosingFromOpeningForward,
  computeMonthlyStepBackward,
  computeMonthlyStepForward,
  computeOpeningFromClosingBackward,
  dominantStoreId,
  extendIdentityIndexWithAliases,
  firstDayOfMonth,
  getInventoryPeriodState,
  lastDayOfMonth,
  monthlySnapshotDocId,
  monthsAscending,
  monthsDescending,
  nextMonth,
  previousMonth,
  recoverNullProductIdSales,
  stripDuplicateSuffix,
  type BackwardAnchor,
  type ForwardAnchor,
} from "./olsera-inventory-monthly-snapshot-core.ts";

function product(overrides: Partial<InventoryProductInput>): InventoryProductInput {
  return {
    _id: "1:100:0",
    productId: 100,
    variantId: null,
    sku: null,
    barcode: null,
    name: "PRODUK A",
    variantName: null,
    category: "KATEGORI",
    subCategory: null,
    uom: null,
    storeId: 1,
    storeName: "Toko",
    active: true,
    trackInventory: true,
    sellPrice: 10000,
    buyPrice: 5000,
    lastBuyPrice: 5000,
    stockQty: 10,
    holdQty: 0,
    lowStockAlert: null,
    isOutStock: false,
    modifiedTime: null,
    stockSyncTime: null,
    ...overrides,
  };
}

function movementRow(overrides: Partial<StockMovementApiRow>): StockMovementApiRow {
  return {
    storeId: 1,
    storeName: "Toko",
    productId: 100,
    productGroupName: "GROUP",
    productName: "PRODUK A",
    productSku: null,
    productVariantId: null,
    productVariantName: null,
    productVariantSku: null,
    beginningQty: 0,
    incomingQty: 0,
    returnQty: 0,
    salesQty: 0,
    outgoingQty: 0,
    sisa: 0,
    ...overrides,
  };
}

function matched(row: StockMovementApiRow, method: MatchedMovement["method"] = "identity"): MatchedMovement {
  return { row, method, note: "test" };
}

// ---- Aritmetika bulan ----

test("previousMonth/nextMonth: lintas tahun benar (Januari <-> Desember)", () => {
  assert.deepEqual(previousMonth({ year: 2026, month: 1 }), { year: 2025, month: 12 });
  assert.deepEqual(nextMonth({ year: 2025, month: 12 }), { year: 2026, month: 1 });
  assert.deepEqual(previousMonth({ year: 2026, month: 6 }), { year: 2026, month: 5 });
  assert.deepEqual(nextMonth({ year: 2026, month: 6 }), { year: 2026, month: 7 });
});

test("monthsDescending: Mei -> Februari 2026 inklusif, urutan menurun", () => {
  const result = monthsDescending({ year: 2026, month: 5 }, { year: 2026, month: 2 });
  assert.deepEqual(result, [
    { year: 2026, month: 5 },
    { year: 2026, month: 4 },
    { year: 2026, month: 3 },
    { year: 2026, month: 2 },
  ]);
});

test("monthsAscending: Juli 2026 -> Januari 2027 inklusif, lintas tahun", () => {
  const result = monthsAscending({ year: 2026, month: 11 }, { year: 2027, month: 1 });
  assert.deepEqual(result, [
    { year: 2026, month: 11 },
    { year: 2026, month: 12 },
    { year: 2027, month: 1 },
  ]);
});

test("monthsAscending/monthsDescending: from > to (ascending) / from < to (descending) -> []", () => {
  assert.deepEqual(monthsAscending({ year: 2026, month: 6 }, { year: 2026, month: 5 }), []);
  assert.deepEqual(monthsDescending({ year: 2026, month: 5 }, { year: 2026, month: 6 }), []);
});

test("lastDayOfMonth/firstDayOfMonth: 28/29/30/31 hari benar (termasuk tahun kabisat)", () => {
  assert.equal(lastDayOfMonth(2026, 2), "2026-02-28"); // 2026 bukan kabisat
  assert.equal(lastDayOfMonth(2024, 2), "2024-02-29"); // 2024 kabisat
  assert.equal(lastDayOfMonth(2026, 4), "2026-04-30");
  assert.equal(lastDayOfMonth(2026, 6), "2026-06-30");
  assert.equal(lastDayOfMonth(2026, 7), "2026-07-31");
  assert.equal(firstDayOfMonth(2026, 7), "2026-07-01");
});

// ---- Formula ledger ----

test("computeOpeningFromClosingBackward: closing - incoming - return + sales + outgoing", () => {
  const opening = computeOpeningFromClosingBackward({ closingQty: 21, incomingQty: 24, returnQty: 0, salesQty: 46, outgoingQty: 2 });
  assert.equal(opening, 45); // sama dgn Stok Awal ODEA ROSE Juni 2026 nyata
});

test("computeClosingFromOpeningForward: opening + incoming + return - sales - outgoing", () => {
  const closing = computeClosingFromOpeningForward({ openingQty: 45, incomingQty: 24, returnQty: 0, salesQty: 46, outgoingQty: 2 });
  assert.equal(closing, 21);
});

test("computeOpeningFromClosingBackward dan computeClosingFromOpeningForward saling invers", () => {
  const flow = { incomingQty: 10, returnQty: 1, salesQty: 7, outgoingQty: 2 };
  const opening = 50;
  const closing = computeClosingFromOpeningForward({ openingQty: opening, ...flow });
  const roundTrip = computeOpeningFromClosingBackward({ closingQty: closing, ...flow });
  assert.equal(roundTrip, opening);
});

// ---- stripDuplicateSuffix ----

test("stripDuplicateSuffix: berbagai bentuk suffix dihilangkan, nama inti tetap", () => {
  assert.equal(stripDuplicateSuffix("YONEX SHORTS MEN # SM-J035-2906-RW1-S duplicate"), "YONEX SHORTS MEN # SM-J035-2906-RW1-S");
  assert.equal(stripDuplicateSuffix("PRODUK ASLI (duplicate)"), "PRODUK ASLI");
  assert.equal(stripDuplicateSuffix("PRODUK ASLI [Duplicate]"), "PRODUK ASLI");
  assert.equal(stripDuplicateSuffix("PRODUK ASLI DUPLICATE"), "PRODUK ASLI");
});

test("stripDuplicateSuffix: nama tanpa suffix tidak berubah", () => {
  assert.equal(stripDuplicateSuffix("BOLA PADEL ODEA ROSE"), "BOLA PADEL ODEA ROSE");
});

// ---- extendIdentityIndexWithAliases: perubahan productId lewat alias ----

test("extendIdentityIndexWithAliases: baris movement productId LAMA tetap match ke produk katalog via alias", () => {
  const catalog = [product({ _id: "1:118420650:0", productId: 118420650, variantId: null, storeId: 1, name: "YONEX SHORTS MEN # SM-J035-2906-RW1-S duplicate" })];
  const baseIndex = buildProductIdentityIndex(catalog);
  const extended = extendIdentityIndexWithAliases(baseIndex, catalog, [
    { oldProductId: 106743815, oldVariantId: null, newProductId: 118420650, newVariantId: null, confidence: "verified" },
  ]);
  const oldKey = productKey(1, 106743815, null);
  assert.equal(extended.get(oldKey)?._id, "1:118420650:0");
  // Identity productId baru tetap ada (tidak hilang).
  assert.equal(extended.get(productKey(1, 118420650, null))?._id, "1:118420650:0");
});

test("extendIdentityIndexWithAliases: alias yang target barunya TIDAK ada di katalog sekarang -> dilewati (tidak ditebak)", () => {
  const catalog = [product({ _id: "1:1:0", productId: 1 })];
  const baseIndex = buildProductIdentityIndex(catalog);
  const extended = extendIdentityIndexWithAliases(baseIndex, catalog, [
    { oldProductId: 999, oldVariantId: null, newProductId: 12345, newVariantId: null, confidence: "verified" }, // 12345 tidak ada di katalog
  ]);
  assert.equal(extended.size, baseIndex.size);
});

// ---- computeMonthlyStepBackward ----

test("computeMonthlyStepBackward: ada movement bulan ini -> opening dihitung, jadi anchor closing bulan sebelumnya", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:100:0", { closingQty: 21, productName: "PRODUK A", productSku: null, groupName: "GROUP" }]]);
  const row = movementRow({ productId: 100, incomingQty: 24, returnQty: 0, salesQty: 46, outgoingQty: 2 });
  const matchedMap = new Map([["1:100:0", matched(row)]]);
  const result = computeMonthlyStepBackward({ anchors, matched: matchedMap, catalogById: new Map(), hasEvidenceBeforeOrDuring: () => false });
  const entry = result.entries.get("1:100:0")!;
  assert.equal(entry.openingQty, 45);
  assert.equal(entry.closingQty, 21);
  assert.equal(entry.source, "stockmovement-backward");
  assert.equal(entry.status, "complete");
  assert.equal(result.nextAnchors.get("1:100:0")?.closingQty, 45);
  assert.deepEqual(result.stopped, []);
});

test("computeMonthlyStepBackward: tanpa movement TAPI ada bukti eksistensi -> carry-forward, tetap dilanjutkan", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:100:0", { closingQty: 28, productName: "THERMOFLASK", productSku: null, groupName: "THERMOFLASK" }]]);
  const result = computeMonthlyStepBackward({ anchors, matched: new Map(), catalogById: new Map(), hasEvidenceBeforeOrDuring: () => true });
  const entry = result.entries.get("1:100:0")!;
  assert.equal(entry.source, "carry-forward");
  assert.equal(entry.openingQty, 28);
  assert.equal(entry.closingQty, 28);
  assert.equal(result.nextAnchors.get("1:100:0")?.closingQty, 28);
  assert.deepEqual(result.stopped, []);
});

test("computeMonthlyStepBackward: anchor closingQty = 0, tanpa movement DAN tanpa bukti eksistensi -> DIHENTIKAN (produk belum eksis bulan ini, tidak dipaksa)", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:119043265:0", { closingQty: 0, productName: "BOLA PADEL ODEA RED", productSku: null, groupName: "BOLA PADEL" }]]);
  const result = computeMonthlyStepBackward({ anchors, matched: new Map(), catalogById: new Map(), hasEvidenceBeforeOrDuring: () => false });
  assert.equal(result.entries.size, 0);
  assert.deepEqual(result.stopped, ["1:119043265:0"]);
  assert.equal(result.nextAnchors.size, 0);
});

test("computeMonthlyStepBackward: anchor closingQty = 0 TAPI ada bukti eksistensi -> tetap carry-forward (perilaku lama utk saldo kosong dipertahankan)", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:119043265:0", { closingQty: 0, productName: "BOLA PADEL ODEA RED", productSku: null, groupName: "BOLA PADEL" }]]);
  const result = computeMonthlyStepBackward({ anchors, matched: new Map(), catalogById: new Map(), hasEvidenceBeforeOrDuring: () => true });
  const entry = result.entries.get("1:119043265:0")!;
  assert.equal(entry.source, "carry-forward");
  assert.equal(entry.openingQty, 0);
  assert.equal(entry.closingQty, 0);
  assert.deepEqual(result.stopped, []);
});

// ---- computeMonthlyStepBackward: carry-over tanpa jejak order-item (kasus CUP 22OZ / HOT CUP KRAFT 12OZ) ----
// Barang yang TIDAK PERNAH terjual tidak punya baris olsera_order_items sama
// sekali, sehingga hasEvidenceBeforeOrDuring() selalu false — dulu item begini
// di-stop & dokumennya tidak pernah ditulis (hilang total dari snapshot),
// padahal anchor closing dari bulan berikutnya membuktikan saldonya ada.

test("computeMonthlyStepBackward: anchor closingQty > 0, tanpa movement, TANPA bukti order-item -> TETAP carry-forward (anchor positif = bukti eksistensi)", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:106817283:0", { closingQty: 1000, productName: "CUP 22OZ", productSku: null, groupName: "GELAS/CUP" }]]);
  const result = computeMonthlyStepBackward({ anchors, matched: new Map(), catalogById: new Map(), hasEvidenceBeforeOrDuring: () => false });
  const entry = result.entries.get("1:106817283:0")!;
  assert.equal(entry.source, "carry-forward");
  assert.equal(entry.status, "complete");
  assert.equal(entry.openingQty, 1000);
  assert.equal(entry.closingQty, 1000);
  assert.equal(entry.salesQty, 0);
  assert.match(entry.diagnostics[0], /anchor closing bulan berikutnya = 1000/);
  assert.equal(result.nextAnchors.get("1:106817283:0")?.closingQty, 1000);
  assert.deepEqual(result.stopped, []);
});

test("computeMonthlyStepBackward: anchor closingQty > 0 DAN ada movement -> pakai data movement (jalur normal tidak berubah oleh anchor positif)", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:106817305:0", { closingQty: 1000, productName: "HOT CUP KRAFT 12OZ", productSku: null, groupName: "GELAS/CUP" }]]);
  const row = movementRow({ productId: 106817305, productName: "HOT CUP KRAFT 12OZ", incomingQty: 200, returnQty: 0, salesQty: 150, outgoingQty: 50 });
  const result = computeMonthlyStepBackward({ anchors, matched: new Map([["1:106817305:0", matched(row)]]), catalogById: new Map(), hasEvidenceBeforeOrDuring: () => false });
  const entry = result.entries.get("1:106817305:0")!;
  assert.equal(entry.source, "stockmovement-backward");
  assert.equal(entry.incomingQty, 200);
  assert.equal(entry.salesQty, 150);
  assert.equal(entry.outgoingQty, 50);
  assert.equal(entry.openingQty, 1000); // 1000 = opening + 200 + 0 - 150 - 50
  assert.equal(entry.closingQty, 1000);
  assert.equal(result.nextAnchors.get("1:106817305:0")?.closingQty, 1000);
  assert.deepEqual(result.stopped, []);
});

// ---- ODEA ROSE Mei 2026: ikut angka API Olsera, BUKAN warisan ledger ----
// Olsera memutus identitas ~26 Mei 2026 (106817649 "BOLA PADEL ODEA" ->
// 116138490 "BOLA PADEL ODEA ROSE", mulai begin=0). Setelah
// LEDGER_HISTORY_CUTOFF_BY_PRODUCT_ID menyaring baris pra-putus, ledger Mei
// tinggal 12 — sama dengan salesQty API — sehingga fallback alias TIDAK
// override dan rantai menutup persis di angka Olsera (0 / 57 / 12 / 45).
// BA Stock Opname Mei 2026: sistem Olsera 45, fisik aktual 44.

test("computeMonthlyStepBackward: ODEA ROSE Mei -> ikut API Olsera (begin 0, in 57, sales 12, close 45), ledger pasca-cutoff TIDAK override", () => {
  const key = "1:116138490:0";
  const anchors = new Map<string, BackwardAnchor>([[key, { closingQty: 45, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const row = movementRow({ productId: 116138490, productName: "BOLA PADEL ODEA ROSE", incomingQty: 57, returnQty: 0, salesQty: 12, outgoingQty: 0, sisa: 45 });
  const result = computeMonthlyStepBackward({
    anchors,
    matched: new Map([[key, matched(row)]]),
    catalogById: new Map(),
    hasEvidenceBeforeOrDuring: () => true,
    rawSalesActivityByKey: new Map([[key, 12]]), // pasca-cutoff: 12, bukan 55
    verifiedAliasCanonicalKeys: new Set([key]),
  });
  const entry = result.entries.get(key)!;
  assert.equal(entry.openingQty, 0);
  assert.equal(entry.incomingQty, 57);
  assert.equal(entry.salesQty, 12);
  assert.equal(entry.closingQty, 45);
  assert.equal(entry.status, "complete");
  assert.ok(!entry.diagnostics.some((d) => d.includes("Alias TERVERIFIKASI")), "fallback alias TIDAK boleh aktif saat ledger tidak lebih besar dari API");
});

test("computeMonthlyStepBackward: ODEA ROSE Mei TANPA cutoff (ledger bocor 55) -> fallback override, opening meleset dari 0 (rantai tidak menutup di angka Olsera)", () => {
  const key = "1:116138490:0";
  const anchors = new Map<string, BackwardAnchor>([[key, { closingQty: 45, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const row = movementRow({ productId: 116138490, productName: "BOLA PADEL ODEA ROSE", incomingQty: 57, returnQty: 0, salesQty: 12, outgoingQty: 0, sisa: 45 });
  const result = computeMonthlyStepBackward({
    anchors,
    matched: new Map([[key, matched(row)]]),
    catalogById: new Map(),
    hasEvidenceBeforeOrDuring: () => true,
    rawSalesActivityByKey: new Map([[key, 55]]), // pra-cutoff ikut terbawa
    verifiedAliasCanonicalKeys: new Set([key]),
  });
  const entry = result.entries.get(key)!;
  assert.equal(entry.salesQty, 55); // ledger menimpa API
  assert.equal(entry.openingQty, 43); // 45 - 57 + 55 = 43, bukan 0 -> saldo awal salah, inilah yang merambat jadi negatif di rantai nyata
  assert.ok(entry.diagnostics.some((d) => d.includes("Alias TERVERIFIKASI")));
});

// ---- computeMonthlyStepBackward: produk BARU tanpa anchor bulan berikutnya (kasus RAKET PADEL ADIDAS 2026 MATCH / BULLPADEL Feb-Mar 2026) ----

test("computeMonthlyStepBackward: produk BARU (di 'matched' tapi TIDAK ada anchor) -> HANYA masuk karena ada baris API nyata bulan ini (bukti eksistensi, order-item TIDAK diperlukan)", () => {
  const newProduct = product({ _id: "1:111246035:0", productId: 111246035, name: "RAKET PADEL ADIDAS 2026 MATCH", category: "RAKET PADEL" });
  const row = movementRow({ productId: 111246035, productName: "RAKET PADEL ADIDAS 2026 MATCH", productGroupName: "RAKET PADEL", beginningQty: 0, incomingQty: 4, returnQty: 0, salesQty: 0, outgoingQty: 0, sisa: 4 });
  const matchedMap = new Map([["1:111246035:0", matched(row)]]);
  // hasEvidenceBeforeOrDuring sengaja SELALU false — membuktikan jalur baru ini TIDAK bergantung pada olsera_order_items.
  const result = computeMonthlyStepBackward({ anchors: new Map(), matched: matchedMap, catalogById: new Map([["1:111246035:0", newProduct]]), hasEvidenceBeforeOrDuring: () => false });
  const entry = result.entries.get("1:111246035:0")!;
  assert.equal(entry.closingQty, 4); // dipercaya langsung dari sisa API (satu-satunya bukti)
  assert.equal(entry.openingQty, 0); // 4 - 4 - 0 + 0 + 0
  assert.equal(entry.source, "stockmovement-backward");
  assert.equal(entry.status, "complete");
  assert.equal(result.nextAnchors.get("1:111246035:0")?.closingQty, 0);
  assert.deepEqual(result.stopped, []);
});

test("computeMonthlyStepBackward: produk BARU dengan outgoing (kasus BULLPADEL VERTEX 05 COMFORT Maret 2026) -> opening dihitung mundur benar, equation balance", () => {
  const newProduct = product({ _id: "1:106778998:0", productId: 106778998, name: "BULLPADEL VERTEX 05 COMFORT 2026-360-370 BLACK/BLUE", category: "RAKET PADEL" });
  const row = movementRow({ productId: 106778998, productName: "BULLPADEL VERTEX 05 COMFORT 2026-360-370 BLACK/BLUE", productGroupName: "RAKET PADEL", beginningQty: 1, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 1, sisa: 0 });
  const matchedMap = new Map([["1:106778998:0", matched(row)]]);
  const result = computeMonthlyStepBackward({ anchors: new Map(), matched: matchedMap, catalogById: new Map([["1:106778998:0", newProduct]]), hasEvidenceBeforeOrDuring: () => false });
  const entry = result.entries.get("1:106778998:0")!;
  assert.equal(entry.closingQty, 0);
  assert.equal(entry.openingQty, 1); // 0 - 0 - 0 + 0 + 1
  // Equation forward harus balance: opening + incoming + return - sales - outgoing = closing
  assert.equal(entry.openingQty! + entry.incomingQty! + entry.returnQty! - entry.salesQty! - entry.outgoingQty!, entry.closingQty);
});

test("computeMonthlyStepBackward: 'matched' TAPI catalogById tidak punya entri (identity tidak dapat diresolusi tunggal) -> TIDAK dipaksa masuk (ambiguous tetap manual review)", () => {
  const row = movementRow({ productId: 118420650, productName: "YONEX SHORTS MEN # SM-J035-2906-RW1-S duplicate", beginningQty: 1, incomingQty: 1, returnQty: 0, salesQty: 1, outgoingQty: 0, sisa: 1 });
  const matchedMap = new Map([["1:118420650:0", matched(row)]]);
  // catalogById KOSONG -> mensimulasikan produk ambiguous/duplicate yang tidak lolos resolusi identity tunggal.
  const result = computeMonthlyStepBackward({ anchors: new Map(), matched: matchedMap, catalogById: new Map(), hasEvidenceBeforeOrDuring: () => false });
  assert.equal(result.entries.size, 0);
  assert.deepEqual(result.stopped, []); // bukan "stopped" (itu utk anchor yg gagal) — sekadar tidak pernah dibuat
});

test("computeMonthlyStepBackward: rerun idempoten utk produk BARU tanpa anchor — dijalankan dua kali menghasilkan entries identik (tidak duplicate)", () => {
  const newProduct = product({ _id: "1:111246035:0", productId: 111246035, name: "RAKET PADEL ADIDAS 2026 MATCH", category: "RAKET PADEL" });
  const row = movementRow({ productId: 111246035, beginningQty: 0, incomingQty: 4, returnQty: 0, salesQty: 0, outgoingQty: 0, sisa: 4 });
  const matchedMap = new Map([["1:111246035:0", matched(row)]]);
  const catalogById = new Map([["1:111246035:0", newProduct]]);
  const run1 = computeMonthlyStepBackward({ anchors: new Map(), matched: matchedMap, catalogById, hasEvidenceBeforeOrDuring: () => false });
  const run2 = computeMonthlyStepBackward({ anchors: new Map(), matched: matchedMap, catalogById, hasEvidenceBeforeOrDuring: () => false });
  assert.deepEqual(run1.entries.get("1:111246035:0"), run2.entries.get("1:111246035:0"));
  assert.equal(run1.entries.size, 1);
  assert.equal(run2.entries.size, 1);
});

// ---- carry-forward kontradiktif (rawSalesActivityByKey) — kasus movement-qty:116138490:0 ----

test("computeMonthlyStepBackward: carry-forward TAPI ada bukti penjualan mentah (rawSalesActivityByKey > 0) -> status 'incomplete', angka TETAP 0 (entity sintetis setara 116138490)", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:116138490:0", { closingQty: 45, productName: "PRODUK RENAME", productSku: null, groupName: "GROUP" }]]);
  const result = computeMonthlyStepBackward({
    anchors,
    matched: new Map(),
    catalogById: new Map(),
    hasEvidenceBeforeOrDuring: () => true,
    rawSalesActivityByKey: new Map([["1:116138490:0", 30]]),
  });
  const entry = result.entries.get("1:116138490:0")!;
  assert.equal(entry.source, "carry-forward");
  assert.equal(entry.status, "incomplete"); // BUKAN "complete" — ada kontradiksi bukti
  assert.equal(entry.salesQty, 0); // angka TIDAK ditebak/diubah, tetap 0
  assert.equal(entry.openingQty, 45);
  assert.equal(entry.closingQty, 45);
  assert.match(entry.diagnostics[0], /sumAbsQty=30/);
  assert.match(entry.diagnostics[0], /TIDAK BOLEH dipercaya/);
});

// ---- Fitur ODEA: verifiedAliasCanonicalKeys (fallback ledger historis, guarded) ----

test("computeMonthlyStepBackward: carry-forward + verified alias + rawSales lebih besar -> salesQty dari ledger, status 'complete', opening dihitung ULANG via formula existing (kasus ODEA Apr: sales=51)", () => {
  const key = "324175:116138490:0";
  const anchors = new Map<string, BackwardAnchor>([[key, { closingQty: 43, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const result = computeMonthlyStepBackward({
    anchors,
    matched: new Map(),
    catalogById: new Map(),
    hasEvidenceBeforeOrDuring: () => true,
    rawSalesActivityByKey: new Map([[key, 51]]),
    verifiedAliasCanonicalKeys: new Set([key]),
  });
  const entry = result.entries.get(key)!;
  assert.equal(entry.source, "carry-forward"); // sumber TIDAK dipalsukan jadi lain
  assert.equal(entry.status, "complete"); // BUKAN hardcode — konsekuensi alami dari alias sudah terverifikasi
  assert.equal(entry.salesQty, 51); // dari ledger, BUKAN 0
  assert.equal(entry.closingQty, 43); // anchor-given, TIDAK berubah
  assert.equal(entry.openingQty, computeOpeningFromClosingBackward({ closingQty: 43, incomingQty: 0, returnQty: 0, salesQty: 51, outgoingQty: 0 })); // formula existing, bukan hardcode
  assert.equal(entry.openingQty, 94);
  assert.match(entry.diagnostics.at(-1)!, /TERVERIFIKASI/);
  // nextAnchors bulan sebelumnya (N-1) harus menerima closingQty = openingQty entry ini (94), bukan 43 lama.
  assert.equal(result.nextAnchors.get(key)?.closingQty, 94);
});

test("computeMonthlyStepBackward: TANPA verifiedAliasCanonicalKeys (default) -> perilaku LAMA persis (regresi terhadap fitur baru) walau rawSales lebih besar", () => {
  const key = "324175:116138490:0";
  const anchors = new Map<string, BackwardAnchor>([[key, { closingQty: 43, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const result = computeMonthlyStepBackward({
    anchors,
    matched: new Map(),
    catalogById: new Map(),
    hasEvidenceBeforeOrDuring: () => true,
    rawSalesActivityByKey: new Map([[key, 51]]),
    // verifiedAliasCanonicalKeys TIDAK diisi.
  });
  const entry = result.entries.get(key)!;
  assert.equal(entry.status, "incomplete");
  assert.equal(entry.salesQty, 0);
});

test("computeMonthlyStepBackward: key ADA verifiedAliasCanonicalKeys TAPI BUKAN key ini -> tidak terpengaruh (isolasi antar produk, mis. Yonex tidak boleh ikut saat ODEA yang dimaksud)", () => {
  const key = "324175:116138490:0";
  const otherVerifiedKey = "324175:118420650:0"; // Yonex — verified alias-nya SENDIRI, beda entity
  const anchors = new Map<string, BackwardAnchor>([[key, { closingQty: 43, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const result = computeMonthlyStepBackward({
    anchors,
    matched: new Map(),
    catalogById: new Map(),
    hasEvidenceBeforeOrDuring: () => true,
    rawSalesActivityByKey: new Map([[key, 51]]),
    verifiedAliasCanonicalKeys: new Set([otherVerifiedKey]), // hanya Yonex verified, BUKAN ODEA
  });
  const entry = result.entries.get(key)!;
  assert.equal(entry.status, "incomplete");
  assert.equal(entry.salesQty, 0);
});

test("computeMonthlyStepBackward: verified alias TAPI ledger TIDAK lebih besar dari salesQty sumber lain (baris 'matched'/stockmovement API) -> TIDAK override (tidak menimpa sumber resmi yang sudah lengkap)", () => {
  const key = "324175:116138490:0";
  const anchors = new Map<string, BackwardAnchor>([[key, { closingQty: 45, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const row = movementRow({ productId: 116138490, incomingQty: 57, returnQty: 0, salesQty: 60, outgoingQty: 0, sisa: 45 }); // official API salesQty=60, sudah lebih besar dari ledger
  const matchedMap = new Map([[key, matched(row)]]);
  const result = computeMonthlyStepBackward({
    anchors,
    matched: matchedMap,
    catalogById: new Map(),
    hasEvidenceBeforeOrDuring: () => true,
    rawSalesActivityByKey: new Map([[key, 55]]), // ledger 55 < official 60 -> TIDAK override
    verifiedAliasCanonicalKeys: new Set([key]),
  });
  const entry = result.entries.get(key)!;
  assert.equal(entry.salesQty, 60); // tetap dari stockmovement API, TIDAK ditimpa ledger yang lebih kecil
  assert.equal(entry.source, "stockmovement-backward");
});

test("computeMonthlyStepBackward: verified alias + baris 'matched' (official API) TAPI ledger LEBIH BESAR -> override (kasus ODEA Mei: official=12, ledger=55)", () => {
  const key = "324175:116138490:0";
  const anchors = new Map<string, BackwardAnchor>([[key, { closingQty: 45, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const row = movementRow({ productId: 116138490, incomingQty: 57, returnQty: 0, salesQty: 12, outgoingQty: 0, sisa: 45 });
  const matchedMap = new Map([[key, matched(row)]]);
  const result = computeMonthlyStepBackward({
    anchors,
    matched: matchedMap,
    catalogById: new Map(),
    hasEvidenceBeforeOrDuring: () => true,
    rawSalesActivityByKey: new Map([[key, 55]]),
    verifiedAliasCanonicalKeys: new Set([key]),
  });
  const entry = result.entries.get(key)!;
  assert.equal(entry.salesQty, 55); // ledger dipakai, official (12) TIDAK dipercaya lagi
  assert.equal(entry.closingQty, 45); // anchor-given, tidak berubah
  assert.equal(entry.incomingQty, 57); // TIDAK disentuh — hanya salesQty yang diganti
  assert.equal(entry.openingQty, computeOpeningFromClosingBackward({ closingQty: 45, incomingQty: 57, returnQty: 0, salesQty: 55, outgoingQty: 0 }));
});

test("computeMonthlyStepBackward: TANPA rawSalesActivityByKey sama sekali (undefined) TAPI verifiedAliasCanonicalKeys diisi -> tidak crash, tidak override (tidak ada dasar angka)", () => {
  const key = "324175:116138490:0";
  const anchors = new Map<string, BackwardAnchor>([[key, { closingQty: 45, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const result = computeMonthlyStepBackward({
    anchors,
    matched: new Map(),
    catalogById: new Map(),
    hasEvidenceBeforeOrDuring: () => true,
    verifiedAliasCanonicalKeys: new Set([key]),
  });
  const entry = result.entries.get(key)!;
  assert.equal(entry.salesQty, 0);
  assert.equal(entry.status, "complete");
});

test("computeMonthlyStepBackward: rerun idempoten dengan verifiedAliasCanonicalKeys — dijalankan dua kali menghasilkan entries identik", () => {
  const key = "324175:116138490:0";
  const anchors = new Map<string, BackwardAnchor>([[key, { closingQty: 43, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const rawSalesActivityByKey = new Map([[key, 51]]);
  const verifiedAliasCanonicalKeys = new Set([key]);
  const run1 = computeMonthlyStepBackward({ anchors, matched: new Map(), catalogById: new Map(), hasEvidenceBeforeOrDuring: () => true, rawSalesActivityByKey, verifiedAliasCanonicalKeys });
  const run2 = computeMonthlyStepBackward({ anchors, matched: new Map(), catalogById: new Map(), hasEvidenceBeforeOrDuring: () => true, rawSalesActivityByKey, verifiedAliasCanonicalKeys });
  assert.deepEqual(run1.entries.get(key), run2.entries.get(key));
});

test("computeMonthlyStepBackward: carry-forward TANPA rawSalesActivityByKey (default, tidak diisi) -> status tetap 'complete' (regresi tidak berubah)", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:100:0", { closingQty: 28, productName: "THERMOFLASK", productSku: null, groupName: "THERMOFLASK" }]]);
  const result = computeMonthlyStepBackward({ anchors, matched: new Map(), catalogById: new Map(), hasEvidenceBeforeOrDuring: () => true });
  const entry = result.entries.get("1:100:0")!;
  assert.equal(entry.status, "complete");
});

test("computeMonthlyStepBackward: carry-forward DENGAN rawSalesActivityByKey TAPI key ini sumAbsQty=0 -> status tetap 'complete' (tidak ada kontradiksi)", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:100:0", { closingQty: 28, productName: "PRODUK LAIN", productSku: null, groupName: "GROUP" }]]);
  const result = computeMonthlyStepBackward({
    anchors,
    matched: new Map(),
    catalogById: new Map(),
    hasEvidenceBeforeOrDuring: () => true,
    rawSalesActivityByKey: new Map([["1:999:0", 10]]), // key BERBEDA, tidak menyentuh produk ini
  });
  const entry = result.entries.get("1:100:0")!;
  assert.equal(entry.status, "complete");
});

test("computeMonthlyStepBackward: rerun idempoten — dijalankan dua kali dengan input sama menghasilkan entries identik", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:116138490:0", { closingQty: 45, productName: "PRODUK RENAME", productSku: null, groupName: "GROUP" }]]);
  const rawSalesActivityByKey = new Map([["1:116138490:0", 30]]);
  const run1 = computeMonthlyStepBackward({ anchors, matched: new Map(), catalogById: new Map(), hasEvidenceBeforeOrDuring: () => true, rawSalesActivityByKey });
  const run2 = computeMonthlyStepBackward({ anchors, matched: new Map(), catalogById: new Map(), hasEvidenceBeforeOrDuring: () => true, rawSalesActivityByKey });
  assert.deepEqual(run1.entries.get("1:116138490:0"), run2.entries.get("1:116138490:0"));
});

test("computeMonthlyStepBackward: variantId literal 0 pada anchor key tetap terdeteksi kontradiktif (bukan diperlakukan beda dari null)", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:200:0", { closingQty: 5, productName: "PRODUK VARIAN 0", productSku: null, groupName: "GROUP" }]]);
  const result = computeMonthlyStepBackward({
    anchors,
    matched: new Map(),
    catalogById: new Map(),
    hasEvidenceBeforeOrDuring: () => true,
    rawSalesActivityByKey: new Map([["1:200:0", 7]]),
  });
  assert.equal(result.entries.get("1:200:0")!.status, "incomplete");
});

test("computeMonthlyStepBackward: productId hasil match berbeda dari identitas stabil -> canonicalProductId terisi (jejak alias)", () => {
  const anchors = new Map<string, BackwardAnchor>([["1:118420650:0", { closingQty: 1, productName: "YONEX SHORTS", productSku: null, groupName: "CELANA PRIA" }]]);
  const row = movementRow({ productId: 106743815, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0 }); // productId LAMA (alias)
  const matchedMap = new Map([["1:118420650:0", matched(row, "identity")]]);
  const result = computeMonthlyStepBackward({ anchors, matched: matchedMap, catalogById: new Map(), hasEvidenceBeforeOrDuring: () => false });
  const entry = result.entries.get("1:118420650:0")!;
  assert.equal(entry.productId, 118420650); // identitas stabil (katalog), BUKAN 106743815
  assert.equal(entry.canonicalProductId, 106743815); // tercatat productId mentah API bulan itu berbeda
});

// ---- computeMonthlyStepForward ----

test("computeMonthlyStepForward: ada movement -> closing dihitung, jadi anchor opening bulan berikutnya", () => {
  const anchors = new Map<string, ForwardAnchor>([["1:100:0", { openingQty: 21, productName: "PRODUK A", productSku: null, groupName: "GROUP" }]]);
  const row = movementRow({ productId: 100, incomingQty: 5, returnQty: 0, salesQty: 3, outgoingQty: 1 });
  const matchedMap = new Map([["1:100:0", matched(row)]]);
  const result = computeMonthlyStepForward({ anchors, matched: matchedMap, catalogById: new Map() });
  const entry = result.entries.get("1:100:0")!;
  assert.equal(entry.openingQty, 21);
  assert.equal(entry.closingQty, 22); // 21+5+0-3-1
  assert.equal(entry.source, "stockmovement-forward");
  assert.equal(result.nextAnchors.get("1:100:0")?.openingQty, 22);
});

test("computeMonthlyStepForward: tanpa movement -> carry-forward, TIDAK PERNAH dihentikan (produk existing tetap lanjut)", () => {
  const anchors = new Map<string, ForwardAnchor>([["1:100:0", { openingQty: 5, productName: "PRODUK STATIS", productSku: null, groupName: "GROUP" }]]);
  const result = computeMonthlyStepForward({ anchors, matched: new Map(), catalogById: new Map() });
  const entry = result.entries.get("1:100:0")!;
  assert.equal(entry.source, "carry-forward");
  assert.equal(entry.openingQty, 5);
  assert.equal(entry.closingQty, 5);
  assert.equal(result.nextAnchors.size, 1);
});

test("computeMonthlyStepForward: carry-forward TAPI ada bukti penjualan mentah (rawSalesActivityByKey > 0) -> status 'incomplete', angka TETAP 0", () => {
  const anchors = new Map<string, ForwardAnchor>([["1:116138490:0", { openingQty: 21, productName: "PRODUK RENAME", productSku: null, groupName: "GROUP" }]]);
  const result = computeMonthlyStepForward({
    anchors,
    matched: new Map(),
    catalogById: new Map(),
    rawSalesActivityByKey: new Map([["1:116138490:0", 8]]),
  });
  const entry = result.entries.get("1:116138490:0")!;
  assert.equal(entry.source, "carry-forward");
  assert.equal(entry.status, "incomplete");
  assert.equal(entry.salesQty, 0);
  assert.equal(entry.openingQty, 21);
  assert.equal(entry.closingQty, 21);
  assert.match(entry.diagnostics[0], /sumAbsQty=8/);
});

test("computeMonthlyStepForward: carry-forward + verified alias + rawSales lebih besar -> salesQty dari ledger, closing dihitung ULANG via formula existing (arah maju)", () => {
  const key = "324175:116138490:0";
  const anchors = new Map<string, ForwardAnchor>([[key, { openingQty: 21, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const result = computeMonthlyStepForward({
    anchors,
    matched: new Map(),
    catalogById: new Map(),
    rawSalesActivityByKey: new Map([[key, 8]]),
    verifiedAliasCanonicalKeys: new Set([key]),
  });
  const entry = result.entries.get(key)!;
  assert.equal(entry.status, "complete");
  assert.equal(entry.salesQty, 8);
  assert.equal(entry.openingQty, 21); // anchor-given, tidak berubah di arah maju
  assert.equal(entry.closingQty, computeClosingFromOpeningForward({ openingQty: 21, incomingQty: 0, returnQty: 0, salesQty: 8, outgoingQty: 0 }));
  assert.equal(entry.closingQty, 13);
  assert.equal(result.nextAnchors.get(key)?.openingQty, 13);
});

test("computeMonthlyStepForward: TANPA verifiedAliasCanonicalKeys (default) -> perilaku LAMA persis walau rawSales lebih besar", () => {
  const key = "324175:116138490:0";
  const anchors = new Map<string, ForwardAnchor>([[key, { openingQty: 21, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const result = computeMonthlyStepForward({ anchors, matched: new Map(), catalogById: new Map(), rawSalesActivityByKey: new Map([[key, 8]]) });
  const entry = result.entries.get(key)!;
  assert.equal(entry.status, "incomplete");
  assert.equal(entry.salesQty, 0);
});

test("computeMonthlyStepForward: verified alias TAPI ledger TIDAK lebih besar dari salesQty resmi -> TIDAK override (Jul/Aug: source lebih kuat, tidak boleh rusak)", () => {
  const key = "324175:116138490:0";
  const anchors = new Map<string, ForwardAnchor>([[key, { openingQty: 21, productName: "BOLA PADEL ODEA ROSE", productSku: null, groupName: "BOLA PADEL" }]]);
  const row = movementRow({ productId: 116138490, incomingQty: 24, returnQty: 0, salesQty: 11, outgoingQty: 2 });
  const matchedMap = new Map([[key, matched(row)]]);
  const result = computeMonthlyStepForward({
    anchors,
    matched: matchedMap,
    catalogById: new Map(),
    rawSalesActivityByKey: new Map([[key, 9]]), // ledger 9 < official 11 -> TIDAK override
    verifiedAliasCanonicalKeys: new Set([key]),
  });
  const entry = result.entries.get(key)!;
  assert.equal(entry.salesQty, 11);
  assert.equal(entry.source, "stockmovement-forward");
});

test("computeMonthlyStepForward: carry-forward TANPA rawSalesActivityByKey (default) -> status tetap 'complete' (regresi tidak berubah)", () => {
  const anchors = new Map<string, ForwardAnchor>([["1:100:0", { openingQty: 5, productName: "PRODUK STATIS", productSku: null, groupName: "GROUP" }]]);
  const result = computeMonthlyStepForward({ anchors, matched: new Map(), catalogById: new Map() });
  assert.equal(result.entries.get("1:100:0")!.status, "complete");
});

test("computeMonthlyStepForward: produk BARU (di 'matched' tapi belum ada anchor) -> HANYA masuk karena ada baris API nyata bulan ini (bukti eksistensi)", () => {
  const newProduct = product({ _id: "1:119043265:0", productId: 119043265, name: "BOLA PADEL ODEA RED", category: "BOLA PADEL" });
  const row = movementRow({ productId: 119043265, productName: "BOLA PADEL ODEA RED", productGroupName: "BOLA PADEL", beginningQty: 49, incomingQty: 0, returnQty: 0, salesQty: 2, outgoingQty: 0, sisa: 47 });
  const matchedMap = new Map([["1:119043265:0", matched(row)]]);
  const result = computeMonthlyStepForward({ anchors: new Map(), matched: matchedMap, catalogById: new Map([["1:119043265:0", newProduct]]) });
  const entry = result.entries.get("1:119043265:0")!;
  assert.equal(entry.openingQty, 49); // dipercaya langsung dari beginning_qty API (satu-satunya bukti)
  assert.equal(entry.closingQty, 47);
  assert.equal(entry.source, "stockmovement-forward");
  assert.equal(result.nextAnchors.get("1:119043265:0")?.openingQty, 47);
});

test("computeMonthlyStepForward: TIDAK ada baris API DAN TIDAK ada anchor -> produk tidak muncul sama sekali (tidak dipaksa)", () => {
  const result = computeMonthlyStepForward({ anchors: new Map(), matched: new Map(), catalogById: new Map() });
  assert.equal(result.entries.size, 0);
});

test("computeMonthlyStepForward: katalog aktif qty > 0 tanpa movement -> muncul sebagai source catalog tanpa mengarang movement", () => {
  const catalogProduct = { ...product({ _id: "1:777:0", productId: 777, name: "CATALOG ONLY" }), stockQty: 2, active: true };
  const key = "1:777:0";
  const result = computeMonthlyStepForward({ anchors: new Map(), matched: new Map(), catalogById: new Map([[key, catalogProduct]]), catalogOnly: new Map([[key, catalogProduct]]) });
  const entry = result.entries.get(key);
  assert.equal(entry?.source, "catalog");
  assert.deepEqual([entry?.openingQty, entry?.incomingQty, entry?.returnQty, entry?.salesQty, entry?.outgoingQty, entry?.closingQty], [2, 0, 0, 0, 0, 2]);
});

// ---- recoverNullProductIdSales ----

test("recoverNullProductIdSales: movement productId:null dipulihkan via resolvedProductId order item (kasus YONEX SHORTS)", () => {
  const nullMovements = [
    { _id: "sale:3400368597", productId: null, qtyChange: -2 },
    { _id: "sale:3462030813", productId: null, qtyChange: -1 },
  ];
  const resolvedByOrderItemId = new Map([
    [3400368597, { resolvedProductId: 118420650, variantId: null }],
    [3462030813, { resolvedProductId: 118420650, variantId: null }],
  ]);
  const recovered = recoverNullProductIdSales(nullMovements, resolvedByOrderItemId);
  assert.equal(recovered.length, 2);
  assert.equal(recovered[0].productId, 118420650);
  const totalQty = recovered.reduce((s, m) => s + Math.abs(m.qtyChange), 0);
  assert.equal(totalQty, 3); // persis selisih Penjualan yang dilaporkan
});

test("recoverNullProductIdSales: orderItemId tidak ditemukan di olsera_order_items -> TETAP dilewati (bukan ditebak)", () => {
  const nullMovements = [{ _id: "sale:999", productId: null, qtyChange: -1 }];
  const recovered = recoverNullProductIdSales(nullMovements, new Map());
  assert.deepEqual(recovered, []);
});

test("recoverNullProductIdSales: resolvedProductId juga null di order item -> tetap dilewati", () => {
  const nullMovements = [{ _id: "sale:1", productId: null, qtyChange: -1 }];
  const resolvedByOrderItemId = new Map([[1, { resolvedProductId: null, variantId: null }]]);
  const recovered = recoverNullProductIdSales(nullMovements, resolvedByOrderItemId);
  assert.deepEqual(recovered, []);
});

// ---- monthlySnapshotDocId / dominantStoreId ----

test("monthlySnapshotDocId: format stabil storeId:year:month(2digit):productId:variantId(0 bila null)", () => {
  assert.equal(monthlySnapshotDocId(324175, 2026, 6, 116138490, null), "324175:2026:06:116138490:0");
  assert.equal(monthlySnapshotDocId(324175, 2026, 2, 100, 5), "324175:2026:02:100:5");
});

test("dominantStoreId: storeId paling sering muncul di katalog", () => {
  const catalog = [product({ storeId: 1 }), product({ storeId: 1 }), product({ storeId: 2 })];
  assert.equal(dominantStoreId(catalog), 1);
});

// ---- buildMatchingContext (sanity) ----

test("buildMatchingContext: index identity/sku/nama terbentuk dari katalog", () => {
  const catalog = [product({ _id: "1:100:0", productId: 100, storeId: 1, sku: "SKU-A", name: "PRODUK A" })];
  const context = buildMatchingContext(catalog, []);
  assert.equal(context.identityIndex.get(productKey(1, 100, null))?._id, "1:100:0");
  assert.equal(context.skuIndex.get("SKU-A")?.[0]._id, "1:100:0");
  assert.equal(context.catalogById.get("1:100:0")?._id, "1:100:0");
});

// ---- getInventoryPeriodState — reuse jakartaCurrentPeriod (lib/olsera-financial-core.ts), tidak membuat timezone kedua ----

test("getInventoryPeriodState: bulan sebelum bulan berjalan -> historical", () => {
  const now = new Date("2026-08-15T00:00:00Z");
  assert.equal(getInventoryPeriodState(2026, 7, now), "historical");
  assert.equal(getInventoryPeriodState(2026, 2, now), "historical");
  assert.equal(getInventoryPeriodState(2025, 12, now), "historical");
});

test("getInventoryPeriodState: bulan yang sama dengan bulan berjalan (Asia/Jakarta) -> current", () => {
  // 2026-08-15T20:00:00Z = 2026-08-16 03:00 WIB, TETAP bulan Agustus di kedua zona (aman dari boundary UTC vs WIB).
  const now = new Date("2026-08-15T20:00:00Z");
  assert.equal(getInventoryPeriodState(2026, 8, now), "current");
});

test("getInventoryPeriodState: bulan setelah bulan berjalan -> future, TIDAK PERNAH dianggap current/historical", () => {
  const now = new Date("2026-08-15T00:00:00Z");
  assert.equal(getInventoryPeriodState(2026, 9, now), "future");
  assert.equal(getInventoryPeriodState(2027, 1, now), "future");
});
