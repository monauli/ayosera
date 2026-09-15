import { NextResponse } from "next/server";
import { requireModule, requireSupervisor } from "@/lib/auth";
import { currentStoreId } from "@/lib/reconciliation-store";
import { getMappingPeriodLock, MappingPeriodLockError, setMappingPeriodLock } from "@/lib/mapping-period-lock";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireModule("mapping");
    const period = new URL(request.url).searchParams.get("period") ?? "";
    return NextResponse.json({ data: await getMappingPeriodLock(currentStoreId(), period) }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Gagal membaca lock." }, { status: 400, headers: NO_CACHE_HEADERS });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireSupervisor();
    const body = await request.json() as Record<string, unknown>;
    const action = body.action === "unlock" ? "unlock" : "lock";
    const data = await setMappingPeriodLock({ storeId: currentStoreId(), period: String(body.period ?? ""), actor: user.email, action, reason: typeof body.reason === "string" ? body.reason : undefined });
    return NextResponse.json({ data }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof MappingPeriodLockError) return NextResponse.json({ error: error.message }, { status: 400, headers: NO_CACHE_HEADERS });
    return NextResponse.json({ error: "Gagal memproses lock periode." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
