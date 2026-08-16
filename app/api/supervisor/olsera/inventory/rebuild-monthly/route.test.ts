import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("rebuild endpoint is supervisor-only and accepts dryRun/write only", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /requireSupervisor/);
  assert.match(source, /body\.mode === "write"/);
  assert.match(source, /body\.mode === "dryRun"/);
  assert.match(source, /rebuildMonthlyInventory/);
});
