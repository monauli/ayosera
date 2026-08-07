// Helper murni (tanpa React/DOM) untuk keputusan tampilan panel Inventori
// Olsera — dipisah agar bisa diuji dengan node:test tanpa perlu DOM.
// TIDAK menyentuh backend/DB/export internal: field SKU/uom/gudang/status tetap
// ada di database dan export, modul ini hanya menentukan APA yang dirender.

/**
 * Nilai dianggap bermakna bila BUKAN null/undefined, dan setelah di-trim bukan
 * string kosong maupun placeholder "-". Dipakai untuk semua kolom teks
 * inventori (SKU, Satuan, Gudang, Varian, Referensi, ...).
 */
export function isMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  return text.length > 0 && text !== "-";
}

/** Alias historis khusus SKU — aturannya sama dengan isMeaningfulValue. */
export function isMeaningfulSku(sku: unknown): boolean {
  return isMeaningfulValue(sku);
}

/**
 * Kolom ditampilkan bila MINIMAL satu baris punya nilai bermakna. Bila seluruh
 * baris kosong (atau tabel kosong), kolom disembunyikan.
 */
export function hasAnyMeaningfulValue(values: unknown[]): boolean {
  return values.some(isMeaningfulValue);
}

/** Alias historis khusus SKU. */
export function hasAnyMeaningfulSku(skus: unknown[]): boolean {
  return hasAnyMeaningfulValue(skus);
}

/**
 * Teks yang dirender di sel tabel. Nilai tidak bermakna (null/undefined/""/"-")
 * menjadi string kosong sehingga selnya BENAR-BENAR kosong — data asli di
 * database tidak diubah.
 */
export function displayValue(value: unknown): string {
  return isMeaningfulValue(value) ? String(value).trim() : "";
}

// ---------------------------------------------------------------------------
// Item yang disembunyikan dari daftar Inventori (tampilan saja)
// ---------------------------------------------------------------------------

/**
 * Kategori ini adalah katalog penjualan non-stok. Daftar ini sengaja eksplisit
 * dan dicocokkan secara persis setelah normalisasi agar kategori lain yang
 * kebetulan mengandung kata serupa tidak ikut tersembunyi.
 */
export const HIDDEN_INVENTORY_CATEGORIES = ["LABERS", "JASA HOST"] as const;

/** Normalisasi tunggal untuk perbandingan nama kategori di UI. */
export function normalizeInventoryCategory(category: unknown): string {
  return String(category ?? "").trim().toLocaleUpperCase("id-ID");
}

/** True hanya untuk kategori yang persis ada dalam daftar tampilan tersembunyi. */
export function isHiddenInventoryCategory(category: unknown): boolean {
  return (HIDDEN_INVENTORY_CATEGORIES as readonly string[]).includes(normalizeInventoryCategory(category));
}

type InventoryCategoryRow = { category: unknown };

/**
 * Menyaring salinan baris untuk tabel UI. Input tidak pernah diubah dan helper
 * ini tidak dipakai oleh API, MongoDB, sync, maupun export.
 */
export function visibleInventoryRows<T extends InventoryCategoryRow>(rows: readonly T[], showHiddenItems: boolean): T[] {
  return showHiddenItems ? [...rows] : rows.filter((row) => !isHiddenInventoryCategory(row.category));
}

/** Jumlah item pada data yang sedang dirender dan akan disembunyikan. */
export function hiddenInventoryRowCount<T extends InventoryCategoryRow>(rows: readonly T[]): number {
  return rows.filter((row) => isHiddenInventoryCategory(row.category)).length;
}

// ---------------------------------------------------------------------------
// Aturan Kedua Inventori — sembunyikan produk yang TIDAK punya aktivitas SAMA
// SEKALI pada periode ini (opening 0, tanpa incoming/return/sales/outgoing,
// closing 0). Ini murni aturan TAMPILAN (dashboard + export) — TIDAK PERNAH
// menghapus histori/produk master, TIDAK mengubah perhitungan qty. Berbeda
// dari isHiddenInventoryCategory (kategori LABERS/JASA HOST, manual) — kedua
// aturan independen dan bisa berlaku bersamaan atau sendiri-sendiri.
// ---------------------------------------------------------------------------

export type InventoryActivityRow = {
  openingQty: number | null;
  incomingQty: number | null;
  returnQty: number | null;
  salesQty: number | null;
  outgoingQty: number | null;
  closingQty: number | null;
  /** Status ledger baris ini (lib/olsera-inventory-monthly-snapshot-core.ts). Absen/undefined diperlakukan sama seperti "complete". */
  snapshotStatus?: "complete" | "boundary-only" | "incomplete";
};

