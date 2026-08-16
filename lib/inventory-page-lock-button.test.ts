import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("halaman Inventori biasa tidak merender tombol Kunci Periode", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Kunci Periode/);
});
