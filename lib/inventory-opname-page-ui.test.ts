import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const page = readFileSync(fileURLToPath(new URL("../app/reconciliation/inventory/page.tsx", import.meta.url)), "utf8");

test("alur BA tidak lagi dikunci hardcode Februari, dan tidak mengunci otomatis", () => {
  // Gate lama `!isFebruaryHistoricalFinal` dilepas: Februari 2026 justru periode
  // yang butuh BA fisik untuk memutuskan selisih terhadap FEBRUARY_HISTORICAL_SOURCE.
  assert.match(page, /const baFlowRelevant = needsBa \|\| Boolean\(attachment\) \|\| baRows\.length > 0;/);
  assert.doesNotMatch(page, /showBaFlow =/);
  assert.match(page, /\{baFlowRelevant && <section className="recon-filters recon-finalization"/);
  assert.match(page, /onClick=\{\(\) => void lockPeriod\(\)\}/);
  assert.doesNotMatch(page, /useEffect\(\(\) => .*lockPeriod/);
});

test("kolom Stok Berita Acara dan Selisih selalu dirender", () => {
  assert.match(page, /<th>Stok Berita Acara<\/th><th>Selisih<\/th>/);
  assert.doesNotMatch(page, /&& <><th>Stok Berita Acara/);
});

test("ringkasan inventori memakai format sederhana Cocok", () => {
  assert.match(page, /\{liveSummary\.cocok\}\/\{liveSummary\.totalProduk\} Cocok/);
  assert.doesNotMatch(page, /Ada Pergerakan:|Diverifikasi:|Status Kelengkapan:|Total Produk:|Status Periode:/);
});

test("status Butuh Adjust Manual disembunyikan untuk Februari", () => {
  assert.match(page, /!isFebruaryHistoricalFinal \? \[\[\"Butuh Adjust Manual\"/);
});
