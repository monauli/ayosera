// Verifikasi statis scripts/audit-reconciliation-inventory-null-product.ts:
// read-only (tidak ada operasi mutasi MongoDB), selalu memfilter storeId,
// tidak mencetak credential/URI. Pola sama lib/reconciliation-api.test.ts /
// lib/reconciliation-cli.test.ts (baca source, bukan menjalankan proses).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/audit-reconciliation-inventory-null-product.ts", import.meta.url));
const source = readFileSync(scriptPath, "utf8");

const MUTATION_PATTERN = /\.(updateOne|updateMany|bulkWrite|insertOne|insertMany|deleteOne|deleteMany|findOneAndUpdate|findOneAndReplace|findOneAndDelete|drop)\s*\(/;

test("script: TIDAK ADA operasi mutasi MongoDB apa pun (read-only)", () => {
  assert.doesNotMatch(source, MUTATION_PATTERN);
});

test("script: query movement SELALU menyertakan storeId (tidak ada cross-store read)", () => {
  assert.match(source, /olseraInventoryMovements\s*\n?\s*\.find\(\{\s*storeId/);
});

test("script: tidak mencetak MONGODB_URI/credential mentah (hanya storeId/from/to yang di-log)", () => {
  assert.doesNotMatch(source, /console\.(log|warn|error)\([^)]*MONGODB_URI/);
  assert.doesNotMatch(source, /console\.(log|warn|error)\([^)]*process\.env\.MONGODB_URI/);
});

test("script: proyeksi field dibatasi eksplisit (tidak membaca seluruh dokumen mentah)", () => {
  assert.match(source, /\.project\(\{/);
});

test("script: validasi storeId/from/to lewat helper murni sebelum dipakai (bukan langsung dari argv)", () => {
  assert.match(source, /validateDateArg\(/);
  assert.match(source, /validateStoreIdArg\(/);
});
