// Backfill field `addonPrice` untuk item Olsera lama sejak 1 Mei 2026
// (rerunnable, idempoten). Hanya melengkapi addonPrice — TIDAK mengubah
// amount, qty, costAmount, discount, orderNo, tanggal, kategori, atau field
// lain, dan TIDAK membuat order/item baru (hanya update dokumen yang sudah
// ada, dicocokkan lewat _id = item id Olsera, unique key yang sudah dipakai
// project).
//
// Strategi hemat panggilan API: hanya tanggal yang MASIH punya item tanpa
// addonPrice yang diproses. Tanggal yang sudah lengkap dilewati sepenuhnya —
// run kedua pada rentang yang sama akan menghasilkan 0 perubahan dengan
// nyaris tanpa panggilan API.
//
// Item yang sudah tersimpan di MongoDB tetapi TIDAK ditemukan lagi di API
// (order dibatalkan/dihapus dari Olsera) diberi addonPrice=0 (default aman,
// dicatat sebagai peringatan) — supaya run berikutnya tidak mengulang tanggal
// yang sama selamanya.
//
// Pakai: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/backfill-olsera-addon.ts [START] [END]
import { existsSync, readFileSync } from "fs";
import path from "path";

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

const { collections, withMongo, mongoClient } = await import("../lib/mongodb.ts");
const { getAccessToken } = await import("../lib/olsera.ts");
const { parseAddonPrice } = await import("../lib/olsera-addon.ts");

const BASE_URL = "https://api-open.olsera.co.id";
const API_PREFIX = "/api/open-api/v1/id";
const LIST_DELAY_MS = 120;
const DETAIL_DELAY_MS = 150;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayJakarta(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );
}

const BASELINE = "2026-05-01";
const START = process.argv[2] ?? BASELINE;
const END = process.argv[3] ?? todayJakarta();

