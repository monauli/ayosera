import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/reconciliation-store";
import { listManualResolutions, ManualResolutionError } from "@/lib/reconciliation-manual-resolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireModule("rekonsiliasi");
    const p = new URL(request.url).searchParams;
    const result = await listManualResolutions({ storeId: currentStoreId(), period: p.get("period") ?? undefined, domain: (p.get("domain") ?? undefined) as never, decision: (p.get("decision") ?? undefined) as never, reasonCode: (p.get("reasonCode") ?? undefined) as never, createdBy: p.get("createdBy") ?? undefined, dateFrom: p.get("dateFrom") ?? undefined, dateTo: p.get("dateTo") ?? undefined, page: p.get("page") ? Number(p.get("page")) : undefined, limit: p.get("limit") ? Number(p.get("limit")) : undefined });
    return NextResponse.json({ data: result.items, total: result.total, page: result.page, limit: result.limit }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ManualResolutionError) return NextResponse.json({ error: error.message }, { status: 400, headers: NO_CACHE_HEADERS });
    console.error("[reconciliation:manual-resolutions]", error);
    return NextResponse.json({ error: "Gagal memuat manual resolutions." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
