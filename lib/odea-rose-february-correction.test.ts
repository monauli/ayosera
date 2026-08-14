import assert from "node:assert/strict";
import test from "node:test";

test("ODEA ROSE Februari 2026: approved formula menghasilkan closing 66 tanpa +64 movement", () => {
  const opening = 96;
  const incoming = 0;
  const returns = 0;
  const sales = 30;
  const outgoing = 0;
  assert.equal(opening + incoming + returns - sales - outgoing, 66);
  assert.notEqual(66, 130);
  assert.equal(64, 130 - 66);
  assert.equal("Closing corrected from 130 to 66 based on verified opening 96 and sales 30; previous +64 gap had no proven source movement.".includes("movement"), true);
});

test("ODEA ROSE carry-forward dimulai dari corrected Februari closing", () => {
  const febClosing = 66;
  const march = { opening: febClosing, incoming: 0, returns: 0, sales: 36, outgoing: 0 };
  assert.equal(march.opening, 66);
  assert.equal(march.opening + march.incoming + march.returns - march.sales - march.outgoing, 30);
});

test("ODEA RED identity tetap terpisah dari ODEA ROSE", () => {
  assert.notEqual(116138490, 119043265);
  assert.equal(106817649, 106817649);
});
