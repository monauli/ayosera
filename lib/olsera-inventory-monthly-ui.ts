import { DEFAULT_LOW_STOCK_THRESHOLD, isActiveOrUnknownProduct } from "./olsera-inventory-core.ts";
import { visibleMonthlyInventoryRows, type InventoryActivityRow } from "./olsera-inventory-ui.ts";

export type MonthlyInventoryUiRow = {
  closingQty: number | null;
  unitCost: number | null;
  minimumStock: number;
  trackInventory: boolean;
  hidden: boolean;
  snapshotStatus: "complete" | "boundary-only" | "incomplete";
};

export type MonthlyInventorySummary = {
  totalProducts: number;
  productsWithStock: number;
  outOfStock: number;
  lowStock: number;
  totalStock: number;
  totalValue: number | null;
  usesDefaultThreshold: boolean;
  defaultThreshold: number;
  missingCostRows: number;
};

export function monthlyStockStatus(row: Pick<MonthlyInventoryUiRow, "closingQty" | "minimumStock">): "Aman" | "Hampir Habis" | "Habis" | "Butuh Adjust Manual" {
  if (row.closingQty === null) return "Butuh Adjust Manual";
  if (row.closingQty <= 0) return "Habis";
  if (row.closingQty <= row.minimumStock) return "Hampir Habis";
  return "Aman";
}

export function summarizeMonthlyInventory(rows: readonly MonthlyInventoryUiRow[]): MonthlyInventorySummary {
  const visible = rows.filter((row) => !row.hidden);
  let totalStock = 0;
  let totalValue = 0;
  let missingCostRows = 0;
  let productsWithStock = 0;
  let outOfStock = 0;
  let lowStock = 0;
  let usesDefaultThreshold = false;
  for (const row of visible) {
    if (row.minimumStock === DEFAULT_LOW_STOCK_THRESHOLD) usesDefaultThreshold = true;
    if (row.closingQty === null) {
      missingCostRows++;
      continue;
    }
    totalStock += row.closingQty;
    if (row.closingQty > 0) productsWithStock++;
    else outOfStock++;
    if (row.closingQty > 0 && row.closingQty <= row.minimumStock) lowStock++;
    if (row.unitCost === null) missingCostRows++;
    else totalValue += row.closingQty * row.unitCost;
  }
  return {
    totalProducts: visible.length,
    productsWithStock,
    outOfStock,
    lowStock,
    totalStock,
    totalValue,
    usesDefaultThreshold,
    defaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
    missingCostRows,
  };
}

export function monthlyPeriodStatus(period: string, currentPeriod: string, rows: readonly Pick<MonthlyInventoryUiRow, "snapshotStatus">[]) {
  if (period === currentPeriod) return "Bulan Berjalan / Belum Final" as const;
  if (!rows.length) return "Snapshot Tidak Tersedia" as const;
  return rows.some((row) => row.snapshotStatus !== "complete") ? "Menunggu Validasi" as const : "Final" as const;
}

// ---------------------------------------------------------------------------
// Panel Inventori Olsera bulanan — produk active:false yang TIDAK punya
// pergerakan riil pada periode ini TIDAK relevan lagi ditampilkan (investigasi
// Agustus 2026: 73 vs 40 item dibanding menu "Pergerakan Stok" Olsera sendiri
// — selisih 33 item, SELURUHNYA produk nonaktif tanpa pergerakan). Pola sama
// persis dengan jalur stagnant lib/inventory-stock-opname-store.ts (komit
// 2c2a36d): produk nonaktif yang MASIH bertransaksi periode ini tetap relevan.
// ---------------------------------------------------------------------------

export type MonthlyRelevanceRow = {
  active: boolean;
  incomingQty: number | null;
  returnQty: number | null;
  salesQty: number | null;
  outgoingQty: number | null;
};

/**
 * true bila TIDAK ada pergerakan riil (masuk/retur/jual/keluar) pada periode
 * ini. Saldo (opening/closing) SENGAJA tidak diperiksa — produk idle dengan
 * stok tersisa (opening=closing=N, N!=0, carry-forward) tetap "tidak
 * bergerak": itu saldo warisan bulan lalu, bukan aktivitas periode ini.
 * Beda tujuan dari hasInventoryActivity (lib/olsera-inventory-ui.ts) yang
 * MEMPERTAHANKAN baris bersaldo walau tidak bergerak — di sini justru salah
 * satu syarat MENYINGKIRKAN baris nonaktif-tak-bergerak.
 */
export function hasNoPeriodMovement(row: Pick<MonthlyRelevanceRow, "incomingQty" | "returnQty" | "salesQty" | "outgoingQty">): boolean {
  const isZero = (value: number | null) => value === null || value === 0;
  return isZero(row.incomingQty) && isZero(row.returnQty) && isZero(row.salesQty) && isZero(row.outgoingQty);
}

/**
 * Baris TIDAK relevan lagi (harus dikecualikan dari rows/tabCounts) HANYA
 * bila produknya sudah active:false DAN tidak ada pergerakan riil periode
 * ini — kombinasi keduanya, bukan salah satu saja: produk nonaktif yang
 * MASIH bertransaksi tetap relevan (baru dinonaktifkan setelah bertransaksi).
 */
export function isStagnantInactiveMonthlyRow(row: MonthlyRelevanceRow): boolean {
  return !isActiveOrUnknownProduct(row) && hasNoPeriodMovement(row);
}

/**
 * Filter TUNGGAL dipakai oleh route API panel bulanan sebelum menghitung
 * tabCounts/summary/categories/data — supaya badge tab (mis. "Stok
 * Keseluruhan") SELALU konsisten dengan baris yang benar-benar akan
 * dirender di tabel untuk tab yang sama. Menggabungkan 2 aturan independen:
 * 1. isStagnantInactiveMonthlyRow di atas (produk nonaktif + tak bergerak).
 * 2. visibleMonthlyInventoryRows (Aturan Kedua Inventori: hasInventoryActivity
 *    + kategori tersembunyi LABERS/JASA HOST) — filter yang SAMA yang sudah
 *    dipakai untuk baris yang dirender di tabel (components/olsera-inventory-panel.tsx).
 *    showHiddenItems dikunci false (default tampilan) karena toggle itu murni
 *    state client, tidak dikirim ke server.
 */
export function filterRelevantMonthlyRows<T extends MonthlyRelevanceRow & InventoryActivityRow & { category: unknown }>(rows: readonly T[]): T[] {
  return visibleMonthlyInventoryRows(
    rows.filter((row) => !isStagnantInactiveMonthlyRow(row)),
    false,
  );
}
