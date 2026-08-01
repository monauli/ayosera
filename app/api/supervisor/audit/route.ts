import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { getLatestSystemAudit, runSystemAudit } from "@/lib/system-audit";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSupervisor();
    const latest = await getLatestSystemAudit();
    return NextResponse.json({ status: "success", audit: latest }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[supervisor:audit:get]", error instanceof Error ? error.message : "error");
    return NextResponse.json({ status: "failed", message: "Audit terakhir belum tersedia." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}

export async function POST(request: Request) {
  try {
    await requireSupervisor();
    const body = await request.json().catch(() => ({}));
    const period = typeof body?.period === "string" && /^\d{4}-\d{2}$/.test(body.period) ? body.period : undefined;
    const audit = await runSystemAudit({ period });
    return NextResponse.json({ status: "success", audit }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[supervisor:audit:post]", error instanceof Error ? error.message : "error");
    return NextResponse.json({ status: "failed", message: "Audit sistem gagal diselesaikan." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
