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
  formatQty,
  hasAnyMeaningfulSku,
  hasAnyMeaningfulValue,
  hiddenInventoryRowCount,
  isHiddenInventoryCategory,
  isMeaningfulSku,
  isMeaningfulValue,
  normalizeInventoryCategory,
  periodStatusLabel,
  productStatusBadges,
  stockEmptyStateMessage,
  stockStatusBadgeLabel,
  syncStatusLabel,
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
  assert.ok(source.includes("Item tersembunyi tetap ikut dihitung di laporan dan export."));
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

test("panel: satu periode YYYY-MM menjadi sumber data bulanan dan URL", () => {
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("inventoryPeriod"));
  assert.ok(source.includes("/api/olsera/inventory/monthly?${params.toString()}"));
  assert.ok(source.includes("periodStatus"));
  assert.ok(source.includes("stockEmptyStateMessage({"));
});

// ---- 19. Regresi: status periode & tombol export tidak boleh basi saat user
// pindah ke tab Riwayat Mutasi lalu mengganti periode (ditemukan saat audit
// visual — kartu "Laporan Stock Opname Bulanan" & Ringkasan dirender di luar
// blok tab, jadi effect stok TIDAK BOLEH digerbang oleh `tab`) -------------

test("panel: fetch stok TIDAK digerbang oleh tab aktif (kartu Laporan Bulanan & Ringkasan tetap segar walau user sedang di tab Riwayat Mutasi)", () => {
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  assert.equal(source.includes('if (tab !== "stock") return;'), false, "guard ini menyebabkan status periode & tombol export basi saat tab Riwayat Mutasi aktif");
  // Effect tetap ada dan tetap bereaksi terhadap perubahan periode.
  assert.ok(source.includes("// Tabel stok. Sengaja TIDAK digerbang oleh tab"));
  assert.ok(source.includes("[tab, period, stockSearch, stockCategory, stockStatusFilter, stockSort, stockPage, refreshTick, stockReloadTick]"));
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

test("globals.css: badge Produk Nonaktif (inv-badge-neutral) punya aturan kontras untuk light DAN dark mode", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.ok(css.includes('[data-mode="light"] .rd-shell .inv-panel .inv-badge-neutral'));
  assert.ok(css.includes('[data-mode="dark"] .rd-shell .inv-panel .inv-badge-neutral'));
});

// ---- 9. Status produk: Produk Nonaktif > Perlu Penyesuaian Manual > stok --

test("productStatusBadges: produk nonaktif menampilkan 'Produk Nonaktif' sebagai status utama", () => {
  const badges = productStatusBadges({ active: false, status: "Aman", trackInventory: true, snapshotStatus: "complete" });
  assert.deepEqual(badges.map((badge) => badge.label), ["Produk Nonaktif"]);
});

test("productStatusBadges: produk nonaktif dengan data tidak lengkap (boundary-only/incomplete) juga menampilkan 'Perlu Penyesuaian Manual'", () => {
  const boundaryOnly = productStatusBadges({ active: false, status: "Habis", trackInventory: true, snapshotStatus: "boundary-only" });
  assert.deepEqual(boundaryOnly.map((badge) => badge.label), ["Produk Nonaktif", "Perlu Penyesuaian Manual"]);

  const incomplete = productStatusBadges({ active: false, status: "Habis", trackInventory: true, snapshotStatus: "incomplete" });
  assert.deepEqual(incomplete.map((badge) => badge.label), ["Produk Nonaktif", "Perlu Penyesuaian Manual"]);

  const complete = productStatusBadges({ active: false, status: "Habis", trackInventory: true, snapshotStatus: "complete" });
  assert.deepEqual(complete.map((badge) => badge.label), ["Produk Nonaktif"]);
});

test("productStatusBadges: produk nonaktif TIDAK PERNAH menampilkan status stok (Aman/Hampir Habis/Habis/Butuh Adjust Manual) sebagai badge utama", () => {
  for (const status of ["Aman", "Hampir Habis", "Habis", "Butuh Adjust Manual"]) {
    const badges = productStatusBadges({ active: false, status, trackInventory: true, snapshotStatus: "complete" });
    assert.equal(badges[0]?.label, "Produk Nonaktif");
    assert.equal(badges.some((badge) => badge.label === status), false);
  }
});

test("productStatusBadges: produk aktif tetap memakai status stok biasa (perilaku existing tidak berubah)", () => {
  assert.deepEqual(productStatusBadges({ active: true, status: "Aman", trackInventory: true }).map((b) => b.label), ["Aman"]);
  assert.deepEqual(productStatusBadges({ active: true, status: "Hampir Habis", trackInventory: true }).map((b) => b.label), ["Hampir Habis"]);
  assert.deepEqual(productStatusBadges({ active: true, status: "Habis", trackInventory: true }).map((b) => b.label), ["Habis"]);
  assert.deepEqual(
    productStatusBadges({ active: true, status: "Butuh Adjust Manual", trackInventory: true }).map((b) => b.label),
    ["Butuh Adjust Manual"],
  );
  assert.deepEqual(productStatusBadges({ active: true, status: "Entah Apa", trackInventory: true }), []);
});

// ---- 10. Nilai null vs 0 pada kolom kuantitas -----------------------------

test("formatQty: null/undefined menjadi '—', BUKAN 0 dan BUKAN 'Tidak tersedia'", () => {
  assert.equal(formatQty(null), "—");
  assert.equal(formatQty(undefined), "—");
});

test("formatQty: nilai 0 asli tetap tampil sebagai '0'", () => {
  assert.equal(formatQty(0), "0");
  assert.equal(formatQty(5), "5");
  assert.equal(formatQty(-3), "-3");
});

// ---- 11. Status sync diterjemahkan ke Bahasa Indonesia --------------------

test("syncStatusLabel: status sync diterjemahkan ke Bahasa Indonesia (nilai backend tidak diubah, hanya label)", () => {
  assert.equal(syncStatusLabel("stale"), "Perlu Sync");
  assert.equal(syncStatusLabel("running"), "Berjalan");
  assert.equal(syncStatusLabel("success"), "Berhasil");
  assert.equal(syncStatusLabel("partial"), "Sebagian");
  assert.equal(syncStatusLabel("failed"), "Gagal");
  assert.equal(syncStatusLabel("idle"), "Menunggu");
});

// ---- 12. Status periode: istilah "Snapshot" diganti bahasa sederhana -----

test("periodStatusLabel: 'Snapshot Tidak Tersedia' diganti 'Data Bulan Ini Belum Tersedia' tanpa mengubah nilai status internal", () => {
  assert.equal(periodStatusLabel("Snapshot Tidak Tersedia"), "Data Bulan Ini Belum Tersedia");
  assert.equal(periodStatusLabel("Final"), "Final");
  assert.equal(periodStatusLabel("Menunggu Validasi"), "Menunggu Validasi");
  assert.equal(periodStatusLabel("Bulan Berjalan / Belum Final"), "Bulan Berjalan / Belum Final");
});

// ---- 13. Empty state: filter kosong vs periode belum tersedia vs semua disembunyikan

test("stockEmptyStateMessage: bedakan periode belum tersedia, filter tidak menemukan hasil, dan semua produk disembunyikan", () => {
  assert.equal(
    stockEmptyStateMessage({ totalRows: 0, visibleRows: 0, hasData: false }),
    "Data inventori untuk periode ini belum tersedia.",
  );
  assert.equal(
    stockEmptyStateMessage({ totalRows: 0, visibleRows: 0, hasData: true }),
    "Tidak ada produk yang sesuai dengan filter.",
  );
  assert.equal(
    stockEmptyStateMessage({ totalRows: 5, visibleRows: 0, hasData: true }),
    "Tidak ada produk yang ditampilkan.",
  );
});

// ---- 14. Kolom Outlet dihapus dari tabel Stok Bulanan ---------------------

test("kolom 'Outlet' dihapus dari tabel Stok Bulanan (field storeName tetap ada di tipe/data)", () => {
  assert.ok(REMOVED_STOCK_COLUMNS.includes("Outlet"));
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  assert.equal(source.includes(">Outlet<"), false);
  assert.ok(source.includes("storeName"));
});

// ---- 15. Error fetch: pesan + tombol Coba Lagi, terpisah dari loading/empty

test("panel: error fetch Stok dan Mutasi menampilkan pesan dan tombol Coba Lagi (state terpisah dari loading/data kosong)", () => {
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  const messageOccurrences = source.split("Gagal memuat data. Silakan coba lagi.").length - 1;
  assert.equal(messageOccurrences, 2, "pesan error harus dipakai tabel Stok DAN Mutasi");
  const retryButtonOccurrences = source.split("Coba Lagi").length - 1;
  assert.equal(retryButtonOccurrences, 2, "tombol Coba Lagi harus ada di tabel Stok DAN Mutasi");
  assert.ok(source.includes("stockError ? ("));
  assert.ok(source.includes("movementError ? ("));
  assert.ok(source.includes("setStockReloadTick((value) => value + 1)"));
  assert.ok(source.includes("setMovementReloadTick((value) => value + 1)"));
  assert.ok(source.includes("setStockError(true)"));
  assert.ok(source.includes("setMovementError(true)"));
});

// ---- 16. Export bulanan disabled saat data periode belum tersedia --------

test("panel: Export Laporan Stock Opname Bulanan disabled saat data periode belum tersedia, dengan penjelasan singkat (bukan popup error)", () => {
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("disabled={monthlyReportExporting || !period || stockHasData === false}"));
  assert.ok(source.includes("Data periode ini belum tersedia."));
});

