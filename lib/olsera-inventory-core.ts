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

/**
 * Batas basi (stale) untuk run sync yang macet di status "running" — mis. proses
 * Vercel/terminal/koneksi terputus sebelum status sempat diperbarui. Satu step
 * (fase produk ATAU satu tanggal mutasi) dibatasi maxDuration 300 detik per
 * request (app/api/olsera/inventory/sync/route.ts), dan retry/backoff internal
 * (lib/olsera-inventory.ts getJson: maks 6x percobaan, backoff sampai 10 detik)
 * jauh di bawah itu. 30 menit memberi jarak aman berkali-lipat dari durasi step
 * terpanjang yang wajar, sehingga sync yang masih benar-benar berjalan (retry
 * beruntun, katalog besar) tidak pernah salah dianggap basi.
 */
export const INVENTORY_SYNC_STALE_MS = 30 * 60 * 1000;
export const INVENTORY_SYNC_STALE_MINUTES = INVENTORY_SYNC_STALE_MS / 60_000;

export type StaleCheckableRun = {
  status: "running" | "success" | "partial" | "failed";
  startedAt: Date | string;
  updatedAt?: Date | string | null;
};

/**
 * true bila run berstatus "running" tapi heartbeat-nya (updatedAt, fallback ke
 * startedAt untuk dokumen lama yang belum punya updatedAt valid) sudah
 * melewati INVENTORY_SYNC_STALE_MS. Run yang bukan "running" tidak pernah basi.
 */
export function isInventorySyncStale(run: StaleCheckableRun, now: Date = new Date()): boolean {
  if (run.status !== "running") return false;
  const heartbeatRaw = run.updatedAt ?? run.startedAt;
  const heartbeat = heartbeatRaw instanceof Date ? heartbeatRaw : new Date(heartbeatRaw);
  if (Number.isNaN(heartbeat.getTime())) return false;
  return now.getTime() - heartbeat.getTime() > INVENTORY_SYNC_STALE_MS;
}

/** Pesan errorMessage baku saat run "running" ditutup otomatis karena basi. */
export const INVENTORY_SYNC_STALE_MESSAGE =
  `Sync dianggap terputus karena tidak ada heartbeat selama ${INVENTORY_SYNC_STALE_MINUTES} menit.`;

export type StaleClosureRun = {
  phase: "products" | "movements" | "done";
  currentDate: string | null;
  failedDates: string[];
  processedDays: number;
  createdRecords: number;
  updatedRecords: number;
};

export type StaleClosurePlan = {
  status: "partial" | "failed";
  phase: "done";
  failedDates: string[];
  errorMessage: string;
};

/**
 * Hitung field yang perlu di-set untuk menutup run "running" yang basi — murni
 * logika, tidak menyentuh DB (caller yang menulisnya, atomik, lihat
 * lib/olsera-inventory.ts closeStaleInventorySyncRun). "partial" dipilih bila
 * ada progres nyata yang bisa dilanjutkan (fase mutasi sudah dimulai, atau
 * sudah ada tanggal/record yang berhasil); selain itu "failed". currentDate
 * yang sedang diproses saat macet ditambahkan ke failedDates (bila belum ada)
 * supaya otomatis diulang run berikutnya lewat buildPendingDates — currentDate
 * sendiri, pendingDates, processedDays, totalProducts/Movements, dan
 * createdRecords/updatedRecords TIDAK disentuh (dipertahankan caller apa adanya).
 */
export function planStaleClosure(run: StaleClosureRun): StaleClosurePlan {
  const failedDates =
    run.currentDate && !run.failedDates.includes(run.currentDate) ? [...run.failedDates, run.currentDate] : run.failedDates;
  const hasProgress = run.phase !== "products" || run.processedDays > 0 || run.createdRecords > 0 || run.updatedRecords > 0;
  const status: "partial" | "failed" = hasProgress ? "partial" : "failed";
  return { status, phase: "done", failedDates, errorMessage: INVENTORY_SYNC_STALE_MESSAGE };
}

// ---------------------------------------------------------------------------
// Loop step cron dalam SATU invocation — lihat lib/cron-olsera-inventory.ts.
// Root cause (audit 2026-07-29, tmp/ai-handoff.md): scheduler eksternal
// (cron-job.org) memanggil endpoint cron setiap 60 menit, padahal desain lama
// hanya menjalankan SATU step per invocation (fase produk ATAU satu tanggal
// mutasi) — fase mutasi tidak pernah sempat berjalan sebelum run dianggap
// basi (>INVENTORY_SYNC_STALE_MS) oleh invocation berikutnya. Perbaikan: satu
// invocation memanggil stepInventorySync() berulang sampai selesai/mendekati
// batas waktu. Logika BERHENTI (bukan proses step itu sendiri, yang tetap di
// lib/olsera-inventory.ts) murni di sini supaya testable tanpa mock waktu di
// dalam loop async.
// ---------------------------------------------------------------------------

