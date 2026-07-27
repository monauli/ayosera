import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId, listFindings, ReconciliationValidationError } from "@/lib/reconciliation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "true"/"false" dari query string -> boolean; nilai lain dibiarkan lolos apa adanya supaya validator service yang menolaknya (pesan error konsisten). */
function parseBooleanParam(value: string | null): unknown {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return value; // sengaja bukan boolean -> validator service akan menolak dengan pesan aman
}

/**
 * GET /api/reconciliation/findings — daftar temuan (READ-ONLY, tidak ada
 * mutation). storeId SELALU dari server, tidak pernah dari input klien.
 */
export async function GET(request: Request) {
  try {
    await requireModule("rekonsiliasi");
    const url = new URL(request.url);
    const params = url.searchParams;

    const result = await listFindings({
      storeId: currentStoreId(),
      reconciliationType: params.get("reconciliationType") ?? undefined,
      domain: params.get("domain") ?? undefined,
      status: params.get("status") ?? undefined,
      impact: params.get("impact") ?? undefined,
      confidence: params.get("confidence") ?? undefined,
      requiresManualAdjustment: parseBooleanParam(params.get("requiresManualAdjustment")),
      period: params.get("period") ?? undefined,
      runId: params.get("runId") ?? undefined,
      page: params.get("page") ?? undefined,
      limit: params.get("limit") ?? undefined,
      sort: params.get("sort") ?? undefined,
      sortDir: params.get("sortDir") ?? undefined,
    });

    return NextResponse.json(
      { data: result.items, total: result.total, page: result.page, limit: result.limit },
      { headers: NO_CACHE_HEADERS },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ReconciliationValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    console.error("[reconciliation:findings]", error);
    return NextResponse.json({ error: "Gagal memuat daftar temuan rekonsiliasi." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
