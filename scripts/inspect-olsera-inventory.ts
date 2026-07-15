// Inspeksi READ-ONLY endpoint inventori Olsera Open API.
// Tujuan: menemukan endpoint & bentuk payload nyata (produk, stok, mutasi,
// gudang, pembelian, transfer, adjustment) tanpa menebak dan tanpa menulis DB.
// Token/credential TIDAK pernah dicetak.
//
// Pakai: node --no-warnings --experimental-strip-types scripts/inspect-olsera-inventory.ts [detail]
import { existsSync, readFileSync } from "fs";
import path from "path";

const BASE_URL = "https://api-open.olsera.co.id";
const ID_PREFIX = "/api/open-api/v1/id";
const EN_PREFIX = "/api/open-api/v1/en";

for (const fileName of [".env.local", ".env"]) {
  const filePath = path.join(process.cwd(), fileName);
  if (!existsSync(filePath)) continue;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
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

const appId = process.env.OLSERA_APP_ID;
const secretKey = process.env.OLSERA_SECRET_KEY;
if (!appId || !secretKey) {
  console.error("OLSERA_APP_ID / OLSERA_SECRET_KEY tidak ditemukan.");
  process.exit(1);
}

const form = new FormData();
form.append("app_id", appId);
form.append("secret_key", secretKey);
form.append("grant_type", "secret_key");
const tokenResponse = await fetch(`${BASE_URL}${ID_PREFIX}/token`, {
  method: "POST",
  headers: { Accept: "application/json" },
  body: form,
});
if (!tokenResponse.ok) {
  console.error(`Auth gagal: HTTP ${tokenResponse.status}`);
  process.exit(1);
}
const token = ((await tokenResponse.json()) as { access_token?: string }).access_token;
if (!token) {
  console.error("Auth tidak mengembalikan access_token.");
  process.exit(1);
}
console.log("Autentikasi OK (token tidak dicetak).");

function wibDate(offsetDays: number): string {
  return new Date(Date.now() + 7 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
const TODAY = wibDate(0);
const WEEK_AGO = wibDate(-7);
const { OLSERA_INVENTORY_BASELINE_DATE: BASELINE } = await import("../lib/olsera-baseline.ts");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(label: string, pathName: string, params: Record<string, string>, showFull = false) {
  const url = new URL(BASE_URL + pathName);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    console.log(`\n[${label}] ${pathName} → request error: ${(error as Error).message}`);
    return null;
  }
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // bukan JSON
  }
  const paramText = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  console.log(`\n[${label}] GET ${pathName}${paramText ? `?${paramText}` : ""} → HTTP ${response.status}`);
  if (!body) {
    console.log(`  (bukan JSON) ${raw.slice(0, 200)}`);
    return null;
  }
  if (response.status !== 200) {
    console.log(`  ${JSON.stringify(body).slice(0, 300)}`);
    return null;
  }
  const record = body as Record<string, unknown>;
  const data = record.data;
  if (Array.isArray(data)) {
    console.log(`  data: array ${data.length} item; meta: ${JSON.stringify(record.meta ?? null)}`);
    if (data[0] && typeof data[0] === "object") {
      if (showFull) console.log(`  item[0]: ${JSON.stringify(data[0], null, 2)}`);
      else console.log(`  item[0] keys: ${Object.keys(data[0] as object).join(", ")}`);
    }
  } else if (data && typeof data === "object") {
    console.log(`  data: object keys: ${Object.keys(data as object).join(", ")}`);
    if (showFull) console.log(`  data: ${JSON.stringify(data, null, 2).slice(0, 4000)}`);
  } else {
    console.log(`  body keys: ${Object.keys(record).join(", ")} — ${JSON.stringify(record).slice(0, 300)}`);
  }
  return body;
}

const FULL = process.argv.includes("detail");

// --- Produk (dikenal) — lihat field stok/harga/unit di list & detail ---
const productBody = await probe("product-list", `${ID_PREFIX}/product`, { per_page: "2", page: "1" }, FULL);
let firstProductId: string | null = null;
if (productBody && typeof productBody === "object") {
  const list = (productBody as { data?: { id?: unknown }[] }).data;
  if (Array.isArray(list) && list[0]?.id !== undefined) firstProductId = String(list[0].id);
}
await sleep(400);
if (firstProductId) {
  await probe("product-detail", `${ID_PREFIX}/product/detail`, { id: firstProductId }, true);
  await sleep(400);
}

// --- Kandidat endpoint inventori/stok/mutasi ---
const candidates: [string, string, Record<string, string>][] = [
  ["inventory", `${ID_PREFIX}/inventory`, { per_page: "2" }],
  ["stock", `${ID_PREFIX}/stock`, { per_page: "2" }],
  ["product-stock", `${ID_PREFIX}/product/stock`, { per_page: "2" }],
  ["stockmovement", `${ID_PREFIX}/stockmovement`, { per_page: "2", start_date: WEEK_AGO, end_date: TODAY }],
  ["stock-movement", `${ID_PREFIX}/stock-movement`, { per_page: "2" }],
  ["inventory-movement", `${ID_PREFIX}/inventory/movement`, { per_page: "2" }],
  ["stockcard", `${ID_PREFIX}/stockcard`, { per_page: "2", start_date: WEEK_AGO, end_date: TODAY }],
  ["warehouse", `${ID_PREFIX}/warehouse`, { per_page: "2" }],
  ["outlet", `${ID_PREFIX}/outlet`, { per_page: "2" }],
  ["store", `${ID_PREFIX}/store`, {}],
  ["purchase", `${ID_PREFIX}/purchase`, { per_page: "2" }],
  ["purchaseorder", `${ID_PREFIX}/purchaseorder`, { per_page: "2" }],
  ["po", `${ID_PREFIX}/po`, { per_page: "2" }],
  ["transfer", `${ID_PREFIX}/transfer`, { per_page: "2" }],
  ["stocktransfer", `${ID_PREFIX}/stocktransfer`, { per_page: "2" }],
  ["adjustment", `${ID_PREFIX}/adjustment`, { per_page: "2" }],
  ["stockadjustment", `${ID_PREFIX}/stockadjustment`, { per_page: "2" }],
  ["stockopname", `${ID_PREFIX}/stockopname`, { per_page: "2" }],
  // report (prefix /en seperti salesitemspergroup)
  ["report-inventory", `${EN_PREFIX}/report/inventory`, { from: WEEK_AGO, to: TODAY }],
  ["report-stockmovement", `${EN_PREFIX}/report/stockmovement`, { from: WEEK_AGO, to: TODAY }],
  ["report-stockcard", `${EN_PREFIX}/report/stockcard`, { from: WEEK_AGO, to: TODAY }],
  ["report-inventorymovement", `${EN_PREFIX}/report/inventorymovement`, { from: WEEK_AGO, to: TODAY }],
  ["report-currentstock", `${EN_PREFIX}/report/currentstock`, {}],
];
for (const [label, pathName, params] of candidates) {
  await probe(label, pathName, params, FULL);
  await sleep(400);
}

// Histori sejak baseline — dicoba pada endpoint mutasi yang tampak hidup (manual pass kedua via argumen "detail").
console.log(`\nBaseline uji histori: ${BASELINE} s/d ${TODAY}`);