export type CronLoopStopReason = "deadline" | "max-iterations";

/**
 * null bila loop boleh lanjut ke iterasi berikutnya; sebaliknya alasan
 * berhenti. `maxIterations` adalah perlindungan TAMBAHAN di luar deadline
 * waktu (mis. bila jam sistem bermasalah) — memastikan loop tidak pernah
 * berjalan tak terbatas walau deadline gagal terdeteksi.
 */
export function shouldStopCronLoop(input: {
  iterations: number;
  maxIterations: number;
  nowMs: number;
  deadlineMs: number;
}): CronLoopStopReason | null {
  if (input.iterations >= input.maxIterations) return "max-iterations";
  if (input.nowMs >= input.deadlineMs) return "deadline";
  return null;
}

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

/**
 * true bila entri katalog TIDAK diketahui (undefined — fail-safe, jangan
 * pernah menyembunyikan tanpa bukti) ATAU `active` bukan false. Satu sumber
 * kebenaran dipakai di 2 titik: jalur stagnant rekonsiliasi BA
 * (lib/inventory-stock-opname-store.ts, komit 2c2a36d) dan filter tab
 * panel bulanan Inventori Olsera (lib/olsera-inventory-monthly-ui.ts) —
 * keduanya perlu keputusan yang sama "produk ini masih relevan ditampilkan
 * berdasarkan status aktif katalognya".
 */
export function isActiveOrUnknownProduct(product: { active: boolean } | null | undefined): boolean {
  return product?.active !== false;
}

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

// ---------------------------------------------------------------------------
// Product mapping movement — prioritas identitas (resolvedProductId/productId
// +variantId) di atas pencocokan nama. buildNameIndex di atas TETAP DIPAKAI
// oleh kode lama (tidak dihapus, backward-compatible); pemetaan movement baru
// pakai index terpisah di bawah yang menyimpan SEMUA kandidat per kunci (bukan
// pemenang pertama) supaya ambiguitas bisa dideteksi, bukan ditebak diam-diam.
// ---------------------------------------------------------------------------

/** Kelompokkan katalog per productId — dasar pencocokan berbasis ID (langkah 1-4). */
export function buildMovementIdentityIndex(products: InventoryProductInput[]): Map<number, InventoryProductInput[]> {
  const index = new Map<number, InventoryProductInput[]>();
  for (const product of products) {
    const list = index.get(product.productId) ?? [];
    list.push(product);
    index.set(product.productId, list);
  }
  return index;
}

/**
 * Kelompokkan katalog per nama ternormalisasi — SEMUA kandidat disimpan (bukan
 * pemenang pertama) supaya nama yang dipakai >1 produk/variant terdeteksi
 * ambigu, bukan diam-diam memilih salah satu (lihat selectMovementProduct).
 */
export function buildMovementNameIndex(products: InventoryProductInput[]): Map<string, InventoryProductInput[]> {
  const index = new Map<string, InventoryProductInput[]>();
  const add = (key: string, product: InventoryProductInput) => {
    const list = index.get(key) ?? [];
    list.push(product);
    index.set(key, list);
  };
  for (const product of products) {
    const fullKey = product.variantName
      ? normalizeItemName(`${product.name} - ${product.variantName}`)
      : normalizeItemName(product.name);
    add(fullKey, product);
    // Produk ber-variant juga didaftarkan di bawah nama polos (item order lama
    // bisa tersimpan tanpa suffix varian) — kalau produk itu ber-variant lebih
    // dari satu, nama polos otomatis jadi ambigu (benar, bukan bug).
    if (product.variantName) add(normalizeItemName(product.name), product);
  }
  return index;
}

export type MovementItemIdentity = {
  itemName: string;
  productId: number | null;
  variantId: number | null;
  resolvedProductId: number | null;
};

export type MovementProductMethod =
  | "resolvedProductId"
  | "productId+variantId"
  | "productId"
  | "name"
  | "ambiguous-name"
  | "unmatched";

export type MovementProductSelection = {
  product: InventoryProductInput | null;
  method: MovementProductMethod;
  note: string;
};

const MOVEMENT_MAPPING_NOTE: Record<MovementProductMethod, string> = {
  "resolvedProductId": "Dipetakan dari resolvedProductId",
  "productId+variantId": "Dipetakan dari productId + variantId",
  "productId": "Dipetakan dari productId (kandidat tunggal)",
  "name": "Dipetakan dari nama unik (fallback)",
  "ambiguous-name": "Nama produk ambigu — tidak dipetakan otomatis",
  "unmatched": "Produk tidak ditemukan di katalog (nama tidak cocok)",
};

