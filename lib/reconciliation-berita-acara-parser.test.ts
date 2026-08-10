import assert from "node:assert/strict";
import test from "node:test";
import {
  parseIndonesianRupiah,
  parseBeritaAcaraText,
  matchBeritaAcaraToSystemDifference,
  MIN_OCR_CONFIDENCE,
} from "./reconciliation-berita-acara-parser.ts";

test("parseIndonesianRupiah: format Indonesia titik-ribuan diparse benar", () => {
  assert.equal(parseIndonesianRupiah("Rp740.000"), 740_000);
  assert.equal(parseIndonesianRupiah("Rp 740.000"), 740_000);
  assert.equal(parseIndonesianRupiah("Rp. 740.000,00"), 740_000);
  assert.equal(parseIndonesianRupiah("740.000"), 740_000);
  assert.equal(parseIndonesianRupiah("Rp1.234.567"), 1_234_567);
  assert.equal(parseIndonesianRupiah("bukan angka"), null);
  assert.equal(parseIndonesianRupiah("Rp0"), null);
});

// Skenario 4 — PENAMBAHAN terdeteksi benar
test("scenario 4: PENAMBAHAN terdeteksi", () => {
  const result = parseBeritaAcaraText("Berita Acara Rekonsiliasi\nTerdapat PENAMBAHAN sebesar Rp740.000 pada omzet Maret.\nAlasan: advance payment received in March recognized as March revenue");
  assert.equal(result.direction, "PENAMBAHAN");
  assert.equal(result.nominal, 740_000);
  assert.equal(result.status, "OK");
});

// Skenario 5 — PENGURANGAN terdeteksi benar
test("scenario 5: PENGURANGAN terdeteksi", () => {
  const result = parseBeritaAcaraText("Dilakukan PENGURANGAN sebesar Rp740.000 pada omzet April.\nAlasan: koreksi pengakuan pendapatan advance payment.");
  assert.equal(result.direction, "PENGURANGAN");
  assert.equal(result.nominal, 740_000);
  assert.equal(result.status, "OK");
});

// Skenario 6 — reason auto-filled dari teks dokumen asli, tidak dikarang
test("scenario 6: reason diambil dari field eksplisit 'Alasan:'", () => {
  const result = parseBeritaAcaraText("PENAMBAHAN Rp740.000.\nAlasan: advance payment received in March recognized as March revenue.");
  assert.equal(result.reason, "advance payment received in March recognized as March revenue");
});

test("reason fallback ke baris tempat nominal disebut bila tidak ada field eksplisit", () => {
  const result = parseBeritaAcaraText("Terjadi PENAMBAHAN Rp500.000 karena selisih pembulatan kasir.");
  assert.equal(result.direction, "PENAMBAHAN");
  assert.ok(result.reason?.includes("PENAMBAHAN Rp500.000"));
});

// Skenario 7 — Maret: +740000 sistem vs BA PENAMBAHAN 740000 -> COCOK
test("scenario 7: Maret systemDifference +740000 vs BA PENAMBAHAN 740000 -> COCOK", () => {
  const status = matchBeritaAcaraToSystemDifference(740_000, { nominal: 740_000, direction: "PENAMBAHAN" });
  assert.equal(status, "COCOK");
});

// Skenario 8 — April: -739999 sistem vs BA PENGURANGAN 740000 -> COCOK (toleransi Rp1)
test("scenario 8: April systemDifference -739999 vs BA PENGURANGAN 740000 -> COCOK (toleransi Rp1)", () => {
  const status = matchBeritaAcaraToSystemDifference(-739_999, { nominal: 740_000, direction: "PENGURANGAN" });
  assert.equal(status, "COCOK");
});

// Skenario 9 — selisih > Rp1 -> TIDAK_COCOK
test("scenario 9: selisih lebih dari Rp1 -> TIDAK_COCOK", () => {
  const status = matchBeritaAcaraToSystemDifference(740_000, { nominal: 741_500, direction: "PENAMBAHAN" });
  assert.equal(status, "TIDAK_COCOK");
});

