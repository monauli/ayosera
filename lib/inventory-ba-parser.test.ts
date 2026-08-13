import assert from "node:assert/strict";
import test from "node:test";
import { extractInventoryBaPeriod, inventoryBaParseFailure, normalizeInventoryBaName, numberValue } from "./inventory-ba-parser.ts";

// ---------------------------------------------------------------------------
// V4 REWRITE: parser baris/text-stream lama (`parseInventoryBaText`,
// heuristik pendingPrefix/orphan-suffix) DIHAPUS SELURUHNYA — TERBUKTI salah
// secara struktural (BA Juli 2026: YONEX AC102 Sistem 10/Fisik 9/Selisih -1
// terbaca sebagai 201/350/+349, angka milik baris NESTLE PURE LIFE 1500ML).
// Rekonstruksi tabel sekarang dilakukan SPASIAL dari text item pdf.js
// (posisi X/Y) — lihat lib/inventory-ba-table-parser.ts dan
// lib/inventory-ba-table-parser.test.ts untuk regresi 7-baris lengkap
// (termasuk regresi utama YONEX AC102).
//
// File ini hanya menguji sisa helper murni yang TETAP di lib/inventory-ba-parser.ts:
// ekstraksi periode/cutoff dari teks bebas (tidak bergantung layout tabel,
// tidak pernah terbukti salah) dan fail-safe eksplisit untuk kasus tabel
// tidak bisa direkonstruksi secara spasial sama sekali.
// ---------------------------------------------------------------------------

test("extractInventoryBaPeriod: periode dan cutoff terbaca dari teks bebas", () => {
  const result = extractInventoryBaPeriod("Periode 01 Juli 2026 sampai 16 Juli 2026\nDitandatangani 17 Juli 2026");
  assert.equal(result.periodStart, "2026-07-01");
  assert.equal(result.cutoffDate, "2026-07-16");
});

test("extractInventoryBaPeriod: teks tanpa pola periode -> null (bukan tebakan)", () => {
  const result = extractInventoryBaPeriod("Dokumen tanpa informasi periode apa pun.");
  assert.equal(result.periodStart, null);
  assert.equal(result.cutoffDate, null);
});

test("numberValue: parse integer bertanda, tolak nilai bukan angka murni", () => {
  assert.equal(numberValue("10"), 10);
  assert.equal(numberValue("-1"), -1);
  assert.equal(numberValue("+2"), 2);
  assert.equal(numberValue("abc"), null);
  assert.equal(numberValue("10 pcs"), null);
});

test("normalizeInventoryBaName: uppercase, hilangkan karakter non-alfanumerik", () => {
  assert.equal(normalizeInventoryBaName("nestle  pure-life 1500ml"), "NESTLE PURE LIFE 1500ML");
});

// ---------------------------------------------------------------------------
// Fail-safe eksplisit (dipakai lib/inventory-ba-client.ts): tabel yang TIDAK
// BISA direkonstruksi secara spasial (mis. OCR plain text tanpa koordinat
// per kata pada PDF hasil scan) WAJIB menghasilkan 0 baris + PERLU_DICEK,
// TIDAK PERNAH jatuh ke parser baris teks lama yang terbukti salah.
// ---------------------------------------------------------------------------

test("inventoryBaParseFailure: 0 baris, status PERLU_DICEK, periode tetap dicoba dibaca (tidak bergantung tabel)", () => {
  const result = inventoryBaParseFailure("Periode 01 Juli 2026 sampai 16 Juli 2026\nYONEX AC102 pcs 10 9 -1");
  assert.equal(result.items.length, 0);
  assert.equal(result.status, "PERLU_DICEK");
  assert.equal(result.periodStart, "2026-07-01");
  assert.equal(result.cutoffDate, "2026-07-16");
});

test("inventoryBaParseFailure: teks kosong -> 0 baris, PERLU_DICEK, periode null", () => {
  const result = inventoryBaParseFailure("");
  assert.equal(result.items.length, 0);
  assert.equal(result.status, "PERLU_DICEK");
  assert.equal(result.periodStart, null);
  assert.equal(result.cutoffDate, null);
});
