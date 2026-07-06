// Validasi pendekatan agregasi penjualan per kategori Olsera untuk SATU tanggal.
// Murni eksplorasi/validasi: read-only ke API Olsera, tidak menulis MongoDB.
// Jalankan: node --no-warnings --experimental-strip-types scripts/validate-olsera-category.ts [YYYY-MM-DD]

import { existsSync, readFileSync } from "fs";
import path from "path";

const BASE_URL = "https://api-open.olsera.co.id";
const API_PREFIX = "/api/open-api/v1/id";
const TARGET_DATE = process.argv[2] ?? "2026-05-01";
const END_DATE = process.argv[3] ?? TARGET_DATE;
const DETAIL_DELAY_MS = 350;

// Statistik untuk mengukur kelayakan skala (rentang lebih besar).
const stats = {
  requestCount: 0,
  errors: [] as string[],
  fallbackDetail: 0,
  fallbackNama: 0,
  unknownCategory: 0,
};

// Referensi resmi laporan Olsera 2026-05-01 (total qty 140, total Rp6.734.000).
const REFERENCE: Record<string, { qty: number; amount: number }> = {
  "CELANA PRIA": { qty: 1, amount: 120000 },
  "SKORT WANITA": { qty: 1, amount: 260000 },
  "BOLA PADEL": { qty: 5, amount: 475000 },
  MINUMAN: { qty: 40, amount: 534000 },
  LABERS: { qty: 29, amount: 880000 },
  "LAPANGAN PADEL": { qty: 15, amount: 2300000 },
  SNACK: { qty: 4, amount: 60000 },
  "LAPANGAN PICKLEBALL": { qty: 1, amount: 150000 },
  "SEWA RAKET": { qty: 39, amount: 1750000 },
  GRIP: { qty: 3, amount: 105000 },
  "SEWA KERANJANG+BOLA": { qty: 2, amount: 100000 },
};

type ProductInfo = { klasifikasi: string; categoryName: string; name: string };
type Aggregate = { qty: number; amount: number };

const UNKNOWN_CATEGORY = "Tidak Diketahui";

// Normalisasi nama klasifikasi agar konsisten: trim, collapse spasi ganda,
// dan hilangkan spasi di sekeliling "+" (Olsera kadang menulis "KERANJANG+ BOLA").
function normalizeKlasifikasi(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/\s*\+\s*/g, "+");
}

loadLocalEnv();

