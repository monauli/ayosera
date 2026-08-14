import assert from "node:assert/strict";
import { test } from "node:test";
import { FEBRUARY_HISTORICAL_SOURCE } from "./february-historical-source.ts";
import { historicalDiagnostics } from "./olsera-historical-inventory-import.ts";

const diagnosticRow = (row: (typeof FEBRUARY_HISTORICAL_SOURCE.overall)[number], productId: number) => ({ productId, variantId: null, productName: row.product, productSku: null, groupName: row.group, openingQty: row.opening, incomingQty: row.incoming, returnQty: row.returnQty, salesQty: row.salesQty, outgoingQty: row.outgoingQty, closingQty: row.closing });

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
  const sniper = overall.find((row) => row.product === "Bullpadel Sniper 2.0 Power Light Blue 2026");
  const grip = overall.find((row) => row.product === "GRIP YONEX AC102");
  assert.deepEqual([sniper?.opening, sniper?.salesQty, sniper?.closing], [2, 1, 1]);
  assert.deepEqual([grip?.opening, grip?.incoming, grip?.closing], [0, 60, 60]);
  assert.equal(historicalDiagnostics(diagnosticRow(sniper!, 1)).length, 0);
  assert.equal(historicalDiagnostics(diagnosticRow(grip!, 2)).length, 0);
});
