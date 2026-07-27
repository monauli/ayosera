// Ledger stok BULANAN per produk — pengganti fallback stockQty katalog
// terkini untuk Export Stock Opname Bulanan OTOMATIS (lihat audit live
// 2026-07-21: current-snapshot fallback terbukti salah untuk produk stok
// tipis yang bergerak SETELAH bulan target, mis. BULLPADEL INDIGA PWR 25 &
// YONEX SHORTS). Modul ini murni (zero dependency ExcelJS/MongoDB/fetch —
// bisa diuji unit dengan node --test), sama seperti
// lib/olsera-inventory-monthly-core.ts. Glue (Mongo, panggilan stockmovement
// API, query olsera_order_items/olsera_product_aliases) ada di
// lib/olsera-inventory-monthly-snapshot-store.ts.
//
// Model: satu dokumen per (storeId, year, month, productId, variantId) berisi
// SELURUH ledger bulan itu (opening + arus + closing) — closing bulan N =
// opening bulan N+1, rantai berkelanjutan dari baseline Juni 2026 (file resmi
// terverifikasi) mundur ke Februari 2026 dan maju ke bulan berjalan.
import {
  buildMovementNameIndex,
  buildProductIdentityIndex,
  buildSkuIndex,
  monthDateRange,
  productKey,
  type InventoryProductInput,
  type MatchedMovement,
} from "./olsera-inventory-monthly-core.ts";

// ---------------------------------------------------------------------------
// Aritmetika bulan (murni)
// ---------------------------------------------------------------------------

export type MonthKey = { year: number; month: number };

