import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeExcelCellValue, sanitizeExcelText } from "./excel-sanitization.ts";

test("sanitizeExcelText neutralizes the four formula-prefix characters, including leading whitespace", () => {
  assert.equal(sanitizeExcelText("=SUM(1,1)"), "'=SUM(1,1)");
  assert.equal(sanitizeExcelText("+CMD"), "'+CMD");
  assert.equal(sanitizeExcelText("-10+20"), "'-10+20");
  assert.equal(sanitizeExcelText("-1+1"), "'-1+1");
  assert.equal(sanitizeExcelText("@SUM(A1:A2)"), "'@SUM(A1:A2)");
  assert.equal(sanitizeExcelText("  =SUM(1,1)"), "'  =SUM(1,1)");
});

test("sanitizeExcelText neutralizes a leading tab/carriage return even without a formula char following (CSV-injection bypass)", () => {
  assert.equal(sanitizeExcelText("\tSUM(A1:A2)"), "'\tSUM(A1:A2)");
  assert.equal(sanitizeExcelText("\r=SUM(A1:A2)"), "'\r=SUM(A1:A2)");
  assert.equal(sanitizeExcelText("\tHello"), "'\tHello");
  assert.equal(sanitizeExcelText("\rHello"), "'\rHello");
});

test("sanitizeExcelText leaves normal text and edge-case strings untouched", () => {
  assert.equal(sanitizeExcelText("Teks normal"), "Teks normal");
  assert.equal(sanitizeExcelText(""), "");
  assert.equal(sanitizeExcelText("Raket Yonex Astrox 99 Pro - Kuning"), "Raket Yonex Astrox 99 Pro - Kuning");
});

test("sanitizeExcelText preserves Indonesian/Unicode product names unchanged", () => {
  assert.equal(sanitizeExcelText("Sepatu Bola Ukuran 42"), "Sepatu Bola Ukuran 42");
  assert.equal(sanitizeExcelText("Kategori: Minuman & Snack"), "Kategori: Minuman & Snack");
  assert.equal(sanitizeExcelText("Nasi Goreng Spesial 🍛"), "Nasi Goreng Spesial 🍛");
  assert.equal(sanitizeExcelText("Café René — édition"), "Café René — édition");
});

test("sanitizeExcelText is idempotent: sanitizing an already-sanitized value does not add a second escape", () => {
  const once = sanitizeExcelText("=SUM(1,1)");
  const twice = sanitizeExcelText(once);
  assert.equal(once, "'=SUM(1,1)");
  assert.equal(twice, once);
  assert.equal(sanitizeExcelText("'already-quoted-by-user"), "'already-quoted-by-user");
});

test("sanitizeExcelCellValue leaves non-string Excel values (numbers, dates, null/undefined, internal formulas) unchanged", () => {
  assert.equal(sanitizeExcelCellValue(null), null);
  assert.equal(sanitizeExcelCellValue(undefined), undefined);
  assert.equal(sanitizeExcelCellValue(10), 10);
  assert.equal(sanitizeExcelCellValue(-10), -10);
  assert.equal(sanitizeExcelCellValue(150000.5), 150000.5);
  const date = new Date("2026-07-30T00:00:00.000Z");
  assert.equal(sanitizeExcelCellValue(date), date);
  assert.equal(sanitizeExcelCellValue(date) instanceof Date, true);
  const formula = { formula: "SUM(A1:A2)", result: 3 };
  assert.equal(sanitizeExcelCellValue(formula), formula);
});

test("sanitizeExcelCellValue neutralizes dangerous string values the same way as sanitizeExcelText", () => {
  assert.equal(sanitizeExcelCellValue("=SUM(1,1)"), "'=SUM(1,1)");
  assert.equal(sanitizeExcelCellValue("+CMD"), "'+CMD");
  assert.equal(sanitizeExcelCellValue("-1+1"), "'-1+1");
  assert.equal(sanitizeExcelCellValue("@SUM(A1:A2)"), "'@SUM(A1:A2)");
  assert.equal(sanitizeExcelCellValue("\tpayload"), "'\tpayload");
  assert.equal(sanitizeExcelCellValue("\rpayload"), "'\rpayload");
});
