import assert from "node:assert/strict";
import test from "node:test";
import {
  BA_UNREAD_MESSAGE,
  computeOmittedAsMatchEdits,
  evaluateBaRow,
  isBaParseUnread,
  isDateWithinPeriod,
  matchBaItemToCatalog,
  shouldBlockFinalizeForBaRows,
  shouldBlockFinalizeForUnreadBa,
  type CatalogRow,
  type OmittedAsMatchRow,
} from "./inventory-ba-finalize-guard.ts";
import { normalizeInventoryBaName } from "./inventory-ba-parser.ts";

// Regresi bug produksi (BA Stock Opname Juli 2026): PDF berhasil diupload,
// parser menghasilkan 0 item -> aplikasi lama diam-diam menganggap SELURUH
// katalog "cocok" (BA_OMITTED_ASSUMED_MATCH), membuat tombol Finalisasi
// terlihat aman padahal BA belum benar-benar terbaca.

test("BA berhasil upload tapi 0 item terbaca -> isBaParseUnread true, WAJIB blokir finalisasi", () => {
  const outcome = { uploadSucceeded: true, itemsFound: 0 };
  assert.equal(isBaParseUnread(outcome), true);
  assert.equal(shouldBlockFinalizeForUnreadBa(outcome), true);
});

test("BA berhasil upload dan >=1 item terbaca -> tidak diblokir oleh guard unread", () => {
  const outcome = { uploadSucceeded: true, itemsFound: 7 };
  assert.equal(isBaParseUnread(outcome), false);
  assert.equal(shouldBlockFinalizeForUnreadBa(outcome), false);
});

test("pesan block sesuai spesifikasi produk", () => {
  assert.equal(BA_UNREAD_MESSAGE, "Item pada Berita Acara belum berhasil dibaca. Periksa file atau isi secara manual.");
});

// computeOmittedAsMatchEdits — pengganti checkbox baOnlyDifferencesConfirmed
// (state persisten yang bisa desync dari baItemsFound lewat cancelBaRead,
// lihat app/reconciliation/inventory/page.tsx) jadi aksi sekali-klik.

function omittedRow(overrides: Partial<OmittedAsMatchRow> & { productId: number }): OmittedAsMatchRow {
  return { variantId: null, physicalQty: null, systemClosingQty: 15, manualAdjust: false, note: null, ...overrides };
}

test("computeOmittedAsMatchEdits: baris eligible (physicalQty null, systemClosingQty ada, bukan manualAdjust) diisi Cocok", () => {
  const rows = [omittedRow({ productId: 1, systemClosingQty: 15 })];
  const next = computeOmittedAsMatchEdits(rows, {});
  assert.deepEqual(next["1:0"], { physicalQty: 15, note: null });
});

test("computeOmittedAsMatchEdits: baris manualAdjust TIDAK disentuh", () => {
  const rows = [omittedRow({ productId: 1, manualAdjust: true })];
  const next = computeOmittedAsMatchEdits(rows, {});
  assert.equal(next["1:0"], undefined);
});

test("computeOmittedAsMatchEdits: baris systemClosingQty null TIDAK disentuh (tidak ada angka sistem untuk diasumsikan)", () => {
  const rows = [omittedRow({ productId: 1, systemClosingQty: null })];
  const next = computeOmittedAsMatchEdits(rows, {});
  assert.equal(next["1:0"], undefined);
});

test("computeOmittedAsMatchEdits: baris yang SUDAH ada physicalQty (edit manual atau dari BA) TIDAK ditimpa", () => {
  const rows = [omittedRow({ productId: 1, systemClosingQty: 15 })];
  const existing = { "1:0": { physicalQty: 8, note: "Dibaca dari BA" } };
  const next = computeOmittedAsMatchEdits(rows, existing);
  assert.deepEqual(next["1:0"], { physicalQty: 8, note: "Dibaca dari BA" });
});

test("computeOmittedAsMatchEdits: BA gagal terbaca (itemsFound 0) TETAP mengisi baris eligible — tombol adalah konfirmasi manual supervisor, bukan hasil parsing BA", () => {
  const rows = [omittedRow({ productId: 1, systemClosingQty: 15 }), omittedRow({ productId: 2, manualAdjust: true }), omittedRow({ productId: 3, systemClosingQty: null })];
  const next = computeOmittedAsMatchEdits(rows, {});
  assert.deepEqual(next["1:0"], { physicalQty: 15, note: null });
  assert.equal(next["2:0"], undefined);
  assert.equal(next["3:0"], undefined);
});

