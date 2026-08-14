import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("historical inventory route requires supervisor and validates period", () => {
  assert.match(source, /requireSupervisor\(\)/);
  assert.match(source, /actor\.role !== "supervisor"/);
  assert.match(source, /mode: z\.enum\(\["dry-run", "confirm"\]\)/);
  assert.match(source, /period: z\.string\(\)\.regex/);
});

test("historical import is idempotent and never locks the period", () => {
  assert.match(source, /bulkWrite\(/);
  assert.match(source, /upsert: true/);
  assert.doesNotMatch(source, /lockInventoryMonthlyPeriod/);
});
