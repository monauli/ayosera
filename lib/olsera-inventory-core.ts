// Helper murni modul Inventori Olsera — bebas dependency (tanpa MongoDB/fetch)
// supaya bisa diuji unit dengan node --test. Glue API/DB ada di lib/olsera-inventory.ts.
//
// Fakta API (diverifikasi scripts/inspect-olsera-inventory.ts, payload nyata):
// - Hanya endpoint /product (list + detail) yang tersedia. Endpoint stock movement,
//   warehouse, purchase, transfer, adjustment, dan report inventori semuanya 404.
// - Karena itu histori mutasi resmi TIDAK tersedia → historyCoverage "snapshot-only":
//   stok saat ini disimpan sebagai snapshot, dan mutasi "penjualan" diturunkan dari
//   olsera_order_items (order Olsera nyata hasil sync modul penjualan sejak baseline).

import { OLSERA_INVENTORY_BASELINE_DATE } from "./olsera-baseline.ts";

/** Baseline tetap sync inventori (spesifikasi bisnis) — sumber: lib/olsera-baseline.ts. */
export const INVENTORY_BASELINE_DATE = OLSERA_INVENTORY_BASELINE_DATE;
/** Threshold "hampir habis" bila produk tidak punya low_stock_alert dari Olsera. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

export type InventoryProductInput = {
  _id: string;
  productId: number;
  variantId: number | null;
  sku: string | null;
  barcode: string | null;
  name: string;
  variantName: string | null;
  category: string;
  subCategory: string | null;
  uom: string | null;
  storeId: number | null;
  storeName: string | null;
  active: boolean;
  trackInventory: boolean;
  sellPrice: number;
  buyPrice: number;
  lastBuyPrice: number;
  stockQty: number;
  holdQty: number;
  lowStockAlert: number | null;
  isOutStock: boolean;
  modifiedTime: string | null;
  stockSyncTime: string | null;
};

/** Angka Olsera pada payload produk memakai desimal titik ("78585.42") atau string "0". */
export function toInventoryNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

export function productKey(storeId: number | null, productId: number, variantId: number | null): string {
  return `${storeId ?? 0}:${productId}:${variantId ?? 0}`;
}

/**
 * Ratakan satu baris Product List Olsera (beserta variants embedded) menjadi
 * baris produk inventori. Produk ber-variant menghasilkan satu baris per variant
 * (stok & harga per variant); produk tanpa variant menghasilkan satu baris.
 */
export function flattenOlseraProduct(raw: Record<string, unknown>): InventoryProductInput[] {
  const productId = Number(raw.id);
  if (!Number.isFinite(productId)) return [];
  const storeId = raw.store_id === null || raw.store_id === undefined ? null : Number(raw.store_id);
  const base = {
    productId,
    barcode: textOrNull(raw.barcode),
    name: String(raw.name ?? "").trim(),
    category:
      typeof raw.klasifikasi === "string" && raw.klasifikasi.trim() ? raw.klasifikasi.trim() : "(tanpa klasifikasi)",
    subCategory: textOrNull(raw.category_name),
    uom: textOrNull(raw.uom),
    storeId,
    storeName: textOrNull(raw.store_name),
    trackInventory: Number(raw.track_inventory) === 1,
    modifiedTime: textOrNull(raw.modified_time),
    stockSyncTime: textOrNull(raw.stock_sync_time),
  };

  const variants = Array.isArray(raw.variants) ? (raw.variants as Record<string, unknown>[]) : [];
  if (Number(raw.has_variant) === 1 && variants.length) {
    return variants
      .filter((variant) => Number.isFinite(Number(variant.id)))
      .map((variant) => {
        const variantId = Number(variant.id);
        const lowAlert = toInventoryNumber(raw.low_stock_alert);
        return {
          ...base,
          _id: productKey(storeId, productId, variantId),
          variantId,
          sku: textOrNull(variant.sku) ?? textOrNull(raw.sku),
          barcode: textOrNull(variant.variant_barcode) ?? base.barcode,
          variantName: textOrNull(variant.name),
          active: String(variant.status ?? "A") === "A" && Number(raw.published) === 1,
          sellPrice: toInventoryNumber(variant.sell_price_pos ?? variant.sell_price),
          buyPrice: toInventoryNumber(variant.buy_price),
          lastBuyPrice: toInventoryNumber(variant.last_buy_price),
          stockQty: toInventoryNumber(variant.stock_qty),
          holdQty: toInventoryNumber(variant.hold_qty),
          lowStockAlert: lowAlert > 0 ? lowAlert : null,
          isOutStock: Number(variant.is_out_stock) === 1,
        };
      });
  }

  const lowAlert = toInventoryNumber(raw.low_stock_alert);
  return [
    {
      ...base,
      _id: productKey(storeId, productId, null),
      variantId: null,
      sku: textOrNull(raw.sku),
      variantName: null,
      active: Number(raw.published) === 1,
      sellPrice: toInventoryNumber(raw.sell_price_pos ?? raw.sell_price),
      buyPrice: toInventoryNumber(raw.buy_price),
      lastBuyPrice: toInventoryNumber(raw.last_buy_price),
      stockQty: toInventoryNumber(raw.stock_qty),
      holdQty: toInventoryNumber(raw.hold_qty),
      lowStockAlert: lowAlert > 0 ? lowAlert : null,
      isOutStock: Number(raw.is_out_stock) === 1,
    },
  ];
}