/**
 * true bila baris ini punya aktivitas apa pun (harus tetap tampil), false
 * HANYA bila status ledger "complete" DAN seluruh opening/incoming/return/
 * sales/outgoing/closing benar-benar nol. Baris dengan data TIDAK LENGKAP
 * ("boundary-only"/"incomplete") SELALU dianggap punya aktivitas (jangan
 * pernah menyembunyikan produk hanya karena datanya belum lengkap — beda
 * dari "terbukti tidak ada aktivitas").
 */
export function hasInventoryActivity(row: InventoryActivityRow): boolean {
  if (row.snapshotStatus && row.snapshotStatus !== "complete") return true;
  const isZero = (value: number | null) => value === null || value === 0;
  return !(
    isZero(row.openingQty) &&
    isZero(row.incomingQty) &&
    isZero(row.returnQty) &&
    isZero(row.salesQty) &&
    isZero(row.outgoingQty) &&
    isZero(row.closingQty)
  );
}

type InventoryMonthlyRow = InventoryCategoryRow & InventoryActivityRow;

/**
 * Helper inclusion TUNGGAL dipakai BERSAMA oleh dashboard Stok Bulanan dan
 * export bulanan (lib/olsera-inventory-monthly-export.ts) — supaya keduanya
 * SELALU konsisten, tidak ada filter berbeda-beda. Menggabungkan dua aturan
 * independen: kategori tersembunyi (togglable lewat `showHiddenItems`, sama
 * seperti visibleInventoryRows) dan Aturan Kedua Inventori (SELALU berlaku,
 * tidak togglable — produk dengan aktivitas apa pun sekecil apa pun tetap
 * tampil).
 */
export function visibleMonthlyInventoryRows<T extends InventoryMonthlyRow>(rows: readonly T[], showHiddenItems: boolean): T[] {
  return rows.filter((row) => hasInventoryActivity(row) && (showHiddenItems || !isHiddenInventoryCategory(row.category)));
}

// ---------------------------------------------------------------------------
// Status stok
// ---------------------------------------------------------------------------

/** Status yang punya badge. "Data Tidak Lengkap" sengaja TIDAK termasuk. */
export const STOCK_STATUS_WITH_BADGE = ["Aman", "Hampir Habis", "Habis"] as const;
export type StockStatusWithBadge = (typeof STOCK_STATUS_WITH_BADGE)[number];

/**
 * Status stok yang layak ditampilkan sebagai badge, atau null bila sel harus
 * dibiarkan KOSONG:
 * - stockQty tidak tersedia (trackInventory=false) -> null; TIDAK PERNAH
 *   dianggap "Habis" maupun "Hampir Habis".
 * - status internal "Data Tidak Lengkap" (atau nilai lain di luar tiga status
 *   di atas) -> null; badge "Data Tidak Lengkap" sudah dihapus dari UI.
 * Perhitungan status di backend TIDAK diubah — ini murni filter tampilan.
 */
export function stockStatusBadgeLabel(
  status: unknown,
  trackInventory: boolean,
): StockStatusWithBadge | null {
  if (!trackInventory) return null;
  const label = String(status ?? "").trim();
  return (STOCK_STATUS_WITH_BADGE as readonly string[]).includes(label)
    ? (label as StockStatusWithBadge)
    : null;
}

/**
 * Class kontras badge status stok. Warna dasar (rose/amber/emerald) memakai
 * aksen existing; kelas inv-badge-* didefinisikan di app/globals.css dengan
 * aturan TERPISAH untuk light & dark mode ([data-mode]) supaya keduanya
 * terbaca tanpa saling merusak.
 */
export const STOCK_STATUS_BADGE_CLASS: Record<StockStatusWithBadge, string> = {
  Aman: "inv-badge inv-badge-ok",
  "Hampir Habis": "inv-badge inv-badge-warning",
  Habis: "inv-badge inv-badge-danger",
};

// ---------------------------------------------------------------------------
// Status produk (Nonaktif / Perlu Penyesuaian Manual / status stok biasa)
// ---------------------------------------------------------------------------

export type ProductStatusBadge = { label: string; className: string };

