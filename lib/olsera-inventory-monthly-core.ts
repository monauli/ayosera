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
  dateRangeList,
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

// ---------------------------------------------------------------------------
// Jalur OTOMATIS: GET /api/open-api/v1/en/inventory/stockmovement (Open API
// Olsera) — terverifikasi 20 Juli 2026 terhadap doc export/summary-2026-06-01
// __2026-06-30.xlsx: 33/33 produk cocok persis (beginning, incoming+return,
// sales, sisa) dan sum_outgoing_qty API == outgoing+production_out+opname
// file untuk SETIAP baris (Olsera sudah menggabungkan opname/koreksi stock ke
// "outgoing" di endpoint ini — bukan komponen terpisah seperti file summary
// manual). Karena itu formula jalur otomatis LEBIH SEDERHANA dari jalur upload
// manual di atas: Barang Masuk = incoming+return, Keluar = outgoing (apa
// adanya, tanpa perlu menjumlahkan production_out/opname terpisah — sudah
// termasuk). Baris API menyertakan storeId/productId/variantId asli — jalur
// ini TIDAK PERLU fallback nama sebagai prioritas utama seperti file summary
// manual (yang tidak punya ID sama sekali).
// ---------------------------------------------------------------------------

export type StockMovementApiRow = {
  storeId: number;
  storeName: string | null;
  productId: number;
  productGroupName: string | null;
  productName: string;
  productSku: string | null;
  productVariantId: number | null;
  productVariantName: string | null;
  productVariantSku: string | null;
  beginningQty: number;
  incomingQty: number;
  returnQty: number;
  salesQty: number;
  outgoingQty: number;
  sisa: number;
};

function apiNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function apiTextOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function apiIdOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Ubah satu baris mentah GET .../en/inventory/stockmovement menjadi
 * StockMovementApiRow tervalidasi tipe. null bila product_id tidak ada/tidak
 * valid (baris tidak bisa dipakai sama sekali) — pemanggil menghitungnya
 * sebagai baris yang dilewati, bukan error fatal (satu baris rusak tidak
 * boleh menggagalkan seluruh halaman).
 */
export function parseStockMovementApiRow(raw: Record<string, unknown>): StockMovementApiRow | null {
  const productId = apiIdOrNull(raw.product_id);
  const storeIdRaw = apiIdOrNull(raw.store_id);
  if (productId === null) return null;
  return {
    storeId: storeIdRaw ?? 0,
    storeName: apiTextOrNull(raw.store_name),
    productId,
    productGroupName: apiTextOrNull(raw.product_group_name),
    productName: apiTextOrNull(raw.product_name) ?? "",
    productSku: apiTextOrNull(raw.product_sku),
    productVariantId: apiIdOrNull(raw.product_variant_id),
    productVariantName: apiTextOrNull(raw.product_variant_name),
    productVariantSku: apiTextOrNull(raw.product_variant_sku),
    beginningQty: apiNumber(raw.beginning_qty),
    incomingQty: apiNumber(raw.sum_incoming_qty),
    returnQty: apiNumber(raw.sum_return_qty),
    salesQty: apiNumber(raw.sum_sales_qty),
    outgoingQty: apiNumber(raw.sum_outgoing_qty),
    sisa: apiNumber(raw.sisa),
  };
}

/** Barang Masuk (jalur otomatis) = incoming + return. Tidak ada production_in di endpoint ini. */
export function computeBarangMasukFromStockMovement(row: Pick<StockMovementApiRow, "incomingQty" | "returnQty">): number {
  return row.incomingQty + row.returnQty;
}

/**
 * Keluar (jalur otomatis) = outgoing API apa adanya — SUDAH menggabungkan
 * koreksi stock opname/production_out (terverifikasi per-baris terhadap file
 * Juni 2026, lihat komentar di atas). Fungsi ini murni identitas, dipertahankan
 * supaya pemanggil tidak perlu tahu detail ini dan supaya simetris dengan
 * computeBarangMasukFromStockMovement bila Olsera mengubah struktur di masa depan.
 */
export function computeKeluarFromStockMovement(row: Pick<StockMovementApiRow, "outgoingQty">): number {
  return row.outgoingQty;
}