export function previousMonth({ year, month }: MonthKey): MonthKey {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function nextMonth({ year, month }: MonthKey): MonthKey {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function monthIndex({ year, month }: MonthKey): number {
  return year * 12 + (month - 1);
}

/** [from, to] menaik (from <= to), inklusif — [] bila from > to. */
export function monthsAscending(from: MonthKey, to: MonthKey): MonthKey[] {
  const result: MonthKey[] = [];
  let cursor = from;
  while (monthIndex(cursor) <= monthIndex(to)) {
    result.push(cursor);
    cursor = nextMonth(cursor);
  }
  return result;
}

/** [from, to] menurun (from >= to), inklusif — [] bila from < to. */
export function monthsDescending(from: MonthKey, to: MonthKey): MonthKey[] {
  const result: MonthKey[] = [];
  let cursor = from;
  while (monthIndex(cursor) >= monthIndex(to)) {
    result.push(cursor);
    cursor = previousMonth(cursor);
  }
  return result;
}

export function lastDayOfMonth(year: number, month: number): string {
  return monthDateRange(year, month).endDate;
}

export function firstDayOfMonth(year: number, month: number): string {
  return monthDateRange(year, month).startDate;
}

// ---------------------------------------------------------------------------
// Formula ledger — SELALU memakai arus (incoming/return/sales/outgoing) dari
// baris Open API Olsera sendiri (bukan agregat penjualan AYOSERA) supaya
// rantai bulanan tertutup persis dengan angka "sisa"/"beginning_qty" yang
// dilaporkan Olsera sendiri per bulan. Penjualan AYOSERA tetap dipakai
// terpisah HANYA saat export (lib/olsera-inventory-monthly-export.ts) untuk
// kolom Penjualan & perhitungan Stock Akhir Sistem perusahaan — perbandingan
// keduanya jadi diagnostik (balanceMismatch), bukan dilebur ke dalam rantai.
// ---------------------------------------------------------------------------

export function computeOpeningFromClosingBackward(input: {
  closingQty: number;
  incomingQty: number;
  returnQty: number;
  salesQty: number;
  outgoingQty: number;
}): number {
  return input.closingQty - input.incomingQty - input.returnQty + input.salesQty + input.outgoingQty;
}

export function computeClosingFromOpeningForward(input: {
  openingQty: number;
  incomingQty: number;
  returnQty: number;
  salesQty: number;
  outgoingQty: number;
}): number {
  return input.openingQty + input.incomingQty + input.returnQty - input.salesQty - input.outgoingQty;
}

// ---------------------------------------------------------------------------
// Nama tampil — hilangkan suffix literal "duplicate" (penanda manual staf
// Olsera, terverifikasi live pada katalog nyata: "YONEX SHORTS MEN #
// SM-J035-2906-RW1-S duplicate") HANYA dari nama yang ditampilkan; identitas
// produk (productId/variantId/SKU) tidak pernah berubah oleh fungsi ini.
// ---------------------------------------------------------------------------

const DUPLICATE_SUFFIX_PATTERN = /\s*[([]?duplicate[)\]]?\s*$/i;

export function stripDuplicateSuffix(name: string): string {
  return name.replace(DUPLICATE_SUFFIX_PATTERN, "").trim();
}

// ---------------------------------------------------------------------------
// Alias productId (olsera_product_aliases) — perluas index identitas supaya
// baris stockmovement API bulan LAMPAU yang masih memakai productId LAMA
// (sebelum Olsera mengganti ID katalognya) tetap match ke produk katalog
// kanonik saat ini. Alias TIDAK menyimpan storeId — storeId diambil dari
// produk kanonik yang ditunjuk (asumsi satu toko per productId, sesuai data
// nyata). Alias yang target barunya tidak ada di katalog SEKARANG dilewati
// (tidak ditebak), bukan dipaksa.
// ---------------------------------------------------------------------------

export type ProductAliasEntry = {
  oldProductId: number;
  oldVariantId: number | null;
  newProductId: number | null;
  newVariantId: number | null;
};

export function extendIdentityIndexWithAliases(
  identityIndex: Map<string, InventoryProductInput>,
  catalogProducts: InventoryProductInput[],
  aliases: ProductAliasEntry[],
): Map<string, InventoryProductInput> {
  const byProductVariant = new Map<string, InventoryProductInput>();
  for (const product of catalogProducts) {
    byProductVariant.set(`${product.productId}:${product.variantId ?? 0}`, product);
  }
  const extended = new Map(identityIndex);
  for (const alias of aliases) {
    if (alias.newProductId === null) continue;
    const canonical = byProductVariant.get(`${alias.newProductId}:${alias.newVariantId ?? 0}`);
    if (!canonical) continue;
    const oldKey = productKey(canonical.storeId, alias.oldProductId, alias.oldVariantId);
    if (!extended.has(oldKey)) extended.set(oldKey, canonical);
  }
  return extended;
}

// ---------------------------------------------------------------------------
// Dokumen ledger bulanan (bentuk plain, dipetakan ke
// OlseraInventoryMonthlySnapshotDocument oleh layer store)
// ---------------------------------------------------------------------------

export type MonthlyLedgerSource = "baseline-file" | "stockmovement-backward" | "stockmovement-forward" | "carry-forward";
export type MonthlyLedgerStatus = "complete" | "boundary-only" | "incomplete";

export type MonthlyLedgerEntry = {
  productId: number;
  variantId: number | null;
  /** productId MENTAH dari baris Open API bulan ini, HANYA diisi bila berbeda dari productId katalog stabil (berarti resolusi alias/rename dipakai) — bukti audit, lihat extendIdentityIndexWithAliases. */
  canonicalProductId: number | null;
  productName: string;
  productSku: string | null;
  groupName: string;
  openingQty: number | null;
  incomingQty: number | null;
  returnQty: number | null;
  salesQty: number | null;
  outgoingQty: number | null;
  closingQty: number | null;
  source: MonthlyLedgerSource;
  status: MonthlyLedgerStatus;
  diagnostics: string[];
};

function parseProductKey(key: string): { storeId: number; productId: number; variantId: number | null } {
  const [storeIdRaw, productIdRaw, variantIdRaw] = key.split(":");
  const variantId = Number(variantIdRaw);
  return { storeId: Number(storeIdRaw), productId: Number(productIdRaw), variantId: variantId === 0 ? null : variantId };
}

/** Anchor yang dibawa ANTAR bulan saat backfill mundur (kunci Map = product._id katalog, identitas stabil). */
export type BackwardAnchor = {
  closingQty: number;
  productName: string;
  productSku: string | null;
  groupName: string;
};

/** Anchor yang dibawa ANTAR bulan saat backfill maju (kunci Map = product._id katalog, identitas stabil). */
export type ForwardAnchor = {
  openingQty: number;
  productName: string;
  productSku: string | null;
  groupName: string;
};

export type MonthlyStepBackwardResult = {
  entries: Map<string, MonthlyLedgerEntry>;
  nextAnchors: Map<string, BackwardAnchor>;
  /** product._id yang DIHENTIKAN di bulan ini (tidak ada movement & tidak ada bukti eksistensi) — tidak ditulis dokumen utk bulan ini/lebih awal. */
  stopped: string[];
};

// ---------------------------------------------------------------------------
// Kontradiksi carry-forward — terverifikasi live 2026-07-27 (audit
// movement-qty:116138490:0): stockmovement API Open API Olsera kadang TIDAK
// mengembalikan baris SAMA SEKALI untuk suatu productId pada bulan tertentu
// (carry-forward dipakai, salesQty dipaksa 0), padahal olsera_inventory_movements
// (ledger penjualan AYOSERA sendiri, independen dari API tsb) MEMBUKTIKAN ada
// penjualan nyata pada productId+bulan yang sama — root cause TERBUKTI:
// productId 116138490 ("BOLA PADEL ODEA ROSE") sebelumnya bernama/berID
// "BOLA PADEL ODEA" dengan product_id Olsera LAMA 106817649 (lihat
// olsera_order_items.raw.product_id Feb-Apr 2026), tapi tidak ada dokumen
// olsera_product_aliases yang menjembatani rename ini — sehingga baris
// stockmovement API bulan tsb (yang masih memakai productId LAMA) gagal
// match identity/SKU/nama ke katalog kanonik & dianggap "tidak ada movement".
// carry-forward TETAP dipakai (TIDAK menebak/mengisi salesQty) — HANYA status
// diubah dari "complete" ke "incomplete" + diagnostic eksplisit, supaya
// konsumen (mis. Modul Rekonsiliasi) tahu angka 0 ini TIDAK bisa dipercaya
// penuh sampai alias historis diverifikasi & direbuild ulang secara eksplisit.
// ---------------------------------------------------------------------------

/** key sama seperti `anchors`/`matched` (`${storeId}:${productId}:${variantId ?? 0}`) -> total abs(qtyChange) olsera_inventory_movements bulan ini (evidence independen, BUKAN dari stockmovement API). */
export type RawSalesActivityByKey = Map<string, number>;

function carryForwardStatusAndDiagnostic(key: string, rawSalesActivityByKey: RawSalesActivityByKey | undefined): { status: MonthlyLedgerStatus; diagnostic: string } {
  const rawSales = rawSalesActivityByKey?.get(key);
  if (rawSales !== undefined && rawSales > 0) {
    return {
      status: "incomplete",
      diagnostic: `Tidak ada baris stockmovement API pada bulan ini, TAPI olsera_inventory_movements (ledger penjualan independen) mencatat aktivitas sumAbsQty=${rawSales} untuk productId ini pada bulan yang sama — kemungkinan productId berubah di sisi Olsera tanpa alias yang menjembatani (lihat olsera_product_aliases). salesQty=0 pada entri ini TIDAK BOLEH dipercaya sebagai final; perlu verifikasi manual/alias sebelum rebuild eksplisit.`,
    };
  }
  return {
    status: "complete",
    diagnostic: "Tidak ada baris stockmovement API pada bulan ini — saldo dibawa sama (carry-forward), didukung bukti riwayat pada/sebelum bulan ini.",
  };
}

/**
 * Satu langkah mundur (bulan N, closing SUDAH diketahui dari anchor) →
 * hitung opening bulan N via formula, jadikan opening itu closing anchor utk
 * bulan N-1. `productId`/`variantId` pada entry SELALU identitas katalog
 * STABIL (dari kunci Map, bukan productId mentah baris API — bisa beda bila
 * Olsera pernah mengganti ID, lihat canonicalProductId). Produk tanpa baris
 * movement bulan ini: dibawa rata (carry-forward) HANYA bila
 * `hasEvidenceBeforeOrDuring` membuktikan produk itu sudah eksis pada/​
 * sebelum bulan ini (mis. ada olsera_order_items) — bila tidak, dihentikan
 * (TIDAK dipaksa masuk laporan bulan yang belum eksis). `rawSalesActivityByKey`
 * (opsional, additive — default tanpa perubahan bila tidak diisi) menandai
 * carry-forward yang KONTRADIKTIF dengan bukti penjualan independen sebagai
 * status "incomplete" (lihat carryForwardStatusAndDiagnostic) — TIDAK PERNAH
 * mengubah angka openingQty/salesQty/closingQty itu sendiri.
 */
export function computeMonthlyStepBackward(input: {
  anchors: Map<string, BackwardAnchor>;
  matched: Map<string, MatchedMovement>;
  hasEvidenceBeforeOrDuring: (productKeyId: string) => boolean;
  rawSalesActivityByKey?: RawSalesActivityByKey;
}): MonthlyStepBackwardResult {
  const entries = new Map<string, MonthlyLedgerEntry>();
  const nextAnchors = new Map<string, BackwardAnchor>();
  const stopped: string[] = [];

  for (const [key, anchor] of input.anchors) {
    const stable = parseProductKey(key);
    const movement = input.matched.get(key);
    if (movement) {
      const opening = computeOpeningFromClosingBackward({
        closingQty: anchor.closingQty,
        incomingQty: movement.row.incomingQty,
        returnQty: movement.row.returnQty,
        salesQty: movement.row.salesQty,
        outgoingQty: movement.row.outgoingQty,
      });
      entries.set(key, {
        productId: stable.productId,
        variantId: stable.variantId,
        canonicalProductId: movement.row.productId !== stable.productId ? movement.row.productId : null,
        productName: anchor.productName,
        productSku: anchor.productSku,
        groupName: anchor.groupName,
        openingQty: opening,
        incomingQty: movement.row.incomingQty,
        returnQty: movement.row.returnQty,
        salesQty: movement.row.salesQty,
        outgoingQty: movement.row.outgoingQty,
        closingQty: anchor.closingQty,
        source: "stockmovement-backward",
        status: "complete",
        diagnostics: [`Opening dihitung mundur dari closing bulan berikutnya via stockmovement API (metode match: ${movement.method}).`],
      });
      nextAnchors.set(key, { closingQty: opening, productName: anchor.productName, productSku: anchor.productSku, groupName: anchor.groupName });
    } else if (input.hasEvidenceBeforeOrDuring(key)) {
      const { status, diagnostic } = carryForwardStatusAndDiagnostic(key, input.rawSalesActivityByKey);
      entries.set(key, {
        productId: stable.productId,
        variantId: stable.variantId,
        canonicalProductId: null,
        productName: anchor.productName,
        productSku: anchor.productSku,
        groupName: anchor.groupName,
        openingQty: anchor.closingQty,
        incomingQty: 0,
        returnQty: 0,
        salesQty: 0,
        outgoingQty: 0,
        closingQty: anchor.closingQty,
        source: "carry-forward",
        status,
        diagnostics: [diagnostic],
      });
      nextAnchors.set(key, anchor);
    } else {
      stopped.push(key);
    }
  }

  return { entries, nextAnchors, stopped };
}

export type MonthlyStepForwardResult = {
  entries: Map<string, MonthlyLedgerEntry>;
  nextAnchors: Map<string, ForwardAnchor>;
};

/**
 * Satu langkah maju (bulan N, opening SUDAH diketahui dari anchor) → hitung
 * closing bulan N via formula, jadikan closing itu opening anchor utk bulan
 * N+1. Produk tanpa baris movement bulan ini: dibawa rata (carry-forward),
 * TIDAK PERNAH dihentikan (produk yang sudah eksis tidak "berhenti eksis"
 * tanpa bukti eksplisit sebaliknya). Produk BARU yang muncul di `matched`
 * tapi belum punya anchor: dimasukkan HANYA karena `matched` sudah berarti
 * ada baris stockmovement API sungguhan bulan ini (bukti eksistensi nyata,
 * bukan tebakan) — openingQty-nya dipercaya langsung dari beginning_qty API.
 * `rawSalesActivityByKey` (opsional, additive) — lihat computeMonthlyStepBackward.
 */
export function computeMonthlyStepForward(input: {
  anchors: Map<string, ForwardAnchor>;
  matched: Map<string, MatchedMovement>;
  catalogById: Map<string, InventoryProductInput>;
  rawSalesActivityByKey?: RawSalesActivityByKey;
}): MonthlyStepForwardResult {
  const entries = new Map<string, MonthlyLedgerEntry>();
  const nextAnchors = new Map<string, ForwardAnchor>();
  const seen = new Set<string>();

  for (const [key, anchor] of input.anchors) {
    seen.add(key);
    const stable = parseProductKey(key);
    const movement = input.matched.get(key);
    if (movement) {
      const closing = computeClosingFromOpeningForward({
        openingQty: anchor.openingQty,
        incomingQty: movement.row.incomingQty,
        returnQty: movement.row.returnQty,
        salesQty: movement.row.salesQty,
        outgoingQty: movement.row.outgoingQty,
      });
      entries.set(key, {
        productId: stable.productId,
        variantId: stable.variantId,
        canonicalProductId: movement.row.productId !== stable.productId ? movement.row.productId : null,
        productName: anchor.productName,
        productSku: anchor.productSku,
        groupName: anchor.groupName,
        openingQty: anchor.openingQty,
        incomingQty: movement.row.incomingQty,
        returnQty: movement.row.returnQty,
        salesQty: movement.row.salesQty,
        outgoingQty: movement.row.outgoingQty,
        closingQty: closing,
        source: "stockmovement-forward",
        status: "complete",
        diagnostics: [`Closing dihitung maju dari opening bulan sebelumnya via stockmovement API (metode match: ${movement.method}).`],
      });
      nextAnchors.set(key, { openingQty: closing, productName: anchor.productName, productSku: anchor.productSku, groupName: anchor.groupName });
    } else {
      const { status, diagnostic } = carryForwardStatusAndDiagnostic(key, input.rawSalesActivityByKey);
      entries.set(key, {
        productId: stable.productId,
        variantId: stable.variantId,
        canonicalProductId: null,
        productName: anchor.productName,
        productSku: anchor.productSku,
        groupName: anchor.groupName,
        openingQty: anchor.openingQty,
        incomingQty: 0,
        returnQty: 0,
        salesQty: 0,
        outgoingQty: 0,
        closingQty: anchor.openingQty,
        source: "carry-forward",
        status,
        diagnostics: [diagnostic],
      });
      nextAnchors.set(key, anchor);
    }
  }

  for (const [key, movement] of input.matched) {
    if (seen.has(key)) continue;
    const product = input.catalogById.get(key);
    if (!product) continue;
    const productName = product.variantName ? `${product.name} - ${product.variantName}` : product.name;
    const closing = movement.row.sisa;
    entries.set(key, {
      productId: product.productId,
      variantId: product.variantId,
      canonicalProductId: movement.row.productId !== product.productId ? movement.row.productId : null,
      productName,
      productSku: product.sku,
      groupName: movement.row.productGroupName ?? product.category,
      openingQty: movement.row.beginningQty,
      incomingQty: movement.row.incomingQty,
      returnQty: movement.row.returnQty,
      salesQty: movement.row.salesQty,
      outgoingQty: movement.row.outgoingQty,
      closingQty: closing,
      source: "stockmovement-forward",
      status: "complete",
      diagnostics: [
        "Produk baru terdeteksi bulan ini (tidak ada anchor/riwayat sebelumnya di rantai) — opening dipercaya langsung dari beginning_qty Open API Olsera untuk bulan ini (bukti nyata, bukan tebakan).",
      ],
    });
    nextAnchors.set(key, {
      openingQty: closing,
      productName,
      productSku: product.sku,
      groupName: movement.row.productGroupName ?? product.category,
    });
  }

  return { entries, nextAnchors };
}

export function monthlySnapshotDocId(storeId: number, year: number, month: number, productId: number, variantId: number | null): string {
  return `${storeId}:${year}:${String(month).padStart(2, "0")}:${productId}:${variantId ?? 0}`;
}

// ---------------------------------------------------------------------------
// Pemulihan movement penjualan dengan productId null — terverifikasi live
// 2026-07-21 (kasus YONEX SHORTS): olsera_order_items.resolvedProductId utk
// item order yang SAMA berhasil diresolusi via olsera_product_aliases, tapi
// dokumen olsera_inventory_movements-nya sendiri gagal ikut ter-resolve
// (resolver movement tidak konsisten dengan resolver order item) — hasilnya
// productId:null dan movement itu tersaring habis dari agregasi penjualan
// (query produksi memfilter productId:{$ne:null}). Dari 2534 movement
// penjualan Juni 2026, hanya 2 punya productId:null — keduanya kasus SKU ini
// (bukti live, bukan dugaan). Murni (Map lookup by orderItemId, tidak
// menyentuh Mongo) — glue (lib/olsera-inventory-monthly-snapshot-store.ts
// tidak memanggil ini; dipakai langsung di
// lib/olsera-inventory-monthly-export.ts) yang mengambil datanya dari Mongo.
// ---------------------------------------------------------------------------

export type ResolvedOrderItem = { resolvedProductId: number | null; variantId?: number | null };

export function recoverNullProductIdSales<T extends { _id: unknown }>(
  nullProductMovements: T[],
  resolvedByOrderItemId: Map<number, ResolvedOrderItem>,
): (Omit<T, "productId" | "variantId"> & { productId: number; variantId: number | null })[] {
  return nullProductMovements.flatMap((movement) => {
    const orderItemId = Number(String(movement._id).split(":")[1]);
    const resolved = Number.isFinite(orderItemId) ? resolvedByOrderItemId.get(orderItemId) : undefined;
    if (!resolved?.resolvedProductId) return [];
    return [{ ...movement, productId: resolved.resolvedProductId, variantId: resolved.variantId ?? null }];
  });
}

// ---------------------------------------------------------------------------
// Konteks matching (murni — hanya menyusun index dari array yang sudah
// diambil pemanggil; I/O Mongo/HTTP tetap di lib/olsera-inventory-monthly-snapshot-store.ts).
// ---------------------------------------------------------------------------

export type MatchingContext = {
  catalogProducts: InventoryProductInput[];
  identityIndex: Map<string, InventoryProductInput>;
  skuIndex: Map<string, InventoryProductInput[]>;
  nameIndex: Map<string, InventoryProductInput[]>;
  catalogById: Map<string, InventoryProductInput>;
};

export function buildMatchingContext(catalogProducts: InventoryProductInput[], aliases: ProductAliasEntry[]): MatchingContext {
  const baseIdentityIndex = buildProductIdentityIndex(catalogProducts);
  const identityIndex = extendIdentityIndexWithAliases(baseIdentityIndex, catalogProducts, aliases);
  const skuIndex = buildSkuIndex(catalogProducts);
  const nameIndex = buildMovementNameIndex(catalogProducts);
  const catalogById = new Map(catalogProducts.map((product) => [product._id, product]));
  return { catalogProducts, identityIndex, skuIndex, nameIndex, catalogById };
}

/** Modus (nilai paling sering) storeId di katalog — dipakai sebagai storeId dokumen ledger bulanan (data nyata: satu toko, 324175). */
export function dominantStoreId(catalogProducts: InventoryProductInput[]): number {
  const counts = new Map<number, number>();
  for (const product of catalogProducts) {
    const id = product.storeId ?? 0;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}
