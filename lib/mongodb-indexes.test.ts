import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("AYO payment collections do not request custom unique _id indexes", async () => {
  const source = await readFile(new URL("./mongodb.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ayoPaymentEvents\.createIndex\(\s*\{\s*_id\s*:\s*1\s*\}\s*,\s*\{\s*unique\s*:\s*true/);
  assert.doesNotMatch(source, /ayoPaymentPeriods\.createIndex\(\s*\{\s*_id\s*:\s*1\s*\}\s*,\s*\{\s*unique\s*:\s*true/);
  assert.match(source, /ayoPaymentEvents\.createIndex\(\{ bookingId: 1, date: 1 \}\)/);
});

test("AYO index initialization remains centralized and cached", async () => {
  const source = await readFile(new URL("./mongodb.ts", import.meta.url), "utf8");
  assert.match(source, /let indexesEnsured: Promise<void> \| null = null/);
  assert.match(source, /if \(!indexesEnsured\) \{[\s\S]*indexesEnsured = createIndexes\(\)/);
  assert.match(source, /ayoPaymentEvents: db\.collection/);
  assert.match(source, /ayoPaymentPeriods: db\.collection/);
});