/**
 * Alias nama eksplisit untuk jalur OTOMATIS — dipakai HANYA sebagai langkah 4
 * (setelah identity, SKU, dan nama exact gagal), dan HANYA bila nama target
 * menghasilkan kandidat TUNGGAL di katalog.
 *
 * SENGAJA KOSONG. Entri ODEA ("BOLA PADEL ODEA ROSE" -> "BOLA PADEL ODEA")
 * dihapus 2026-08-26 setelah diverifikasi terhadap katalog Mongo produksi:
 * entri itu TIDAK PERNAH bisa aktif, dua sebab independen —
 *   1. baris API bernama "BOLA PADEL ODEA ROSE" sudah cocok di langkah 1 lewat
 *      productId 116138490 yang ada di katalog, jadi tidak pernah sampai ke
 *      langkah alias; dan
 *   2. katalog tidak punya produk bernama "BOLA PADEL ODEA" (hanya "... ODEA
 *      ROSE" dan "... ODEA RED"), sehingga lookup target selalu nol kandidat.
 * Pemetaan identitas lama→baru untuk pasangan ini ditangani di tempat yang
 * benar: olsera_product_aliases (106817649 -> 116138490, confidence "verified").
 */
export const STOCKMOVEMENT_NAME_ALIASES: Record<string, string> = {};

export type StockMovementMatchMethod = "identity" | "sku" | "name" | "alias" | "name-prefix-stripped" | "ambiguous-sku" | "ambiguous-name" | "unmatched";

export type StockMovementMatchResult = {
  product: InventoryProductInput | null;
  method: StockMovementMatchMethod;
  note: string;
};

const STOCKMOVEMENT_MATCH_NOTE: Record<StockMovementMatchMethod, string> = {
  identity: "Dipetakan dari storeId+productId+variantId (identitas Open API Olsera)",
  sku: "Dipetakan dari SKU (kandidat tunggal, identitas tidak cocok)",
  name: "Dipetakan dari nama ternormalisasi (fallback — identitas & SKU tidak cocok)",
  alias: "Dipetakan lewat alias nama eksplisit (STOCKMOVEMENT_NAME_ALIASES) — verifikasi pengguna, BELUM diverifikasi ulang terhadap katalog Mongo live",
  "name-prefix-stripped":
    "Dipetakan setelah menghapus prefix kategori generik (BOLA/BOLA PADEL/GRIP) dari product_name Open API — hasil tetap harus unik (mis. \"BOLA HEAD PRO ISI 3\" API → \"HEAD PRO ISI 3\" katalog)",
  "ambiguous-sku": "SKU cocok lebih dari satu produk katalog — tidak dipetakan otomatis",
  "ambiguous-name": "Nama produk cocok lebih dari satu produk katalog — tidak dipetakan otomatis",
  unmatched: "Tidak ditemukan di katalog produk (identitas, SKU, maupun nama tidak cocok)",
};

/** Index katalog per _id (storeId:productId:variantId) — pencarian identitas O(1). */
export function buildProductIdentityIndex(products: InventoryProductInput[]): Map<string, InventoryProductInput> {
  const index = new Map<string, InventoryProductInput>();
  for (const product of products) index.set(product._id, product);
  return index;
}

/**
 * Cocokkan satu baris stockmovement API ke katalog produk. Prioritas WAJIB:
 * 1. storeId+productId+variantId (identitas asli dari Open API — TERSEDIA di
 *    endpoint ini, tidak seperti file summary manual) → dipilih langsung bila
 *    ada di katalog, tidak pernah ambigu (kunci unik per definisi).
 * 2. SKU exact (variant SKU diutamakan atas SKU produk), HANYA bila hasilnya
 *    kandidat tunggal.
 * 3. Nama ternormalisasi exact (termasuk suffix " - Variant"), HANYA bila
 *    kandidat tunggal.
 * 4. Alias nama eksplisit (STOCKMOVEMENT_NAME_ALIASES).
 * 5. Tidak ada yang cocok / ambigu → product null + note jelas, TIDAK PERNAH
 *    menebak kandidat pertama.
 */
