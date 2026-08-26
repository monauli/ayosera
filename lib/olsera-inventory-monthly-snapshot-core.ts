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
import { jakartaCurrentPeriod } from "./olsera-financial-core.ts";

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
// Status periode (current/historical/future) — SATU sumber kebenaran dipakai
// ensureMonthlySnapshotChain untuk memutuskan boleh dipercaya-final atau
// harus dihitung ulang. Reuse jakartaCurrentPeriod (lib/olsera-financial-core.ts)
// — timezone bisnis "Asia/Jakarta" yang sama dipakai modul Laporan Keuangan &
// Rekonsiliasi, TIDAK membuat konsep timezone kedua.
// ---------------------------------------------------------------------------

export type InventoryPeriodState = "future" | "current" | "historical";

/**
 * `future`: bulan belum dimulai — jangan pernah generate data seolah-olah
 * sudah berjalan. `current`: bulan kalender Asia/Jakarta yang sedang
 * berjalan — dinamis, TIDAK boleh dipercaya final walau sudah pernah
 * dihitung sebelumnya. `historical`: bulan sudah lewat — boleh dipercaya
 * final SETELAH mendapat satu kali finalisasi (lihat `finalizedAt` di
 * OlseraInventoryMonthlySnapshotDocument).
 */
export function getInventoryPeriodState(year: number, month: number, now: Date = new Date()): InventoryPeriodState {
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const current = jakartaCurrentPeriod(now);
  if (period > current) return "future";
  if (period === current) return "current";
  return "historical";
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
  /** olsera_product_aliases.confidence — HANYA "verified" yang boleh membuka fallback ledger historis (lihat buildVerifiedAliasCanonicalKeys/applyVerifiedAliasLedgerFallback). "high"/"low" tetap dipakai untuk identity-index (matching stockmovement API) seperti sebelumnya, TIDAK berubah. */
  confidence: "verified" | "high" | "low";
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

/**
 * Kunci kanonik (`${storeId}:${productId}:${variantId ?? 0}`, format SAMA
 * dengan anchors/matched/rawSalesActivityByKey) yang punya SETIDAKNYA SATU
 * alias `confidence:"verified"` menunjuk ke sana — dipakai sebagai guard
 * ketat untuk applyVerifiedAliasLedgerFallback (Fitur historical rebuild
 * ODEA). Alias "high"/"low" TIDAK ikut serta di sini — hanya "verified"
 * (keputusan manusia eksplisit, pola sama scripts/seed-olsera-aliases.ts)
 * yang boleh mempercayai ledger historis sebagai salesQty final.
 */
export function buildVerifiedAliasCanonicalKeys(catalogProducts: InventoryProductInput[], aliases: ProductAliasEntry[]): Set<string> {
  const byProductVariant = new Map<string, InventoryProductInput>();
  for (const product of catalogProducts) {
    byProductVariant.set(`${product.productId}:${product.variantId ?? 0}`, product);
  }
  const keys = new Set<string>();
  for (const alias of aliases) {
    if (alias.confidence !== "verified" || alias.newProductId === null) continue;
    const canonical = byProductVariant.get(`${alias.newProductId}:${alias.newVariantId ?? 0}`);
    if (!canonical) continue;
    keys.add(productKey(canonical.storeId, canonical.productId, canonical.variantId));
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Dokumen ledger bulanan (bentuk plain, dipetakan ke
// OlseraInventoryMonthlySnapshotDocument oleh layer store)
// ---------------------------------------------------------------------------

export type MonthlyLedgerSource = "baseline-file" | "stockmovement-backward" | "stockmovement-forward" | "carry-forward" | "catalog";
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
  /** product._id yang DIHENTIKAN di bulan ini (tidak ada movement, anchor closing = 0, & tidak ada bukti eksistensi) — tidak ditulis dokumen utk bulan ini/lebih awal. */
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

/** `anchorClosingQty` HANYA diisi jalur mundur (computeMonthlyStepBackward) — dipakai untuk menulis alasan carry-forward yang jujur bila bukti order-item tidak ada. Jalur maju tidak mengisinya (perilaku/diagnostiknya TIDAK berubah). */
function carryForwardStatusAndDiagnostic(key: string, rawSalesActivityByKey: RawSalesActivityByKey | undefined, anchorClosingQty = 0): { status: MonthlyLedgerStatus; diagnostic: string } {
  const rawSales = rawSalesActivityByKey?.get(key);
  if (rawSales !== undefined && rawSales > 0) {
    return {
      status: "incomplete",
      diagnostic: `Tidak ada baris stockmovement API pada bulan ini, TAPI olsera_inventory_movements (ledger penjualan independen) mencatat aktivitas sumAbsQty=${rawSales} untuk productId ini pada bulan yang sama — kemungkinan productId berubah di sisi Olsera tanpa alias yang menjembatani (lihat olsera_product_aliases). salesQty=0 pada entri ini TIDAK BOLEH dipercaya sebagai final; perlu verifikasi manual/alias sebelum rebuild eksplisit.`,
    };
  }
  return {
    status: "complete",
    diagnostic:
      anchorClosingQty > 0
        ? `Tidak ada baris stockmovement API pada bulan ini — saldo dibawa sama (carry-forward), didukung anchor closing bulan berikutnya = ${anchorClosingQty} (>0): saldo itu SENDIRI bukti produk sudah eksis pada bulan ini, olsera_order_items TIDAK diperlukan (produk yang tidak pernah terjual tidak pernah punya baris order-item).`
        : "Tidak ada baris stockmovement API pada bulan ini — saldo dibawa sama (carry-forward), didukung bukti riwayat pada/sebelum bulan ini.",
  };
}

// ---------------------------------------------------------------------------
// PUTUS BERSIH identitas Olsera — batas tanggal per productId kanonik.
//
// Olsera kadang mengganti identitas produk dan MEMULAI ulang ledger stoknya
// dari nol, TANPA pernah mengekspos riwayat identitas lama lewat stockmovement
// API. Bila alias `verified` menjembatani identitas lama→baru, ledger AYOSERA
// (olsera_inventory_movements) MASIH memuat penjualan identitas lama — dan
// applyVerifiedAliasLedgerFallback akan mewariskannya ke produk kanonik,
// menghasilkan saldo yang tidak pernah bisa cocok dengan Olsera.
//
// Peta ini menandai tanggal putus: baris ledger SEBELUM tanggal tsb milik
// identitas LAMA dan TIDAK BOLEH dihitung sebagai aktivitas produk kanonik
// (lihat fetchRawSalesActivityByMonth di lib/olsera-inventory-monthly-snapshot-store.ts).
// Sengaja per-productId & eksplisit, BUKAN aturan umum: setiap entri harus
// punya bukti terverifikasi sendiri, bukan heuristik.
//
// 116138490 "BOLA PADEL ODEA ROSE" — terverifikasi live 2026-08-26:
//   - stockmovement API Olsera TIDAK punya baris ODEA sama sekali Feb/Mar/Apr;
//     baris pertama muncul Mei dengan begin=0, in=57, sales=12, sisa=45.
//   - olsera_order_items menunjukkan penjualan terus-menerus 1-25 Mei di bawah
//     identitas LAMA 106817649 "BOLA PADEL ODEA" (43 unit), lalu 12 unit pada
//     26-31 Mei — 12 itu PERSIS salesQty Mei versi Olsera.
//   - BA Stock Opname Mei 2026: stok sistem Olsera 45, fisik aktual 44 —
//     hitung fisik mendukung angka Olsera, bukan warisan ledger.
export const LEDGER_HISTORY_CUTOFF_BY_PRODUCT_ID: Record<number, string> = {
  116138490: "2026-05-26",
};

/** true bila baris ledger tanggal `date` milik identitas LAMA productId ini (sebelum putus bersih) — lihat LEDGER_HISTORY_CUTOFF_BY_PRODUCT_ID. */
export function isPreCutoffLedgerRow(productId: number, date: string): boolean {
  const cutoff = LEDGER_HISTORY_CUTOFF_BY_PRODUCT_ID[productId];
  return cutoff !== undefined && date < cutoff;
}

// ---------------------------------------------------------------------------
// Fallback ledger historis untuk identity-change TERVERIFIKASI (Fitur ODEA,
// generik — TIDAK hardcode nama produk apa pun). Diterapkan sebagai langkah
// TERAKHIR (post-processing) atas entries yang SUDAH dihitung oleh sumber
// normal (carry-forward ATAU baris stockmovement API/"matched") — TIDAK
// mengubah cara entries itu sendiri dihitung di tempat lain.
//
// Guard (SEMUA harus benar-benar terbukti dari data existing, tidak ada yang
// ditebak):
//  1. Key ini ada di `verifiedAliasCanonicalKeys` — SATU-SATUNYA sumber
//     kebenaran adalah olsera_product_aliases.confidence==="verified" (lihat
//     buildVerifiedAliasCanonicalKeys), keputusan manusia eksplisit, BUKAN
//     heuristik otomatis apa pun di sini.
//  2. olsera_inventory_movements (rawSalesActivityByKey — saat ini HANYA
//     berisi mutasi "penjualan", lihat lib/mongodb.ts) mencatat aktivitas
//     LEBIH BESAR dari salesQty yang sudah dihitung entry ini dari sumber
//     lain (carry-forward selalu 0, ATAU baris stockmovement API yang
//     ternyata hanya sebagian/tidak lengkap) — bila TIDAK lebih besar, TIDAK
//     ADA alasan mempercayai ledger di atas sumber yang sudah ada, sehingga
//     TIDAK override (mencegah fallback menimpa sumber resmi yang justru
//     lebih kuat/lengkap tanpa alasan).
// Bila kedua syarat terpenuhi: salesQty entry diganti dengan angka ledger
// (satu angka pasti/deterministic, bukan estimasi), lalu opening/closing
// DIHITUNG ULANG lewat formula existing (computeOpeningFromClosingBackward/
// computeClosingFromOpeningForward) — TIDAK PERNAH hardcode. incoming/
// return/outgoing TIDAK disentuh (tetap apa adanya dari sumber asli, karena
// olsera_inventory_movements saat ini hanya mencatat penjualan, bukan
// incoming/return/outgoing). Status menjadi "complete" — bukan dipaksa,
// tapi karena kondisi override HANYA terjadi ketika identitas SUDAH
// terverifikasi eksplisit oleh manusia (alias confidence:"verified"), bukan
// tebakan otomatis. Bila TIDAK terverifikasi (default — semua produk lain,
// termasuk kasus mirip yang belum diverifikasi manual): TIDAK ADA
// perubahan sama sekali, perilaku identik dengan sebelum fitur ini ada.
function applyVerifiedAliasLedgerFallback(
  key: string,
  entry: MonthlyLedgerEntry,
  direction: "backward" | "forward",
  rawSalesActivityByKey: RawSalesActivityByKey | undefined,
  verifiedAliasCanonicalKeys: Set<string> | undefined,
): MonthlyLedgerEntry {
  if (!verifiedAliasCanonicalKeys?.has(key)) return entry;
  const rawSales = rawSalesActivityByKey?.get(key);
  const currentSalesQty = entry.salesQty ?? 0;
  if (rawSales === undefined || rawSales <= currentSalesQty) return entry;

  const diagnostic = `Alias TERVERIFIKASI (olsera_product_aliases, confidence="verified") untuk identitas ini — olsera_inventory_movements mencatat aktivitas penjualan sumAbsQty=${rawSales}, lebih besar dari salesQty=${currentSalesQty} hasil sumber sebelumnya (${entry.source}). Ledger dipakai sebagai salesQty final bulan ini (fallback historis untuk identity-change terverifikasi); incoming/return/outgoing tidak diubah.`;
  const diagnostics = [...entry.diagnostics, diagnostic];

  if (direction === "backward") {
    const openingQty = computeOpeningFromClosingBackward({
      closingQty: entry.closingQty ?? 0,
      incomingQty: entry.incomingQty ?? 0,
      returnQty: entry.returnQty ?? 0,
      salesQty: rawSales,
      outgoingQty: entry.outgoingQty ?? 0,
    });
    return { ...entry, salesQty: rawSales, openingQty, status: "complete", diagnostics };
  }
  const closingQty = computeClosingFromOpeningForward({
    openingQty: entry.openingQty ?? 0,
    incomingQty: entry.incomingQty ?? 0,
    returnQty: entry.returnQty ?? 0,
    salesQty: rawSales,
    outgoingQty: entry.outgoingQty ?? 0,
  });
  return { ...entry, salesQty: rawSales, closingQty, status: "complete", diagnostics };
}

/**
 * Satu langkah mundur (bulan N, closing SUDAH diketahui dari anchor) →
 * hitung opening bulan N via formula, jadikan opening itu closing anchor utk
 * bulan N-1. `productId`/`variantId` pada entry SELALU identitas katalog
 * STABIL (dari kunci Map, bukan productId mentah baris API — bisa beda bila
 * Olsera pernah mengganti ID, lihat canonicalProductId). Produk tanpa baris
 * movement bulan ini: dibawa rata (carry-forward) bila anchor closing bulan
 * berikutnya > 0 — saldo positif itu SENDIRI sudah bukti eksistensi, jadi
 * `hasEvidenceBeforeOrDuring` TIDAK diperlukan di jalur ini (terbukti live
 * 2026-08: "CUP 22OZ" & "HOT CUP KRAFT 12OZ" punya anchor closing 1000 tapi
 * tidak pernah terjual, sehingga tidak pernah punya olsera_order_items dan
 * DULU hilang total dari snapshot bulan-bulan sebelumnya). Bila anchor
 * closing = 0 (produk yang memang belum eksis / saldo kosong): perilaku LAMA
 * dipertahankan — carry-forward HANYA bila `hasEvidenceBeforeOrDuring`
 * membuktikan produk sudah eksis pada/sebelum bulan ini (mis. ada
 * olsera_order_items), bila tidak dihentikan (TIDAK dipaksa masuk laporan
 * bulan yang belum eksis). `rawSalesActivityByKey`
 * (opsional, additive — default tanpa perubahan bila tidak diisi) menandai
 * carry-forward yang KONTRADIKTIF dengan bukti penjualan independen sebagai
 * status "incomplete" (lihat carryForwardStatusAndDiagnostic) — TIDAK PERNAH
 * mengubah angka openingQty/salesQty/closingQty itu sendiri.
 *
 * Produk TANPA anchor (tidak ada dokumen bulan berikutnya) tapi MUNCUL di
 * `matched` bulan ini: dimasukkan HANYA karena `matched` sudah berarti ada
 * baris stockmovement API sungguhan bulan ini (bukti eksistensi nyata sama
 * seperti mekanisme forward, lihat computeMonthlyStepForward) — closingQty-nya
 * dipercaya langsung dari `sisa` API, openingQty dihitung mundur dari situ.
 * `hasEvidenceBeforeOrDuring`/olsera_order_items TIDAK dipakai di jalur ini —
 * identity sudah terbukti unambiguous lewat resolusi `matched` itu sendiri
 * (identity/SKU/nama via matching context yang sama dipakai di semua bulan),
 * jadi bukti order-item tambahan tidak diperlukan (terbukti live 2026-08:
 * RAKET PADEL ADIDAS 2026 MATCH productId 111246035 di Feb 2026 & 3 produk
 * Bullpadel di Mar 2026 — semua punya baris stockmovement lengkap tapi tidak
 * pernah terjual, sehingga tidak pernah punya olsera_order_items).
 */
export function computeMonthlyStepBackward(input: {
  anchors: Map<string, BackwardAnchor>;
  matched: Map<string, MatchedMovement>;
  catalogById: Map<string, InventoryProductInput>;
  hasEvidenceBeforeOrDuring: (productKeyId: string) => boolean;
  rawSalesActivityByKey?: RawSalesActivityByKey;
  /** Opsional (additive) — lihat applyVerifiedAliasLedgerFallback. Default: tidak diisi, perilaku lama TIDAK berubah. */
  verifiedAliasCanonicalKeys?: Set<string>;
}): MonthlyStepBackwardResult {
  const entries = new Map<string, MonthlyLedgerEntry>();
  const nextAnchors = new Map<string, BackwardAnchor>();
  const stopped: string[] = [];
  const seen = new Set<string>();

  for (const [key, anchor] of input.anchors) {
    seen.add(key);
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
    } else if (anchor.closingQty > 0 || input.hasEvidenceBeforeOrDuring(key)) {
      const { status, diagnostic } = carryForwardStatusAndDiagnostic(key, input.rawSalesActivityByKey, anchor.closingQty);
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

  for (const [key, movement] of input.matched) {
    if (seen.has(key)) continue;
    const product = input.catalogById.get(key);
    if (!product) continue;
    const productName = product.variantName ? `${product.name} - ${product.variantName}` : product.name;
    const closing = movement.row.sisa;
    const opening = computeOpeningFromClosingBackward({
      closingQty: closing,
      incomingQty: movement.row.incomingQty,
      returnQty: movement.row.returnQty,
      salesQty: movement.row.salesQty,
      outgoingQty: movement.row.outgoingQty,
    });
    entries.set(key, {
      productId: product.productId,
      variantId: product.variantId,
      canonicalProductId: movement.row.productId !== product.productId ? movement.row.productId : null,
      productName,
      productSku: product.sku,
      groupName: movement.row.productGroupName ?? product.category,
      openingQty: opening,
      incomingQty: movement.row.incomingQty,
      returnQty: movement.row.returnQty,
      salesQty: movement.row.salesQty,
      outgoingQty: movement.row.outgoingQty,
      closingQty: closing,
      source: "stockmovement-backward",
      status: "complete",
      diagnostics: [
        "Produk baru terdeteksi bulan ini (tidak ada anchor/riwayat bulan berikutnya di rantai) — closing dipercaya langsung dari sisa Open API Olsera untuk bulan ini (bukti nyata, bukan tebakan), opening dihitung mundur dari situ.",
      ],
    });
    nextAnchors.set(key, {
      closingQty: opening,
      productName,
      productSku: product.sku,
      groupName: movement.row.productGroupName ?? product.category,
    });
  }

  // Fallback ledger historis untuk identity-change TERVERIFIKASI — langkah
  // TERAKHIR, tidak mengganggu perhitungan di atas (lihat
  // applyVerifiedAliasLedgerFallback). Hanya entries yang memenuhi guard
  // ketat yang berubah; nextAnchors disesuaikan supaya bulan sebelumnya
  // (N-1) menerima closingQty (= openingQty entry ini) yang sudah benar.
  if (input.verifiedAliasCanonicalKeys?.size) {
    for (const [key, entry] of entries) {
      const updated = applyVerifiedAliasLedgerFallback(key, entry, "backward", input.rawSalesActivityByKey, input.verifiedAliasCanonicalKeys);
      if (updated === entry) continue;
      entries.set(key, updated);
      const anchor = nextAnchors.get(key);
      if (anchor && updated.openingQty !== null) nextAnchors.set(key, { ...anchor, closingQty: updated.openingQty });
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
  /** Opsional (additive) — lihat applyVerifiedAliasLedgerFallback. Default: tidak diisi, perilaku lama TIDAK berubah. */
  verifiedAliasCanonicalKeys?: Set<string>;
  /** Katalog aktif dengan stok live > 0 tanpa anchor/movement; hanya dipakai current month. */
  catalogOnly?: Map<string, InventoryProductInput>;
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

  for (const [key, product] of input.catalogOnly ?? []) {
    if (seen.has(key) || entries.has(key) || !product.active || product.stockQty <= 0) continue;
    const productName = product.variantName ? `${product.name} - ${product.variantName}` : product.name;
    entries.set(key, {
      productId: product.productId,
      variantId: product.variantId,
      canonicalProductId: null,
      productName,
      productSku: product.sku,
      groupName: product.category,
      openingQty: product.stockQty,
      incomingQty: 0,
      returnQty: 0,
      salesQty: 0,
      outgoingQty: 0,
      closingQty: product.stockQty,
      source: "catalog",
      status: "complete",
      diagnostics: ["Produk aktif tidak memiliki movement bulan berjalan; stok penutupan berasal dari katalog live Olsera.", "Provenance: CATALOG."],
    });
    nextAnchors.set(key, { openingQty: product.stockQty, productName, productSku: product.sku, groupName: product.category });
  }

  // Fallback ledger historis untuk identity-change TERVERIFIKASI — lihat
  // catatan yang sama di computeMonthlyStepBackward.
  if (input.verifiedAliasCanonicalKeys?.size) {
    for (const [key, entry] of entries) {
      const updated = applyVerifiedAliasLedgerFallback(key, entry, "forward", input.rawSalesActivityByKey, input.verifiedAliasCanonicalKeys);
      if (updated === entry) continue;
      entries.set(key, updated);
      const anchor = nextAnchors.get(key);
      if (anchor && updated.closingQty !== null) nextAnchors.set(key, { ...anchor, openingQty: updated.closingQty });
    }
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
  /** Lihat buildVerifiedAliasCanonicalKeys — dipakai applyVerifiedAliasLedgerFallback. */
  verifiedAliasCanonicalKeys: Set<string>;
};

export function buildMatchingContext(catalogProducts: InventoryProductInput[], aliases: ProductAliasEntry[]): MatchingContext {
  const baseIdentityIndex = buildProductIdentityIndex(catalogProducts);
  const identityIndex = extendIdentityIndexWithAliases(baseIdentityIndex, catalogProducts, aliases);
  const skuIndex = buildSkuIndex(catalogProducts);
  const nameIndex = buildMovementNameIndex(catalogProducts);
  const catalogById = new Map(catalogProducts.map((product) => [product._id, product]));
  const verifiedAliasCanonicalKeys = buildVerifiedAliasCanonicalKeys(catalogProducts, aliases);
  return { catalogProducts, identityIndex, skuIndex, nameIndex, catalogById, verifiedAliasCanonicalKeys };
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