/**
 * Pilih produk katalog untuk satu item transaksi — urutan wajib:
 * 1. resolvedProductId (bila ada) sebagai id efektif, else productId asli.
 * 2. Bila variantId tersedia, prioritaskan kecocokan id efektif + variantId.
 * 3. Bila id efektif cocok dan kandidatnya cuma satu (produk tanpa variant
 *    atau variantId tidak diberikan), pakai kandidat itu.
 * 4. Selain itu (id efektif tidak ketemu, atau ambigu — banyak variant tanpa
 *    variantId yang cocok): fallback ke exact normalized name, HANYA bila
 *    hasilnya unik satu kandidat.
 * 5. Tidak ada yang cocok / ambigu di kedua jalur → product null + note jelas.
 * TIDAK PERNAH memilih kandidat pertama secara sembarang saat ambigu (baik by
 * ID maupun by nama) — SKU tidak dipakai sebagai kriteria pencocokan sama sekali.
 */
export function selectMovementProduct(
  item: MovementItemIdentity,
  idIndex: Map<number, InventoryProductInput[]>,
  nameIndex: Map<string, InventoryProductInput[]>,
): MovementProductSelection {
  const effectiveId = item.resolvedProductId ?? item.productId;
  const usedResolvedId = item.resolvedProductId !== null;

  if (effectiveId !== null) {
    const candidates = idIndex.get(effectiveId) ?? [];
    if (candidates.length) {
      if (item.variantId !== null) {
        const exact = candidates.find((candidate) => candidate.variantId === item.variantId);
        if (exact) {
          const method: MovementProductMethod = usedResolvedId ? "resolvedProductId" : "productId+variantId";
          return { product: exact, method, note: MOVEMENT_MAPPING_NOTE[method] };
        }
        // variantId diberikan tapi tidak cocok kandidat manapun untuk id ini —
        // jangan menebak variant; tetap boleh lanjut ke fallback baris di bawah
        // HANYA bila kandidatnya memang cuma satu (produk tanpa variant nyata).
      }
      if (candidates.length === 1) {
        const method: MovementProductMethod = usedResolvedId ? "resolvedProductId" : "productId";
        return { product: candidates[0], method, note: MOVEMENT_MAPPING_NOTE[method] };
      }
      // Ambigu by ID (banyak variant, variantId item tidak menunjuk salah
      // satunya) — jangan pilih sembarang, lanjut ke fallback nama.
    }
  }

  const key = normalizeItemName(item.itemName);
  const nameCandidates = nameIndex.get(key) ?? [];
  if (nameCandidates.length === 1) {
    return { product: nameCandidates[0], method: "name", note: MOVEMENT_MAPPING_NOTE.name };
  }
  if (nameCandidates.length > 1) {
    return { product: null, method: "ambiguous-name", note: MOVEMENT_MAPPING_NOTE["ambiguous-name"] };
  }
  return { product: null, method: "unmatched", note: MOVEMENT_MAPPING_NOTE.unmatched };
}

// ---------------------------------------------------------------------------
// Rekonsiliasi movement per tanggal — hapus movement "yatim" (order item
// sumbernya sudah dibatalkan/dihapus dari olsera_order_items) HANYA bila
// tanggal penjualan sudah terkonfirmasi tuntas disync (lihat
// lib/olsera-inventory.ts runMovementDate: dicek lewat olsera_synced_days).
// ---------------------------------------------------------------------------

export type MovementReconciliationInput = {
  /** `sale:{orderItemId}` dari olsera_order_items yang ADA saat ini untuk tanggal ini. */
  expectedIds: string[];
  /** _id movement source="sale" yang SAAT INI tersimpan di DB untuk tanggal ini. */
  existingSaleMovementIds: string[];
  /** true bila tanggal penjualan ini sudah terkonfirmasi tuntas disync (olsera_synced_days). */
  dateFullySynced: boolean;
};

export type MovementReconciliationPlan = {
  /** _id movement yang aman dihapus (source="sale", tanggal ini, tidak ada order item sumbernya lagi). */
  idsToDelete: string[];
  cleanupSkipped: boolean;
  cleanupSkippedReason: string | null;
};

export function planMovementReconciliation(input: MovementReconciliationInput): MovementReconciliationPlan {
  if (!input.dateFullySynced) {
    return {
      idsToDelete: [],
      cleanupSkipped: true,
      cleanupSkippedReason: "Tanggal belum terkonfirmasi tuntas disync (olsera_synced_days) — cleanup movement yatim dilewati.",
    };
  }
  const expected = new Set(input.expectedIds);
  const idsToDelete = input.existingSaleMovementIds.filter((id) => !expected.has(id));
  return { idsToDelete, cleanupSkipped: false, cleanupSkippedReason: null };
}