/**
 * Badge status produk, urutan prioritas:
 * 1. Produk Nonaktif (product.active === false) — selalu badge utama,
 *    TIDAK PERNAH ditampilkan bersama status stok (Aman/Hampir Habis/Habis)
 *    supaya produk nonaktif tidak terlihat seolah perlu restock.
 * 2. Perlu Penyesuaian Manual — tambahan HANYA bila produk nonaktif dan
 *    datanya tidak lengkap (snapshotStatus backend "boundary-only"/
 *    "incomplete"; istilah tsb tidak pernah dirender ke user).
 * 3. Status stok biasa (Aman/Hampir Habis/Habis/Butuh Adjust Manual) — HANYA
 *    untuk produk aktif. Perhitungan status di backend tidak diubah.
 */
export function productStatusBadges(row: {
  active: boolean;
  status: string;
  trackInventory: boolean;
  snapshotStatus?: "complete" | "boundary-only" | "incomplete";
}): ProductStatusBadge[] {
  if (!row.active) {
    const badges: ProductStatusBadge[] = [{ label: "Produk Nonaktif", className: "inv-badge inv-badge-neutral" }];
    if (row.snapshotStatus === "boundary-only" || row.snapshotStatus === "incomplete") {
      badges.push({ label: "Perlu Penyesuaian Manual", className: "inv-badge inv-badge-warning" });
    }
    return badges;
  }
  if (row.status === "Butuh Adjust Manual") {
    return [{ label: "Butuh Adjust Manual", className: "inv-badge inv-badge-warning" }];
  }
  const label = stockStatusBadgeLabel(row.status, row.trackInventory);
  return label ? [{ label, className: STOCK_STATUS_BADGE_CLASS[label] }] : [];
}

// ---------------------------------------------------------------------------
// Nilai angka null vs 0 (tanda "—" untuk null, 0 asli tetap "0")
// ---------------------------------------------------------------------------

/** Angka null/undefined -> "—" (bukan 0, bukan "Tidak tersedia"). Nilai 0 asli tetap "0". */
export function formatQty(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(value);
}

// ---------------------------------------------------------------------------
// Status sync — label Indonesia (nilai backend TIDAK diubah)
// ---------------------------------------------------------------------------

export const SYNC_STATUS_LABEL = {
  stale: "Perlu Sync",
  running: "Berjalan",
  success: "Berhasil",
  partial: "Sebagian",
  failed: "Gagal",
  idle: "Menunggu",
} as const;

export type SyncStatusKey = keyof typeof SYNC_STATUS_LABEL;

export function syncStatusLabel(key: SyncStatusKey): string {
  return SYNC_STATUS_LABEL[key];
}

// ---------------------------------------------------------------------------
// Status periode — label sederhana untuk user (nilai internal TIDAK diubah,
// masih dipakai untuk perbandingan logika seperti sebelumnya)
// ---------------------------------------------------------------------------

export function periodStatusLabel(status: string): string {
  if (status === "Snapshot Tidak Tersedia") return "Data Bulan Ini Belum Tersedia";
  return status;
}

// ---------------------------------------------------------------------------
// Empty state tabel Stok Bulanan — bedakan periode belum tersedia / filter
// kosong / semua item disembunyikan
// ---------------------------------------------------------------------------

export function stockEmptyStateMessage(input: {
  totalRows: number;
  visibleRows: number;
  hasData: boolean | null;
}): string {
  if (input.totalRows > 0 && input.visibleRows === 0) return "Tidak ada produk yang ditampilkan.";
  if (input.hasData === false) return "Data inventori untuk periode ini belum tersedia.";
  return "Tidak ada produk yang sesuai dengan filter.";
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export type InventoryTabKey = "stock" | "movements";

export const INVENTORY_TABS: {
  key: InventoryTabKey;
  label: string;
  supervisorOnly: boolean;
}[] = [
  { key: "stock", label: "Stok Bulanan", supervisorOnly: false },
  { key: "movements", label: "Riwayat Mutasi", supervisorOnly: false },
];

/** Tab yang boleh dilihat sesuai role existing. */
export function visibleInventoryTabs(isSupervisor: boolean) {
  return INVENTORY_TABS.filter((tab) => !tab.supervisorOnly || isSupervisor);
}

// ---------------------------------------------------------------------------
// Kolom tabel — daftar kolom yang SUDAH DIHAPUS dari UI (data tetap tersimpan)
// ---------------------------------------------------------------------------

/** Kolom yang dihapus dari tabel Stok Saat Ini (field tetap ada di DB/export). */
export const REMOVED_STOCK_COLUMNS = ["Terakhir Diperbarui", "Outlet"] as const;
/** Kolom yang dihapus dari tabel Riwayat Mutasi (catatan tetap ada di DB). */
export const REMOVED_MOVEMENT_COLUMNS = ["Catatan"] as const;
