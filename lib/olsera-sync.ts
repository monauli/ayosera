// Sync permanen penjualan per kategori Olsera ke MongoDB.
// Mengikuti pipeline TERVALIDASI 100% di scripts/validate-olsera-category.ts:
//   Close Order List + Open Order List (is_paid=1, dedup) → detail per order →
//   map product_id ke "klasifikasi" (Product List, fallback detail → nama → "Tidak Diketahui")
//   → agregasi qty+amount per (tanggal, kategori).
// Sepenuhnya terpisah dari sync AYO (lib/booking-sync.ts / lib/production-sync.ts).

import { collections, withMongo, type OlseraSyncLogDocument } from "@/lib/mongodb";
import { getAccessToken } from "@/lib/olsera";

const BASE_URL = "https://api-open.olsera.co.id";
const API_PREFIX = "/api/open-api/v1/id";
const DETAIL_DELAY_MS = 100;
const LIST_DELAY_MS = 100;
// Jumlah request detail order yang berjalan paralel. Rate limit Olsera
// ditangani lewat retry-backoff pada getJson, bukan jeda panjang.
const DETAIL_CONCURRENCY = 4;
// Cache daftar produk dua lapis:
// - In-memory (module-level, TTL pendek) — hanya membantu bila instance yang sama
//   dipanggil berulang dalam waktu singkat.
// - MongoDB "olsera_product_cache" (persisten, TTL 24 jam) — sumber utama yang
//   selamat dari cold start Vercel, supaya sync tidak menarik ulang seluruh
//   Product List setiap invocation.
const PRODUCT_CACHE_TTL_MS = 10 * 60 * 1000;
const PRODUCT_CACHE_MONGO_TTL_MS = 24 * 60 * 60 * 1000;

const UNKNOWN_CATEGORY = "Tidak Diketahui";

