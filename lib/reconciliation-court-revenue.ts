// Ringkasan bulanan Rekonsiliasi Omset AYO vs Olsera (halaman /reconciliation
// yang disederhanakan) — HANYA membandingkan omset booking lapangan AYO
// (`bookings`) dengan omset transaksi kategori lapangan Olsera yang SUDAH
// ter-resolve saat sync (`olsera_order_items.resolvedCategoryName`, difilter
// lewat classifyCategoryForCourtRevenue — business rule Modul Rekonsiliasi
// yang sudah ada, lib/reconciliation-rules.ts, TIDAK diubah di sini).
//
// Read-only, tidak pernah menulis, tidak pernah memanggil API Olsera/AYO live
// (kategori dibaca dari field yang sudah tersimpan, sama pola dengan
// lib/reconciliation-sources.ts loadCategoryFindings). Modul ini TERPISAH dari
// runner/manual-resolution/audit-log/feature-flag Modul Rekonsiliasi — tidak
// menyentuh maupun menggantikan salah satu dari itu.
import "server-only";
import { isCurrentJakartaPeriod, jakartaCurrentPeriod } from "./olsera-financial-core.ts";
import { classifyCategoryForCourtRevenue, evaluateCourtRevenue } from "./reconciliation-rules.ts";
import { periodToMonthRange } from "./reconciliation-sources.ts";
import { isMatchLike, statusLabel, type ReconciliationStatus } from "./reconciliation-types.ts";
import { getRevenueAmount, isRevenueEligibleTransaction } from "./revenue.ts";
import type { BookingDocument, OlseraOrderItemDocument } from "./mongodb.ts";

export type MinimalReadCollection<T> = {
  find(filter: Record<string, unknown>): { toArray(): Promise<T[]> };
};

export type CourtRevenueSourceContext = {
  bookings: MinimalReadCollection<BookingDocument>;
  orderItems: MinimalReadCollection<OlseraOrderItemDocument>;
};

export async function resolveCourtRevenueSourceContext(context?: CourtRevenueSourceContext): Promise<CourtRevenueSourceContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { bookings, olseraOrderItems } = await collections();
  return { bookings, orderItems: olseraOrderItems };
}

export type CourtRevenueSide = { count: number; revenue: number };

export type CourtRevenueDisplayStatus = "MATCH" | "NEEDS_REVIEW" | "CURRENT_PERIOD";

export type CourtRevenueMonthSummary = {
  period: string;
  ayo: CourtRevenueSide;
  olsera: CourtRevenueSide;
  differenceRevenue: number;
  differenceCount: number;
  status: ReconciliationStatus;
  displayStatus: CourtRevenueDisplayStatus;
};

export type CourtRevenueDayRow = {
  date: string;
  ayo: CourtRevenueSide;
  olsera: CourtRevenueSide;
  differenceRevenue: number;
  status: ReconciliationStatus;
  statusLabel: string;
};

export type CourtRevenueMonthDetail = CourtRevenueMonthSummary & {
  mismatchedDays: CourtRevenueDayRow[];
};

function emptySide(): CourtRevenueSide {
  return { count: 0, revenue: 0 };
}

function isLapanganItem(item: Pick<OlseraOrderItemDocument, "categoryResolutionStatus" | "resolvedCategoryName">): boolean {
  if (item.categoryResolutionStatus !== "resolved" || !item.resolvedCategoryName) return false;
  return classifyCategoryForCourtRevenue(item.resolvedCategoryName) === "court";
}

/**
 * Identitas SATU order Olsera. `orderNo` adalah field order (bukan per-baris
 * item) — satu order lapangan dengan beberapa baris item lapangan HARUS
 * dihitung satu transaksi, bukan per baris (lihat `olsera_order_items.orderNo`,
 * dipakai identik di lib/olsera-sync.ts `distinct("orderNo", ...)` dan
 * lib/olsera-audit.ts sebagai identitas order yang sudah baku di codebase).
 * Baris tanpa `orderNo` valid (kosong/hilang) TIDAK digabung menebak-nebak ke
 * order lain — jatuh ke `_id` baris (unik per baris) supaya tidak
 * under-count transaksi yang sebenarnya berbeda.
 */
function orderIdentity(item: Pick<OlseraOrderItemDocument, "_id" | "orderNo">): string {
  return typeof item.orderNo === "string" && item.orderNo.trim() !== "" ? `order:${item.orderNo}` : `row:${item._id}`;
}

/**
 * Agregasi omset lapangan Olsera per ORDER unik (bukan per baris item) —
 * `revenue` tetap menjumlahkan `amount` tiap baris item lapangan (tidak
 * pernah nominal total order, mencegah dobel hitung bila satu order punya
 * >1 baris lapangan), `count`/`byDate` menghitung `orderIdentity` unik.
 */
