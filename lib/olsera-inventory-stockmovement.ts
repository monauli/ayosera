// Client read-only untuk GET /api/open-api/v1/en/inventory/stockmovement
// (Open API Olsera) — sumber data OTOMATIS untuk Export Inventori Bulanan
// (lihat lib/olsera-inventory-monthly-snapshot-store.ts:ensureMonthlySnapshotChain,
// dipakai lib/olsera-inventory-two-sheet-export.ts).
// Memakai flow autentikasi existing (lib/olsera.ts:getAccessToken) — TIDAK
// membuat autentikasi baru, TIDAK memakai token/cookie Backoffice, TIDAK
// hard-code credential. Murni baca: tidak pernah menulis apa pun ke Olsera.
//
// Endpoint ini diverifikasi 2026-07-20 (scripts/inspect-olsera-inventory.ts +
// validasi manual terhadap doc export/summary-2026-06-01__2026-06-30.xlsx,
// lihat komentar lib/olsera-inventory-monthly-core.ts) — 33/33 produk Juni
// 2026 cocok persis. Endpoint lain (id/stockmovement, en/report/stockmovement,
// dst.) tetap 404, TIDAK diubah di sini.
import { getAccessToken } from "./olsera.ts";
import { parseStockMovementApiRow, type StockMovementApiRow } from "./olsera-inventory-monthly-core.ts";

const BASE_URL = "https://api-open.olsera.co.id";
const EN_PREFIX = "/api/open-api/v1/en";
const PAGE_DELAY_MS = 250;
const PER_PAGE = 100;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FetchStockMovementResult =
  | { ok: true; rows: StockMovementApiRow[]; skippedRawRows: number }
  | { ok: false; error: string };

/**
 * Tarik SELURUH halaman stockmovement untuk rentang tanggal (start_date/
 * end_date inklusif), mengikuti meta.last_page sampai tuntas. Retry dengan
 * backoff pada 429/5xx (pola sama dengan lib/olsera-sync.ts:getJson) — 429
 * diberi budget lebih longgar karena pasti pulih bila menunggu. 404 dari
 * Olsera dianggap "tidak ada data" (array kosong), konsisten dengan endpoint
 * order/report Olsera lain — BUKAN error. Baris mentah yang gagal diparse
 * (product_id hilang/tidak valid) dilewati dan dihitung di skippedRawRows,
 * TIDAK menggagalkan seluruh fetch.
 */
export async function fetchStockMovementRange(startDate: string, endDate: string): Promise<FetchStockMovementResult> {
  const auth = await getAccessToken();
  if ("error" in auth) return { ok: false, error: auth.error };
  const token = auth.token;

  const rows: StockMovementApiRow[] = [];
  let skippedRawRows = 0;
  let page = 1;

  for (;;) {
    const url = new URL(`${BASE_URL}${EN_PREFIX}/inventory/stockmovement`);
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);

    let body: Record<string, unknown> | null = null;
    for (let attempt = 1; ; attempt++) {
      let response: globalThis.Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
      } catch {
        return { ok: false, error: `Tidak dapat terhubung ke server Olsera (halaman ${page}).` };
      }

      if (response.status === 404) {
        body = null; // tidak ada data pada rentang ini — bukan error.
        break;
      }
      if (response.status === 401) {
        return { ok: false, error: "Token Olsera tidak valid/kedaluwarsa saat menarik stockmovement." };
      }
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
        return { ok: false, error: `Olsera mengembalikan HTTP ${response.status} pada halaman ${page}: ${raw.slice(0, 200)}` };
      }
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        return { ok: false, error: `Respons Olsera bukan JSON yang valid pada halaman ${page}.` };
      }
      break;
    }

    if (!body) break; // 404 — tuntas, tidak ada halaman berikutnya.

    const list = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
    for (const raw of list) {
      const parsed = parseStockMovementApiRow(raw);
      if (parsed) rows.push(parsed);
      else skippedRawRows++;
    }

    const meta = body.meta as { last_page?: number } | undefined;
    if (!meta?.last_page || page >= meta.last_page) break;
    page++;
    await sleep(PAGE_DELAY_MS);
  }

  return { ok: true, rows, skippedRawRows };
}
