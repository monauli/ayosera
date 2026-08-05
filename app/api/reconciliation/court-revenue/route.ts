import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { loadOmzetLedgerRecentSummaries } from "@/lib/reconciliation-omzet-ledger";
import { currentStoreId } from "@/lib/olsera-store-id";
import { applyLockedOmzetPresentation, getOmzetPeriodLock } from "@/lib/reconciliation-omzet-period-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 24;

/**
 * GET /api/reconciliation/court-revenue — ringkasan bulanan Rekonsiliasi Omzet
 * AYOSERA (ledger 40001+40004, READ-ONLY). Bulan tanpa omzet AYO, tanpa data
 * ledger Olsera, dan bukan bulan berjalan TIDAK ditampilkan (lihat
 * lib/reconciliation-omzet-ledger.ts hasOmzetActivity) — mencegah periode di
 * luar cakupan data muncul dengan status "Perlu Dicek" yang menyesatkan.
 */
export async function GET(request: Request) {
  try {
    await requireModule("rekonsiliasi");
    const params = new URL(request.url).searchParams;
    const requested = Number(params.get("months") ?? DEFAULT_MONTHS);
    const months = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_MONTHS) : DEFAULT_MONTHS;

    const rawItems = await loadOmzetLedgerRecentSummaries(months);
    const items = await Promise.all(rawItems.map(async (item) => {
      try { return applyLockedOmzetPresentation(item, await getOmzetPeriodLock(currentStoreId(), item.period)); }
      catch { return item; }
    }));

    return NextResponse.json({ items }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue]", error);
    return NextResponse.json({ error: "Gagal memuat ringkasan omset." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