test("computeOmittedAsMatchEdits: dipanggil 2x (klik tombol dua kali) idempotent — hasil kedua identik dengan hasil pertama", () => {
  const rows = [omittedRow({ productId: 1, systemClosingQty: 15 }), omittedRow({ productId: 2, systemClosingQty: null }), omittedRow({ productId: 3, manualAdjust: true })];
  const first = computeOmittedAsMatchEdits(rows, {});
  const second = computeOmittedAsMatchEdits(rows, first);
  assert.deepEqual(second, first);
});

test("computeOmittedAsMatchEdits: baris lain yang tidak eligible TIDAK ikut membuat entri kosong di edits", () => {
  const rows = [omittedRow({ productId: 1, systemClosingQty: null }), omittedRow({ productId: 2, manualAdjust: true })];
  const next = computeOmittedAsMatchEdits(rows, {});
  assert.deepEqual(next, {});
});

const catalog: CatalogRow[] = [
  { productId: 1, variantId: null, productName: "YONEX AC102", productSku: "YX-AC102" },
  { productId: 2, variantId: null, productName: "ODEA RED" },
  { productId: 3, variantId: null, productName: "ODEA ROSE" },
  { productId: 4, variantId: 10, productName: "NESTLE PURE LIFE 1500ML" },
  { productId: 5, variantId: 20, productName: "NESTLE PURE LIFE 1500ML" }, // duplikat nama sengaja (varian berbeda) untuk uji ambigu
];

test("matchBaItemToCatalog: cocok tunggal -> MATCHED", () => {
  const result = matchBaItemToCatalog("YONEX AC102", catalog, normalizeInventoryBaName);
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") assert.equal(result.row.productId, 1);
});

test("matchBaItemToCatalog: ODEA RED dan ODEA ROSE tidak saling tertukar", () => {
  const red = matchBaItemToCatalog("ODEA RED", catalog, normalizeInventoryBaName);
  const rose = matchBaItemToCatalog("ODEA ROSE", catalog, normalizeInventoryBaName);
  assert.equal(red.kind, "MATCHED");
  assert.equal(rose.kind, "MATCHED");
  if (red.kind === "MATCHED" && rose.kind === "MATCHED") {
    assert.equal(red.row.productId, 2);
    assert.equal(rose.row.productId, 3);
  }
});

test("matchBaItemToCatalog: nama ambigu (>1 baris katalog cocok) -> AMBIGUOUS, TIDAK auto-pilih", () => {
  const result = matchBaItemToCatalog("NESTLE PURE LIFE 1500ML", catalog, normalizeInventoryBaName);
  assert.equal(result.kind, "AMBIGUOUS");
  if (result.kind === "AMBIGUOUS") assert.equal(result.candidates.length, 2);
});

test("matchBaItemToCatalog: tidak ada yang cocok -> NO_MATCH", () => {
  const result = matchBaItemToCatalog("PRODUK TIDAK DIKENAL", catalog, normalizeInventoryBaName);
  assert.equal(result.kind, "NO_MATCH");
});

// ---------------------------------------------------------------------------
// Fuzzy match (tier 4, hanya dipakai bila SKU dan nama exact tidak menemukan
// apa pun) + evaluasi selisih dua lapis (CEK A aritmetika cetak, CEK B stok
// sistem BA vs stok sistem AYOSERA) + guard blokir finalisasi per baris BA.
// ---------------------------------------------------------------------------

test("matchBaItemToCatalog: variasi spasi kecil (fuzzy tier) tetap MATCHED via fuzzy, bukan NO_MATCH", () => {
  const result = matchBaItemToCatalog("NESTLE  PURE  LIFE 600ML", [{ productId: 9, variantId: null, productName: "NESTLE PURE LIFE 600ML" }], normalizeInventoryBaName);
  // Normalisasi sudah menghilangkan spasi ganda -> ini sebenarnya exact-name juga, tapi memverifikasi tier fuzzy tidak dibutuhkan di sini dan tidak salah pilih.
  assert.equal(result.kind, "MATCHED");
});

test("matchBaItemToCatalog: ODEA RED dan ODEA ROSE TIDAK PERNAH fuzzy-cross-match satu sama lain walau hanya beda satu kata", () => {
  const onlyRose: CatalogRow[] = [{ productId: 3, variantId: null, productName: "ODEA ROSE" }];
  const result = matchBaItemToCatalog("ODEA RED", onlyRose, normalizeInventoryBaName);
  assert.equal(result.kind, "NO_MATCH", "ODEA RED vs katalog yang hanya berisi ODEA ROSE harus NO_MATCH, bukan fuzzy-matched ke ODEA ROSE");
});

