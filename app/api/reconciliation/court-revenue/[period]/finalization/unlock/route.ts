import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/olsera-store-id";
import { unlockOmzetPeriodFinalization, OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock";
const PERIOD = /^\d{4}-\d{2}$/; export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ period: string }> }) {
  try { const user = await requireSupervisor(); const { period } = await context.params; if (!PERIOD.test(period)) return NextResponse.json({ error: "Format periode tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS }); const payload = await request.json(); const data = await unlockOmzetPeriodFinalization({ storeId: currentStoreId(), period, actor: user.id, expectedVersion: payload.version, reason: payload.reason }); return NextResponse.json({ data }, { headers: NO_CACHE_HEADERS }); }
  catch (error) { if (error instanceof Response) return error; if (error instanceof OmzetPeriodLockError) return NextResponse.json({ error: error.message }, { status: error.code === "CONFLICT" ? 409 : 400, headers: NO_CACHE_HEADERS }); console.error("[reconciliation:period-finalization:unlock]", error); return NextResponse.json({ error: "Gagal membuka kunci periode." }, { status: 500, headers: NO_CACHE_HEADERS }); }
}