export function matchStockMovementRowToProduct(
  row: Pick<
    StockMovementApiRow,
    "storeId" | "productId" | "productVariantId" | "productSku" | "productVariantSku" | "productName" | "productVariantName"
  >,
  identityIndex: Map<string, InventoryProductInput>,
  skuIndex: Map<string, InventoryProductInput[]>,
  nameIndex: Map<string, InventoryProductInput[]>,
): StockMovementMatchResult {
  const identityKey = productKey(row.storeId, row.productId, row.productVariantId);
  const identityMatch = identityIndex.get(identityKey);
  if (identityMatch) return { product: identityMatch, method: "identity", note: STOCKMOVEMENT_MATCH_NOTE.identity };

  const candidateSku = row.productVariantSku ?? row.productSku;
  if (candidateSku) {
    const skuCandidates = skuIndex.get(candidateSku.trim().toUpperCase()) ?? [];
    if (skuCandidates.length === 1) return { product: skuCandidates[0], method: "sku", note: STOCKMOVEMENT_MATCH_NOTE.sku };
    if (skuCandidates.length > 1) {
      return { product: null, method: "ambiguous-sku", note: STOCKMOVEMENT_MATCH_NOTE["ambiguous-sku"] };
    }
  }

  const fullName = row.productVariantName ? `${row.productName} - ${row.productVariantName}` : row.productName;
  const normalized = normalizeItemName(fullName);
  const nameCandidates = nameIndex.get(normalized) ?? [];
  if (nameCandidates.length === 1) return { product: nameCandidates[0], method: "name", note: STOCKMOVEMENT_MATCH_NOTE.name };
  if (nameCandidates.length > 1) {
    return { product: null, method: "ambiguous-name", note: STOCKMOVEMENT_MATCH_NOTE["ambiguous-name"] };
  }

  const aliasTarget = STOCKMOVEMENT_NAME_ALIASES[normalized];
  if (aliasTarget) {
    const aliasCandidates = nameIndex.get(aliasTarget) ?? [];
    if (aliasCandidates.length === 1) return { product: aliasCandidates[0], method: "alias", note: STOCKMOVEMENT_MATCH_NOTE.alias };
    if (aliasCandidates.length > 1) {
      return { product: null, method: "ambiguous-name", note: STOCKMOVEMENT_MATCH_NOTE["ambiguous-name"] };
    }
  }

  // product_name Open API kadang membawa prefix kategori generik yang TIDAK
  // ada di nama katalog (mis. "BOLA HEAD PRO ISI 3" API vs "HEAD PRO ISI 3"
  // katalog) — sama seperti jalur upload manual (stripGenericCategoryPrefix).
  // HANYA dipakai bila hasilnya tetap kandidat tunggal.
  const stripped = stripGenericCategoryPrefix(normalized);
  if (stripped) {
    const strippedCandidates = nameIndex.get(stripped) ?? [];
    if (strippedCandidates.length === 1) {
      return { product: strippedCandidates[0], method: "name-prefix-stripped", note: STOCKMOVEMENT_MATCH_NOTE["name-prefix-stripped"] };
    }
    if (strippedCandidates.length > 1) {
      return { product: null, method: "ambiguous-name", note: STOCKMOVEMENT_MATCH_NOTE["ambiguous-name"] };
    }
  }

  return { product: null, method: "unmatched", note: STOCKMOVEMENT_MATCH_NOTE.unmatched };
}

export type MatchedMovement = { row: StockMovementApiRow; method: StockMovementMatchMethod; note: string };

export type UnmatchedMovementEntry = {
  rowIndex: number;
  group: string;
  product: string;
  sku: string | null;
  method: StockMovementMatchMethod;
  note: string;
};

/**
 * Cocokkan seluruh baris stockmovement API SATU bulan/jendela ke katalog
 * produk, dikunci per product._id (identitas unik) — dipakai baik oleh
 * pipeline snapshot bulanan (lib/olsera-inventory-monthly-snapshot-store.ts,
 * satu bulan per panggilan) maupun oleh diagnostik. Baris yang tidak cocok/
 * ambigu ATAU dobel-match ke produk yang sama dilaporkan ke
 * `unmatchedOrAmbiguous`, tidak pernah ditebak.
 */
