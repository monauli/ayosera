import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeExcelCellValue, sanitizeExcelText } from "./excel-sanitization.ts";

test("sanitizeExcelText neutralizes formula prefixes, including leading whitespace", () => {
  assert.equal(sanitizeExcelText("=SUM(1,1)"), "'=SUM(1,1)");
  assert.equal(sanitizeExcelText("+CMD"), "'+CMD");
  assert.equal(sanitizeExcelText("-10+20"), "'-10+20");
  assert.equal(sanitizeExcelText("@SUM(A1:A2)"), "'@SUM(A1:A2)");
  assert.equal(sanitizeExcelText("  =SUM(1,1)"), "'  =SUM(1,1)");
  assert.equal(sanitizeExcelText("Teks normal"), "Teks normal");
  assert.equal(sanitizeExcelText(""), "");
});

test("sanitizeExcelCellValue leaves non-string Excel values unchanged", () => {
  assert.equal(sanitizeExcelCellValue(null), null);
  assert.equal(sanitizeExcelCellValue(undefined), undefined);
  assert.equal(sanitizeExcelCellValue(10), 10);
  assert.equal(sanitizeExcelCellValue(-10), -10);
  assert.equal(sanitizeExcelCellValue(150000.5), 150000.5);
  const formula = { formula: "SUM(A1:A2)", result: 3 };
  assert.equal(sanitizeExcelCellValue(formula), formula);
});