export type StockStatus = "Aman" | "Hampir Habis" | "Habis" | "Data Tidak Lengkap";

export function stockStatusFor(product: {
  trackInventory: boolean;
  stockQty: number;
  buyPrice: number;
  lowStockAlert: number | null;
}): StockStatus {
  if (!product.trackInventory) return "Data Tidak Lengkap";
  // Produk tanpa harga modal dari Olsera (buy_price 0/tidak diisi) — status stok
  // tidak bisa dinyatakan tanpa data harga; tampilkan sebagai tidak lengkap
  // daripada memberi label Aman/Habis yang menyesatkan.
  if (!product.buyPrice) return "Data Tidak Lengkap";
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

/**
 * Status cakupan data konsistensi — TIDAK PERNAH menyatakan stok fisik "Cocok"/benar
 * (itu memerlukan stock opname). Hanya menyatakan seberapa lengkap data snapshot
 * & penjualan yang tersedia untuk produk ini.
 */
export type ConsistencyStatus = "Snapshot Tersedia" | "Histori Tidak Lengkap" | "Belum Ada Snapshot" | "Perlu Stock Opname";

export type ConsistencyRow = {
  key: string;
  sku: string | null;
  name: string;
  category: string;
  /** Snapshot stok paling awal yang benar-benar tersedia — null bila belum ada snapshot sama sekali. */
  startSnapshotQty: number | null;
  /** Total qty terjual tercatat (dari olsera_order_items via mutasi "penjualan") antara snapshot awal & akhir — null bila kurang dari 2 snapshot (periode tidak bisa ditentukan). */
  recordedSales: number | null;
  /** Snapshot stok paling akhir yang tersedia. */
  endSnapshotQty: number | null;
  /** endSnapshotQty - startSnapshotQty — null bila kurang dari 2 snapshot (tidak ada perubahan yang bisa dihitung). */
  snapshotChange: number | null;
  status: ConsistencyStatus;
};

/**
 * Cakupan data konsistensi per produk — BUKAN rekonsiliasi stok fisik.
 * API Olsera hanya menyediakan snapshot stok saat ini + transaksi penjualan;
 * pembelian/adjustment/transfer/retur tidak tersedia. Karena itu fungsi ini
 * TIDAK PERNAH merekonstruksi "stok akhir hasil hitung" sebagai angka final —
 * ia hanya melaporkan snapshot yang benar-benar ada, penjualan yang benar-benar
 * tercatat, dan menandai `Perlu Stock Opname` bila perubahan snapshot tidak
 * habis dijelaskan oleh penjualan tercatat saja (indikasi ada mutasi lain yang
 * tidak terlihat dari API — pembelian/adjustment manual di Olsera).
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
  const base = { key: input.key, sku: input.sku, name: input.name, category: input.category };
  if (!input.snapshots.length) {
    return { ...base, startSnapshotQty: null, recordedSales: null, endSnapshotQty: null, snapshotChange: null, status: "Belum Ada Snapshot" };
  }
  const sorted = [...input.snapshots].sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  // Kurang dari 2 titik snapshot (atau produk tidak dilacak Olsera) — snapshot
  // yang ada tetap ditampilkan apa adanya, tetapi perubahan/penjualan TIDAK
  // dihitung (periode tidak bisa ditentukan dari satu titik data).
  if (!input.trackInventory || first.date === last.date) {
    return {
      ...base,
      startSnapshotQty: first.stockQty,
      recordedSales: null,
      endSnapshotQty: last.stockQty,
      snapshotChange: null,
      status: "Histori Tidak Lengkap",
    };
  }

  // Penjualan tercatat = total qty terjual (satu-satunya jenis mutasi yang
  // tersedia dari API) antara snapshot awal (eksklusif) dan snapshot akhir (inklusif).
  let recordedSales = 0;
  for (const movement of input.movements) {
    if (movement.date <= first.date || movement.date > last.date) continue;
    recordedSales += -movement.qtyChange;
  }
  const snapshotChange = last.stockQty - first.stockQty;
  const explainedBySalesOnly = -recordedSales;
  const unexplained = snapshotChange - explainedBySalesOnly;
  const status: ConsistencyStatus = Math.abs(unexplained) < 0.001 ? "Snapshot Tersedia" : "Perlu Stock Opname";

  return {
    ...base,
    startSnapshotQty: first.stockQty,
    recordedSales,
    endSnapshotQty: last.stockQty,
    snapshotChange,
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
