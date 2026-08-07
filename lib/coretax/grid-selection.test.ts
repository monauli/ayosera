// Test engine seleksi grid — lihat docs/coretax.md "Cara Pakai Seperti Spreadsheet".
// Jalankan: node --no-warnings --experimental-strip-types --test lib/coretax/grid-selection.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRangeValues,
  extendSelection,
  fillDownValues,
  fillRightValues,
  isInRange,
  jumpToDataEdge,
  moveCell,
  normalizeRange,
  rangeCellCount,
  rangeToTsv,
} from "./grid-selection.ts";
import { CORETAX_MODULES, emptyCoretaxRowValues } from "./modules.ts";
import type { CoretaxRow } from "./types.ts";

const fields = CORETAX_MODULES.bpu.fields; // 15 kolom, cukup untuk uji navigasi/range.

function rowsOf(values: Record<string, string>[]): CoretaxRow[] {
  return values.map((v, i) => ({
    rowId: `r${i}`,
    values: { ...emptyCoretaxRowValues(CORETAX_MODULES.bpu), ...v },
    status: "belum-diperiksa" as const,
    errors: [],
  }));
}

// ---- 1. Arrow navigation ----
test("1. moveCell arrow pindah satu sel, diclamp ke batas grid", () => {
  assert.deepEqual(moveCell({ row: 1, col: 1 }, "down", 5, 15), { row: 2, col: 1 });
  assert.deepEqual(moveCell({ row: 0, col: 0 }, "up", 5, 15), { row: 0, col: 0 }, "tidak boleh keluar batas atas");
  assert.deepEqual(moveCell({ row: 4, col: 14 }, "right", 5, 15), { row: 4, col: 14 }, "tidak boleh keluar batas kanan");
});

// ---- 2/3. Tab/Shift+Tab & Enter/Shift+Enter memakai moveCell yang sama (left/right, up/down) ----
test("2. Tab = right, Shift+Tab = left", () => {
  assert.deepEqual(moveCell({ row: 0, col: 2 }, "right", 5, 15), { row: 0, col: 3 });
  assert.deepEqual(moveCell({ row: 0, col: 2 }, "left", 5, 15), { row: 0, col: 1 });
});

test("3. Enter = down, Shift+Enter = up", () => {
  assert.deepEqual(moveCell({ row: 2, col: 2 }, "down", 5, 15), { row: 3, col: 2 });
  assert.deepEqual(moveCell({ row: 2, col: 2 }, "up", 5, 15), { row: 1, col: 2 });
});

// ---- 4. Shift+Arrow memilih range ----
test("4. extendSelection memperluas focus, anchor tetap", () => {
  const range = { anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } };
  const extended = extendSelection(range, "down", 5, 15);
  assert.deepEqual(extended, { anchor: { row: 1, col: 1 }, focus: { row: 2, col: 1 } });
  assert.equal(isInRange({ row: 1, col: 1 }, extended), true);
  assert.equal(isInRange({ row: 2, col: 1 }, extended), true);
  assert.equal(isInRange({ row: 3, col: 1 }, extended), false);
});

test("normalizeRange bekerja walau anchor > focus", () => {
  const n = normalizeRange({ anchor: { row: 3, col: 3 }, focus: { row: 1, col: 1 } });
  assert.deepEqual(n, { top: 1, bottom: 3, left: 1, right: 3 });
});

// ---- 5. Ctrl+Shift+Down ----
test("5. jumpToDataEdge Ctrl+Shift+Down berhenti sebelum sel kosong berikutnya", () => {
  const rows = rowsOf([{ CounterpartTin: "1" }, { CounterpartTin: "2" }, {}, { CounterpartTin: "4" }]);
  const range = { anchor: { row: 0, col: 2 }, focus: { row: 0, col: 2 } };
  const result = jumpToDataEdge(range, "down", rows, fields, fields.length);
  assert.deepEqual(result.focus, { row: 1, col: 2 }, "berhenti di baris terakhir yang masih berisi sebelum baris kosong");
});

test("5b. jumpToDataEdge dari sel kosong loncat ke sel berisi data pertama", () => {
  const rows = rowsOf([{}, {}, { CounterpartTin: "3" }, { CounterpartTin: "4" }]);
  const range = { anchor: { row: 0, col: 2 }, focus: { row: 0, col: 2 } };
  const result = jumpToDataEdge(range, "down", rows, fields, fields.length);
  assert.deepEqual(result.focus, { row: 2, col: 2 });
});

