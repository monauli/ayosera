import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/olsera-store-id";
import { loadOmzetLedgerMonthDetail } from "@/lib/reconciliation-omzet-ledger";
import { lockOmzetPeriod, OmzetNoteError } from "@/lib/reconciliation-omzet-note-store";
import { omzetNoteErrorResponse, PERIOD_PATTERN, toOmzetNoteResponse } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/reconciliation/court-revenue/:period/lock — kunci penjelasan
 * selisih SAAT INI lewat Berita Acara (lib/reconciliation-omzet-note-store.ts
 * lockOmzetPeriod). Syarat: sudah ada penjelasan aktif (isCurrent:true) untuk
 * periode ini, belum locked, dan explainedAmount-nya masih sama persis
 * dengan selisih yang dihitung engine SAAT INI (dicek ulang di sini —
 * mencegah mengunci penjelasan yang nominalnya sudah basi).
 *
 * TIDAK ADA endpoint unlock — lihat "Desain Skema Lock+Berita Acara" di
 * tmp/ai-handoff.md: pembukaan kunci SENGAJA ditunda untuk sistem role
 * developer di masa depan, bukan dilupakan. Status locked terbaca lewat
 * GET .../explanation (field locked/lockedBy/lockedAt pada response).
 */
export async function POST(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    const user = await requireSupervisor();
    const { period } = await context.params;
    if (!PERIOD_PATTERN.test(period)) {
      return NextResponse.json({ error: "Format periode tidak valid (harus YYYY-MM)." }, { status: 400, headers: NO_CACHE_HEADERS });
    }

    const storeId = currentStoreId();
    const current = await loadOmzetLedgerMonthDetail(period);

    try {
      const result = await lockOmzetPeriod({ storeId, period, actor: user.id, currentDifferenceRevenue: current.differenceRevenue });
      return NextResponse.json({ data: toOmzetNoteResponse(result.note) }, { headers: NO_CACHE_HEADERS });
    } catch (error) {
      if (error instanceof OmzetNoteError) return omzetNoteErrorResponse(error);
      throw error;
    }
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue:lock]", error);
    return NextResponse.json({ error: "Gagal mengunci periode ini." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