test("evaluateBaRow: match kuat + selisih arithmetic OK + stok sistem cutoff sama -> COCOK", () => {
  const evaluation = evaluateBaRow(
    { description: "ODEA RED", systemQty: 45, physicalQty: 47, differenceQty: 2, arithmeticStatus: "OK" },
    catalog,
    normalizeInventoryBaName,
    45,
  );
  assert.equal(evaluation.status, "COCOK");
  assert.equal(evaluation.matchedProduct?.productId, 2);
});

test("evaluateBaRow: arithmetic BA sendiri tidak konsisten (CEK A gagal) -> PERLU_DICEK walau produk cocok", () => {
  const evaluation = evaluateBaRow(
    { description: "ODEA RED", systemQty: 45, physicalQty: 47, differenceQty: 0, arithmeticStatus: "PERLU_DICEK" },
    catalog,
    normalizeInventoryBaName,
    45,
  );
  assert.equal(evaluation.status, "PERLU_DICEK");
});

test("evaluateBaRow: stok sistem BA berbeda dari stok sistem AYOSERA pada cutoff (CEK B gagal) -> PERLU_DICEK, angka BA TIDAK ditulis ulang", () => {
  const evaluation = evaluateBaRow(
    { description: "ODEA RED", systemQty: 45, physicalQty: 47, differenceQty: 2, arithmeticStatus: "OK" },
    catalog,
    normalizeInventoryBaName,
    50, // stok sistem AYOSERA sendiri berbeda dari 45 yang tercetak di BA
  );
  assert.equal(evaluation.status, "PERLU_DICEK");
  assert.ok(evaluation.reasons.some((r) => r.includes("berbeda dari stok sistem AYOSERA")));
});

test("evaluateBaRow: tidak ada produk katalog yang cocok -> TIDAK_DITEMUKAN", () => {
  const evaluation = evaluateBaRow({ description: "PRODUK ASING", systemQty: 1, physicalQty: 1, differenceQty: 0, arithmeticStatus: "OK" }, catalog, normalizeInventoryBaName, null);
  assert.equal(evaluation.status, "TIDAK_DITEMUKAN");
});

// ---------------------------------------------------------------------------
// Tier suffix generik (BA menulis nama TANPA prefix kategori katalog) —
// iterasi ini. Kasus nyata: YONEX AC102/ODEA RED/ODEA ROSE, plus satu
// kategori SINTETIS ("CATEGORY X") untuk membuktikan logikanya generik,
// bukan daftar kata kategori hardcode.
// ---------------------------------------------------------------------------

const prefixCatalog: CatalogRow[] = [
  { productId: 101, variantId: null, productName: "GRIP YONEX AC102" },
  { productId: 102, variantId: null, productName: "BOLA PADEL ODEA RED" },
  { productId: 103, variantId: null, productName: "BOLA PADEL ODEA ROSE" },
  { productId: 104, variantId: null, productName: "CATEGORY X WIDGET PRO" },
];

test("matchBaItemToCatalog: 'YONEX AC102' cocok kuat dengan katalog 'GRIP YONEX AC102' (prefix kategori generik dilepas)", () => {
  const result = matchBaItemToCatalog("YONEX AC102", prefixCatalog, normalizeInventoryBaName);
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") {
    assert.equal(result.row.productId, 101);
    assert.equal(result.via, "suffix");
  }
});

test("matchBaItemToCatalog: 'ODEA RED' cocok kuat dengan katalog 'BOLA PADEL ODEA RED'", () => {
  const result = matchBaItemToCatalog("ODEA RED", prefixCatalog, normalizeInventoryBaName);
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") assert.equal(result.row.productId, 102);
});

test("matchBaItemToCatalog: 'ODEA ROSE' cocok kuat dengan katalog 'BOLA PADEL ODEA ROSE'", () => {
  const result = matchBaItemToCatalog("ODEA ROSE", prefixCatalog, normalizeInventoryBaName);
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") assert.equal(result.row.productId, 103);
});

test("matchBaItemToCatalog: tier suffix TIDAK PERNAH mempertukarkan ODEA RED <-> ODEA ROSE walau sama-sama punya prefix kategori", () => {
  const red = matchBaItemToCatalog("ODEA RED", prefixCatalog, normalizeInventoryBaName);
  const rose = matchBaItemToCatalog("ODEA ROSE", prefixCatalog, normalizeInventoryBaName);
  assert.equal(red.kind, "MATCHED");
  assert.equal(rose.kind, "MATCHED");
  if (red.kind === "MATCHED" && rose.kind === "MATCHED") {
    assert.notEqual(red.row.productId, rose.row.productId);
    assert.equal(red.row.productId, 102);
    assert.equal(rose.row.productId, 103);
  }
});

