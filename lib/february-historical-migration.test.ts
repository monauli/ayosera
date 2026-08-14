import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("February historical cron migration claims a marker and never locks the period", () => {
    const source = readFileSync(new URL("./february-historical-migration.ts", import.meta.url), "utf8");
    assert.match(source, /februaryHistoricalImport/);
    assert.match(source, /status: "complete"/);
    assert.match(source, /sourceRevision/);
    assert.doesNotMatch(source, /lockInventoryMonthlyPeriod/);
});
