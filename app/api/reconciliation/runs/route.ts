import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId, listRuns, ReconciliationValidationError } from "@/lib/reconciliation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reconciliation/runs — daftar run rekonsiliasi (READ-ONLY, tidak
 * ada mutation). storeId SELALU dari server (currentStoreId()), tidak pernah
 * dari input klien (lihat lib/reconciliation-store.ts).
 */
export async function GET(request: Request) {
  try {
    await requireModule("rekonsiliasi");
    const url = new URL(request.url);
    const params = url.searchParams;

    const result = await listRuns({
      storeId: currentStoreId(),
      reconciliationType: params.get("reconciliationType") ?? undefined,
      period: params.get("period") ?? undefined,
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
    console.error("[reconciliation:runs]", error);
    return NextResponse.json({ error: "Gagal memuat daftar run rekonsiliasi." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