/** Normalisasi nama untuk pencocokan itemName order ↔ katalog produk. */
export function normalizeItemName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Bangun index pencocokan nama → produk. Item order disimpan sebagai
 * "NAMA PRODUK" atau "NAMA PRODUK - NAMA VARIANT" (lihat lib/olsera-sync.ts).
 */
export function buildNameIndex(products: InventoryProductInput[]): Map<string, InventoryProductInput> {
  const index = new Map<string, InventoryProductInput>();
  for (const product of products) {
    const key = product.variantName
      ? normalizeItemName(`${product.name} - ${product.variantName}`)
      : normalizeItemName(product.name);
    if (!index.has(key)) index.set(key, product);
    // Produk tanpa variant juga bisa muncul dengan nama polos meski katalog punya variant default.
    if (product.variantName && !index.has(normalizeItemName(product.name))) {
      index.set(normalizeItemName(product.name), product);
    }
  }
  return index;
}

export type StockStatus = "Aman" | "Hampir Habis" | "Habis" | "Data Tidak Lengkap";

export function stockStatusFor(product: {
  trackInventory: boolean;
  stockQty: number;
  lowStockAlert: number | null;
}): StockStatus {
  if (!product.trackInventory) return "Data Tidak Lengkap";
  const threshold = product.lowStockAlert ?? DEFAULT_LOW_STOCK_THRESHOLD;
  if (product.stockQty <= 0) return "Habis";
  if (product.stockQty <= threshold) return "Hampir Habis";
  return "Aman";
}

/** Nilai persediaan = stok saat ini × harga modal (0 bila stok negatif tidak dihargai? tidak — apa adanya). */
export function inventoryValueFor(product: { stockQty: number; buyPrice: number }): number {
  return product.stockQty * product.buyPrice;
}

export type InventorySummary = {
  totalProducts: number;
  activeProducts: number;
  outOfStock: number;
  lowStock: number;
  totalStock: number;
  totalValue: number;
  /** true bila ada produk yang memakai threshold default (bukan minimum stock Olsera). */
  usesDefaultThreshold: boolean;
  defaultThreshold: number;
};

export function summarizeInventory(products: InventoryProductInput[]): InventorySummary {
  const summary: InventorySummary = {
    totalProducts: products.length,
    activeProducts: 0,
    outOfStock: 0,
    lowStock: 0,
    totalStock: 0,
    totalValue: 0,
    usesDefaultThreshold: false,
    defaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
  };
  for (const product of products) {
    if (product.active) summary.activeProducts++;
    if (!product.trackInventory) continue;
    if (product.lowStockAlert === null) summary.usesDefaultThreshold = true;
    const status = stockStatusFor(product);
    if (status === "Habis") summary.outOfStock++;
    if (status === "Hampir Habis") summary.lowStock++;
    summary.totalStock += product.stockQty;
    summary.totalValue += inventoryValueFor(product);
  }
  return summary;
}

