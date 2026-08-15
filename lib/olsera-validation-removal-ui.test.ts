import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const page = readFileSync(fileURLToPath(new URL("../app/page.tsx", import.meta.url)), "utf8");
test("panel Validasi Data Olsera tidak lagi di-mount", () => {
  assert.doesNotMatch(page, /OlseraValidationPanel|Validasi Data Olsera|olsera-validation/);
});
