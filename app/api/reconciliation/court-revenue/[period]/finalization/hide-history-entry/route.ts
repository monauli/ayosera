import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/olsera-store-id";
import { hideOmzetPeriodHistoryEntry, OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock";
import { attachActorDisplayNames } from "@/lib/reconciliation-actor-display";

const PERIOD = /^\d{4}-\d{2}$/;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — V11 "×" per-item pada Riwayat Aktivitas: SOFT DELETE (hiddenAt/
 * hiddenBy) SATU entri `history` di index `entryIndex` (index array mentah,
 * SAMA seperti urutan tersimpan — bukan index tampilan yang sudah
 * difilter/dibalik di client). Entri asli (action/actor/timestamp/reason/
 * before/after) TIDAK PERNAH dihapus — lihat computeHiddenHistory di
 * lib/reconciliation-omzet-period-lock.ts.
 *
 * Supervisor-only (sama seperti cleanup-upload-history) — user biasa
 * mendapat 403 dari requireSupervisor() sebelum baris kode lain di handler
 * ini sempat jalan.
 */
export async function POST(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    const user = await requireSupervisor();
    const { period } = await context.params;
    if (!PERIOD.test(period)) return NextResponse.json({ error: "Format periode tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    const payload = await request.json();
    const document = await hideOmzetPeriodHistoryEntry({ storeId: currentStoreId(), period, actor: user.id, expectedVersion: payload.version, entryIndex: payload.entryIndex });
    return NextResponse.json({ data: await attachActorDisplayNames(document) }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof OmzetPeriodLockError) return NextResponse.json({ error: error.message }, { status: error.code === "CONFLICT" ? 409 : error.code === "NOT_FOUND" ? 404 : 400, headers: NO_CACHE_HEADERS });
    console.error("[reconciliation:period-finalization:hide-history-entry]", error);
    return NextResponse.json({ error: "Gagal menyembunyikan item riwayat." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
