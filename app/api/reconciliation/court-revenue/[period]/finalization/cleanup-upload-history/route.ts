import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/olsera-store-id";
import { cleanupOmzetPeriodUploadHistory, OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock";
import { attachActorDisplayNames } from "@/lib/reconciliation-actor-display";

const PERIOD = /^\d{4}-\d{2}$/;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — "Bersihkan Riwayat Upload" (V10): hapus entri `history` beraksi
 * "upload" yang duplikat/lama, mempertahankan HANYA upload terakhir (yang
 * menghasilkan attachment aktif) — lihat computeCleanedUploadHistory di
 * lib/reconciliation-omzet-period-lock.ts untuk alasan keamanan pendekatan
 * ini. Entri preview/lock/relock/unlock TIDAK PERNAH disentuh.
 *
 * Supervisor-only (sama seperti unlock) — user biasa mendapat 403 dari
 * requireSupervisor() sebelum baris kode lain di handler ini sempat jalan.
 */
export async function POST(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    const user = await requireSupervisor();
    const { period } = await context.params;
    if (!PERIOD.test(period)) return NextResponse.json({ error: "Format periode tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    const payload = await request.json();
    const result = await cleanupOmzetPeriodUploadHistory({ storeId: currentStoreId(), period, actor: user.id, expectedVersion: payload.version });
    return NextResponse.json({ data: await attachActorDisplayNames(result.lock), removedCount: result.removedCount }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof OmzetPeriodLockError) return NextResponse.json({ error: error.message }, { status: error.code === "CONFLICT" ? 409 : error.code === "NOT_FOUND" ? 404 : 400, headers: NO_CACHE_HEADERS });
    console.error("[reconciliation:period-finalization:cleanup-upload-history]", error);
    return NextResponse.json({ error: "Gagal membersihkan riwayat unggahan." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
