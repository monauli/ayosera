// Verifikasi statis route API Modul Rekonsiliasi (Phase 5A): setiap route
// WAJIB memanggil requireModule("rekonsiliasi") sebelum apa pun, TIDAK ADA
// operasi mutasi (updateOne/updateMany/bulkWrite/insertOne/insertMany/
// deleteOne/deleteMany/findOneAndUpdate/dst), dan memakai NO_CACHE_HEADERS.
// Pola sama dengan lib/olsera-financial-export.test.ts (baca source, bukan
// menjalankan server Next.js sungguhan).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const ROUTES = [
  "../app/api/reconciliation/runs/route.ts",
  "../app/api/reconciliation/runs/[runId]/route.ts",
  "../app/api/reconciliation/findings/route.ts",
];

const MUTATION_PATTERN = /\.(updateOne|updateMany|bulkWrite|insertOne|insertMany|deleteOne|deleteMany|findOneAndUpdate|findOneAndReplace|findOneAndDelete|drop)\s*\(/;

test("seluruh route rekonsiliasi memanggil requireModule(\"rekonsiliasi\") sebelum operasi apa pun", () => {
  for (const route of ROUTES) {
    const source = readFileSync(here(route), "utf8");
    assert.match(source, /requireModule\("rekonsiliasi"\)/, `${route} harus memanggil requireModule("rekonsiliasi")`);
  }
});

test("seluruh route rekonsiliasi TIDAK memiliki operasi mutasi MongoDB apa pun", () => {
  for (const route of ROUTES) {
    const source = readFileSync(here(route), "utf8");
    assert.doesNotMatch(source, MUTATION_PATTERN, `${route} tidak boleh memiliki operasi mutasi`);
  }
});

test("seluruh route rekonsiliasi memakai NO_CACHE_HEADERS pada response", () => {
  for (const route of ROUTES) {
    const source = readFileSync(here(route), "utf8");
    assert.match(source, /NO_CACHE_HEADERS/, `${route} harus memakai NO_CACHE_HEADERS`);
  }
});

test("route runs & findings tidak menerima storeId dari client (selalu currentStoreId())", () => {
  for (const route of ["../app/api/reconciliation/runs/route.ts", "../app/api/reconciliation/runs/[runId]/route.ts", "../app/api/reconciliation/findings/route.ts"]) {
    const source = readFileSync(here(route), "utf8");
    assert.match(source, /currentStoreId\(\)/, `${route} harus memakai currentStoreId()`);
    assert.doesNotMatch(source, /searchParams\.get\("storeId"\)/, `${route} tidak boleh membaca storeId dari query string`);
  }
});

test("service reconciliation-store tidak mengimpor library live Olsera/AYO (murni MongoDB read-only)", () => {
  const source = readFileSync(here("./reconciliation-store.ts"), "utf8");
  assert.doesNotMatch(source, /olsera-financial-client|from "\.\/olsera\.ts"|from "\.\/ayo\.ts"/);
});