// ---- 17. Hidden Item: penjelasan tidak diulang, fungsi tidak berubah ------

test("panel: Hidden Item — penjelasan tidak lagi diulang (tooltip duplikat dihapus), fungsi filter TIDAK berubah", () => {
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  assert.equal(source.includes('title="Item tersembunyi'), false);
  const explanationOccurrences = source.split("Item tersembunyi tetap ikut dihitung di laporan dan export.").length - 1;
  assert.equal(explanationOccurrences, 1, "penjelasan Hidden Item hanya boleh muncul sekali");
  assert.ok(source.includes("const visibleStockRows = visibleInventoryRows(stockRows, showHiddenItems);"));
  assert.ok(source.includes("aria-pressed={showHiddenItems}"));
  assert.ok(source.includes("hiddenInventoryRowCount(stockRows)"));
});

// ---- 18. Istilah teknis dihapus dari tampilan user ------------------------

test("panel: istilah dan penjelasan teknis (snapshot/baseline) dihapus dari tampilan user", () => {
  const source = readFileSync(new URL("../components/olsera-inventory-panel.tsx", import.meta.url), "utf8");
  const bannedRenderedStrings = [
    "Baseline yang diminta",
    "Riwayat penjualan tersedia sejak",
    "Snapshot stok tersedia sejak",
    "Sumber: snapshot bulanan",
    "Snapshot ${period} belum tersedia",
    "Memuat snapshot",
    "Baseline {formatDate(BASELINE_DATE)}",
    "Item tersembunyi tetap tersimpan dan tetap digunakan oleh laporan serta export.",
  ];
  for (const banned of bannedRenderedStrings) {
    assert.equal(source.includes(banned), false, `teks lama "${banned}" seharusnya sudah dihapus/diganti`);
  }
  // Status periode selalu dirender lewat periodStatusLabel() (bukan string mentah).
  assert.ok(source.includes("Status periode: {periodStatusLabel(periodStatus)}"));
  // Chip status sync selalu dirender lewat syncStatusLabel() (bukan literal Inggris).
  for (const key of ["stale", "running", "success", "partial", "failed", "idle"]) {
    assert.ok(source.includes(`syncStatusLabel("${key}")`), `chip sync "${key}" harus memakai syncStatusLabel`);
  }
});
