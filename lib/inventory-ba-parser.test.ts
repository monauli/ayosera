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

// ---------------------------------------------------------------------------
// Regresi bug produksi (BA Juli 2026): PDF asli 0 item terbaca. Root cause
// SEBENARNYA ada di lib/reconciliation-berita-acara-client-ocr.ts
// (extractPdfTextLayer menggabungkan seluruh tabel jadi satu baris tanpa
// newline, sudah diperbaiki dengan groupPdfTextItemsIntoLines berbasis
// posisi). Test di bawah membuktikan parser INI tetap benar begitu baris
// tabel sudah terpisah newline dengan benar (kontrak antara kedua modul),
// plus dua variasi nyata yang harus tetap tertangani: kolom No. di depan
// baris, dan nama produk yang wrap ke baris fisik terpisah.
// ---------------------------------------------------------------------------

test("BA Juli real-layout: kolom No. di depan tiap baris tetap terbaca generik (bukan ikut jadi bagian deskripsi)", () => {
  const result = parseInventoryBaText(
    `Periode 01 Juli 2026 sampai 16 Juli 2026\nNo Kelompok Barang Deskripsi Barang Satuan Stock Sistem Olsera Stock Fisik Aktual Selisih Keterangan\n1 YONEX AC102 pcs 10 9 -1\n2 NESTLE PURE LIFE 1500ML pcs 350 349 -1\n3 NESTLE PURE LIFE 600ML pcs 529 528 -1\n4 ODEA RED pcs 45 47 +2\n5 ODEA ROSE pcs 38 36 -2\n6 POCARI SWEAT PET 500 ML pcs 342 341 -1\n7 POCARI ION WATER 500ML pcs 202 201 -1\nDitandatangani 17 Juli 2026`,
  );
  assert.equal(result.periodStart, "2026-07-01");
  assert.equal(result.cutoffDate, "2026-07-16");
  assert.equal(result.items.length, 7);
  assert.equal(result.items[0].description, "YONEX AC102");
  assert.equal(result.items[0].systemQty, 10);
  assert.equal(result.items[0].physicalQty, 9);
  assert.equal(result.items[0].differenceQty, -1);
  assert.equal(result.status, "OK");
});

test("BA Juli real-layout: nama produk yang wrap ke baris fisik terpisah tetap digabung menjadi satu deskripsi", () => {
  const result = parseInventoryBaText(
    `Periode 01 Juli 2026 sampai 16 Juli 2026\nNESTLE PURE LIFE\n1500ML pcs 350 349 -1\nNESTLE PURE LIFE\n600ML pcs 529 528 -1\nPOCARI SWEAT PET\n500 ML pcs 342 341 -1`,
  );
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].description, "NESTLE PURE LIFE 1500ML");
  assert.equal(result.items[1].description, "NESTLE PURE LIFE 600ML");
  assert.equal(result.items[2].description, "POCARI SWEAT PET 500 ML");
});

test("BA Juli real-layout: ODEA RED dan ODEA ROSE dibedakan sebagai baris terpisah (tidak tertukar/gabung)", () => {
  const result = parseInventoryBaText(`Periode 01 Juli 2026 sampai 16 Juli 2026\nODEA RED pcs 45 47 +2\nODEA ROSE pcs 38 36 -2`);
  assert.equal(result.items.length, 2);
  const red = result.items.find((i) => i.description === "ODEA RED");
  const rose = result.items.find((i) => i.description === "ODEA ROSE");
  assert.ok(red, "ODEA RED harus ada sebagai baris sendiri");
  assert.ok(rose, "ODEA ROSE harus ada sebagai baris sendiri");
  assert.equal(red!.differenceQty, 2);
  assert.equal(rose!.differenceQty, -2);
});

// ---------------------------------------------------------------------------
// Regresi bug produksi kedua (BA Juli 2026, "6 dari 7 item terbaca" setelah
// fix pertama): ROOT CAUSE ditemukan lewat rekonstruksi layout realistis
// (BUKAN file PDF byte-asli — lihat catatan di AYOSERA-HANDOFF-LATEST.md).
// Sebagian tabel BA me-render TOP-ALIGNED: ketika nama produk wrap ke 2
// baris fisik, kolom Satuan/Stock Sistem/Stock Fisik/Selisih tetap muncul di
// baris fisik PERTAMA (sejajar bagian ATAS baris tabel), sehingga sisa nama
// produk (mis. "1500ML", "500 ML") muncul sebagai baris YATIM SETELAH angka
// — bukan SEBELUM angka seperti pola wrap yang sudah ditangani sebelumnya.
// Parser lama menganggap baris yatim itu sebagai prefix baris BERIKUTNYA
// (pola lama, prefix-only), sehingga nomor tiap baris tertukar/bercampur
// antar produk. Fix generik: baris yatim yang DIAWALI ANGKA (bukan huruf)
// setelah baris yang baru saja menghasilkan item digabung sebagai SUFFIX ke
// item tersebut — bukan prefix ke item berikutnya. Nama produk pada domain
// ini tidak pernah diawali angka mentah tanpa kolom No. yang jelas terpisah
// spasi+huruf (sudah ditangani terpisah), sehingga aturan ini generik.
// ---------------------------------------------------------------------------

