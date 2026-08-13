import assert from "node:assert/strict";
import test from "node:test";
import { BA_UNREAD_MESSAGE, canApplyBaOmittedAssumedMatch, isBaParseUnread, matchBaItemToCatalog, shouldBlockFinalizeForUnreadBa, type CatalogRow } from "./inventory-ba-finalize-guard.ts";
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

test("BA_OMITTED_ASSUMED_MATCH TIDAK aktif ketika 0 item terbaca, WALAU checkbox 'BA hanya memuat item selisih' sudah dicentang", () => {
  assert.equal(canApplyBaOmittedAssumedMatch({ baOnlyDifferencesConfirmed: true, itemsFound: 0 }), false);
});

test("BA_OMITTED_ASSUMED_MATCH TIDAK aktif ketika checkbox belum dicentang, walau item terbaca", () => {
  assert.equal(canApplyBaOmittedAssumedMatch({ baOnlyDifferencesConfirmed: false, itemsFound: 7 }), false);
});

test("BA_OMITTED_ASSUMED_MATCH aktif HANYA ketika checkbox dicentang DAN minimal 1 item berhasil diparse", () => {
  assert.equal(canApplyBaOmittedAssumedMatch({ baOnlyDifferencesConfirmed: true, itemsFound: 7 }), true);
  assert.equal(canApplyBaOmittedAssumedMatch({ baOnlyDifferencesConfirmed: true, itemsFound: 1 }), true);
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