test("5c. kolom kosong seluruhnya -> loncat ke baris terakhir grid", () => {
  const rows = rowsOf([{}, {}, {}]);
  const range = { anchor: { row: 0, col: 2 }, focus: { row: 0, col: 2 } };
  const result = jumpToDataEdge(range, "down", rows, fields, fields.length);
  assert.deepEqual(result.focus, { row: 2, col: 2 });
});

// ---- 6. Ctrl+Shift+Right ----
test("6. jumpToDataEdge arah kanan menghormati colCount", () => {
  const rows = rowsOf([{}]);
  const range = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } };
  const result = jumpToDataEdge(range, "right", rows, fields, fields.length);
  assert.equal(result.focus.col, fields.length - 1);
});

// ---- 7/8/9. Copy TSV ----
test("7. rangeToTsv satu sel", () => {
  const rows = rowsOf([{ CounterpartTin: "0012345678" }]);
  const tsv = rangeToTsv({ anchor: { row: 0, col: 2 }, focus: { row: 0, col: 2 } }, rows, fields);
  assert.equal(tsv, "0012345678", "nol depan tidak boleh hilang saat copy");
});

test("8. rangeToTsv satu kolom banyak baris", () => {
  const rows = rowsOf([{ CounterpartTin: "1" }, { CounterpartTin: "2" }, { CounterpartTin: "3" }]);
  const tsv = rangeToTsv({ anchor: { row: 0, col: 2 }, focus: { row: 2, col: 2 } }, rows, fields);
  assert.equal(tsv, "1\n2\n3");
});

test("9. rangeToTsv banyak kolom jadi TSV (tab-separated)", () => {
  const rows = rowsOf([{ CounterpartTin: "1", IDPlaceOfBusinessActivityOfIncomeRecipient: "A" }]);
  const tsv = rangeToTsv({ anchor: { row: 0, col: 2 }, focus: { row: 0, col: 3 } }, rows, fields);
  assert.equal(tsv, "1\tA");
});

// ---- 17. Delete selected range ----
test("17. clearRangeValues mengosongkan seluruh sel dalam range, posisi tetap", () => {
  const updates = clearRangeValues({ anchor: { row: 0, col: 0 }, focus: { row: 1, col: 1 } }, fields);
  assert.deepEqual(updates, [
    { row: 0, col: 0, value: "" },
    { row: 0, col: 1, value: "" },
    { row: 1, col: 0, value: "" },
    { row: 1, col: 1, value: "" },
  ]);
});

test("clearRangeValues memicu konfirmasi pada selection besar (>500 sel) — cek lewat rangeCellCount", () => {
  const big = { anchor: { row: 0, col: 0 }, focus: { row: 40, col: 14 } }; // 41*15 = 615
  assert.equal(rangeCellCount(big) > 500, true);
});

// ---- 18. Ctrl+D fill down ----
test("18. fillDownValues menyalin baris teratas ke bawah, satu & banyak kolom", () => {
  const rows = rowsOf([{ Rate: "5" }, {}, {}]);
  const updates = fillDownValues({ anchor: { row: 0, col: 7 }, focus: { row: 2, col: 7 } }, rows, fields);
  assert.deepEqual(updates, [
    { row: 1, col: 7, value: "5" },
    { row: 2, col: 7, value: "5" },
  ]);
});

test("18b. fillDownValues banyak kolom sekaligus", () => {
  const rows = rowsOf([{ Rate: "5", TaxBase: "1000" }, {}, {}]);
  const updates = fillDownValues({ anchor: { row: 0, col: 6 }, focus: { row: 2, col: 7 } }, rows, fields);
  assert.deepEqual(updates.filter((u) => u.col === 6).map((u) => u.value), ["1000", "1000"]);
  assert.deepEqual(updates.filter((u) => u.col === 7).map((u) => u.value), ["5", "5"]);
});

// ---- Ctrl+R fill right ----
test("fillRightValues menyalin kolom terkiri ke kanan", () => {
  const rows = rowsOf([{ Rate: "5" }]);
  const updates = fillRightValues({ anchor: { row: 0, col: 7 }, focus: { row: 0, col: 9 } }, rows, fields);
  assert.deepEqual(updates, [
    { row: 0, col: 8, value: "5" },
    { row: 0, col: 9, value: "5" },
  ]);
});
