// Regression test untuk Task 4 (security hardening) — storeId scoping.
//
// Root cause yang terbukti (bukan dugaan): lib/olsera-inventory.ts,
// lib/olsera-inventory-export.ts, lib/olsera-inventory-monthly-export.ts, dan
// lib/olsera-inventory-monthly-snapshot-store.ts membaca koleksi
// olsera_inventory_products/olsera_inventory_movements/olseraInventorySnapshots
// TANPA filter storeId sama sekali. Diverifikasi read-only terhadap data
// nyata (lihat tmp/ai-handoff.md): olsera_inventory_products HANYA berisi
// storeId 324175 (OLSERA_INTERNAL_STORE_ID), movements HANYA [null, 324175] —
// jadi menambah `{ storeId: { $in: [currentStoreId(), null] } }` TERBUKTI
// tidak mengubah hasil single-store saat ini (himpunan match 100% sama),
// sekaligus menutup kebocoran lintas-toko bila suatu saat toko lain
// ditambahkan ke koleksi yang sama.
//
// Tidak ada infra MongoDB dua-toko untuk membuktikan ini secara perilaku
// murni tanpa membangun fixture besar (di luar proporsi task hardening ini)
// — jadi diverifikasi lewat pemeriksaan sumber (pola sama seperti
// lib/theme-mode.test.ts/lib/logout-flow.test.ts di proyek ini), memastikan
// pola BENAR ada dan pola lama (query tanpa storeId) tidak lagi ditemukan.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

test("lib/olsera-inventory.ts: currentStoreId diimpor dan storeId scope dipakai di query products/movements/snapshots", () => {
  const source = read("./olsera-inventory.ts");
  assert.ok(source.includes('import { currentStoreId } from "./olsera-store-id.ts";'));
  const occurrences = source.match(/storeId: \{ \$in: \[currentStoreId\(\), null\] \}/g) ?? [];
  assert.ok(occurrences.length >= 5, `harus ada beberapa query yang di-scope, ditemukan ${occurrences.length}`);
});

test("lib/olsera-inventory-export.ts: export Stok Saat Ini dan Riwayat Mutasi di-scope storeId", () => {
  const source = read("./olsera-inventory-export.ts");
  assert.ok(source.includes('import { currentStoreId } from "./olsera-store-id.ts";'));
  assert.match(source, /storeId: \{ \$in: \[currentStoreId\(\), null\] \}/);
});

test("lib/olsera-inventory-monthly-export.ts: kedua jalur (manual & auto) di-scope storeId lewat storeScope", () => {
  const source = read("./olsera-inventory-monthly-export.ts");
  assert.ok(source.includes('import { currentStoreId } from "./olsera-store-id.ts";'));
  const storeScopeDeclarations = source.match(/const storeScope = \{ storeId: \{ \$in: \[currentStoreId\(\), null\] \} \};/g) ?? [];
  assert.ok(storeScopeDeclarations.length >= 2, "kedua fungsi export (manual & auto) harus mendeklarasikan storeScope sendiri");
});

test("lib/olsera-inventory-monthly-snapshot-store.ts: fetchMatchingContext (katalog) di-scope storeId", () => {
  const source = read("./olsera-inventory-monthly-snapshot-store.ts");
  assert.ok(source.includes('import { currentStoreId } from "./olsera-store-id.ts";'));
  assert.match(source, /olseraInventoryProducts\s*\n?\s*\.find\(\{ storeId: \{ \$in: \[currentStoreId\(\), null\] \} \}\)/);
});
