import { DEFAULT_LOW_STOCK_THRESHOLD } from "./olsera-inventory-core.ts";

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