// Skenario 10 — arah salah -> TIDAK_COCOK (walau nilai absolut sama persis)
test("scenario 10: arah salah -> TIDAK_COCOK meski nilai absolut identik", () => {
  const statusA = matchBeritaAcaraToSystemDifference(740_000, { nominal: 740_000, direction: "PENGURANGAN" });
  assert.equal(statusA, "TIDAK_COCOK");
  const statusB = matchBeritaAcaraToSystemDifference(-740_000, { nominal: 740_000, direction: "PENAMBAHAN" });
  assert.equal(statusB, "TIDAK_COCOK");
});

test("systemDifference nol tidak pernah cocok dengan arah manapun", () => {
  assert.equal(matchBeritaAcaraToSystemDifference(0, { nominal: 0, direction: "PENAMBAHAN" }), "TIDAK_COCOK");
  assert.equal(matchBeritaAcaraToSystemDifference(0, { nominal: 0, direction: "PENGURANGAN" }), "TIDAK_COCOK");
});

// Skenario 11 — OCR confidence rendah / field ambigu -> PERLU_REVIEW, bukan tebakan
test("scenario 11a: OCR confidence rendah memaksa PERLU_REVIEW walau field lain lengkap", () => {
  const result = parseBeritaAcaraText("PENAMBAHAN Rp740.000. Alasan: koreksi.", MIN_OCR_CONFIDENCE - 0.01);
  assert.equal(result.status, "PERLU_REVIEW");
  // Field yang berhasil dibaca tetap dilaporkan (untuk ditampilkan ke user untuk direview), bukan disembunyikan.
  assert.equal(result.nominal, 740_000);
});

test("scenario 11b: nominal tidak ditemukan -> PERLU_REVIEW", () => {
  const result = parseBeritaAcaraText("Dokumen tidak berisi nominal yang jelas.");
  assert.equal(result.status, "PERLU_REVIEW");
  assert.equal(result.nominal, null);
});

test("scenario 11c: dua arah disebut sekaligus (ambigu) -> direction null, PERLU_REVIEW", () => {
  const result = parseBeritaAcaraText("Ada PENAMBAHAN dan PENGURANGAN pada dokumen ini, nominal Rp100.000.");
  assert.equal(result.direction, null);
  assert.equal(result.status, "PERLU_REVIEW");
});

// Kasus toleransi Rp1 lengkap (9 kasus) — 6 harus COCOK, 3 harus TIDAK_COCOK.
test("matcher: 9 kasus toleransi Rp1 dengan arah wajib", () => {
  assert.equal(matchBeritaAcaraToSystemDifference(740_000, { nominal: 740_000, direction: "PENAMBAHAN" }), "COCOK");
  assert.equal(matchBeritaAcaraToSystemDifference(739_999, { nominal: 740_000, direction: "PENAMBAHAN" }), "COCOK");
  assert.equal(matchBeritaAcaraToSystemDifference(740_001, { nominal: 740_000, direction: "PENAMBAHAN" }), "COCOK");
  assert.equal(matchBeritaAcaraToSystemDifference(-740_000, { nominal: 740_000, direction: "PENGURANGAN" }), "COCOK");
  assert.equal(matchBeritaAcaraToSystemDifference(-739_999, { nominal: 740_000, direction: "PENGURANGAN" }), "COCOK");
  assert.equal(matchBeritaAcaraToSystemDifference(-740_001, { nominal: 740_000, direction: "PENGURANGAN" }), "COCOK");
  assert.equal(matchBeritaAcaraToSystemDifference(739_998, { nominal: 740_000, direction: "PENAMBAHAN" }), "TIDAK_COCOK");
  assert.equal(matchBeritaAcaraToSystemDifference(-739_998, { nominal: 740_000, direction: "PENGURANGAN" }), "TIDAK_COCOK");
  assert.equal(matchBeritaAcaraToSystemDifference(740_000, { nominal: 740_000, direction: "PENGURANGAN" }), "TIDAK_COCOK");
});

test("matcher: nominal atau direction null -> PERLU_REVIEW, bukan TIDAK_COCOK", () => {
  assert.equal(matchBeritaAcaraToSystemDifference(740_000, { nominal: null, direction: "PENAMBAHAN" }), "PERLU_REVIEW");
  assert.equal(matchBeritaAcaraToSystemDifference(740_000, { nominal: 740_000, direction: null }), "PERLU_REVIEW");
});
