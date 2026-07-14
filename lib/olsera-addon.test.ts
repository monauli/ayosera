// Test unit normalisasi addon_price. Jalankan: npm run test:olsera-addon
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAddonPrice } from "./olsera-addon.ts";

test("null → 0, tanpa warning", () => {
  assert.deepEqual(parseAddonPrice(null), { value: 0, warning: null });
});

test("undefined → 0, tanpa warning", () => {
  assert.deepEqual(parseAddonPrice(undefined), { value: 0, warning: null });
});

test("addon_price = 0 (string) → 0, tanpa warning", () => {
  assert.deepEqual(parseAddonPrice("0.00"), { value: 0, warning: null });
});

test("addon_price = 0 (number) → 0, tanpa warning", () => {
  assert.deepEqual(parseAddonPrice(0), { value: 0, warning: null });
});

test("string angka valid (format Olsera) → number", () => {
  assert.equal(parseAddonPrice("10000.00").value, 10000);
  assert.equal(parseAddonPrice("2500.5").value, 2500.5);
});

test("string kosong → 0, tanpa warning", () => {
  assert.deepEqual(parseAddonPrice(""), { value: 0, warning: null });
  assert.deepEqual(parseAddonPrice("   "), { value: 0, warning: null });
});

test("number valid apa adanya", () => {
  assert.equal(parseAddonPrice(15000).value, 15000);
});

test("string tidak valid → 0 + warning, bukan NaN", () => {
  const result = parseAddonPrice("abc");
  assert.equal(result.value, 0);
  assert.ok(Number.isFinite(result.value));
  assert.ok(result.warning?.includes("abc"));
});

test("number NaN/Infinity → 0 + warning", () => {
  assert.equal(parseAddonPrice(Number.NaN).warning !== null, true);
  assert.equal(parseAddonPrice(Number.NaN).value, 0);
  assert.equal(parseAddonPrice(Number.POSITIVE_INFINITY).value, 0);
});

test("tipe tidak dikenal (object/array) → 0 + warning", () => {
  const result = parseAddonPrice({ foo: "bar" });
  assert.equal(result.value, 0);
  assert.ok(result.warning);
});
