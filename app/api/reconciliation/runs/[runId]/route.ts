import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId, getRunDetail, ReconciliationValidationError } from "@/lib/reconciliation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reconciliation/runs/:runId — detail satu run (READ-ONLY). Run
 * milik toko lain diperlakukan sama seperti tidak ada (404) — lihat
 * getRunDetail di lib/reconciliation-store.ts (mencegah IDOR lintas toko).
 */
export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    await requireModule("rekonsiliasi");
    const { runId } = await context.params;

    const run = await getRunDetail({ runId, storeId: currentStoreId() });
    if (!run) {
      return NextResponse.json({ error: "Run rekonsiliasi tidak ditemukan." }, { status: 404, headers: NO_CACHE_HEADERS });
    }

    return NextResponse.json({ data: run }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ReconciliationValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    console.error("[reconciliation:runs:detail]", error);
    return NextResponse.json({ error: "Gagal memuat detail run rekonsiliasi." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
