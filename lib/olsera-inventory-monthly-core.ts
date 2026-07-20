// Helper murni untuk Export Inventori Bulanan (format "Laporan Stock Opname"
// perusahaan) — bebas dependency ExcelJS/MongoDB supaya bisa diuji unit dengan
// node --test. Glue (baca file upload, query Mongo, tulis workbook) ada di
// lib/olsera-inventory-monthly-export.ts.
//
// Sumber data (lihat audit): API Olsera TIDAK menyediakan endpoint Pergerakan
// Stok (stockmovement/export/summary dan seluruh variannya terverifikasi 404
// lewat kredensial Open API existing) — komponen Stok Awal/Barang Masuk/
// Pengembalian/Keluar/Produksi/Koreksi Opname WAJIB berasal dari file Excel
// resmi yang diunggah manual (export Backoffice Olsera), BUKAN dari sync
// otomatis. Penjualan harian tetap dari olsera_inventory_movements existing
// (sudah upsert-dedup per orderItemId, sudah mengecualikan order
// dibatalkan/void — lihat lib/olsera-sync.ts).
import {
  buildMovementNameIndex,
  normalizeItemName,
  productKey,
  type InventoryProductInput,
  type MovementProductMethod,
} from "./olsera-inventory-core.ts";

// ---------------------------------------------------------------------------
// Parsing & validasi struktur file summary Olsera
// ---------------------------------------------------------------------------

/** Urutan header persis yang diamati pada export resmi Olsera (huruf kecil semua). */
export const SUMMARY_EXPECTED_HEADERS = [
  "group",
  "product",
  "product sku",
  "product uom",
  "begining",
  "incoming",
  "return",
  "sales",
  "outgoing",
  "production_in",
  "production_out",
  "opname",
  "balance",
] as const;

export type SummaryRow = {
  rowIndex: number;
  group: string;
  product: string;
  sku: string | null;
  uom: string | null;
  begining: number;
  incoming: number;
  return: number;
  sales: number;
  outgoing: number;
  productionIn: number;
  productionOut: number;
  opname: number;
  balance: number;
  createdBy: string | null;
  createdTime: string | null;
};