test("BA Juli real-layout TOP-ALIGNED: kolom angka muncul di baris fisik pertama, sisa nama produk sebagai baris yatim SETELAH angka -> tetap 7 item, tidak ada yang hilang/tertukar", () => {
  const result = parseInventoryBaText(
    `Periode 01 Juli 2026 sampai 16 Juli 2026\nNo Kelompok Barang Deskripsi Barang Satuan Stock Sistem Olsera Stock Fisik Aktual Selisih Keterangan\n1 YONEX AC102 pcs 10 9 -1\n2 NESTLE PURE LIFE pcs 350 349 -1\n1500ML\n3 NESTLE PURE LIFE pcs 529 528 -1\n600ML\n4 ODEA RED pcs 45 47 +2\n5 ODEA ROSE pcs 38 36 -2\n6 POCARI SWEAT PET pcs 342 341 -1\n500 ML\n7 POCARI ION WATER pcs 202 201 -1\n500ML\nDitandatangani 17 Juli 2026`,
  );
  assert.equal(result.items.length, 7);
  assert.equal(result.status, "OK");
  const byDescription = new Map(result.items.map((i) => [i.description, i]));
  assert.ok(byDescription.has("YONEX AC102"));
  assert.deepEqual(
    [byDescription.get("NESTLE PURE LIFE 1500ML")?.systemQty, byDescription.get("NESTLE PURE LIFE 1500ML")?.physicalQty, byDescription.get("NESTLE PURE LIFE 1500ML")?.differenceQty],
    [350, 349, -1],
  );
  assert.deepEqual(
    [byDescription.get("NESTLE PURE LIFE 600ML")?.systemQty, byDescription.get("NESTLE PURE LIFE 600ML")?.physicalQty, byDescription.get("NESTLE PURE LIFE 600ML")?.differenceQty],
    [529, 528, -1],
  );
  assert.deepEqual(
    [byDescription.get("ODEA RED")?.systemQty, byDescription.get("ODEA RED")?.physicalQty, byDescription.get("ODEA RED")?.differenceQty],
    [45, 47, 2],
  );
  assert.deepEqual(
    [byDescription.get("ODEA ROSE")?.systemQty, byDescription.get("ODEA ROSE")?.physicalQty, byDescription.get("ODEA ROSE")?.differenceQty],
    [38, 36, -2],
  );
  assert.deepEqual(
    [byDescription.get("POCARI SWEAT PET 500 ML")?.systemQty, byDescription.get("POCARI SWEAT PET 500 ML")?.physicalQty, byDescription.get("POCARI SWEAT PET 500 ML")?.differenceQty],
    [342, 341, -1],
  );
  assert.deepEqual(
    [byDescription.get("POCARI ION WATER 500ML")?.systemQty, byDescription.get("POCARI ION WATER 500ML")?.physicalQty, byDescription.get("POCARI ION WATER 500ML")?.differenceQty],
    [202, 201, -1],
  );
});

test("BA seluruh tabel jadi satu baris raksasa (bug produksi asli, sebelum fix newline) -> 0 item, status PERLU_DICEK (fail-safe, bukan crash/salah tebak)", () => {
  const flattened =
    "Periode 01 Juli 2026 sampai 16 Juli 2026 No Kelompok Barang Deskripsi Barang Satuan Stock Sistem Olsera Stock Fisik Aktual Selisih Keterangan 1 YONEX AC102 pcs 10 9 -1 2 NESTLE PURE LIFE 1500ML pcs 350 349 -1";
  const result = parseInventoryBaText(flattened);
  assert.equal(result.periodStart, "2026-07-01");
  assert.equal(result.cutoffDate, "2026-07-16");
  assert.equal(result.items.length, 0);
  assert.equal(result.status, "PERLU_DICEK");
});
