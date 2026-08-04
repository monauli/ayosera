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
 * POST /api/reconciliation/court-revenue/:period/lock — kunci periode ini
 * (lib/reconciliation-omzet-note-store.ts lockOmzetPeriod). TIDAK ADA body
 * request — endpoint ini SELALU menghitung ulang differenceRevenue SAAT INI
 * lewat loadOmzetLedgerMonthDetail dan mengoper ke lockOmzetPeriod, yang lalu
 * memutuskan salah satu dari DUA jalur (lihat lockOmzetPeriod untuk detail):
 *   1. Selisih Terjelaskan: sudah ada penjelasan aktif (isCurrent:true),
 *      belum locked, dan explainedAmount-nya masih sama persis dengan
 *      selisih SAAT INI (mencegah mengunci penjelasan yang nominalnya basi).
 *   2. Cocok TANPA penjelasan: belum ada penjelasan aktif SAMA SEKALI, TAPI
 *      selisih SAAT INI benar-benar Rp0 — boleh dikunci langsung tanpa
 *      mewajibkan penjelasan manual (tidak ada apa pun untuk dijelaskan).
 * Kalau belum ada penjelasan aktif DAN selisih bukan Rp0, tetap ditolak
 * (NOT_FOUND) — harus kirim penjelasan dulu.
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
