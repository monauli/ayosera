// Regression test paste dari Excel — Coretax Fase 1.
// Jalankan: node --no-warnings --experimental-strip-types --test lib/coretax/paste-parser.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { CORETAX_MODULES } from "./modules.ts";
import { detectHeaderRow, parsePastedRows, splitPastedGrid } from "./paste-parser.ts";

const bpuFields = CORETAX_MODULES.bpu.fields;

test("1. paste satu baris (tanpa header) -> satu baris data, kolom mengikuti posisi dari sel terpilih", () => {
  const text = "6\t2026\t3172024806201234\t3172024806201234000000";
  const rows = parsePastedRows(text, bpuFields, 0);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    TaxPeriodMonth: "6",
    TaxPeriodYear: "2026",
    CounterpartTin: "3172024806201234",
    IDPlaceOfBusinessActivityOfIncomeRecipient: "3172024806201234000000",
  });
});

test("2. paste banyak baris (tanpa header) -> tiap baris teks jadi satu baris data", () => {
  const text = ["1\t2026\tAAA", "2\t2026\tBBB", "3\t2026\tCCC"].join("\n");
  const rows = parsePastedRows(text, bpuFields, 0);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].TaxPeriodMonth, "1");
  assert.equal(rows[1].TaxPeriodMonth, "2");
  assert.equal(rows[2].CounterpartTin, "CCC");
});

test("3. paste dengan header (baris pertama header dikenal) -> baris header TIDAK masuk data, kolom dipetakan berdasarkan nama", () => {
  // Header sengaja urutan ACAK (bukan urutan XML) — memaksa mode nama, bukan posisi.
  const text = ["Tahun Pajak\tMasa Pajak\tNPWP/NIK", "2026\t6\t3172024806201234"].join("\n");
  const rows = parsePastedRows(text, bpuFields, 0);
  assert.equal(rows.length, 1, "baris header tidak boleh ikut jadi baris data");
  assert.equal(rows[0].TaxPeriodYear, "2026");
  assert.equal(rows[0].TaxPeriodMonth, "6");
  assert.equal(rows[0].CounterpartTin, "3172024806201234");
});

test("3b. header dikenali lewat headerAlias, bukan hanya label utama", () => {
  const text = ["NPWP\tDPP", "3172024806201234\t10000"].join("\n");
  const rows = parsePastedRows(text, bpuFields, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].CounterpartTin, "3172024806201234");
  assert.equal(rows[0].TaxBase, "10000");
});

test("4. paste tanpa header -> mode posisi kolom dipakai, dimulai dari startFieldIndex (sel yang sedang dipilih)", () => {
  const text = "24-104-06\t10000\t20";
  const rows = parsePastedRows(text, bpuFields, 5); // mulai dari TaxObjectCode (index 5)
  assert.equal(rows.length, 1);
  assert.equal(rows[0].TaxObjectCode, "24-104-06");
  assert.equal(rows[0].TaxBase, "10000");
  assert.equal(rows[0].Rate, "20");
});

test("5. nol di depan TIDAK hilang saat parsing paste (NPWP/NITKU sebagai teks, bukan angka)", () => {
  const text = "021234567891234\t000000";
  const rows = parsePastedRows(text, bpuFields, 2); // CounterpartTin, IDPlaceOfBusinessActivityOfIncomeRecipient
  assert.equal(rows[0].CounterpartTin, "021234567891234");
  assert.equal(rows[0].IDPlaceOfBusinessActivityOfIncomeRecipient, "000000");
});

test("splitPastedGrid: pisah TSV jadi grid, baris kosong trailing dibuang", () => {
  const grid = splitPastedGrid("a\tb\nc\td\n\n");
  assert.deepEqual(grid, [["a", "b"], ["c", "d"]]);
});

test("splitPastedGrid: normalisasi CRLF dari Excel Windows", () => {
  const grid = splitPastedGrid("a\tb\r\nc\td\r\n");
  assert.deepEqual(grid, [["a", "b"], ["c", "d"]]);
});

test("detectHeaderRow: baris data yang kebetulan mirip header tidak salah terdeteksi bila tidak ada sel yang cocok referensi", () => {
  assert.equal(detectHeaderRow(["6", "2026", "3172024806201234"], bpuFields), false);
});

test("detectHeaderRow: satu sel cocok header (case-insensitive) sudah cukup", () => {
  assert.equal(detectHeaderRow(["masa pajak", "tahun pajak"], bpuFields), true);
});

test("paste ke kolom di luar jangkauan field (posisi) diabaikan, tidak error", () => {
  const text = "a\tb\tc\td\te\tf\tg\th\ti\tj\tk\tl\tm\tn\to\tp\tq\tr";
  const rows = parsePastedRows(text, bpuFields, 0);
  assert.equal(rows.length, 1);
  assert.equal(Object.keys(rows[0]).length, bpuFields.length);
});

test("baris kosong pada teks yang di-paste (di tengah, bukan trailing) tetap jadi satu baris data kosong", () => {
  const text = ["1\t2026", "", "2\t2026"].join("\n");
  const rows = parsePastedRows(text, bpuFields, 0);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].TaxPeriodMonth, "");
});
