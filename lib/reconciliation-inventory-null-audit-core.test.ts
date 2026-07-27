import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyField,
  classifyProductId,
  isMissingIdentity,
  validateDateArg,
  validateStoreIdArg,
} from "./reconciliation-inventory-null-audit-core.ts";

// ---- classifyProductId ------------------------------------------------------

test("classifyProductId: productId null -> 'null'", () => {
  assert.equal(classifyProductId({ productId: null }), "null");
});

test("classifyProductId: field productId tidak ada sama sekali -> 'absent'", () => {
  assert.equal(classifyProductId({ _id: "sale:1" }), "absent");
});

test("classifyProductId: productId string kosong -> 'empty-string'", () => {
  assert.equal(classifyProductId({ productId: "" }), "empty-string");
  assert.equal(classifyProductId({ productId: "   " }), "empty-string");
});

test("classifyProductId: productId number valid -> 'ok-number'", () => {
  assert.equal(classifyProductId({ productId: 116138490 }), "ok-number");
  assert.equal(classifyProductId({ productId: 0 }), "ok-number");
});

test("classifyProductId: productId bertipe tak terduga (string non-kosong/boolean/object) -> 'unexpected-type'", () => {
  assert.equal(classifyProductId({ productId: "116138490" }), "unexpected-type");
  assert.equal(classifyProductId({ productId: true }), "unexpected-type");
  assert.equal(classifyProductId({ productId: { $oid: "x" } }), "unexpected-type");
});

// ---- isMissingIdentity -------------------------------------------------------

test("isMissingIdentity: hanya 'ok-number' yang dianggap TIDAK hilang", () => {
  assert.equal(isMissingIdentity("ok-number"), false);
  assert.equal(isMissingIdentity("null"), true);
  assert.equal(isMissingIdentity("absent"), true);
  assert.equal(isMissingIdentity("empty-string"), true);
  assert.equal(isMissingIdentity("unexpected-type"), true);
});

// ---- classifyField (variantId/sku — informasi tambahan, bukan penentu utama) --

test("classifyField: variantId hilang TIDAK dianggap sebagai productId null (field berbeda, dicatat terpisah)", () => {
  // Dokumen dengan productId valid tapi variantId absent -> productId TETAP ok-number,
  // variantId diklasifikasi terpisah (informasi tambahan saja, bukan pemicu "missing identity").
  const doc = { productId: 100 };
  assert.equal(classifyProductId(doc), "ok-number");
  assert.equal(classifyField(doc, "variantId"), "absent");
});

test("classifyField: null/empty-string/present terdeteksi benar", () => {
  assert.equal(classifyField({ sku: null }, "sku"), "null");
  assert.equal(classifyField({ sku: "" }, "sku"), "empty-string");
  assert.equal(classifyField({ sku: "SKU-1" }, "sku"), "present");
  assert.equal(classifyField({}, "sku"), "absent");
});

// ---- validateDateArg / validateStoreIdArg ------------------------------------

test("validateDateArg: menerima YYYY-MM-DD, menolak format lain", () => {
  assert.equal(validateDateArg("2026-05-01", "--from"), "2026-05-01");
  assert.throws(() => validateDateArg("2026-05", "--from"), /--from tidak valid/);
  assert.throws(() => validateDateArg("2026/05/01", "--from"), /--from tidak valid/);
});

test("validateStoreIdArg: menolak null/negatif/nol/bukan integer", () => {
  assert.equal(validateStoreIdArg(324175), 324175);
  assert.throws(() => validateStoreIdArg(null), /storeId tidak valid/);
  assert.throws(() => validateStoreIdArg(0), /storeId tidak valid/);
  assert.throws(() => validateStoreIdArg(-1), /storeId tidak valid/);
  assert.throws(() => validateStoreIdArg(1.5), /storeId tidak valid/);
});