test("matchBaItemToCatalog: tier suffix GENERIK — kategori sintetis 'CATEGORY X' juga terdeteksi tanpa hardcode kata kategori apa pun", () => {
  const result = matchBaItemToCatalog("WIDGET PRO", prefixCatalog, normalizeInventoryBaName);
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") {
    assert.equal(result.row.productId, 104);
    assert.equal(result.via, "suffix");
  }
});

test("matchBaItemToCatalog: suffix tier ambigu (>1 katalog berakhir dengan token sama) -> AMBIGUOUS, tidak auto-pilih", () => {
  const ambiguousCatalog: CatalogRow[] = [
    { productId: 201, variantId: null, productName: "GRIP YONEX AC102" },
    { productId: 202, variantId: null, productName: "SENAR YONEX AC102" },
  ];
  const result = matchBaItemToCatalog("YONEX AC102", ambiguousCatalog, normalizeInventoryBaName);
  assert.equal(result.kind, "AMBIGUOUS");
});

test("evaluateBaRow: cutoffQueryFailed true -> PERLU_DICEK walau match kuat dan CEK A sudah OK (tidak pernah diam-diam Cocok)", () => {
  const evaluation = evaluateBaRow(
    { description: "YONEX AC102", systemQty: 10, physicalQty: 9, differenceQty: -1, arithmeticStatus: "OK" },
    prefixCatalog,
    normalizeInventoryBaName,
    null,
    { cutoffQueryFailed: true },
  );
  assert.equal(evaluation.status, "PERLU_DICEK");
  assert.ok(evaluation.reasons.some((r) => r.includes("Gagal mengambil stok sistem AYOSERA")));
});

test("evaluateBaRow: systemStockAtCutoff null (produk tidak ditemukan pada hasil query, TANPA error) -> PERLU_DICEK, bukan Cocok diam-diam", () => {
  const evaluation = evaluateBaRow(
    { description: "YONEX AC102", systemQty: 10, physicalQty: 10, differenceQty: 0, arithmeticStatus: "OK" },
    prefixCatalog,
    normalizeInventoryBaName,
    null,
  );
  assert.equal(evaluation.status, "PERLU_DICEK");
  assert.ok(evaluation.reasons.some((r) => r.includes("tidak ditemukan untuk produk ini")));
});

test("evaluateBaRow: match via suffix + stok cutoff sama + CEK A OK -> COCOK", () => {
  const evaluation = evaluateBaRow(
    { description: "YONEX AC102", systemQty: 10, physicalQty: 9, differenceQty: -1, arithmeticStatus: "OK" },
    prefixCatalog,
    normalizeInventoryBaName,
    10,
  );
  assert.equal(evaluation.status, "COCOK");
  assert.equal(evaluation.matchedProduct?.productId, 101);
  assert.equal(evaluation.matchedVia, "suffix");
});

test("shouldBlockFinalizeForBaRows: blokir bila ADA satu saja baris bukan COCOK", () => {
  assert.equal(shouldBlockFinalizeForBaRows([{ status: "COCOK" }, { status: "PERLU_DICEK" }]), true);
  assert.equal(shouldBlockFinalizeForBaRows([{ status: "COCOK" }, { status: "TIDAK_DITEMUKAN" }]), true);
  assert.equal(shouldBlockFinalizeForBaRows([{ status: "COCOK" }, { status: "COCOK" }]), false);
  assert.equal(shouldBlockFinalizeForBaRows([]), false);
});

test("isDateWithinPeriod: cutoff di dalam periode -> true; di luar periode -> false; null -> false (fail-safe)", () => {
  assert.equal(isDateWithinPeriod("2026-07-16", "2026-07-01", "2026-07-16"), true);
  assert.equal(isDateWithinPeriod("2026-07-01", "2026-07-01", "2026-07-16"), true);
  assert.equal(isDateWithinPeriod("2026-07-17", "2026-07-01", "2026-07-16"), false);
  assert.equal(isDateWithinPeriod("2026-06-30", "2026-07-01", "2026-07-16"), false);
  assert.equal(isDateWithinPeriod(null, "2026-07-01", "2026-07-16"), false);
  assert.equal(isDateWithinPeriod("2026-07-16", null, "2026-07-16"), false);
});
