// Sync permanen penjualan per kategori Olsera ke MongoDB.
// Mengikuti pipeline TERVALIDASI 100% di scripts/validate-olsera-category.ts:
//   Close Order List + Open Order List (is_paid=1, dedup) → detail per order →
//   map product_id ke "klasifikasi" (Product List, fallback detail → nama → "Tidak Diketahui")
//   → agregasi qty+amount+costAmount per (tanggal, kategori).
// Sepenuhnya terpisah dari sync AYO (lib/booking-sync.ts / lib/production-sync.ts).

import { collections, withMongo, type OlseraOrderItemDocument, type OlseraSyncLogDocument } from "@/lib/mongodb";
import { getAccessToken } from "@/lib/olsera";
import {
  evaluateDayCompleteness,
  fetchDayOrderRows,
  sumOrderTotals,
  type OlseraOrderKind,
} from "@/lib/olsera-audit";
import {
  emptyResolutionStats,
  normalizeKlasifikasi as normalizeResolverKlasifikasi,
  normalizeName,
  resolveItemCategory,
  tallyResolution,
  type CategoryResolution,
  type ItemIdentity,
  type ResolutionStats,
  type ResolverContext,
} from "@/lib/olsera-category-resolver";
import { loadResolverContext } from "@/lib/olsera-resolver-context";
import { parseAddonPrice } from "@/lib/olsera-addon";

const BASE_URL = "https://api-open.olsera.co.id";
const API_PREFIX = "/api/open-api/v1/id";
// 4 worker × 100ms terbukti memicu badai 429 dari Olsera (~12-18 order gagal
// per ~98 order). Diturunkan ke 2 worker × 200ms: ~100 order ≈ 25-35 detik,
// tetap jauh di bawah maxDuration 300s.
const DETAIL_DELAY_MS = 200;
const LIST_DELAY_MS = 100;
const DETAIL_CONCURRENCY = 2;
// Jeda putaran retry akhir (sekuensial, percobaan terakhir yang hati-hati).
const RETRY_PASS_DELAY_MS = 500;
const UNKNOWN_CATEGORY = "Tidak Diketahui";

type ProductInfo = { klasifikasi: string; name: string };
type Aggregate = { qty: number; amount: number; costAmount: number };
type OrderRef = { id: number; source: "close" | "open" };

export type OlseraSyncResult = {
  status: "success" | "partial" | "failed";
  startDate: string;
  endDate: string;
  expectedOrderCount: number;
  processedOrderCount: number;
  lastFullySyncedDate: string | null;
  days: { date: string; expected: number; processed: number; success: boolean; skipped?: boolean }[];
  errorMessage: string | null;
  /** true = resolver context diambil dari cache in-memory; false = fetch ulang katalog penuh. */
  productCacheHit: boolean;
  /** Order yang tetap gagal setelah putaran retry akhir (ikut disimpan ke olsera_sync_log). */
  failedOrders: { date: string; orderId: number; reason: string }[];
  /** Ringkasan mapping kategori item (canonical resolver). */
  resolutionStats: ResolutionStats;
  /** Contoh item unresolved (maks 50) untuk audit cepat tanpa membongkar DB. */
  unresolvedItems: { date: string; orderNo: string; itemName: string; productId: number | null }[];
};

export type OlseraSyncOptions = {
  /** true = sync ulang hari yang sudah tercatat tuntas (default: dilewati). */
  force?: boolean;
};

// Normalisasi nama klasifikasi (identik dengan skrip validasi): trim, collapse
// spasi ganda, hilangkan spasi di sekeliling "+" ("KERANJANG+ BOLA").
function normalizeKlasifikasi(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/\s*\+\s*/g, "+");
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function todayJakarta(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function* eachDay(startDate: string, endDate: string) {
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) yield date;
}

