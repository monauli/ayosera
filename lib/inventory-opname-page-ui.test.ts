import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const page = readFileSync(fileURLToPath(new URL("../app/reconciliation/inventory/page.tsx", import.meta.url)), "utf8");

test("periode Februari tidak menampilkan alur BA dan tidak mengunci otomatis", () => {
  assert.match(page, /const showBaFlow = !isFebruaryHistoricalFinal/);
  assert.match(page, /onClick=\{\(\) => void lockPeriod\(\)\}/);
  assert.doesNotMatch(page, /useEffect\(\(\) => .*lockPeriod/);
});

test("ringkasan inventori memakai format sederhana Cocok", () => {
  assert.match(page, /\{liveSummary\.cocok\}\/\{liveSummary\.totalProduk\} Cocok/);
  assert.doesNotMatch(page, /Ada Pergerakan:|Diverifikasi:|Status Kelengkapan:|Total Produk:|Status Periode:/);
});

test("status Butuh Adjust Manual disembunyikan untuk Februari", () => {
  assert.match(page, /!isFebruaryHistoricalFinal \? \[\[\"Butuh Adjust Manual\"/);
});
