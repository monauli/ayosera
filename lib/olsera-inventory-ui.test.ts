// Test unit helper tampilan panel Inventori Olsera: nilai kosong, kolom
// kondisional (SKU/Satuan/Gudang), badge status stok, kolom yang dihapus, dan
// visibilitas tab per-role. Tidak menyentuh MongoDB/React.
// Jalankan: npm run test:olsera-inventory-ui
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HIDDEN_INVENTORY_CATEGORIES,
  REMOVED_MOVEMENT_COLUMNS,
  REMOVED_STOCK_COLUMNS,
  STOCK_STATUS_BADGE_CLASS,
  displayValue,
  hasAnyMeaningfulSku,
  hasAnyMeaningfulValue,
  hiddenInventoryRowCount,
  isHiddenInventoryCategory,
  isMeaningfulSku,
  isMeaningfulValue,
  normalizeInventoryCategory,
  stockStatusBadgeLabel,
  visibleInventoryRows,
  visibleInventoryTabs,
} from "./olsera-inventory-ui.ts";

// ---- 1. Nilai kosong TIDAK ditampilkan sebagai "-" ------------------------

test("isMeaningfulValue: null/undefined/''/'-'/spasi dianggap TIDAK bermakna", () => {
  assert.equal(isMeaningfulValue(null), false);
  assert.equal(isMeaningfulValue(undefined), false);
  assert.equal(isMeaningfulValue(""), false);
  assert.equal(isMeaningfulValue("   "), false);
  assert.equal(isMeaningfulValue("-"), false);
  assert.equal(isMeaningfulValue(" - "), false);
});

test("isMeaningfulValue/isMeaningfulSku: nilai nyata dianggap bermakna", () => {
  assert.equal(isMeaningfulValue("SSL-2859R-S"), true);
  assert.equal(isMeaningfulValue("  PCS "), true);
  assert.equal(isMeaningfulSku("ABC123"), true);
});

test("displayValue: nilai '-'/null/undefined/'' menjadi string KOSONG (sel kosong, bukan tanda '-')", () => {
  assert.equal(displayValue("-"), "");
  assert.equal(displayValue(null), "");
  assert.equal(displayValue(undefined), "");
  assert.equal(displayValue(""), "");
  assert.equal(displayValue("   "), "");
});

test("displayValue: nilai valid dikembalikan apa adanya (di-trim), data asli tidak diubah", () => {
  assert.equal(displayValue("PCS"), "PCS");
  assert.equal(displayValue("  GUDANG A  "), "GUDANG A");
  assert.equal(displayValue(0), "0");
});

// ---- 1b. Hidden Item hanya untuk daftar Inventori UI ----------------------

test("Hidden Item: LABERS dan JASA HOST tersembunyi secara default dengan pencocokan kategori persis", () => {
  assert.deepEqual(HIDDEN_INVENTORY_CATEGORIES, ["LABERS", "JASA HOST"]);
  assert.equal(normalizeInventoryCategory("  jasa host  "), "JASA HOST");
  assert.equal(isHiddenInventoryCategory("labers"), true);
  assert.equal(isHiddenInventoryCategory(" JASA HOST "), true);
  assert.equal(isHiddenInventoryCategory("LABERS PREMIUM"), false);
  assert.equal(isHiddenInventoryCategory("GELAS/CUP"), false);
});

test("Hidden Item: toggle menampilkan kembali item tersembunyi tanpa mengubah data sumber", () => {
  const source = [
    { id: "labers", category: "LABERS" },
    { id: "host", category: "jasa host" },
    { id: "cup", category: "GELAS/CUP" },
  ];
  const before = structuredClone(source);

  assert.deepEqual(visibleInventoryRows(source, false).map((row) => row.id), ["cup"]);
  assert.equal(hiddenInventoryRowCount(source), 2);
  assert.deepEqual(visibleInventoryRows(source, true).map((row) => row.id), ["labers", "host", "cup"]);
  assert.deepEqual(source, before);
});

