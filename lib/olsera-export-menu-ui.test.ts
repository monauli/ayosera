import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const menu = readFileSync(fileURLToPath(new URL("../components/redesign/olsera-export-menu.tsx", import.meta.url)), "utf8");

test("menu Export Olsera memakai token kontras light/dark yang tetap bekerja dari portal", () => {
  assert.match(menu, /text-\[rgb\(var\(--rd-text-secondary\)\)\]/);
  assert.match(menu, /text-\[rgb\(var\(--rd-text-tertiary\)\)\]/);
  assert.match(menu, /bg-\[rgb\(var\(--rd-surface\)\/var\(--rd-surface-alpha-strong\)\)\]/);
  assert.match(menu, /focus-visible:ring-2 focus-visible:ring-rose-500\/80/);
});

test("opsi LABERS tetap disabled di mode rentang, namun state disabled terbaca", () => {
  assert.match(menu, /disabled=\{!monthlyMode\}/);
  assert.match(menu, /disabled:opacity-60 disabled:text-\[rgb\(var\(--rd-text-tertiary\)\)\]/);
});