async function main() {
  const appId = process.env.OLSERA_APP_ID;
  const secretKey = process.env.OLSERA_SECRET_KEY;
  if (!appId || !secretKey) {
    console.error("Missing OLSERA_APP_ID / OLSERA_SECRET_KEY in .env.local.");
    process.exit(1);
  }

  const startedAt = Date.now();
  const token = await authenticate(appId, secretKey);

  // ── Langkah 1: Product List lengkap → lookup product_id -> klasifikasi ──
  console.log("Langkah 1: menarik seluruh Product List...");
  const productMap = await fetchAllProducts(token);
  console.log(`  Total produk: ${productMap.size}`);

  // ── Langkah 2: Close Order List untuk rentang tanggal ──
  console.log(`\nLangkah 2: menarik Close Order List untuk ${TARGET_DATE} s/d ${END_DATE}...`);
  const orderIds = await fetchCloseOrderIds(token, TARGET_DATE, END_DATE);
  console.log(`  Total close order: ${orderIds.length}`);

  // ── Langkah 3 & 4: detail per order → akumulasi qty + amount per klasifikasi ──
  console.log(`\nLangkah 3-4: menarik detail ${orderIds.length} order (jeda ${DETAIL_DELAY_MS}ms/call)...`);
  const byKlasifikasi = new Map<string, Aggregate>();
  const byCategoryName = new Map<string, Aggregate>();
  const unknownProducts = new Set<string>();
  let itemCount = 0;
  let amountMismatchCount = 0;

  for (let i = 0; i < orderIds.length; i++) {
    let detail: { orderitems: OrderItem[] };
    try {
      detail = await fetchOrderDetail(token, orderIds[i]);
    } catch (error) {
      stats.errors.push(`detail order ke-${i + 1} (id ${orderIds[i]}): ${(error as Error).message.slice(0, 150)}`);
      continue;
    }
    for (const item of detail.orderitems) {
      itemCount++;
      const qty = toNumber(item.qty);
      const amount = toNumber(item.amount);

      // Verifikasi asumsi: amount = subtotal Rupiah per baris (≈ qty*price + addon - discount).
      const expected = qty * toNumber(item.price) + toNumber(item.addon_price) - toNumber(item.discount);
      if (Math.abs(expected - amount) > 1) {
        amountMismatchCount++;
        console.log(
          `  [cek amount] order ${orderIds[i]} "${item.product_name}": amount=${amount}, qty*price+addon-disc=${expected}`,
        );
      }

      const key = String(item.product_id);
      let info = productMap.get(key);
      if (!info) {
        // Fallback 1: ambil detail produk langsung per id (produk bisa saja
        // di-unpublish sehingga tidak muncul di Product List).
        info = await fetchProductDetail(token, key);
        if (info) {
          stats.fallbackDetail++;
          productMap.set(key, info);
          console.log(`  [fallback-detail] produk ${key} (${item.product_name}) ter-resolve: klasifikasi "${info.klasifikasi}"`);
        }
      }
      if (!info) {
        // Fallback 2: produk sudah dihapus permanen dari Olsera (detail pun 404).
        // Cocokkan nama produk dengan nama klasifikasi yang dikenal (kecocokan terpanjang).
        const guessed = guessKlasifikasiFromName(String(item.product_name ?? ""), productMap);
        if (guessed) {
          stats.fallbackNama++;
          info = { klasifikasi: guessed, categoryName: "(tanpa kategori)", name: String(item.product_name ?? "") };
          productMap.set(key, info);
          console.log(`  [fallback-nama] produk ${key} (${item.product_name}) dipetakan via nama ke klasifikasi "${guessed}"`);
        } else {
          stats.unknownCategory++;
          unknownProducts.add(`${key} (${item.product_name})`);
        }
      }

      accumulate(byKlasifikasi, normalizeKlasifikasi(info?.klasifikasi ?? UNKNOWN_CATEGORY), qty, amount);
      accumulate(byCategoryName, normalizeKlasifikasi(info?.categoryName ?? UNKNOWN_CATEGORY), qty, amount);
    }
    if ((i + 1) % 10 === 0 || i === orderIds.length - 1) {
      process.stdout.write(`  ...${i + 1}/${orderIds.length} order selesai\r`);
    }
    if (i < orderIds.length - 1) await sleep(DETAIL_DELAY_MS);
  }
  console.log(`\n  Total baris item: ${itemCount}`);
  console.log(`  Baris dengan amount ≠ qty*price+addon-discount: ${amountMismatchCount}`);
  if (unknownProducts.size) {
    console.log(`  Produk tanpa entri di Product List: ${[...unknownProducts].join(", ")}`);
  }

  // ── Langkah 5: laporan hasil ──
  if (TARGET_DATE === "2026-05-01" && END_DATE === "2026-05-01") {
    // Hanya 1 Mei yang punya angka referensi resmi.
    printComparison("klasifikasi", byKlasifikasi);
    console.log("\n(Perbandingan sekunder — hipotesis pembanding: category_name)");
    printTotalsOnly(byCategoryName);
  } else {
    console.log(`\n===== HASIL AGREGAT PER KLASIFIKASI (${TARGET_DATE} s/d ${END_DATE}) =====`);
    let totalQty = 0;
    let totalAmount = 0;
    for (const [key, value] of [...byKlasifikasi.entries()].sort((a, b) => b[1].amount - a[1].amount)) {
      totalQty += value.qty;
      totalAmount += value.amount;
      console.log(`  ${key.padEnd(22)} qty ${String(value.qty).padStart(4)}, ${formatIdr(value.amount).padStart(14)}`);
    }
    console.log("─".repeat(50));
    console.log(`  ${"TOTAL".padEnd(22)} qty ${String(totalQty).padStart(4)}, ${formatIdr(totalAmount).padStart(14)}`);
  }

  // ── Statistik kelayakan skala ──
  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.log("\n===== STATISTIK EKSEKUSI =====");
  console.log(`Durasi total          : ${elapsedSec.toFixed(1)} detik (${(elapsedSec / 60).toFixed(1)} menit)`);
  console.log(`Total HTTP request    : ${stats.requestCount}`);
  console.log(`Order diproses        : ${orderIds.length}`);
  console.log(`Error/timeout/429     : ${stats.errors.length}${stats.errors.length ? "\n  - " + stats.errors.join("\n  - ") : " (tidak ada)"}`);
  console.log(`Fallback detail produk: ${stats.fallbackDetail} baris item`);
  console.log(`Fallback via nama     : ${stats.fallbackNama} baris item`);
  console.log(`Kategori Tidak Diketahui: ${stats.unknownCategory} baris item`);
}

