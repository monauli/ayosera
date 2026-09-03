// Helper murni untuk audit sync bulan berjalan Olsera.
// Sengaja bebas dependency (tanpa MongoDB/fetch) supaya bisa diuji unit
// dengan node --test tanpa environment. Dipakai oleh lib/olsera-sync.ts.

export type OlseraOrderKind = "closeorder" | "openorder";

/** Baris order hasil Order List (Close/Open) — cukup id + nominal untuk audit. */
export type OrderRow = { id: number; total: number | null };

/** Halaman Order List mentah dari API Olsera; null berarti 404 = tidak ada data. */
export type OrderListPage = { data?: unknown; meta?: { last_page?: number } } | null;

/** Pengambil satu halaman Order List; error API harus dilempar (bukan dikembalikan kosong). */
export type OrderPageFetcher = (kind: OlseraOrderKind, page: number) => Promise<OrderListPage>;

/** Daftar tanggal (YYYY-MM-DD) dari tanggal 1 bulan berjalan sampai `today` inklusif. */
export function monthDatesUntil(today: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return [];
  const dates: string[] = [];
  const prefix = today.slice(0, 8);
  const lastDay = Number(today.slice(8, 10));
  for (let day = 1; day <= lastDay; day++) {
    dates.push(`${prefix}${String(day).padStart(2, "0")}`);
  }
  return dates;
}

// Kandidat nama field nominal pada baris Order List Olsera. Berbeda antar
// versi payload — dicoba berurutan; null bila tidak ada satupun yang numerik.
const ORDER_TOTAL_KEYS = [
  "total_amount",
  "grand_total",
  "total_after_discount",
  "total",
  "nett_sales",
  "total_payment",
];

export function extractOrderTotal(row: Record<string, unknown>): number | null {
  for (const key of ORDER_TOTAL_KEYS) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Tarik seluruh halaman Close + Open (paid) Order List untuk satu tanggal,
 * dedup berdasarkan id order. Error fetch/pagination dilempar ke pemanggil —
 * hasil kosong hanya sah bila API benar-benar menjawab kosong/404.
 */
export async function fetchDayOrderRows(fetchPage: OrderPageFetcher): Promise<OrderRow[]> {
  const rows: OrderRow[] = [];
  const seen = new Set<number>();
  for (const kind of ["closeorder", "openorder"] as const) {
    for (let page = 1; ; page++) {
      const body = await fetchPage(kind, page);
      if (!body) break; // 404 = memang tidak ada data untuk jenis order ini
      const list = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
      for (const row of list) {
        const id = Number(row.id);
        if (!Number.isFinite(id) || seen.has(id)) continue;
        seen.add(id);
        rows.push({ id, total: extractOrderTotal(row) });
      }
      const lastPage = body.meta?.last_page;
      if (!lastPage || page >= lastPage) break;
    }
  }
  return rows;
}

/** Jumlahkan nominal seluruh baris; null bila ada baris tanpa nominal (tidak bisa dibandingkan adil). */
export function sumOrderTotals(rows: OrderRow[]): number | null {
  let sum = 0;
  for (const row of rows) {
    if (row.total === null) return null;
    sum += row.total;
  }
  return rows.length ? sum : 0;
}

/**
 * Toleransi selisih nominal (rupiah) saat membandingkan nominal Order List
 * Olsera dengan catatan tersimpan — SATU angka untuk evaluateDayCompleteness
 * (level hari) dan planIncrementalOrders (level order).
 */
export const ORDER_TOTAL_TOLERANCE = 0.5;

export type IncrementalOrderPlan = { fetch: number[]; skip: number[] };

/**
 * Rencana sync incremental satu hari — versi PER ORDER dari aturan
 * evaluateDayCompleteness: order yang belum tersimpan (padanan "jumlah
 * transaksi berbeda") atau nominalnya berubah > ORDER_TOTAL_TOLERANCE
 * (padanan "total penjualan berbeda") harus ditarik detailnya; nominal null
 * di salah satu sisi = tidak bisa dibandingkan adil -> tarik. Sisanya di-skip.
 * `stored` = nominal Order List yang tersimpan per id order (olsera_order_items.orderTotal).
 */
export function planIncrementalOrders(listed: OrderRow[], stored: ReadonlyMap<number, number | null>): IncrementalOrderPlan {
  const fetch: number[] = [];
  const skip: number[] = [];
  for (const row of listed) {
    if (!stored.has(row.id)) {
      fetch.push(row.id);
      continue;
    }
    const storedTotal = stored.get(row.id) ?? null;
    if (row.total === null || storedTotal === null || Math.abs(row.total - storedTotal) > ORDER_TOTAL_TOLERANCE) fetch.push(row.id);
    else skip.push(row.id);
  }
  return { fetch, skip };
}

export type DayCompletenessInput = {
  /** Jumlah order unik menurut API Olsera hari ini. */
  expectedCount: number;
  /** Total penjualan menurut Order List Olsera; null bila list tidak memuat nominal. */
  expectedTotal: number | null;
  /** Dokumen olsera_synced_days untuk tanggal ini; null bila belum pernah tuntas. */
  marked: { expectedOrderCount: number; expectedTotal?: number | null } | null;
  /** Jumlah order unik (distinct orderNo) yang tersimpan di MongoDB untuk tanggal ini. */
  storedOrderCount: number;
};

export type DayCompleteness = { complete: boolean; reason: string };

/**
 * Tanggal dianggap lengkap hanya bila jumlah order Olsera == catatan sync
 * terakhir, total penjualan tidak berubah, dan MongoDB memang berisi data.
 * API Olsera adalah sumber kebenaran — status sync lama tidak dipercaya sendirian.
 */
export function evaluateDayCompleteness(input: DayCompletenessInput): DayCompleteness {
  const { expectedCount, expectedTotal, marked, storedOrderCount } = input;

  if (expectedCount === 0) {
    // API sudah dipastikan menjawab (bukan error) — kosong sah hanya bila MongoDB juga kosong.
    return storedOrderCount === 0
      ? { complete: true, reason: "Olsera dan MongoDB sama-sama kosong" }
      : { complete: false, reason: "Olsera kosong tetapi MongoDB masih menyimpan transaksi lama" };
  }
  if (!marked) {
    return { complete: false, reason: "Tanggal belum pernah tuntas disync" };
  }
  if (marked.expectedOrderCount !== expectedCount) {
    return {
      complete: false,
      reason: `Jumlah transaksi berbeda (Olsera ${expectedCount}, tersimpan ${marked.expectedOrderCount})`,
    };
  }
  if (storedOrderCount === 0) {
    return { complete: false, reason: "MongoDB kosong padahal Olsera memiliki transaksi" };
  }
  if (
    expectedTotal !== null &&
    marked.expectedTotal !== null &&
    marked.expectedTotal !== undefined &&
    Math.abs(expectedTotal - marked.expectedTotal) > ORDER_TOTAL_TOLERANCE
  ) {
    return {
      complete: false,
      reason: `Total penjualan berbeda (Olsera ${expectedTotal}, tersimpan ${marked.expectedTotal})`,
    };
  }
  return { complete: true, reason: "Jumlah transaksi dan total penjualan cocok" };
}