export type ConsistencyStatus = "Cocok" | "Selisih" | "Histori Tidak Lengkap" | "Belum Ada Snapshot";

export type ConsistencyRow = {
  key: string;
  sku: string | null;
  name: string;
  category: string;
  startDate: string | null;
  endDate: string | null;
  startQty: number | null;
  stockIn: number;
  stockOut: number;
  adjustment: number;
  computedEndQty: number | null;
  snapshotEndQty: number | null;
  difference: number | null;
  status: ConsistencyStatus;
};

/**
 * Konsistensi SISTEM per produk: Stok Akhir = Stok Awal + Masuk - Keluar ± Penyesuaian.
 * Periode = snapshot paling awal s/d snapshot terakhir yang tersedia. Mutasi yang
 * diketahui hanya penjualan (API tidak memberi mutasi lain), jadi selisih yang
 * tampil = perubahan yang tidak terekam (pembelian/adjustment manual di Olsera).
 * Kecocokan stok FISIK memerlukan stock opname — tidak dinyatakan di sini.
 */
export function computeConsistency(input: {
  key: string;
  sku: string | null;
  name: string;
  category: string;
  trackInventory: boolean;
  snapshots: { date: string; stockQty: number }[];
  movements: { date: string; qtyChange: number }[];
}): ConsistencyRow {
  const base = {
    key: input.key,
    sku: input.sku,
    name: input.name,
    category: input.category,
    stockIn: 0,
    stockOut: 0,
    adjustment: 0,
  };
  if (!input.snapshots.length) {
    return {
      ...base,
      startDate: null,
      endDate: null,
      startQty: null,
      computedEndQty: null,
      snapshotEndQty: null,
      difference: null,
      status: "Belum Ada Snapshot",
    };
  }
  const sorted = [...input.snapshots].sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  let stockIn = 0;
  let stockOut = 0;
  for (const movement of input.movements) {
    // Mutasi dihitung SETELAH snapshot awal sampai dengan snapshot akhir.
    if (movement.date <= first.date || movement.date > last.date) continue;
    if (movement.qtyChange >= 0) stockIn += movement.qtyChange;
    else stockOut += -movement.qtyChange;
  }
  const computedEndQty = first.stockQty + stockIn - stockOut;
  const difference = last.stockQty - computedEndQty;

  let status: ConsistencyStatus;
  if (!input.trackInventory) status = "Histori Tidak Lengkap";
  else if (first.date === last.date) status = "Histori Tidak Lengkap";
  else if (Math.abs(difference) < 0.001) status = "Cocok";
  else status = "Selisih";

  return {
    ...base,
    startDate: first.date,
    endDate: last.date,
    startQty: first.stockQty,
    stockIn,
    stockOut,
    adjustment: 0,
    computedEndQty,
    snapshotEndQty: last.stockQty,
    difference,
    status,
  };
}

/** Daftar tanggal inklusif start..end (YYYY-MM-DD). */
export function dateRangeList(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = nextDate(date)) dates.push(date);
  return dates;
}

function nextDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Susun antrian tanggal sebuah run: tanggal gagal run sebelumnya diprioritaskan
 * di depan, lalu rentang start..end. Duplikat dibuang, urutan stabil.
 */
export function buildPendingDates(previousFailed: string[], startDate: string, endDate: string): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const date of [...previousFailed].sort()) {
    if (!seen.has(date) && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      seen.add(date);
      queue.push(date);
    }
  }
  for (const date of dateRangeList(startDate, endDate)) {
    if (!seen.has(date)) {
      seen.add(date);
      queue.push(date);
    }
  }
  return queue;
}