function accumulate(map: Map<string, Aggregate>, key: string, qty: number, amount: number) {
  const entry = map.get(key) ?? { qty: 0, amount: 0 };
  entry.qty += qty;
  entry.amount += amount;
  map.set(key, entry);
}

function printComparison(label: string, actual: Map<string, Aggregate>) {
  console.log(`\n===== HASIL AGREGAT PER ${label.toUpperCase()} (${TARGET_DATE}) vs REFERENSI =====`);
  // Referensi ikut dinormalisasi agar pembandingan konsisten dengan hasil agregasi.
  const normalizedReference = new Map<string, { qty: number; amount: number }>(
    Object.entries(REFERENCE).map(([key, value]) => [normalizeKlasifikasi(key), value]),
  );
  const allKeys = [...new Set([...normalizedReference.keys(), ...actual.keys()])].sort();
  let matchCount = 0;

  for (const key of allKeys) {
    const ref = normalizedReference.get(key);
    const act = actual.get(key);
    const actQty = act?.qty ?? 0;
    const actAmount = act?.amount ?? 0;
    const refQty = ref?.qty ?? 0;
    const refAmount = ref?.amount ?? 0;
    const qtyDiff = actQty - refQty;
    const amountDiff = actAmount - refAmount;
    const ok = qtyDiff === 0 && amountDiff === 0;
    if (ok) matchCount++;

    console.log(
      `${ok ? "✅" : "❌"} ${key.padEnd(22)} | kita: qty ${String(actQty).padStart(3)}, ${formatIdr(actAmount).padStart(13)}` +
        ` | ref: qty ${String(refQty).padStart(3)}, ${formatIdr(refAmount).padStart(13)}` +
        (ok ? "" : ` | selisih: qty ${qtyDiff >= 0 ? "+" : ""}${qtyDiff}, ${amountDiff >= 0 ? "+" : ""}${formatIdr(amountDiff)}`),
    );
  }

  const totalActual = [...actual.values()].reduce((s, v) => ({ qty: s.qty + v.qty, amount: s.amount + v.amount }), { qty: 0, amount: 0 });
  const totalRef = Object.values(REFERENCE).reduce((s, v) => ({ qty: s.qty + v.qty, amount: s.amount + v.amount }), { qty: 0, amount: 0 });
  console.log("─".repeat(100));
  console.log(
    `TOTAL kita: qty ${totalActual.qty}, ${formatIdr(totalActual.amount)} | TOTAL referensi: qty ${totalRef.qty}, ${formatIdr(totalRef.amount)}`,
  );
  console.log(`Kategori cocok persis: ${matchCount}/${allKeys.length}`);
}

function printTotalsOnly(map: Map<string, Aggregate>) {
  for (const [key, value] of [...map.entries()].sort((a, b) => b[1].amount - a[1].amount)) {
    console.log(`  ${key.padEnd(22)} qty ${String(value.qty).padStart(3)}, ${formatIdr(value.amount)}`);
  }
}