async function getJson(token: string, pathName: string, params: Record<string, string>, allow404 = false) {
  const url = new URL(BASE_URL + pathName);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (response.status === 404 && allow404) return null;
    const isRateLimited = response.status === 429;
    if ((isRateLimited || response.status >= 500) && attempt < (isRateLimited ? 6 : 4)) {
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

async function fetchOrderIds(token: string, kind: "closeorder" | "openorder", date: string): Promise<number[]> {
  const ids: number[] = [];
  let page = 1;
  for (;;) {
    const params: Record<string, string> = { per_page: "100", page: String(page), start_date: date, end_date: date };
    if (kind === "openorder") params.is_paid = "1";
    const body = await getJson(token, `${API_PREFIX}/order/${kind}`, params, true);
    if (!body) break;
    const list = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
    for (const order of list) ids.push(Number(order.id));
    const meta = body.meta as { last_page?: number } | undefined;
    if (!meta?.last_page || page >= meta.last_page) break;
    page++;
    await sleep(LIST_DELAY_MS);
  }
  return ids;
}

type Summary = {
  periodStart: string;
  periodEnd: string;
  startedAt: Date;
  completedAt: Date | null;
  datesPending: number;
  datesProcessed: number;
  itemsChecked: number;
  itemsUpdated: number;
  itemsWithAddonPositive: number;
  itemsFailed: number;
  failedDates: string[];
  succeeded: boolean;
};

const summary: Summary = {
  periodStart: START,
  periodEnd: END,
  startedAt: new Date(),
  completedAt: null,
  datesPending: 0,
  datesProcessed: 0,
  itemsChecked: 0,
  itemsUpdated: 0,
  itemsWithAddonPositive: 0,
  itemsFailed: 0,
  failedDates: [],
  succeeded: false,
};

console.log(`Backfill addonPrice: ${START} s/d ${END}`);

// Tanggal yang masih punya item tanpa addonPrice — hanya ini yang diproses.
const pendingDates: string[] = await withMongo(async () => {
  const { olseraOrderItems } = await collections();
  return olseraOrderItems.distinct("date", {
    date: { $gte: START, $lte: END },
    addonPrice: { $exists: false },
  } as never);
});
pendingDates.sort();
summary.datesPending = pendingDates.length;
console.log(`Tanggal yang perlu diperiksa: ${pendingDates.length} (tanggal lain sudah lengkap, dilewati).`);

if (!pendingDates.length) {
  summary.completedAt = new Date();
  summary.succeeded = true;
  console.log("\nTidak ada yang perlu di-backfill — 0 perubahan.");
} else {
  const auth = await getAccessToken();
  if ("error" in auth) throw new Error(auth.error);
  const token = auth.token;

  for (const date of pendingDates) {
    try {
      const { itemsInDb } = await withMongo(async () => {
        const { olseraOrderItems } = await collections();
        const docs = await olseraOrderItems
          .find({ date, addonPrice: { $exists: false } } as never)
          .project<{ _id: number; orderNo: string }>({ _id: 1, orderNo: 1 })
          .toArray();
        return { itemsInDb: docs };
      });
      if (!itemsInDb.length) {
        summary.datesProcessed++;
        continue;
      }

      // Tarik Close+Open order list (dedup) untuk tanggal ini, lalu detail
      // setiap order untuk memetakan itemId → addon_price.
      const closeIds = await fetchOrderIds(token, "closeorder", date);
      await sleep(LIST_DELAY_MS);
      const openIds = await fetchOrderIds(token, "openorder", date);
      const seen = new Set(closeIds);
      const orderRefs: { id: number; kind: "closeorder" | "openorder" }[] = closeIds.map((id) => ({ id, kind: "closeorder" }));
      for (const id of openIds) if (!seen.has(id)) orderRefs.push({ id, kind: "openorder" });

      const addonByItemId = new Map<number, number>();
      for (const ref of orderRefs) {
        await sleep(DETAIL_DELAY_MS);
        const body = await getJson(token, `${API_PREFIX}/order/${ref.kind}/detail`, { id: String(ref.id) }, true);
        const items = Array.isArray((body?.data as { orderitems?: unknown[] })?.orderitems)
          ? ((body!.data as { orderitems: Record<string, unknown>[] }).orderitems)
          : [];
        for (const item of items) {
          const itemId = Number(item.id);
          if (!Number.isFinite(itemId)) continue;
          const parsed = parseAddonPrice(item.addon_price);
          if (parsed.warning) console.warn(`Backfill addon: item ${itemId} (${date}): ${parsed.warning}`);
          addonByItemId.set(itemId, parsed.value);
        }
      }

      // Update HANYA dokumen yang sudah ada (tanpa upsert) — tidak pernah
      // membuat item/order baru. Item yang tidak ditemukan lagi di API
      // (dibatalkan/dihapus) diberi 0 sebagai default aman.
      const updates = itemsInDb.map((doc) => ({
        _id: doc._id,
        addonPrice: addonByItemId.has(doc._id) ? addonByItemId.get(doc._id)! : 0,
        foundInApi: addonByItemId.has(doc._id),
      }));
      const missingFromApi = updates.filter((u) => !u.foundInApi);
      if (missingFromApi.length) {
        console.warn(
          `Backfill addon: ${missingFromApi.length} item (${date}) tidak ditemukan lagi di API Olsera — addonPrice diset 0.`,
        );
      }

      await withMongo(async () => {
        const { olseraOrderItems } = await collections();
        await olseraOrderItems.bulkWrite(
          updates.map((u) => ({
            updateOne: {
              filter: { _id: u._id },
              update: { $set: { addonPrice: u.addonPrice } },
              // TANPA upsert — hanya update dokumen yang sudah ada.
            },
          })),
        );
      });

      summary.itemsChecked += updates.length;
      summary.itemsUpdated += updates.length;
      summary.itemsWithAddonPositive += updates.filter((u) => u.addonPrice > 0).length;
      summary.datesProcessed++;
      console.log(
        `  ${date}: ${updates.length} item diperbarui (${updates.filter((u) => u.addonPrice > 0).length} dengan add-on > 0)`,
      );
    } catch (error) {
      summary.itemsFailed++;
      summary.failedDates.push(date);
      console.error(`  ${date}: GAGAL — ${error instanceof Error ? error.message : error}`);
    }
  }

  summary.completedAt = new Date();
  // Sukses hanya bila SELURUH tanggal pending berhasil diproses tanpa gagal
  // (pagination/fetch tuntas) — tidak pernah ditandai sukses bila ada yang gagal.
  summary.succeeded = summary.failedDates.length === 0;
}

console.log("\n=== Ringkasan Backfill ===");
console.log(`Periode                 : ${summary.periodStart} s/d ${summary.periodEnd}`);
console.log(`Mulai                   : ${summary.startedAt.toISOString()}`);
console.log(`Selesai                 : ${summary.completedAt?.toISOString()}`);
console.log(`Tanggal diperiksa       : ${summary.datesPending}`);
console.log(`Tanggal berhasil diproses: ${summary.datesProcessed}`);
console.log(`Item diperiksa          : ${summary.itemsChecked}`);
console.log(`Item diperbarui         : ${summary.itemsUpdated}`);
console.log(`Item dengan add-on > 0  : ${summary.itemsWithAddonPositive}`);
console.log(`Tanggal gagal           : ${summary.failedDates.length}${summary.failedDates.length ? ` (${summary.failedDates.join(", ")})` : ""}`);
console.log(`Status                  : ${summary.succeeded ? "SUKSES" : "SEBAGIAN/GAGAL (tanggal gagal akan dicoba lagi run berikutnya)"}`);

await mongoClient.close().catch(() => undefined);
process.exit(summary.succeeded ? 0 : 1);
