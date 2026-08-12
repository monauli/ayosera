// Regresi Phase — "YONEX SHORTS MEN # SM-J035-2906-RW1-S": katalog Olsera
// kadang menyimpan produk lama sebagai entri baru dengan sufiks "duplicate"
// (lihat lib/olsera-inventory-monthly-snapshot-core.ts stripDuplicateSuffix,
// sudah diterapkan di export dua-sheet). Sufiks itu bocor ke tampilan Daftar
// Produk (/api/olsera/inventory/products) dan Stok Bulanan
// (/api/olsera/inventory/monthly) karena keduanya membaca nama katalog
// mentah tanpa dibersihkan — generik untuk produk mana pun yang mengalami
// kasus serupa, BUKAN hardcode nama produk ini. Source-inspection (pola sama
// seperti lib/reconciliation-omzet-period-lock-ui.test.ts) karena kedua route
// ini butuh mock Mongo yang cukup besar untuk full HTTP test; stripDuplicateSuffix
// sendiri sudah diuji penuh (unit) di lib/olsera-inventory-monthly-snapshot-core.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const productsRoute = readFileSync(new URL("../app/api/olsera/inventory/products/route.ts", import.meta.url), "utf8");
const monthlyRoute = readFileSync(new URL("../app/api/olsera/inventory/monthly/route.ts", import.meta.url), "utf8");
const exportLib = readFileSync(new URL("./olsera-inventory-export.ts", import.meta.url), "utf8");

test("Daftar Produk (/api/olsera/inventory/products) membersihkan sufiks 'duplicate' sebelum dikirim ke client", () => {
  assert.match(productsRoute, /import\s*\{\s*stripDuplicateSuffix\s*\}\s*from\s*"@\/lib\/olsera-inventory-monthly-snapshot-core"/);
  assert.match(productsRoute, /name:\s*stripDuplicateSuffix\(doc\.name\)/);
});

test("Stok Bulanan (/api/olsera/inventory/monthly) membersihkan sufiks 'duplicate' sebelum dikirim ke client", () => {
  assert.match(monthlyRoute, /import\s*\{\s*stripDuplicateSuffix\s*\}\s*from\s*"@\/lib\/olsera-inventory-monthly-snapshot-core"/);
  assert.match(monthlyRoute, /name:\s*stripDuplicateSuffix\(product\?\.name\s*\?\?\s*snapshot\.productName\)/);
});

test("Export Excel lama (Stok Saat Ini/Konsistensi, lib/olsera-inventory-export.ts) membersihkan sufiks 'duplicate' juga", () => {
  assert.match(exportLib, /import\s*\{\s*stripDuplicateSuffix\s*\}\s*from\s*"\.\/olsera-inventory-monthly-snapshot-core\.ts"/);
  assert.match(exportLib, /sanitizeExcelCellValue\(stripDuplicateSuffix\(product\.name\)\)/);
  assert.match(exportLib, /sanitizeExcelCellValue\(stripDuplicateSuffix\(item\.name\)\)/);
});