async function getJson(
  token: string,
  pathName: string,
  params: Record<string, string>,
  allow404 = false,
): Promise<Record<string, unknown> | null> {
  const url = new URL(BASE_URL + pathName);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  // Retry dengan backoff saat Olsera menjawab 429/5xx. 429 (rate limit) diberi
  // budget retry lebih longgar (6 attempt) daripada 5xx (4 attempt) karena 429
  // pasti pulih bila menunggu cukup lama; hormati header Retry-After bila ada.
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    // 404 pada endpoint order Olsera berarti "tidak ada data", bukan error.
    if (response.status === 404 && allow404) return null;
    const isRateLimited = response.status === 429;
    const maxAttempts = isRateLimited ? 6 : 4;
    if ((isRateLimited || response.status >= 500) && attempt < maxAttempts) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
      await sleep(Math.min(waitMs, 10_000));
      continue;
    }
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`HTTP ${response.status} untuk ${pathName} setelah ${attempt} percobaan: ${raw.slice(0, 200)}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}

/** Upsert satu produk ke cache MongoDB (produk baru yang belum ada di katalog cache). */
async function upsertProductCacheEntry(productId: string, info: ProductInfo) {
  try {
    await withMongo(async () => {
      const { olseraProductCache } = await collections();
      await olseraProductCache.updateOne(
        { productId },
        { $set: { klasifikasi: info.klasifikasi, cachedAt: new Date() } },
        { upsert: true },
      );
    });
  } catch (error) {
    console.error(`Olsera sync: gagal upsert cache produk ${productId}`, error);
  }
}

// Ambil id order dari list (close atau open) untuk satu tanggal, semua halaman.
async function fetchOrderIds(
  token: string,
  kind: "closeorder" | "openorder",
  date: string,
): Promise<number[]> {
  const ids: number[] = [];
  let page = 1;
  for (;;) {
    const params: Record<string, string> = {
      per_page: "100",
      page: String(page),
      start_date: date,
      end_date: date,
    };
    if (kind === "openorder") params.is_paid = "1";
    const body = await getJson(token, `${API_PREFIX}/order/${kind}`, params, true);
    if (!body) break;
    const list: Record<string, unknown>[] = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
    for (const order of list) ids.push(Number(order.id));
    const meta = body.meta as { last_page?: number } | undefined;
    if (!meta?.last_page || page >= meta.last_page) break;
    page++;
    await sleep(LIST_DELAY_MS);
  }
  return ids;
}

type OrderItem = {
  id: unknown;
  product_id: unknown;
  product_name?: string;
  product_variant_id?: unknown;
  product_variant_name?: string;
  product_sku?: unknown;
  product_variant_sku?: unknown;
  qty: unknown;
  amount: unknown;
  cost_amount?: unknown;
  cost_price?: unknown;
  discount?: unknown;
  /** Nilai add-on per unit — SUDAH termasuk di `amount` (dibuktikan dari data nyata). */
  addon_price?: unknown;
};

/** Read-only representation for the private gap audit. It deliberately shares
 * the authenticated client, list pagination, and detail mapper of this sync. */
export type OlseraSalesAuditSource = {
  orders: { identity: string; total: number; status: string | null }[];
  items: { identity: string; date: string; orderIdentity: string; productId: number | null; variantId: number | null; sku: string | null; qty: number; amount: number; raw: Record<string, unknown> }[];
};

export class OlseraSalesAuditSourceError extends Error {
  readonly code: "TOKEN_ERROR" | "SOURCE_INCOMPLETE";
  constructor(code: "TOKEN_ERROR" | "SOURCE_INCOMPLETE", message: string) { super(message); this.code = code; this.name = "OlseraSalesAuditSourceError"; }
}

function toIdOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

function toTextOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/** Payload item mentah untuk disimpan — buang field photo/gambar agar dokumen ramping. */
function rawItemPayload(item: OrderItem): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (/photo/i.test(key)) continue;
    raw[key] = value;
  }
  return raw;
}

// Field level-order dipakai untuk export detail transaksi (Feature: Export Detail Transaksi).
// Diverifikasi terhadap payload nyata /order/closeorder/detail (lihat laporan resmi Olsera):
//   order_time  = "2026-05-01 06:57:24"  → jam transaksi sebenarnya
//   order_date  = "2026-05-01 00:00:00"  → selalu tengah malam (hanya tanggal)
//   sales_by_name = "AMEL", order_source = "D" (kode: D = DINE IN)
//   customer_id = 0 / customer_name = null / table_no = "" saat kosong
type OrderMeta = {
  order_no?: unknown;
  order_date?: unknown;
  transaction_date?: unknown;
  transaction_time?: unknown;
  order_time?: unknown;
  paid_at?: unknown;
  customer_id?: unknown;
  customer_name?: unknown;
  table_no?: unknown;
  table_name?: unknown;
  sales_by_name?: unknown;
  serve_by_name?: unknown;
  cashier_name?: unknown;
  created_by?: unknown;
  customer?: unknown;
  table?: unknown;
  sales_by?: unknown;
  cashier?: unknown;
  order_source?: unknown;
  order_source_name?: unknown;
  order_type?: unknown;
  order_type_name?: unknown;
  service_type?: unknown;
  service_type_name?: unknown;
};

function objectText(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (candidate !== null && candidate !== undefined && String(candidate).trim() !== "") return String(candidate).trim();
  }
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const candidate of values) {
    if (candidate === null || candidate === undefined || typeof candidate === "object") continue;
    const text = String(candidate).trim();
    if (!text || text === "[object Object]") continue;
    return text;
  }
  return null;
}

function personName(...values: unknown[]): string | null {
  for (const candidate of values) {
    const nested = objectText(candidate, ["name", "full_name", "display_name", "username"]);
    const text = nested ?? firstText(candidate);
    if (!text || /^\d+$/.test(text)) continue;
    return text;
  }
  return null;
}

function labelText(...values: unknown[]): string | null {
  for (const candidate of values) {
    const nested = objectText(candidate, ["name", "label", "title", "display_name", "code"]);
    const text = nested ?? firstText(candidate);
    if (!text || /^\d+$/.test(text)) continue;
    return text.toUpperCase();
  }
  return null;
}

function orderDateTime(meta: OrderMeta, fallbackDate: string): string {
  // order_time membawa jam transaksi sebenarnya; order_date dari Olsera selalu
  // "YYYY-MM-DD 00:00:00". Jangan pernah pakai created_time/modified_time
  // (jam server, beda timezone). Bila jam benar-benar tidak tersedia,
  // kembalikan tanggal saja — bukan 00:00:00 palsu.
  const withClock = firstText(meta.order_time, meta.transaction_time, meta.paid_at);
  if (withClock && /[T ]\d{1,2}:\d{2}/.test(withClock) && !/[T ]00:00:00$/.test(withClock)) return withClock;
  const dateSource = firstText(meta.order_date, meta.transaction_date, withClock) ?? fallbackDate;
  return dateSource.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? fallbackDate;
}

// Kode order_source Olsera → label seperti pada export resmi Olsera.
const ORDER_SOURCE_LABELS: Record<string, string> = {
  D: "DINE IN",
  T: "TAKE AWAY",
  DV: "DELIVERY",
  P: "PICK UP",
};

function orderTypeLabel(meta: OrderMeta): string | null {
  const named = labelText(meta.order_source_name, meta.order_type_name, meta.service_type_name);
  if (named) return named;
  const code = firstText(meta.order_source, meta.order_type, meta.service_type);
  if (!code) return null;
  return ORDER_SOURCE_LABELS[code.toUpperCase()] ?? code.toUpperCase();
}

function salesBy(meta: OrderMeta): string | null {
  // "-" adalah placeholder Olsera untuk serve_by_name kosong.
  const cashier = personName(meta.sales_by_name, meta.cashier_name, meta.created_by, meta.cashier, meta.sales_by, meta.serve_by_name);
  const name = cashier && cashier !== "-" ? cashier : null;
  const orderType = orderTypeLabel(meta);
  return name ? `${name}${orderType ? ` (${orderType})` : ""}` : null;
}

function customerIdText(meta: OrderMeta): string | null {
  // customer_id = 0 berarti tanpa pelanggan — jangan tulis "0" ke kolom teks.
  const id = firstText(meta.customer_id, objectText(meta.customer, ["id", "customer_id"]));
  return id && id !== "0" ? id : null;
}

async function fetchOrderDetail(
  token: string,
  order: OrderRef,
): Promise<{ meta: OrderMeta; items: OrderItem[] }> {
  const kind = order.source === "close" ? "closeorder" : "openorder";
  const body = await getJson(token, `${API_PREFIX}/order/${kind}/detail`, { id: String(order.id) });
  const data = (body?.data ?? {}) as OrderMeta & { orderitems?: OrderItem[] };
  return { meta: data, items: Array.isArray(data.orderitems) ? data.orderitems : [] };
}

async function fetchProductDetail(token: string, productId: string): Promise<ProductInfo | undefined> {
  const candidates: { path: string; params: Record<string, string> }[] = [
    { path: `${API_PREFIX}/product/detail`, params: { id: productId } },
    { path: `${API_PREFIX}/product/${productId}`, params: {} },
  ];
  for (const candidate of candidates) {
    try {
      const body = await getJson(token, candidate.path, candidate.params, true);
      if (!body) continue;
      const data = (body.data ?? body) as Record<string, unknown>;
      const klasifikasi = typeof data.klasifikasi === "string" && data.klasifikasi ? data.klasifikasi : "";
      const name = typeof data.name === "string" ? data.name : "";
      if (!klasifikasi && !name) continue;
      return { klasifikasi: klasifikasi || "(tanpa klasifikasi)", name };
    } catch {
      // kandidat gagal — coba bentuk berikutnya
    }
  }
  return undefined;
}

// Cache resolusi via Product Detail dalam satu run (produk unpublish yang
// tidak muncul di Product List tetapi detail-nya masih bisa ditarik).
type DetailResolution = CategoryResolution | null;

/**
 * Resolusi kategori satu item: canonical resolver (product_id → variant_id →
 * alias → SKU → barcode → nama exact → historis), lalu fallback terakhir
 * Product Detail API untuk product_id yang tidak ada di Product List.
 * Tidak ada pencocokan substring — unresolved dikembalikan apa adanya untuk audit.
 */
async function resolveItemWithFallback(
  token: string,
  identity: ItemIdentity,
  ctx: ResolverContext,
  detailCache: Map<number, DetailResolution>,
): Promise<CategoryResolution> {
  const resolution = resolveItemCategory(identity, ctx);
  if (resolution.status === "resolved" || identity.productId == null) return resolution;

  if (detailCache.has(identity.productId)) {
    return detailCache.get(identity.productId) ?? resolution;
  }
  const info = await fetchProductDetail(token, String(identity.productId));
  let detailResolution: DetailResolution = null;
  if (info) {
    detailResolution = {
      status: "resolved",
      method: "product-id",
      category: normalizeResolverKlasifikasi(info.klasifikasi),
      categoryId: null,
      resolvedProductId: identity.productId,
      resolvedVariantId: identity.variantId ?? null,
      reason: null,
    };
    await upsertProductCacheEntry(String(identity.productId), info);
  }
  detailCache.set(identity.productId, detailResolution);
  return detailResolution ?? resolution;
}

export async function syncOlseraSalesByCategory(
  startDate: string,
  endDate: string,
  options: OlseraSyncOptions = {},
): Promise<OlseraSyncResult> {
  const startedAt = new Date();
  const result: OlseraSyncResult = {
    status: "failed",
    startDate,
    endDate,
    expectedOrderCount: 0,
    processedOrderCount: 0,
    lastFullySyncedDate: null,
    days: [],
    errorMessage: null,
    productCacheHit: false,
    failedOrders: [],
    resolutionStats: emptyResolutionStats(),
    unresolvedItems: [],
  };

  try {
    const auth = await getAccessToken();
    if ("error" in auth) throw new Error(auth.error);
    const token = auth.token;

    // Canonical resolver context: katalog aktif + alias produk historis +
    // identitas historis. Menggantikan peta product_id→klasifikasi lama.
    const { ctx: resolverCtx, cacheHit } = await loadResolverContext();
    result.productCacheHit = cacheHit;
    const detailCache = new Map<number, DetailResolution>();

    // Hari yang sudah pernah tuntas dilewati (kecuali force) — sync ulang
    // rentang lebar jadi hanya mengerjakan hari yang benar-benar kurang.
    const alreadySynced = new Set<string>();
    if (!options.force) {
      await withMongo(async () => {
        const { olseraSyncedDays } = await collections();
        const docs = await olseraSyncedDays
          .find({ _id: { $gte: startDate, $lte: endDate } }, { projection: { _id: 1 } })
          .toArray();
        for (const doc of docs) alreadySynced.add(doc._id);
      });
    }

    for (const date of eachDay(startDate, endDate)) {
      const day = { date, expected: 0, processed: 0, success: false, skipped: false };
      result.days.push(day);
      if (alreadySynced.has(date)) {
        day.success = true;
        day.skipped = true;
        continue;
      }
      try {
        // Langkah 1-3: Close + Open paid, dedup by order id.
        const closeIds = await fetchOrderIds(token, "closeorder", date);
        await sleep(LIST_DELAY_MS);
        const openIds = await fetchOrderIds(token, "openorder", date);
        const seen = new Set(closeIds);
        const orders: OrderRef[] = closeIds.map((id) => ({ id, source: "close" as const }));
        for (const id of openIds) {
          if (!seen.has(id)) orders.push({ id, source: "open" });
        }
        day.expected = orders.length;
        result.expectedOrderCount += orders.length;

        // Langkah 4-7: detail per order → agregasi per klasifikasi.
        // Detail ditarik paralel (pool DETAIL_CONCURRENCY worker) — agregasi
        // Map aman karena JS single-threaded.
        const byCategory = new Map<string, Aggregate>();
        // Detail per baris item (Export Detail Transaksi) — dikumpulkan bareng
        // agregasi kategori supaya cukup satu kali tarik Close Order Detail.
        const itemDocs: OlseraOrderItemDocument[] = [];

        const processOrder = async (order: OrderRef) => {
          const { meta, items } = await fetchOrderDetail(token, order); // boleh throw — ditangani pemanggil
          for (const item of items) {
            const itemName = item.product_variant_name
              ? `${item.product_name ?? ""} - ${item.product_variant_name}`
              : String(item.product_name ?? "");
            const itemId = Number(item.id);
            // Identitas produk dari payload transaksi — disimpan agar perubahan
            // product_id di katalog tidak menghilangkan jejak transaksi lama.
            // orderItemId dipakai HANYA untuk lookup manual override per item
            // (lihat olsera_category_overrides) — tidak pernah aturan global.
            const identity: ItemIdentity = {
              itemName,
              productId: toIdOrNull(item.product_id),
              variantId: toIdOrNull(item.product_variant_id),
              sku: toTextOrNull(item.product_variant_sku) ?? toTextOrNull(item.product_sku),
              barcode: null,
              orderItemId: Number.isFinite(itemId) ? itemId : null,
            };
            const resolution = await resolveItemWithFallback(token, identity, resolverCtx, detailCache);
            tallyResolution(result.resolutionStats, resolution);
            const orderNo = String(meta.order_no ?? order.id);
            if (resolution.status === "unresolved" && result.unresolvedItems.length < 50) {
              result.unresolvedItems.push({ date, orderNo, itemName, productId: identity.productId ?? null });
            }

            const category = resolution.category;
            const entry = byCategory.get(category) ?? { qty: 0, amount: 0, costAmount: 0 };
            entry.qty += toNumber(item.qty);
            entry.amount += toNumber(item.amount);
            entry.costAmount += toNumber(item.cost_amount);
            byCategory.set(category, entry);

            if (Number.isFinite(itemId)) {
              // Add-on: informasi saja — `amount` SUDAH mengandung add-on
              // ((basic price + addon) × qty − discount). Jangan pernah
              // menjumlahkan addonPrice ke amount/total manapun.
              const addonResult = parseAddonPrice(item.addon_price);
              if (addonResult.warning) {
                console.warn(`Olsera sync: item ${itemId} (order ${orderNo}, ${date}): ${addonResult.warning}`);
              }
              itemDocs.push({
                _id: itemId,
                date,
                orderNo,
                orderDate: orderDateTime(meta, date),
                customerId: customerIdText(meta),
                customerName: personName(meta.customer_name, meta.customer),
                tableNo: firstText(meta.table_no, meta.table_name, objectText(meta.table, ["number", "no", "name", "table_no"])),
                salesByName: salesBy(meta),
                itemName,
                qty: toNumber(item.qty),
                amount: toNumber(item.amount),
                costAmount: toNumber(item.cost_amount),
                discount: toNumber(item.discount),
                addonPrice: addonResult.value,
                syncedAt: new Date(),
                // Identitas + hasil resolusi canonical (Feature: category mapping).
                productId: identity.productId ?? null,
                variantId: identity.variantId ?? null,
                sku: identity.sku ?? null,
                barcode: null,
                normalizedItemName: normalizeName(itemName),
                originalCategoryId: null,
                originalCategoryName: null,
                resolvedProductId: resolution.resolvedProductId,
                resolvedCategoryId: resolution.categoryId,
                resolvedCategoryName: resolution.status === "resolved" ? resolution.category : null,
                categoryResolutionMethod: resolution.method,
                categoryResolutionStatus: resolution.status,
                categoryResolutionReason: resolution.reason,
                ...(resolution.method === "manual_override" ? { resolvedAt: new Date() } : {}),
                raw: rawItemPayload(item),
              });
            }
          }
          day.processed++;
          result.processedOrderCount++;
        };

        // Order yang gagal TIDAK langsung divonis — dikumpulkan untuk putaran retry akhir.
        const failedOrders: { order: OrderRef; reason: string }[] = [];
        let cursor = 0;
        const worker = async () => {
          for (;;) {
            const index = cursor++;
            if (index >= orders.length) return;
            const order = orders[index];
            await sleep(DETAIL_DELAY_MS);
            try {
              await processOrder(order);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              console.error(`Olsera sync: gagal detail order ${order.id} (${date}): ${reason}`);
              failedOrders.push({ order, reason });
            }
          }
        };
        await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));

        // Putaran retry akhir: SEKUENSIAL (concurrency 1) dengan jeda lebih lega —
        // percobaan terakhir yang hati-hati sebelum order benar-benar dianggap gagal.
        if (failedOrders.length) {
          console.log(`Olsera sync: retry akhir ${failedOrders.length} order gagal (${date}), sekuensial`);
          for (const failed of failedOrders) {
            await sleep(RETRY_PASS_DELAY_MS);
            try {
              await processOrder(failed.order);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              console.error(`Olsera sync: order ${failed.order.id} (${date}) tetap gagal setelah retry akhir: ${reason}`);
              result.failedOrders.push({ date, orderId: failed.order.id, reason });
            }
          }
        }

        day.success = day.processed === day.expected;

        // Hari yang tidak tuntas TIDAK ditulis: agregat parsial akan menimpa
        // data lama yang benar dengan angka yang kurang.
        if (day.success) {
          await withMongo(async () => {
            const { olseraSalesByCategory, olseraSyncedDays, olseraOrderItems, olseraSalesCorrections } = await collections();
            const syncedAt = new Date();
            // Historical corrections are deliberately separate from order items:
            // they affect sales reporting only and must never become inventory
            // movements or be mislabeled as normal sales.
            const corrections = await olseraSalesCorrections.find({ date }).toArray();
            for (const correction of corrections) {
              const entry = byCategory.get(correction.category) ?? { qty: 0, amount: 0, costAmount: 0 };
              entry.qty += correction.qty;
              entry.amount += correction.amount;
              byCategory.set(correction.category, entry);
            }
            if (byCategory.size) {
              await olseraSalesByCategory.bulkWrite(
                [...byCategory.entries()].map(([category, agg]) => ({
                  updateOne: {
                    filter: { date, category },
                    update: {
                      $set: { qty: agg.qty, totalAmount: agg.amount, costAmount: agg.costAmount, syncedAt },
                    },
                    upsert: true,
                  },
                })),
              );
            }
            // Buang kategori lama yang tidak muncul lagi pada sync ulang hari ini.
            await olseraSalesByCategory.deleteMany({ date, syncedAt: { $lt: syncedAt } });
            if (itemDocs.length) {
              // Upsert per _id (id baris item Olsera) — sync ulang tidak menghasilkan duplikat.
              await olseraOrderItems.bulkWrite(
                itemDocs.map((doc) => ({
                  updateOne: {
                    filter: { _id: doc._id },
                    // syncedAt disamakan dengan timestamp tulis agar tidak ikut
                    // terhapus oleh pembersihan item basi di bawah.
                    update: { $set: { ...doc, syncedAt } },
                    upsert: true,
                  },
                })),
              );
            }
            // Buang item lama yang tidak muncul lagi pada sync ulang hari ini
            // (order dibatalkan/di-void di Olsera) — mencegah data basi tersisa.
            await olseraOrderItems.deleteMany({ date, syncedAt: { $lt: syncedAt } });
            // Tandai hari ini tuntas agar sync berikutnya (rentang tumpang tindih)
            // bisa langsung dilewati tanpa menarik ulang order+detail.
            await olseraSyncedDays.updateOne(
              { _id: date },
              { $set: { expectedOrderCount: day.expected, syncedAt } },
              { upsert: true },
            );
          });
        }
      } catch (error) {
        console.error(`Olsera sync: hari ${date} gagal`, error);
        day.success = false;
      }
    }

    const allSuccess = result.days.every((day) => day.success);
    const anySuccess = result.days.some((day) => day.success);
    result.status = allSuccess ? "success" : anySuccess ? "partial" : "failed";
    if (result.status !== "success") {
      const failedDays = result.days.filter((day) => !day.success).map((day) => day.date);
      result.errorMessage = `Hari tidak tuntas: ${failedDays.join(", ")}`;
    }
  } catch (error) {
    result.status = "failed";
    result.errorMessage = error instanceof Error ? error.message : "Sync Olsera gagal.";
  }

  // Tulis log + update checkpoint (best effort — jangan menutupi error sync).
  try {
    result.lastFullySyncedDate = await withMongo(async () => {
      const { olseraSyncLog, olseraSyncState } = await collections();

      const log: OlseraSyncLogDocument = {
        startDate,
        endDate,
        status: result.status,
        expectedOrderCount: result.expectedOrderCount,
        processedOrderCount: result.processedOrderCount,
        errorMessage: result.errorMessage,
        // Ringkasan order gagal disimpan ke DB agar investigasi tidak bergantung Vercel logs.
        ...(result.failedOrders.length ? { failedOrders: result.failedOrders } : {}),
        startedAt,
        finishedAt: new Date(),
      };
      await olseraSyncLog.insertOne(log);

      // Checkpoint: maju hanya melalui hari-hari sukses BERURUTAN dari awal
      // rentang, dan hanya bila rentang ini menyambung checkpoint lama
      // (tidak boleh melompati tanggal yang belum pernah tuntas).
      const state = await olseraSyncState.findOne({ _id: "olsera" });
      let checkpoint = state?.lastFullySyncedDate ?? null;
      const contiguous = checkpoint === null || startDate <= addDays(checkpoint, 1);
      if (contiguous) {
        let candidate = checkpoint;
        for (const day of result.days) {
          if (!day.success) break;
          if (candidate === null || day.date > candidate) candidate = day.date;
        }
        if (candidate !== checkpoint) {
          checkpoint = candidate;
          await olseraSyncState.updateOne(
            { _id: "olsera" },
            { $set: { lastFullySyncedDate: checkpoint, updatedAt: new Date() } },
            { upsert: true },
          );
        }
      }
      return checkpoint;
    });
  } catch (error) {
    console.error("Olsera sync: gagal menulis log/checkpoint", error);
  }

  return result;
}

/**
 * Fetch the same Close/Open-paid lists and order details as production sync,
 * but performs no database write, category resolution, checkpoint, or cleanup.
 */
export async function fetchOlseraSalesAuditSource(startDate: string, endDate: string): Promise<OlseraSalesAuditSource> {
  const auth = await getAccessToken();
  if ("error" in auth) throw new OlseraSalesAuditSourceError("TOKEN_ERROR", "Autentikasi Olsera tidak tersedia.");
  const result: OlseraSalesAuditSource = { orders: [], items: [] };
  try {
    for (const date of eachDay(startDate, endDate)) {
      const closeIds = await fetchOrderIds(auth.token, "closeorder", date);
      await sleep(LIST_DELAY_MS);
      const openIds = await fetchOrderIds(auth.token, "openorder", date);
      const seen = new Set(closeIds);
      const orders: OrderRef[] = closeIds.map((id) => ({ id, source: "close" }));
      for (const id of openIds) if (!seen.has(id)) orders.push({ id, source: "open" });
      for (const order of orders) {
        const { meta, items } = await fetchOrderDetail(auth.token, order);
        const orderIdentity = String(meta.order_no ?? order.id).trim();
        if (!orderIdentity) throw new OlseraSalesAuditSourceError("SOURCE_INCOMPLETE", "Order Olsera tidak memiliki identity.");
        const normalizedItems = items.map((item) => {
          const itemId = Number(item.id);
          if (!Number.isFinite(itemId)) throw new OlseraSalesAuditSourceError("SOURCE_INCOMPLETE", "Item Olsera tidak memiliki identity.");
          return { identity: String(itemId), date, orderIdentity, productId: toIdOrNull(item.product_id), variantId: toIdOrNull(item.product_variant_id), sku: toTextOrNull(item.product_variant_sku) ?? toTextOrNull(item.product_sku), qty: toNumber(item.qty), amount: toNumber(item.amount), raw: rawItemPayload(item) };
        });
        result.orders.push({ identity: orderIdentity, total: normalizedItems.reduce((sum, item) => sum + item.amount, 0), status: firstText((meta as Record<string, unknown>).status, (meta as Record<string, unknown>).payment_status) });
        result.items.push(...normalizedItems);
      }
    }
    return result;
  } catch (error) {
    if (error instanceof OlseraSalesAuditSourceError) throw error;
    const message = error instanceof Error ? error.message : "Sumber Olsera tidak lengkap.";
    if (/HTTP 401|HTTP 403|token|autentikasi/i.test(message)) throw new OlseraSalesAuditSourceError("TOKEN_ERROR", "Token Olsera ditolak atau kedaluwarsa.");
    throw new OlseraSalesAuditSourceError("SOURCE_INCOMPLETE", "Sumber Olsera tidak dapat dipastikan lengkap.");
  }
}

export type OlseraDayAuditResult = {
  date: string;
  /** match = data sudah cocok; resynced = ditarik ulang dan tersimpan; failed = gagal. */
  action: "match" | "resynced" | "failed";
  expectedOrderCount: number;
  processedOrderCount: number;
  /** Alasan keputusan audit (untuk log/progres UI). */
  reason: string | null;
  errorMessage: string | null;
  /** Ringkasan mapping kategori saat resync (0 semua bila action=match). */
  resolutionStats?: ResolutionStats;
};

/** Majukan checkpoint bila `date` menyambung (tidak melompati tanggal yang belum tuntas). */
async function advanceCheckpointTo(date: string) {
  await withMongo(async () => {
    const { olseraSyncState } = await collections();
    const state = await olseraSyncState.findOne({ _id: "olsera" });
    const checkpoint = state?.lastFullySyncedDate ?? null;
    if (checkpoint !== null && date > addDays(checkpoint, 1)) return;
    if (checkpoint === null || date > checkpoint) {
      await olseraSyncState.updateOne(
        { _id: "olsera" },
        { $set: { lastFullySyncedDate: date, updatedAt: new Date() } },
        { upsert: true },
      );
    }
  });
}

/**
 * Audit satu tanggal terhadap API Olsera (sumber kebenaran):
 * bandingkan jumlah order + total penjualan Order List dengan catatan MongoDB.
 * Bila belum lengkap → tarik ulang penuh (upsert, aman duplikat).
 * Dipanggil frontend satu tanggal per request agar aman di Vercel.
 */
export async function auditAndSyncOlseraDay(date: string): Promise<OlseraDayAuditResult> {
  const result: OlseraDayAuditResult = {
    date,
    action: "failed",
    expectedOrderCount: 0,
    processedOrderCount: 0,
    reason: null,
    errorMessage: null,
  };

  try {
    const auth = await getAccessToken();
    if ("error" in auth) throw new Error(auth.error);
    const token = auth.token;

    // Order List (Close + Open paid, dedup) — error/pagination gagal dilempar,
    // sehingga "0 order" hanya sah bila API benar-benar menjawab kosong.
    const rows = await fetchDayOrderRows(async (kind: OlseraOrderKind, page: number) => {
      if (page > 1) await sleep(LIST_DELAY_MS);
      const params: Record<string, string> = {
        per_page: "100",
        page: String(page),
        start_date: date,
        end_date: date,
      };
      if (kind === "openorder") params.is_paid = "1";
      return (await getJson(token, `${API_PREFIX}/order/${kind}`, params, true)) as {
        data?: unknown;
        meta?: { last_page?: number };
      } | null;
    });
    const expectedCount = rows.length;
    const expectedTotal = sumOrderTotals(rows);
    result.expectedOrderCount = expectedCount;

    const { marked, storedOrderCount } = await withMongo(async () => {
      const { olseraSyncedDays, olseraOrderItems } = await collections();
      const [markedDoc, orderNos] = await Promise.all([
        olseraSyncedDays.findOne({ _id: date }),
        olseraOrderItems.distinct("orderNo", { date }),
      ]);
      return { marked: markedDoc, storedOrderCount: orderNos.length };
    });

    const verdict = evaluateDayCompleteness({
      expectedCount,
      expectedTotal,
      marked: marked ? { expectedOrderCount: marked.expectedOrderCount, expectedTotal: marked.expectedTotal } : null,
      storedOrderCount,
    });
    result.reason = verdict.reason;

    if (verdict.complete) {
      // Catat hasil audit (termasuk total sebagai baseline pembanding berikutnya)
      // dan majukan checkpoint bila menyambung.
      await withMongo(async () => {
        const { olseraSyncedDays } = await collections();
        await olseraSyncedDays.updateOne(
          { _id: date },
          {
            $set: { expectedOrderCount: expectedCount, expectedTotal, verifiedAt: new Date() },
            $setOnInsert: { syncedAt: new Date() },
          },
          { upsert: true },
        );
      });
      await advanceCheckpointTo(date);
      result.action = "match";
      return result;
    }

    // Belum lengkap → tarik ulang penuh tanggal ini (force, upsert aman duplikat).
    const sync = await syncOlseraSalesByCategory(date, date, { force: true });
    result.expectedOrderCount = sync.expectedOrderCount;
    result.processedOrderCount = sync.processedOrderCount;
    result.resolutionStats = sync.resolutionStats;
    if (sync.status === "success") {
      await withMongo(async () => {
        const { olseraSyncedDays } = await collections();
        await olseraSyncedDays.updateOne(
          { _id: date },
          { $set: { expectedTotal, verifiedAt: new Date() } },
        );
      });
      result.action = "resynced";
    } else {
      result.action = "failed";
      result.errorMessage = sync.errorMessage ?? `Sync ulang tanggal ${date} gagal.`;
    }
  } catch (error) {
    result.action = "failed";
    result.errorMessage = error instanceof Error ? error.message : `Audit tanggal ${date} gagal.`;
  }
  return result;
}

export type OlseraMonthSyncSummary = {
  startDate: string;
  endDate: string;
  checkedDates: number;
  matchedDates: number;
  updatedDates: number;
  expectedOrderCount: number;
  processedOrderCount: number;
  failedDates: string[];
  startedAt: string;
};

/**
 * Tulis satu log ringkasan untuk seluruh run bulan berjalan — dipanggil frontend
 * setelah semua tanggal selesai. Log ini yang tampil sebagai status terakhir,
 * sehingga badge tidak pernah "Success" bila masih ada tanggal gagal.
 */
export async function logOlseraMonthSync(summary: OlseraMonthSyncSummary) {
  const status: OlseraSyncLogDocument["status"] = summary.failedDates.length
    ? summary.matchedDates + summary.updatedDates > 0
      ? "partial"
      : "failed"
    : "success";
  const startedAt = new Date(summary.startedAt);
  await withMongo(async () => {
    const { olseraSyncLog } = await collections();
    await olseraSyncLog.insertOne({
      startDate: summary.startDate,
      endDate: summary.endDate,
      status,
      expectedOrderCount: summary.expectedOrderCount,
      processedOrderCount: summary.processedOrderCount,
      errorMessage: summary.failedDates.length ? `Tanggal gagal: ${summary.failedDates.join(", ")}` : null,
      startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
      finishedAt: new Date(),
    });
  });
  return { status };
}

export async function getOlseraSyncStatus() {
  return withMongo(async () => {
    const { olseraSalesByCategory, olseraSyncLog, olseraSyncState, olseraOrderItems } = await collections();
    const [state, lastLog, earliestDoc, unresolvedItemCount] = await Promise.all([
      olseraSyncState.findOne({ _id: "olsera" }),
      olseraSyncLog.find().sort({ startedAt: -1 }).limit(1).next(),
      olseraSalesByCategory.find().sort({ date: 1 }).limit(1).next(),
      olseraOrderItems.countDocuments({ categoryResolutionStatus: "unresolved" }),
    ]);
    return {
      unresolvedItemCount,
      lastFullySyncedDate: state?.lastFullySyncedDate ?? null,
      firstSyncedDate: earliestDoc?.date ?? null,
      lastSync: lastLog
        ? {
            status: lastLog.status,
            startDate: lastLog.startDate,
            endDate: lastLog.endDate,
            expectedOrderCount: lastLog.expectedOrderCount,
            processedOrderCount: lastLog.processedOrderCount,
            errorMessage: lastLog.errorMessage,
            startedAt: lastLog.startedAt,
            finishedAt: lastLog.finishedAt,
          }
        : null,
    };
  });
}
