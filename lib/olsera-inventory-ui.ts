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
// Tab
// ---------------------------------------------------------------------------

export type InventoryTabKey = "stock" | "movements" | "consistency";

export const INVENTORY_TABS: {
  key: InventoryTabKey;
  label: string;
  supervisorOnly: boolean;
}[] = [
  { key: "stock", label: "Stok Saat Ini", supervisorOnly: false },
  { key: "movements", label: "Riwayat Mutasi", supervisorOnly: false },
  // Konsistensi hanya untuk Supervisor/Admin — user biasa tidak melihat tab ini.
  { key: "consistency", label: "Konsistensi", supervisorOnly: true },
];

/** Tab yang boleh dilihat sesuai role existing. */
export function visibleInventoryTabs(isSupervisor: boolean) {
  return INVENTORY_TABS.filter((tab) => !tab.supervisorOnly || isSupervisor);
}

// ---------------------------------------------------------------------------
// Kolom tabel — daftar kolom yang SUDAH DIHAPUS dari UI (data tetap tersimpan)
// ---------------------------------------------------------------------------

/** Kolom yang dihapus dari tabel Stok Saat Ini (timestamp tetap ada di DB). */
export const REMOVED_STOCK_COLUMNS = ["Terakhir Diperbarui"] as const;
/** Kolom yang dihapus dari tabel Riwayat Mutasi (catatan tetap ada di DB). */
export const REMOVED_MOVEMENT_COLUMNS = ["Catatan"] as const;
