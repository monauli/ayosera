// GET Level 4 (Jam/slot) + Level 5 (Booking/transaksi) — drill-down SATU
// (tanggal, court-bucket). Read-only, bukan matching otomatis (lihat
// docs/reconciliation-ayo-olsera-scope.md §4).
import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { collections } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { allCourtKeys } from "@/lib/court-mapping";
import { buildBookingTransactionCandidates, buildHourlySlotDrilldown } from "@/lib/reconciliation-court-revenue-drilldown";
import { jsonError } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    await requireSupervisor();
    const url = new URL(request.url);
    const date = url.searchParams.get("date");
    const court = url.searchParams.get("court");
    if (!date || !DATE_PATTERN.test(date)) return jsonError("Parameter date wajib diisi (format YYYY-MM-DD).", 400);
    if (!court || !allCourtKeys().includes(court)) return jsonError("Parameter court tidak valid.", 400);

    const { bookings, olseraOrderItems } = await collections();
    const [bookingRows, itemRows] = await Promise.all([bookings.find({ date }).toArray(), olseraOrderItems.find({ date }).toArray()]);

    const hourly = buildHourlySlotDrilldown(date, court, bookingRows, itemRows);
    const candidates = buildBookingTransactionCandidates(date, court, bookingRows, itemRows);

    return NextResponse.json({ status: "success", date, court, hourly, candidates }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[supervisor:audit:court-revenue:drilldown]", error instanceof Error ? error.message : "error");
    return jsonError("Gagal memuat drill-down rekonsiliasi.", 500);
  }
}