type ProductInfo = { klasifikasi: string; name: string };
type Aggregate = { qty: number; amount: number };
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
  /** true = peta produk diambil dari cache (memory/MongoDB); false = fetch ulang Product List penuh. */
  productCacheHit: boolean;
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

  // Jeda antar-request dipendekkan; kompensasinya: retry dengan backoff saat
  // Olsera menjawab 429/5xx.
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    // 404 pada endpoint order Olsera berarti "tidak ada data", bukan error.
    if (response.status === 404 && allow404) return null;
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
      await sleep(Math.min(waitMs, 10_000));
      continue;
    }
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`HTTP ${response.status} untuk ${pathName}: ${raw.slice(0, 200)}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}

let productCache: { map: Map<string, ProductInfo>; fetchedAt: number } | null = null;

/** Baca cache produk persisten dari MongoDB; null bila kosong atau melewati TTL 24 jam. */
async function readProductCacheFromMongo(): Promise<Map<string, ProductInfo> | null> {
  try {
    return await withMongo(async () => {
      const { olseraProductCache } = await collections();
      const newest = await olseraProductCache.find().sort({ cachedAt: -1 }).limit(1).next();
      if (!newest || Date.now() - newest.cachedAt.getTime() > PRODUCT_CACHE_MONGO_TTL_MS) return null;
      const docs = await olseraProductCache.find().toArray();
      if (!docs.length) return null;
      const map = new Map<string, ProductInfo>();
      // name tidak disimpan di cache — tidak dipakai untuk mapping klasifikasi.
      for (const doc of docs) map.set(doc.productId, { klasifikasi: doc.klasifikasi, name: "" });
      return map;
    });
  } catch (error) {
    // Cache rusak/DB bermasalah bukan alasan menggagalkan sync — fallback ke fetch penuh.
    console.error("Olsera sync: gagal membaca olsera_product_cache", error);
    return null;
  }
}

/** Simpan hasil fetch katalog penuh ke MongoDB (upsert per productId). Best effort. */
async function writeProductCacheToMongo(map: Map<string, ProductInfo>) {
  if (!map.size) return;
  try {
    await withMongo(async () => {
      const { olseraProductCache } = await collections();
      const cachedAt = new Date();
      await olseraProductCache.bulkWrite(
        [...map.entries()].map(([productId, info]) => ({
          updateOne: {
            filter: { productId },
            update: { $set: { klasifikasi: info.klasifikasi, cachedAt } },
            upsert: true,
          },
        })),
      );
    });
  } catch (error) {
    console.error("Olsera sync: gagal menulis olsera_product_cache", error);
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

// Peta produk: cek in-memory dulu, lalu MongoDB (persisten, TTL 24 jam), baru
// fetch ulang Product List penuh (paging 100/halaman — biaya tetap terbesar di
// awal sync). Hasil fetch penuh disimpan kembali ke MongoDB agar invocation
// berikutnya (proses/instance lain) tidak perlu menarik ulang.
async function getProductMap(token: string): Promise<{ map: Map<string, ProductInfo>; cacheHit: boolean }> {
  if (productCache && Date.now() - productCache.fetchedAt < PRODUCT_CACHE_TTL_MS) {
    console.log(`Olsera sync: product cache HIT (in-memory, ${productCache.map.size} produk)`);
    return { map: productCache.map, cacheHit: true };
  }

  const fromMongo = await readProductCacheFromMongo();
  if (fromMongo) {
    console.log(`Olsera sync: product cache HIT (MongoDB, ${fromMongo.size} produk)`);
    productCache = { map: fromMongo, fetchedAt: Date.now() };
    return { map: fromMongo, cacheHit: true };
  }

  console.log("Olsera sync: product cache MISS/expired — menarik ulang Product List penuh dari API Olsera");
  const map = await fetchAllProducts(token);
  productCache = { map, fetchedAt: Date.now() };
  await writeProductCacheToMongo(map);
  return { map, cacheHit: false };
}

async function fetchAllProducts(token: string): Promise<Map<string, ProductInfo>> {
  const map = new Map<string, ProductInfo>();
  let page = 1;
  for (;;) {
    const body = await getJson(token, `${API_PREFIX}/product`, { per_page: "100", page: String(page) });
    const list: Record<string, unknown>[] = Array.isArray(body?.data) ? (body.data as Record<string, unknown>[]) : [];
    for (const product of list) {
      map.set(String(product.id), {
        klasifikasi:
          typeof product.klasifikasi === "string" && product.klasifikasi ? product.klasifikasi : "(tanpa klasifikasi)",
        name: String(product.name ?? ""),
      });
    }
    const meta = body?.meta as { last_page?: number } | undefined;
    if (!meta?.last_page || page >= meta.last_page) break;
    page++;
    await sleep(LIST_DELAY_MS);
  }
  return map;
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
  product_id: unknown;
  product_name?: string;
  qty: unknown;
  amount: unknown;
};

async function fetchOrderDetail(token: string, order: OrderRef): Promise<OrderItem[]> {
  const kind = order.source === "close" ? "closeorder" : "openorder";
  const body = await getJson(token, `${API_PREFIX}/order/${kind}/detail`, { id: String(order.id) });
  const data = (body?.data ?? {}) as { orderitems?: OrderItem[] };
  return Array.isArray(data.orderitems) ? data.orderitems : [];
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

// Produk terhapus permanen: cocokkan nama produk ke nama klasifikasi terpanjang yang dikenal.
function guessKlasifikasiFromName(productName: string, productMap: Map<string, ProductInfo>): string | undefined {
  const name = normalizeKlasifikasi(productName).toUpperCase();
  if (!name) return undefined;
  const known = [...new Set([...productMap.values()].map((p) => normalizeKlasifikasi(p.klasifikasi)))].filter(
    (k) => k && !k.startsWith("("),
  );
  let best: string | undefined;
  for (const klasifikasi of known) {
    if (name.includes(klasifikasi.toUpperCase()) && (!best || klasifikasi.length > best.length)) {
      best = klasifikasi;
    }
  }
  return best;
}

async function resolveKlasifikasi(
  token: string,
  productId: string,
  productName: string,
  productMap: Map<string, ProductInfo>,
): Promise<string> {
  let info = productMap.get(productId);
  if (!info) {
    // Produk baru yang belum ada di cache katalog: tarik SATU produk dari
    // Product Detail API dan tambahkan ke cache MongoDB — tanpa refresh katalog penuh.
    info = await fetchProductDetail(token, productId);
    if (info) {
      productMap.set(productId, info);
      await upsertProductCacheEntry(productId, info);
    }
  }
  if (!info) {
    const guessed = guessKlasifikasiFromName(productName, productMap);
    if (guessed) {
      info = { klasifikasi: guessed, name: productName };
      productMap.set(productId, info);
    }
  }
  return normalizeKlasifikasi(info?.klasifikasi ?? UNKNOWN_CATEGORY);
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
  };

  try {
    const auth = await getAccessToken();
    if ("error" in auth) throw new Error(auth.error);
    const token = auth.token;

    const { map: productMap, cacheHit } = await getProductMap(token);
    result.productCacheHit = cacheHit;

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
        let cursor = 0;
        const worker = async () => {
          for (;;) {
            const index = cursor++;
            if (index >= orders.length) return;
            const order = orders[index];
            await sleep(DETAIL_DELAY_MS);
            let items: OrderItem[];
            try {
              items = await fetchOrderDetail(token, order);
            } catch (error) {
              console.error(`Olsera sync: gagal detail order ${order.id} (${date})`, error);
              continue;
            }
            for (const item of items) {
              const category = await resolveKlasifikasi(
                token,
                String(item.product_id),
                String(item.product_name ?? ""),
                productMap,
              );
              const entry = byCategory.get(category) ?? { qty: 0, amount: 0 };
              entry.qty += toNumber(item.qty);
              entry.amount += toNumber(item.amount);
              byCategory.set(category, entry);
            }
            day.processed++;
            result.processedOrderCount++;
          }
        };
        await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));

        day.success = day.processed === day.expected;

        // Hari yang tidak tuntas TIDAK ditulis: agregat parsial akan menimpa
        // data lama yang benar dengan angka yang kurang.
        if (day.success) {
          await withMongo(async () => {
            const { olseraSalesByCategory, olseraSyncedDays } = await collections();
            const syncedAt = new Date();
            if (byCategory.size) {
              await olseraSalesByCategory.bulkWrite(
                [...byCategory.entries()].map(([category, agg]) => ({
                  updateOne: {
                    filter: { date, category },
                    update: { $set: { qty: agg.qty, totalAmount: agg.amount, syncedAt } },
                    upsert: true,
                  },
                })),
              );
            }
            // Buang kategori lama yang tidak muncul lagi pada sync ulang hari ini.
            await olseraSalesByCategory.deleteMany({ date, syncedAt: { $lt: syncedAt } });
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

export async function getOlseraSyncStatus() {
  return withMongo(async () => {
    const { olseraSalesByCategory, olseraSyncLog, olseraSyncState } = await collections();
    const [state, lastLog, earliestDoc] = await Promise.all([
      olseraSyncState.findOne({ _id: "olsera" }),
      olseraSyncLog.find().sort({ startedAt: -1 }).limit(1).next(),
      olseraSalesByCategory.find().sort({ date: 1 }).limit(1).next(),
    ]);
    return {
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
