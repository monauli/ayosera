import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const panel = readFileSync(fileURLToPath(new URL("../components/olsera-validation-panel.tsx", import.meta.url)), "utf8");
test("aksi recovery manual dan request client Auto Fix dihapus", () => {
  assert.doesNotMatch(panel, /Auto Fix Semua|autoFixSemua|AUTO_FIX_SOURCES|\/api\/private\/integration-monitor/);
});
