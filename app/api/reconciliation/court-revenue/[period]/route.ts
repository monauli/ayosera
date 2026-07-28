import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { loadCourtRevenueMonthDetail } from "@/lib/reconciliation-court-revenue";
import { ReconciliationSourceError } from "@/lib/reconciliation-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/reconciliation/court-revenue/:period — detail satu bulan omset lapangan AYO vs Olsera (READ-ONLY). */
export async function GET(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    await requireModule("rekonsiliasi");
    const { period } = await context.params;

    const detail = await loadCourtRevenueMonthDetail(period);
    return NextResponse.json({ data: detail }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ReconciliationSourceError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    console.error("[reconciliation:court-revenue:detail]", error);
    return NextResponse.json({ error: "Gagal memuat detail omset lapangan." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
