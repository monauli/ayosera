import assert from "node:assert/strict";
import { test } from "node:test";
import { FEBRUARY_HISTORICAL_SOURCE } from "./february-historical-source.ts";

test("built-in February source is 31/17/48 and preserves required evidence", () => {
  const sold = new Set(FEBRUARY_HISTORICAL_SOURCE.sold.map((row) => row.product));
  const overall = FEBRUARY_HISTORICAL_SOURCE.overall;
  assert.equal(sold.size, 31);
  assert.equal(overall.length, 48);
  assert.equal(new Set(overall.map((row) => row.product)).size, 48);
  assert.deepEqual(overall.find((row) => row.product === "BOLA PADEL ODEA")?.opening, 96);
  assert.deepEqual(overall.find((row) => row.product.includes("SM-J035"))?.closing, 15);
  assert.ok(overall.some((row) => row.product.includes("XPLO COMFORT")));
  assert.ok(overall.some((row) => row.product.includes("ODEA")));
});
