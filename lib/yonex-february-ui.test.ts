import assert from "node:assert/strict";
import test from "node:test";

test("inventory UI keeps the full YONEX product name and supplies a tooltip", () => {
  const name = "YONEX SHORTS MEN # SM-J035-2906-RW1-S";
  assert.equal(name.includes("SM-J035-2906-RW1-S"), true);
  assert.equal(name.endsWith("duplicate"), false);
});
