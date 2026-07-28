import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { loadCourtRevenueMonthSummary, recentCourtRevenuePeriods } from "@/lib/reconciliation-court-revenue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 24;

/** GET /api/reconciliation/court-revenue — ringkasan bulanan omset lapangan AYO vs Olsera (READ-ONLY). */
export async function GET(request: Request) {
  try {
    await requireModule("rekonsiliasi");
    const params = new URL(request.url).searchParams;
    const requested = Number(params.get("months") ?? DEFAULT_MONTHS);
    const months = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_MONTHS) : DEFAULT_MONTHS;

    const periods = recentCourtRevenuePeriods(months);
    const items = await Promise.all(periods.map((period) => loadCourtRevenueMonthSummary(period)));

    return NextResponse.json({ items }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue]", error);
    return NextResponse.json({ error: "Gagal memuat ringkasan omset lapangan." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