test("panel: Hidden Item hanya memengaruhi render, reset pagination, dan tetap responsif", () => {
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("const visibleStockRows = visibleInventoryRows(stockRows, showHiddenItems);"));
  assert.ok(source.includes("setStockPage(1);"));
  assert.ok(source.includes("aria-pressed={showHiddenItems}"));
  assert.ok(source.includes("Item tersembunyi tetap tersimpan dan tetap digunakan oleh laporan serta export."));
  assert.ok(source.includes("flex flex-wrap items-center gap-2.5"));
  assert.ok(source.includes("w-full sm:w-64"));
  assert.ok(source.includes("<PaginationRow page={stockPage} meta={stockMeta}"));
  assert.ok(source.includes("if (stockSearch.trim()) params.set(\"q\", stockSearch.trim());"));
});

test("Hidden Item tidak mengubah endpoint atau jalur export Inventori", () => {
  const panel = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  const exportModule = readFileSync(new URL("./olsera-inventory-export.ts", import.meta.url), "utf8");
  assert.ok(panel.includes("/api/olsera/inventory/monthly?${params.toString()}"));
  assert.ok(panel.includes("/api/olsera/inventory/export?${query}"));
  assert.equal(exportModule.includes("HIDDEN_INVENTORY_CATEGORIES"), false);
  assert.equal(exportModule.includes("visibleInventoryRows"), false);
});

// ---- 2. Kolom SKU / Satuan / Gudang kondisional ---------------------------

test("hasAnyMeaningfulValue: seluruh data kosong -> kolom disembunyikan (false)", () => {
  // SKU semuanya kosong
  assert.equal(hasAnyMeaningfulValue([null, undefined, "", "-", "  "]), false);
  // Satuan semuanya kosong
  assert.equal(hasAnyMeaningfulValue([null, "-", ""]), false);
  // Gudang: API Olsera belum menyediakan -> undefined di semua baris
  assert.equal(hasAnyMeaningfulValue([undefined, undefined, undefined]), false);
  // Tabel kosong
  assert.equal(hasAnyMeaningfulValue([]), false);
});

test("hasAnyMeaningfulValue: minimal satu nilai valid -> kolom TETAP tampil (true)", () => {
  assert.equal(hasAnyMeaningfulValue([null, "-", "SKU-1"]), true);
  assert.equal(hasAnyMeaningfulValue(["", undefined, "PCS"]), true);
  assert.equal(hasAnyMeaningfulValue([undefined, "GUDANG A"]), true);
  assert.equal(hasAnyMeaningfulSku([null, "-", "SKU-1"]), true);
});

// ---- 3. Status stok tanpa data -------------------------------------------

test("stockStatusBadgeLabel: badge 'Data Tidak Lengkap' TIDAK PERNAH ditampilkan", () => {
  assert.equal(stockStatusBadgeLabel("Data Tidak Lengkap", true), null);
  assert.equal(stockStatusBadgeLabel("Data Tidak Lengkap", false), null);
});

test("stockStatusBadgeLabel: stockQty tidak tersedia (trackInventory=false) -> kosong, BUKAN Habis/Hampir Habis", () => {
  assert.equal(stockStatusBadgeLabel("Habis", false), null);
  assert.equal(stockStatusBadgeLabel("Hampir Habis", false), null);
  assert.equal(stockStatusBadgeLabel("Aman", false), null);
  assert.equal(stockStatusBadgeLabel(null, false), null);
});

test("stockStatusBadgeLabel: status valid dengan stockQty tersedia tetap tampil", () => {
  assert.equal(stockStatusBadgeLabel("Aman", true), "Aman");
  assert.equal(stockStatusBadgeLabel("Hampir Habis", true), "Hampir Habis");
  assert.equal(stockStatusBadgeLabel("Habis", true), "Habis");
});

