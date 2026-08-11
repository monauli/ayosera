import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/olsera-store-id";
import { loadOmzetLedgerMonthDetail } from "@/lib/reconciliation-omzet-ledger";
import { recordOmzetPeriodLockPreview, OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock";
import { attachActorDisplayNames } from "@/lib/reconciliation-actor-display";
const PERIOD = /^\d{4}-\d{2}$/; export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ period: string }> }) {
  try { const user = await requireSupervisor(); const { period } = await context.params; if (!PERIOD.test(period)) return NextResponse.json({ error: "Format periode tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS }); const payload = await request.json(); const original = await loadOmzetLedgerMonthDetail(period); const result = await recordOmzetPeriodLockPreview({ storeId: currentStoreId(), period, actor: user.id, expectedVersion: payload.version, original: { ayo: original.ayo.revenue, olsera: original.olseraTotal, difference: original.differenceRevenue }, finalAgreedAmount: payload.finalAgreedAmount, adjustmentReason: payload.adjustmentReason, beritaAcaraNominal: payload.beritaAcaraNominal, beritaAcaraDirection: payload.beritaAcaraDirection }); return NextResponse.json({ data: result.preview, lock: await attachActorDisplayNames(result.lock) }, { headers: NO_CACHE_HEADERS }); }
  catch (error) { if (error instanceof Response) return error; if (error instanceof OmzetPeriodLockError) return NextResponse.json({ error: error.message }, { status: error.code === "CONFLICT" ? 409 : error.code === "LOCKED" ? 423 : 400, headers: NO_CACHE_HEADERS }); console.error("[reconciliation:period-finalization:preview]", error); return NextResponse.json({ error: "Gagal membuat preview finalisasi." }, { status: 500, headers: NO_CACHE_HEADERS }); }
}