function normalizeHeaderCell(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Validasi header persis cocok dengan kolom wajib (urutan & nama, huruf kecil).
 * "created_by"/"created_time" opsional (tidak wajib ada, tidak divalidasi urutannya).
 */
export function validateSummaryHeader(headerRow: unknown[]): string[] {
  const errors: string[] = [];
  const normalized = headerRow.map(normalizeHeaderCell);
  SUMMARY_EXPECTED_HEADERS.forEach((expected, index) => {
    if (normalized[index] !== expected) {
      errors.push(`Kolom ke-${index + 1} seharusnya "${expected}", ditemukan "${normalized[index] ?? "(kosong)"}".`);
    }
  });
  return errors;
}

function toRowNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toTextOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

export type ParseSummaryResult = {
  rows: SummaryRow[];
  /** Baris kosong (tanpa nama produk) yang dilewati — bukan error. */
  skippedBlankRows: number;
};

/**
 * Ubah baris mentah (array-of-array, hasil sheet_to_json header:1) tanpa
 * header menjadi SummaryRow[] tervalidasi tipe. Pemanggil wajib memvalidasi
 * header lebih dulu lewat validateSummaryHeader.
 */
export function parseSummaryRows(dataRows: unknown[][]): ParseSummaryResult {
  const rows: SummaryRow[] = [];
  let skippedBlankRows = 0;
  dataRows.forEach((raw, index) => {
    const product = toTextOrNull(raw[1]);
    if (!product) {
      skippedBlankRows++;
      return;
    }
    rows.push({
      rowIndex: index,
      group: toTextOrNull(raw[0]) ?? "(Tanpa Group)",
      product,
      sku: toTextOrNull(raw[2]),
      uom: toTextOrNull(raw[3]),
      begining: toRowNumber(raw[4]),
      incoming: toRowNumber(raw[5]),
      return: toRowNumber(raw[6]),
      sales: toRowNumber(raw[7]),
      outgoing: toRowNumber(raw[8]),
      productionIn: toRowNumber(raw[9]),
      productionOut: toRowNumber(raw[10]),
      opname: toRowNumber(raw[11]),
      balance: toRowNumber(raw[12]),
      createdBy: toTextOrNull(raw[13]),
      createdTime: toTextOrNull(raw[14]),
    });
  });
  return { rows, skippedBlankRows };
}

/** Kunci duplikasi: group+product+sku ternormalisasi (satu-satunya identitas yang tersedia di file). */
export function duplicateKeyFor(row: Pick<SummaryRow, "group" | "product" | "sku">): string {
  return `${normalizeItemName(row.group)}|${normalizeItemName(row.product)}|${row.sku ? normalizeItemName(row.sku) : ""}`;
}

export type DuplicateGroup = { key: string; rowIndexes: number[] };

/** Baris dengan kunci (group+product+sku) yang sama persis lebih dari sekali — wajib dilaporkan, tidak digabung otomatis. */
export function detectDuplicateSummaryRows(rows: SummaryRow[]): DuplicateGroup[] {
  const byKey = new Map<string, number[]>();
  for (const row of rows) {
    const key = duplicateKeyFor(row);
    const list = byKey.get(key) ?? [];
    list.push(row.rowIndex);
    byKey.set(key, list);
  }
  return [...byKey.entries()].filter(([, idx]) => idx.length > 1).map(([key, rowIndexes]) => ({ key, rowIndexes }));
}

/**
 * created_time (bila ada) di luar rentang periode yang diminta — indikasi file
 * salah periode atau berisi transaksi dari bulan lain. Tanggal diekstrak dari
 * awal string "YYYY-MM-DD ..."; baris tanpa created_time tidak dianggap error
 * (field opsional pada beberapa baris agregat).
 */
export function findRowsOutsidePeriod(rows: SummaryRow[], startDate: string, endDate: string): number[] {
  const outside: number[] = [];
  for (const row of rows) {
    if (!row.createdTime) continue;
    const match = row.createdTime.match(/^\d{4}-\d{2}-\d{2}/);
    if (!match) continue;
    const date = match[0];
    if (date < startDate || date > endDate) outside.push(row.rowIndex);
  }
  return outside;
}

// ---------------------------------------------------------------------------
// Pemetaan produk: SKU → nama ternormalisasi. storeId+productId+variantId
// (prioritas #1 sesuai spesifikasi) TIDAK TERSEDIA di file summary Olsera —
// file ini tidak menyertakan ID apa pun, hanya group/nama/SKU. Keterbatasan
// ini dilaporkan di setiap hasil match sebagai method, bukan disembunyikan.
// ---------------------------------------------------------------------------

function normalizeSku(value: string): string {
  return value.trim().toUpperCase();
}

/** Index katalog per SKU ternormalisasi — SEMUA kandidat disimpan (deteksi ambigu, bukan pemenang pertama). */
export function buildSkuIndex(products: InventoryProductInput[]): Map<string, InventoryProductInput[]> {
  const index = new Map<string, InventoryProductInput[]>();
  for (const product of products) {
    if (!product.sku) continue;
    const key = normalizeSku(product.sku);
    const list = index.get(key) ?? [];
    list.push(product);
    index.set(key, list);
  }
  return index;
}

export type MonthlyMatchMethod =
  | "sku"
  | "name"
  | "alias"
  | "name-prefix-stripped"
  | "ambiguous-sku"
  | "ambiguous-name"
  | "unmatched";

export type MonthlyMatchResult = {
  product: InventoryProductInput | null;
  method: MonthlyMatchMethod;
  note: string;
};

const MONTHLY_MATCH_NOTE: Record<MonthlyMatchMethod, string> = {
  sku: "Dipetakan dari SKU (kandidat tunggal)",
  name: "Dipetakan dari nama ternormalisasi (fallback — file summary Olsera tidak menyertakan productId/variantId)",
  alias: "Dipetakan lewat alias nama eksplisit (MONTHLY_NAME_ALIASES) — sudah diverifikasi manual sebagai produk yang sama",
  "name-prefix-stripped":
    "Dipetakan setelah menghapus prefix kategori generik (BOLA/BOLA PADEL/GRIP) dari nama file summary — hasil tetap harus unik",
  "ambiguous-sku": "SKU cocok lebih dari satu produk katalog — tidak dipetakan otomatis",
  "ambiguous-name": "Nama produk (termasuk setelah hapus prefix generik) cocok lebih dari satu produk katalog — tidak dipetakan otomatis",
  unmatched: "Tidak ditemukan di katalog produk (SKU maupun nama, termasuk setelah hapus prefix generik, tidak cocok)",
};

/**
 * Prefix kategori generik yang kadang ditempel di depan nama produk pada file
 * summary Olsera tapi TIDAK ada di nama katalog produk (mis. "BOLA HEAD PRO
 * ISI 3" di file summary vs "HEAD PRO ISI 3" di katalog). Urutan PENTING —
 * prefix lebih panjang dicoba lebih dulu ("BOLA PADEL" sebelum "BOLA") supaya
 * "BOLA PADEL HEAD PRO S+ ISI 3" menghasilkan "HEAD PRO S+ ISI 3", bukan
 * "PADEL HEAD PRO S+ ISI 3". HANYA menghapus prefix di AWAL nama (bukan
 * substring di tengah/akhir) — tidak pernah mengubah kata lain dalam nama,
 * sehingga tidak bisa mencocokkan dua produk yang benar-benar berbeda hanya
 * karena kebetulan berbagi prefix kategori.
 */
export const GENERIC_CATEGORY_PREFIXES = ["BOLA PADEL", "BOLA", "GRIP"] as const;

/** null bila nama tidak diawali salah satu prefix generik (atau tidak ada sisa setelah dihapus). */
export function stripGenericCategoryPrefix(normalizedName: string): string | null {
  for (const prefix of GENERIC_CATEGORY_PREFIXES) {
    if (normalizedName.startsWith(`${prefix} `)) {
      const rest = normalizedName.slice(prefix.length).trim();
      if (rest) return rest;
    }
  }
  return null;
}

/**
 * Alias nama eksplisit untuk kasus yang SUDAH diverifikasi manual (mis. lewat
 * katalog Mongo live) sebagai produk yang benar-benar sama — bukan tebakan
 * otomatis. Key & value adalah hasil normalizeItemName.
 *
 * SENGAJA DIBIARKAN KOSONG untuk "BOLA PADEL ODEA ROSE" ↔ "BOLA PADEL ODEA":
 * inspeksi API Olsera langsung (scripts/inspect-olsera-inventory.ts) pernah
 * menemukan produk katalog nyata bernama "BOLA PADEL ODEA RED" sebagai entri
 * TERPISAH (varian warna dijual sebagai produk sendiri, bukan variant dari
 * satu produk induk) — artinya "ODEA ROSE" kemungkinan besar produk warna
 * lain yang berbeda dari "ODEA", bukan penulisan berbeda untuk produk yang
 * sama. Menyamakan keduanya secara otomatis berisiko menggabungkan stok dua
 * produk berbeda. Baris ini WAJIB tetap muncul di Diagnostik Import sampai
 * dikonfirmasi manual terhadap katalog Mongo live (lihat SKU di Olsera).
 */
export const MONTHLY_NAME_ALIASES: Record<string, string> = {};

/**
 * Cocokkan satu baris file summary ke katalog produk (olsera_inventory_products).
 * Prioritas: SKU exact → productId+variantId (TIDAK TERSEDIA di file summary
 * Olsera — dilewati, bukan ditebak) → nama ternormalisasi exact → alias nama
 * eksplisit (MONTHLY_NAME_ALIASES, hanya pasangan yang sudah terverifikasi
 * manual) → nama setelah prefix kategori generik dihapus (hanya bila hasilnya
 * tetap unik). Tidak pernah memilih kandidat pertama secara sembarang saat
 * ambigu, di jalur manapun.
 */
export function matchSummaryRowToProduct(
  row: Pick<SummaryRow, "product" | "sku">,
  skuIndex: Map<string, InventoryProductInput[]>,
  nameIndex: Map<string, InventoryProductInput[]>,
): MonthlyMatchResult {
  if (row.sku) {
    const candidates = skuIndex.get(normalizeSku(row.sku)) ?? [];
    if (candidates.length === 1) return { product: candidates[0], method: "sku", note: MONTHLY_MATCH_NOTE.sku };
    if (candidates.length > 1) {
      return { product: null, method: "ambiguous-sku", note: MONTHLY_MATCH_NOTE["ambiguous-sku"] };
    }
    // SKU diisi tapi tidak ditemukan di katalog — lanjut ke fallback nama.
  }

  const normalized = normalizeItemName(row.product);
  const exactCandidates = nameIndex.get(normalized) ?? [];
  if (exactCandidates.length === 1) return { product: exactCandidates[0], method: "name", note: MONTHLY_MATCH_NOTE.name };
  if (exactCandidates.length > 1) {
    return { product: null, method: "ambiguous-name", note: MONTHLY_MATCH_NOTE["ambiguous-name"] };
  }

  const aliasTarget = MONTHLY_NAME_ALIASES[normalized];
  if (aliasTarget) {
    const aliasCandidates = nameIndex.get(aliasTarget) ?? [];
    if (aliasCandidates.length === 1) return { product: aliasCandidates[0], method: "alias", note: MONTHLY_MATCH_NOTE.alias };
    if (aliasCandidates.length > 1) {
      return { product: null, method: "ambiguous-name", note: MONTHLY_MATCH_NOTE["ambiguous-name"] };
    }
  }

  const stripped = stripGenericCategoryPrefix(normalized);
  if (stripped) {
    const strippedCandidates = nameIndex.get(stripped) ?? [];
    if (strippedCandidates.length === 1) {
      return { product: strippedCandidates[0], method: "name-prefix-stripped", note: MONTHLY_MATCH_NOTE["name-prefix-stripped"] };
    }
    if (strippedCandidates.length > 1) {
      return { product: null, method: "ambiguous-name", note: MONTHLY_MATCH_NOTE["ambiguous-name"] };
    }
  }

  return { product: null, method: "unmatched", note: MONTHLY_MATCH_NOTE.unmatched };
}

export { buildMovementNameIndex, normalizeItemName, productKey };
export type { InventoryProductInput, MovementProductMethod };

// ---------------------------------------------------------------------------
// Formula Stok Akhir Sistem (mengikuti komponen Pergerakan Stok Olsera yang
// terverifikasi — lihat audit: Keluar perusahaan = opname Olsera, bukan
// outgoing. return/production_in/production_out selalu 0 pada data Juni yang
// tersedia sehingga arah tandanya tidak bisa dibuktikan dari data — dilipat
// ke Barang Masuk/Keluar mengikuti konvensi penamaan Olsera sendiri (return &
// production_in menambah stok, production_out & opname mengurangi, sama
// seperti outgoing) supaya formula tetap benar bila nilainya tidak nol di
// bulan lain, TANPA menambah kolom baru di format visual perusahaan.
// ---------------------------------------------------------------------------

/** Barang Masuk (tampil) = incoming + return + production_in. */
export function computeDisplayedBarangMasuk(row: Pick<SummaryRow, "incoming" | "return" | "productionIn">): number {
  return row.incoming + row.return + row.productionIn;
}

/** Keluar (tampil) = outgoing + production_out + opname (koreksi stock opname). */
export function computeDisplayedKeluar(row: Pick<SummaryRow, "outgoing" | "productionOut" | "opname">): number {
  return row.outgoing + row.productionOut + row.opname;
}

/** Stok Akhir Sistem = Stok Awal + Barang Masuk − Total Penjualan (AYOSERA) − Keluar. */
export function computeStockAkhirSistem(input: {
  stokAwal: number;
  barangMasuk: number;
  totalPenjualan: number;
  keluar: number;
}): number {
  return input.stokAwal + input.barangMasuk - input.totalPenjualan - input.keluar;
}

// ---------------------------------------------------------------------------
// Kalender bulan & agregasi penjualan harian
// ---------------------------------------------------------------------------

/** Jumlah hari pada bulan tertentu (month 1-12), termasuk tahun kabisat. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthDateRange(year: number, month: number): { startDate: string; endDate: string; days: number } {
  const days = daysInMonth(year, month);
  const mm = String(month).padStart(2, "0");
  return {
    startDate: `${year}-${mm}-01`,
    endDate: `${year}-${mm}-${String(days).padStart(2, "0")}`,
    days,
  };
}

export type DailySalesInput = { key: string; date: string; qtyChange: number };

export type DailySalesAggregate = { daily: number[]; total: number };

/**
 * Agregasi qty terjual per produk (key = productKey) × hari (index 0 = tanggal
 * 1). qtyChange dari olsera_inventory_movements disimpan negatif untuk
 * penjualan — hasil agregasi berupa qty POSITIF. Movement dengan key kosong
 * (productId null — item tidak match katalog, mis. add-on lepas yang bukan
 * produk stok, atau item tidak dikenali) TIDAK disertakan oleh pemanggil
 * (lihat lib/olsera-inventory-monthly-export.ts — hanya movement dengan
 * productId terisi yang dipetakan ke sini).
 */
export function aggregateDailySales(
  movements: DailySalesInput[],
  year: number,
  month: number,
): Map<string, DailySalesAggregate> {
  const { days, startDate, endDate } = monthDateRange(year, month);
  const result = new Map<string, DailySalesAggregate>();
  for (const movement of movements) {
    if (movement.date < startDate || movement.date > endDate) continue;
    const dayIndex = Number(movement.date.slice(8, 10)) - 1;
    if (dayIndex < 0 || dayIndex >= days) continue;
    const entry = result.get(movement.key) ?? { daily: new Array(days).fill(0), total: 0 };
    const qty = -movement.qtyChange;
    entry.daily[dayIndex] += qty;
    entry.total += qty;
    result.set(movement.key, entry);
  }
  return result;
}
