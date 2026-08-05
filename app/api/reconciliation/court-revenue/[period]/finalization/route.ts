import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/olsera-store-id";
import { getOmzetPeriodLock } from "@/lib/reconciliation-omzet-period-lock";

const PERIOD = /^\d{4}-\d{2}$/;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ period: string }> }) {
  try {
    await requireModule("rekonsiliasi"); const { period } = await context.params;
    if (!PERIOD.test(period)) return NextResponse.json({ error: "Format periode tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    return NextResponse.json({ data: await getOmzetPeriodLock(currentStoreId(), period) }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:period-finalization:get]", error);
    return NextResponse.json({ error: "Gagal memuat finalisasi periode." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
