import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { loadOmzetLedgerMonthDetail } from "@/lib/reconciliation-omzet-ledger";
import { currentStoreId } from "@/lib/olsera-store-id";
import { getOmzetPeriodLock, isBeritaAcaraVerifiedUnlocked } from "@/lib/reconciliation-omzet-period-lock";
import { attachActorDisplayNames } from "@/lib/reconciliation-actor-display";

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
    let beritaAcaraVerified = false;
    try {
      const lock = await getOmzetPeriodLock(currentStoreId(), period);
      // V10: HANYA flag "sudah diverifikasi" yang ditambahkan di sini —
      // detail.status/statusReason/ayo/olseraTotal/differenceRevenue TETAP
      // apa adanya dari ledger (TIDAK di-collapse seperti list route via
      // applyLockedOmzetPresentation), supaya kartu rincian per-olahraga di
      // detail drawer (SportReconciliationCard) TETAP menampilkan angka asli
      // walau periode sudah Cocok — collapse Rp0 HANYA untuk periode locked,
      // dan itu pun sudah ditangani terpisah lewat blok "PERIODE DIKUNCI" di
      // client (finalization.originalAyoAmount dkk), bukan di sini.
      beritaAcaraVerified = isBeritaAcaraVerifiedUnlocked(lock);
      periodLock = lock ? await attachActorDisplayNames(lock) : null;
    } catch { /* fail closed: detail tetap memakai data asli */ }
    return NextResponse.json({ data: { ...detail, periodLock, beritaAcaraVerified } }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue:detail]", error);
    return NextResponse.json({ error: "Gagal memuat detail omset." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