export function attachMovementsToProducts(
  rows: StockMovementApiRow[],
  identityIndex: Map<string, InventoryProductInput>,
  skuIndex: Map<string, InventoryProductInput[]>,
  nameIndex: Map<string, InventoryProductInput[]>,
  windowLabel: string,
  unmatchedOrAmbiguous: UnmatchedMovementEntry[],
): Map<string, MatchedMovement> {
  const byProductId = new Map<string, MatchedMovement>();
  for (const row of rows) {
    const match = matchStockMovementRowToProduct(row, identityIndex, skuIndex, nameIndex);
    const fullProductName = row.productVariantName ? `${row.productName} - ${row.productVariantName}` : row.productName;

    if (["ambiguous-sku", "ambiguous-name", "unmatched"].includes(match.method) || !match.product) {
      unmatchedOrAmbiguous.push({
        rowIndex: unmatchedOrAmbiguous.length,
        group: row.productGroupName ?? "(Tanpa Group)",
        product: fullProductName,
        sku: row.productVariantSku ?? row.productSku,
        method: match.method,
        note: `[${windowLabel}] ${match.note}`,
      });
      continue;
    }

    if (byProductId.has(match.product._id)) {
      unmatchedOrAmbiguous.push({
        rowIndex: unmatchedOrAmbiguous.length,
        group: row.productGroupName ?? "(Tanpa Group)",
        product: fullProductName,
        sku: row.productVariantSku ?? row.productSku,
        method: "ambiguous-sku",
        note: `[${windowLabel}] Lebih dari satu baris stockmovement API cocok ke produk katalog yang sama (${match.product._id}) — baris ini tidak dipetakan, periksa manual.`,
      });
      continue;
    }
    byProductId.set(match.product._id, { row, method: match.method, note: match.note });
  }
  return byProductId;
}

export type DuplicateNamedProduct = {
  _id: string;
  productId: number;
  variantId: number | null;
  sku: string | null;
  name: string;
  variantName: string | null;
  storeName: string | null;
};

/**
 * Audit katalog: produk yang namanya mengandung kata "duplicate" (case-
 * insensitive) — biasanya penanda manual di Olsera untuk entri yang belum
 * dibereskan (SKU pindah toko, produk lama yang ditinggal, dsb). HANYA
 * melaporkan — TIDAK PERNAH menghapus atau menggabungkan otomatis, sesuai
 * instruksi. Pemanggil menampilkan ini di sheet Diagnostik supaya ditinjau
 * manual terhadap katalog Mongo (olsera_inventory_products).
 */
export function findDuplicateNamedProducts(products: InventoryProductInput[]): DuplicateNamedProduct[] {
  const found: DuplicateNamedProduct[] = [];
  for (const product of products) {
    const haystack = `${product.name} ${product.variantName ?? ""}`;
    if (/duplicate/i.test(haystack)) {
      found.push({
        _id: product._id,
        productId: product.productId,
        variantId: product.variantId,
        sku: product.sku,
        name: product.name,
        variantName: product.variantName,
        storeName: product.storeName,
      });
    }
  }
  return found;
}

export type DuplicateResolutionEntry = {
  productId: number;
  variantId: number | null;
  sku: string | null;
  name: string;
  storeName: string | null;
  resolution: "merged-into-canonical" | "needs-manual-review";
  canonicalProductId: number | null;
  canonicalVariantId: number | null;
  note: string;
};

export type DuplicateResolution = {
  /** _id (storeId:productId:variantId) produk "duplicate" yang TERBUKTI (SKU sama persis, tidak ambigu) produk yang sama dengan entri katalog lain — dikecualikan dari baris laporan supaya tidak dobel. */
  excludedIds: string[];
  entries: DuplicateResolutionEntry[];
};

/**
 * Audit + resolusi produk bernama "duplicate": HANYA digabung (dikecualikan
 * dari baris laporan) bila SKU-nya sama persis dengan SATU produk katalog
 * lain yang BUKAN juga bernama "duplicate" (bukti identity/data katalog,
 * bukan tebakan nama). Selain itu ("duplicate" tanpa SKU, atau SKU tidak
 * cocok tunggal) TETAP TAMPIL sebagai baris terpisah + ditandai untuk
 * tinjauan manual — TIDAK PERNAH dihapus hanya karena mengandung kata
 * "duplicate" di namanya.
 */
