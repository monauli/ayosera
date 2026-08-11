import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/olsera-store-id";
import { resetOmzetPeriodFinalization, OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock";
import { attachActorDisplayNames } from "@/lib/reconciliation-actor-display";

const PERIOD = /^\d{4}-\d{2}$/;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — V12 "Reset Finalisasi": kosongkan SELURUH active finalization
 * state (attachment/verifiedMatchStatus/beritaAcaraNominal/
 * beritaAcaraDirection/finalAgreedAmount/adjustmentAmount/adjustmentReason/
 * original*) kembali ke "draft", supaya user bisa mulai ulang siklus
 * Upload -> OCR -> Simpan dari nol. Riwayat lama di-soft-hide (bukan
 * dihapus, lihat computeHistoryAfterReset di
 * lib/reconciliation-omzet-period-lock.ts), satu entri "reset" baru
 * ditambahkan supaya tetap terlihat siapa yang mereset dan kapan. TIDAK
 * PERNAH menyentuh data sumber AYO/Olsera/ledger.
 *
 * Supervisor-only (sama seperti unlock/cleanup-upload-history/hide-history-entry)
 * — user biasa mendapat 403 dari requireSupervisor() sebelum baris kode lain
 * di handler ini sempat jalan. Periode yang sedang locked ditolak dengan
 * 423 (harus dibuka kunci dulu).
 */
export async function POST(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    const user = await requireSupervisor();
    const { period } = await context.params;
    if (!PERIOD.test(period)) return NextResponse.json({ error: "Format periode tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    const payload = await request.json();
    const document = await resetOmzetPeriodFinalization({ storeId: currentStoreId(), period, actor: user.id, expectedVersion: payload.version });
    return NextResponse.json({ data: await attachActorDisplayNames(document) }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof OmzetPeriodLockError) {
      const status = error.code === "CONFLICT" ? 409 : error.code === "NOT_FOUND" ? 404 : error.code === "LOCKED" ? 423 : 400;
      return NextResponse.json({ error: error.message }, { status, headers: NO_CACHE_HEADERS });
    }
    console.error("[reconciliation:period-finalization:reset]", error);
    return NextResponse.json({ error: "Gagal mereset finalisasi." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