function aggregateOlseraCourtRevenue(itemRows: OlseraOrderItemDocument[]): { total: CourtRevenueSide; byDate: Map<string, CourtRevenueSide> } {
  let revenue = 0;
  const orderKeys = new Set<string>();
  const revenueByDate = new Map<string, number>();
  const orderKeysByDate = new Map<string, Set<string>>();

  for (const item of itemRows) {
    if (!isLapanganItem(item)) continue;
    revenue += item.amount;
    orderKeys.add(orderIdentity(item));
    revenueByDate.set(item.date, (revenueByDate.get(item.date) ?? 0) + item.amount);
    const daySet = orderKeysByDate.get(item.date) ?? new Set<string>();
    daySet.add(orderIdentity(item));
    orderKeysByDate.set(item.date, daySet);
  }

  const byDate = new Map<string, CourtRevenueSide>();
  for (const [date, keys] of orderKeysByDate) {
    byDate.set(date, { count: keys.size, revenue: revenueByDate.get(date) ?? 0 });
  }
  return { total: { count: orderKeys.size, revenue }, byDate };
}

function evaluate(date: string, ayo: CourtRevenueSide, olsera: CourtRevenueSide) {
  return evaluateCourtRevenue({
    date,
    court: "ALL",
    ayo: ayo.count > 0 ? ayo : null,
    olsera: olsera.count > 0 ? olsera : null,
    olseraCourtCategoryConfident: true,
    courtMappingConfidence: "exact",
  });
}

function displayStatusFor(period: string, status: ReconciliationStatus, now: Date): CourtRevenueDisplayStatus {
  if (isCurrentJakartaPeriod(period, now)) return "CURRENT_PERIOD";
  return isMatchLike(status) ? "MATCH" : "NEEDS_REVIEW";
}

async function loadMonthRows(period: string, context?: CourtRevenueSourceContext) {
  const { start, end } = periodToMonthRange(period);
  const { bookings, orderItems } = await resolveCourtRevenueSourceContext(context);
  const [bookingRows, itemRows] = await Promise.all([
    bookings.find({ date: { $gte: start, $lte: end } }).toArray(),
    orderItems.find({ date: { $gte: start, $lte: end } }).toArray(),
  ]);
  return { bookingRows, itemRows };
}

export async function loadCourtRevenueMonthSummary(
  period: string,
  context?: CourtRevenueSourceContext,
  now: Date = new Date(),
): Promise<CourtRevenueMonthSummary> {
  const { bookingRows, itemRows } = await loadMonthRows(period, context);

  const ayo = emptySide();
  for (const booking of bookingRows) {
    if (!isRevenueEligibleTransaction(booking)) continue;
    ayo.count += 1;
    ayo.revenue += getRevenueAmount(booking);
  }

  const { total: olsera } = aggregateOlseraCourtRevenue(itemRows);

  const evaluation = evaluate(`${period}-01`, ayo, olsera);
  return {
    period,
    ayo,
    olsera,
    differenceRevenue: olsera.revenue - ayo.revenue,
    differenceCount: olsera.count - ayo.count,
    status: evaluation.status,
    displayStatus: displayStatusFor(period, evaluation.status, now),
  };
}

export async function loadCourtRevenueMonthDetail(
  period: string,
  context?: CourtRevenueSourceContext,
  now: Date = new Date(),
): Promise<CourtRevenueMonthDetail> {
  const { bookingRows, itemRows } = await loadMonthRows(period, context);

  const ayo = emptySide();
  const ayoByDate = new Map<string, CourtRevenueSide>();
  for (const booking of bookingRows) {
    if (!isRevenueEligibleTransaction(booking)) continue;
    const amount = getRevenueAmount(booking);
    ayo.count += 1;
    ayo.revenue += amount;
    const side = ayoByDate.get(booking.date) ?? emptySide();
    side.count += 1;
    side.revenue += amount;
    ayoByDate.set(booking.date, side);
  }

  const { total: olsera, byDate: olseraByDate } = aggregateOlseraCourtRevenue(itemRows);

  const evaluation = evaluate(`${period}-01`, ayo, olsera);

  const dates = [...new Set([...ayoByDate.keys(), ...olseraByDate.keys()])].sort();
  const mismatchedDays: CourtRevenueDayRow[] = [];
  for (const date of dates) {
    const daySideAyo = ayoByDate.get(date) ?? emptySide();
    const daySideOlsera = olseraByDate.get(date) ?? emptySide();
    const dayEvaluation = evaluate(date, daySideAyo, daySideOlsera);
    if (isMatchLike(dayEvaluation.status)) continue;
    mismatchedDays.push({
      date,
      ayo: daySideAyo,
      olsera: daySideOlsera,
      differenceRevenue: daySideOlsera.revenue - daySideAyo.revenue,
      status: dayEvaluation.status,
      statusLabel: statusLabel(dayEvaluation.status),
    });
  }

  return {
    period,
    ayo,
    olsera,
    differenceRevenue: olsera.revenue - ayo.revenue,
    differenceCount: olsera.count - ayo.count,
    status: evaluation.status,
    displayStatus: displayStatusFor(period, evaluation.status, now),
    mismatchedDays,
  };
}

/** Daftar period (YYYY-MM) `count` bulan terakhir, dari bulan berjalan (Asia/Jakarta) mundur. */
export function recentCourtRevenuePeriods(count: number, now: Date = new Date()): string[] {
  const current = jakartaCurrentPeriod(now);
  let [year, month] = current.split("-").map(Number);
  const periods: string[] = [];
  for (let i = 0; i < count; i++) {
    periods.push(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  return periods;
}
