import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("reconciliation inventory no longer exposes monthly rebuild controls", () => {
  const source = readFileSync(join(process.cwd(), "app/reconciliation/inventory/page.tsx"), "utf8");
  assert.doesNotMatch(source, /Bangun Ulang Inventori Bulanan|Periksa Dulu|rebuild-monthly|rebuildMonthlyInventory/);
});
