import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("endpoint backfill supervisor memiliki guard write dan tidak memiliki delete", async () => {
  const source = await readFile(new URL("../app/api/supervisor/ayo-payment-events/backfill/route.ts", import.meta.url), "utf8");
  assert.match(source, /requireSupervisor\(\)/);
  assert.match(source, /body\.dryRun === true/);
  assert.match(source, /assertBackfillWriteAllowed/);
  assert.match(source, /resolveStagingRange\(body\)/);
  assert.doesNotMatch(source, /month harus 2026-06 atau 2026-07/);
  assert.match(source, /bulkWrite/);
  assert.ok(source.indexOf("if (dryRun || status.validationStatus === \"invalid\")") < source.indexOf("await events.bulkWrite"));
  const stageSource = source.slice(source.indexOf('if (action === "stage")'), source.indexOf('if (action === "activate")'));
  assert.doesNotMatch(stageSource, /activation\.findOneAndUpdate/);
  assert.doesNotMatch(source, /deleteMany|deleteOne|drop\(/);
});