test("stockStatusBadgeLabel: status tak dikenal/kosong -> sel dibiarkan kosong", () => {
  assert.equal(stockStatusBadgeLabel("", true), null);
  assert.equal(stockStatusBadgeLabel(undefined, true), null);
  assert.equal(stockStatusBadgeLabel("Entah Apa", true), null);
});

// ---- 4 & 5. Kolom yang dihapus dari UI ------------------------------------

test("kolom 'Terakhir Diperbarui' dihapus dari tabel Stok Saat Ini", () => {
  assert.ok(REMOVED_STOCK_COLUMNS.includes("Terakhir Diperbarui"));
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  // Tidak ada lagi header kolom yang dirender (kemunculan di komentar kode diabaikan).
  assert.equal(source.includes(">Terakhir Diperbarui<"), false);
  // Field timestamp tetap ada di tipe data (disimpan internal, hanya tidak dirender).
  assert.ok(source.includes("modifiedTime"));
});

test("kolom 'Catatan' dihapus dari tabel Riwayat Mutasi", () => {
  assert.ok(REMOVED_MOVEMENT_COLUMNS.includes("Catatan"));
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  assert.equal(source.includes(">Catatan<"), false);
  // Field note tetap ada di tipe data (disimpan internal).
  assert.ok(source.includes("note: string | null"));
});

test("tabel Riwayat Mutasi mempertahankan kolom penting", () => {
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  for (const column of ["Tanggal", "Produk", "Jenis Mutasi", "Perubahan", "Harga Modal", "Nilai", "Referensi"]) {
    assert.ok(source.includes(`>${column}<`), `kolom ${column} harus tetap ada`);
  }
});

// ---- 6. Tab Konsistensi per-role -----------------------------------------

test("visibleInventoryTabs: UI utama hanya menampilkan Stok Bulanan dan Riwayat Mutasi", () => {
  const keys = visibleInventoryTabs(false).map((t) => t.key);
  assert.deepEqual(keys, ["stock", "movements"]);
});

test("visibleInventoryTabs: supervisor juga tidak melihat tab teknis Konsistensi", () => {
  const keys = visibleInventoryTabs(true).map((t) => t.key);
  assert.deepEqual(keys, ["stock", "movements"]);
});

test("panel: satu periode YYYY-MM menjadi sumber snapshot bulanan dan URL", () => {
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("inventoryPeriod"));
  assert.ok(source.includes("/api/olsera/inventory/monthly?${params.toString()}"));
  assert.ok(source.includes("periodStatus"));
  assert.ok(source.includes("Snapshot ${period} belum tersedia"));
});

// ---- 7 & 8. Kontras badge light & dark mode -------------------------------

test("STOCK_STATUS_BADGE_CLASS: Habis/Hampir Habis punya class kontras khusus", () => {
  assert.equal(STOCK_STATUS_BADGE_CLASS["Habis"], "inv-badge inv-badge-danger");
  assert.equal(STOCK_STATUS_BADGE_CLASS["Hampir Habis"], "inv-badge inv-badge-warning");
  assert.equal(STOCK_STATUS_BADGE_CLASS["Aman"], "inv-badge inv-badge-ok");
});

test("globals.css: badge Habis/Hampir Habis punya aturan kontras untuk light DAN dark mode", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const badge of ["inv-badge-danger", "inv-badge-warning", "inv-badge-ok"]) {
    assert.ok(
      css.includes(`[data-mode="light"] .rd-shell .inv-panel .${badge}`),
      `${badge} butuh aturan light mode`,
    );
    assert.ok(
      css.includes(`[data-mode="dark"] .rd-shell .inv-panel .${badge}`),
      `${badge} butuh aturan dark mode`,
    );
  }
});

test("globals.css: angka statistik Stok Habis/Hampir Habis digelapkan di light mode", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.ok(css.includes('[data-mode="light"] .rd-shell .inv-panel .text-rose-400'));
  assert.ok(css.includes('[data-mode="light"] .rd-shell .inv-panel .text-amber-300'));
});
