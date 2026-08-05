import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { loadOmzetLedgerMonthDetail } from "@/lib/reconciliation-omzet-ledger";
import { currentStoreId } from "@/lib/olsera-store-id";
import { getOmzetPeriodLock } from "@/lib/reconciliation-omzet-period-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

/** GET /api/reconciliation/court-revenue/:period — detail satu bulan Rekonsiliasi Omzet AYOSERA (ledger 40001+40004, READ-ONLY). */
export async function GET(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    await requireModule("rekonsiliasi");
    const { period } = await context.params;
    if (!PERIOD_PATTERN.test(period)) {
      return NextResponse.json({ error: "Format periode tidak valid (harus YYYY-MM)." }, { status: 400, headers: NO_CACHE_HEADERS });
    }

    const detail = await loadOmzetLedgerMonthDetail(period);
    let periodLock = null;
    try { periodLock = await getOmzetPeriodLock(currentStoreId(), period); } catch { /* fail closed: detail tetap memakai data asli */ }
    return NextResponse.json({ data: { ...detail, periodLock } }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue:detail]", error);
    return NextResponse.json({ error: "Gagal memuat detail omset." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