export function resolveDuplicateNamedProducts(products: InventoryProductInput[]): DuplicateResolution {
  const duplicates = findDuplicateNamedProducts(products);
  const bySku = new Map<string, InventoryProductInput[]>();
  for (const p of products) {
    if (!p.sku) continue;
    const key = p.sku.trim().toUpperCase();
    const list = bySku.get(key) ?? [];
    list.push(p);
    bySku.set(key, list);
  }

  const excludedIds: string[] = [];
  const entries: DuplicateResolutionEntry[] = [];
  for (const dup of duplicates) {
    const skuKey = dup.sku ? dup.sku.trim().toUpperCase() : null;
    const candidates = skuKey ? bySku.get(skuKey) ?? [] : [];
    const otherCandidates = candidates.filter((c) => c._id !== dup._id);
    const nonDuplicateOthers = otherCandidates.filter((c) => !/duplicate/i.test(`${c.name} ${c.variantName ?? ""}`));

    if (skuKey && otherCandidates.length === 1 && nonDuplicateOthers.length === 1) {
      const canonical = nonDuplicateOthers[0];
      excludedIds.push(dup._id);
      entries.push({
        productId: dup.productId,
        variantId: dup.variantId,
        sku: dup.sku,
        name: dup.name,
        storeName: dup.storeName,
        resolution: "merged-into-canonical",
        canonicalProductId: canonical.productId,
        canonicalVariantId: canonical.variantId,
        note: `SKU "${dup.sku}" sama persis dan tunggal dengan produk katalog productId=${canonical.productId}${canonical.variantId ? `/variantId=${canonical.variantId}` : ""} (bukan bernama "duplicate") — dianggap produk sama (terbukti via SKU), baris "duplicate" ini dikecualikan dari laporan.`,
      });
    } else {
      entries.push({
        productId: dup.productId,
        variantId: dup.variantId,
        sku: dup.sku,
        name: dup.name,
        storeName: dup.storeName,
        resolution: "needs-manual-review",
        canonicalProductId: null,
        canonicalVariantId: null,
        note: skuKey
          ? `SKU "${dup.sku}" tidak cocok tunggal ke SATU produk katalog non-"duplicate" lain (ambigu atau tidak ditemukan) — TIDAK digabung/dihapus otomatis, tinjau manual.`
          : `Produk tidak punya SKU untuk membuktikan sama dengan produk lain — nama saja bukan bukti identity, TIDAK digabung/dihapus otomatis, tinjau manual.`,
      });
    }
  }
  return { excludedIds, entries };
}

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

/**
 * Tanggal dalam [startDate, endDate] yang BELUM terkonfirmasi tuntas disync
 * (olsera_synced_days) — dipakai sebagai diagnostik NON-FORMULA untuk
 * menjelaskan selisih Total Penjualan AYOSERA vs Olsera Open API (bukan untuk
 * mengubah formula penjualan itu sendiri). Tanggal di masa depan (setelah
 * `today`) SENGAJA tidak ikut dilaporkan "belum sync" — belum terjadi, bukan
 * tertinggal.
 */
// ---------------------------------------------------------------------------
// CATATAN SEJARAH: sebelum ada rantai snapshot bulanan
// (lib/olsera-inventory-monthly-snapshot-*.ts), Stok Awal/Stock Akhir produk
// tanpa pergerakan pada bulan target direkonstruksi lewat 2 jendela query
// lebar (wideBeforeRange/wideAfterRange, dihapus) atau fallback stockQty
// katalog TERKINI — keduanya TIDAK AKURAT untuk laporan bulan lampau (lihat
// audit live 2026-07-21: BULLPADEL INDIGA PWR 25 & YONEX SHORTS terbukti
// snapshot hari ini SUDAH BERBEDA dari stok akhir bulan target). Diganti
// dengan rantai bulanan berkelanjutan yang menyimpan opening/closing setiap
// bulan di MongoDB (olsera_inventory_monthly_snapshots) — lihat modul
// tersebut untuk formula opening/closing & carry-forward. Open API Olsera
// tetap menolak query stockmovement >3 bulan sekali jalan (HTTP 406 "You are
// not allowed pulling data for more than 3 mounts.") — TIDAK relevan lagi di
// sini karena setiap query backfill sekarang selalu SATU bulan (jauh di bawah
// batas), tapi tetap dicatat untuk siapa pun yang menambah query rentang.
// ---------------------------------------------------------------------------

export function computeUnsyncedDates(
  startDate: string,
  endDate: string,
  today: string,
  syncedDayIds: Set<string> | string[],
): string[] {
  const ids = syncedDayIds instanceof Set ? syncedDayIds : new Set(syncedDayIds);
  const effectiveEnd = endDate <= today ? endDate : today;
  if (effectiveEnd < startDate) return [];
  return dateRangeList(startDate, effectiveEnd).filter((date) => !ids.has(date));
}