async function fetchAllProducts(token: string): Promise<Map<string, ProductInfo>> {
  const map = new Map<string, ProductInfo>();
  let page = 1;
  for (;;) {
    const body = await getJson(token, `${API_PREFIX}/product`, { per_page: "100", page: String(page) });
    const list: Record<string, unknown>[] = Array.isArray(body.data) ? body.data : [];
    for (const product of list) {
      map.set(String(product.id), {
        klasifikasi: typeof product.klasifikasi === "string" && product.klasifikasi ? product.klasifikasi : "(tanpa klasifikasi)",
        categoryName: typeof product.category_name === "string" && product.category_name ? product.category_name : "(tanpa kategori)",
        name: String(product.name ?? ""),
      });
    }
    const meta = body.meta as { current_page?: number; last_page?: number } | undefined;
    if (!meta?.last_page || page >= meta.last_page) break;
    page++;
    await sleep(250);
  }
  return map;
}

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

async function fetchProductDetail(token: string, productId: string): Promise<ProductInfo | undefined> {
  // Bentuk path detail belum terdokumentasi — coba beberapa kandidat.
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
      if (!klasifikasi && !name) continue; // respons tidak berbentuk detail produk
      return {
        klasifikasi: klasifikasi || "(tanpa klasifikasi)",
        categoryName:
          typeof data.category_name === "string" && data.category_name ? data.category_name : "(tanpa kategori)",
        name,
      };
    } catch {
      // kandidat gagal (406/500/dll) — coba bentuk berikutnya
    }
  }
  return undefined;
}

async function fetchCloseOrderIds(token: string, startDate: string, endDate: string): Promise<number[]> {
  const ids: number[] = [];
  let page = 1;
  for (;;) {
    const body = await getJson(
      token,
      `${API_PREFIX}/order/closeorder`,
      { per_page: "100", page: String(page), start_date: startDate, end_date: endDate },
      // 404 = tidak ada order pada tanggal itu (perilaku khas API Olsera), bukan error.
      true,
    );
    if (!body) break;
    const list: Record<string, unknown>[] = Array.isArray(body.data) ? body.data : [];
    for (const order of list) ids.push(Number(order.id));
    const meta = body.meta as { last_page?: number } | undefined;
    if (!meta?.last_page || page >= meta.last_page) break;
    page++;
    await sleep(250);
  }
  return ids;
}

type OrderItem = {
  product_id: unknown;
  product_name?: string;
  qty: unknown;
  price: unknown;
  amount: unknown;
  discount: unknown;
  addon_price: unknown;
};

async function fetchOrderDetail(token: string, orderId: number): Promise<{ orderitems: OrderItem[] }> {
  const body = await getJson(token, `${API_PREFIX}/order/closeorder/detail`, { id: String(orderId) });
  const data = (body.data ?? {}) as { orderitems?: OrderItem[] };
  return { orderitems: Array.isArray(data.orderitems) ? data.orderitems : [] };
}

async function getJson(
  token: string,
  pathName: string,
  params: Record<string, string>,
  allow404 = false,
): Promise<Record<string, unknown>> {
  const url = new URL(BASE_URL + pathName);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  stats.requestCount++;
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (response.status === 429) {
    stats.errors.push(`HTTP 429 (rate limit) pada request ke-${stats.requestCount}: ${pathName}`);
    throw new Error(`HTTP 429 (rate limit) untuk ${pathName}`);
  }
  if (response.status === 404 && allow404) return null as unknown as Record<string, unknown>;
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`HTTP ${response.status} untuk ${pathName}: ${raw.slice(0, 300)}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatIdr(value: number) {
  return `Rp${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(value)}`;
}

async function authenticate(appId: string, secretKey: string): Promise<string> {
  const form = new FormData();
  form.append("app_id", appId);
  form.append("secret_key", secretKey);
  form.append("grant_type", "secret_key");
  const response = await fetch(`${BASE_URL}${API_PREFIX}/token`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  });
  if (!response.ok) {
    console.error(`Auth failed: HTTP ${response.status}`);
    process.exit(1);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    console.error("Auth response did not contain access_token.");
    process.exit(1);
  }
  return body.access_token;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadLocalEnv() {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(process.cwd(), fileName);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Validasi Olsera gagal");
  process.exit(1);
});
