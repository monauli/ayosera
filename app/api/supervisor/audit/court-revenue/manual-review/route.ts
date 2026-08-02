// GET unified "Butuh Adjust Manual" lintas domain — Milestone 3 Bagian F.
import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { currentStoreId } from "@/lib/reconciliation-store";
import { buildManualReviewSummary } from "@/lib/reconciliation-manual-review";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { jsonError } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSupervisor();
    const summary = await buildManualReviewSummary(currentStoreId());
    return NextResponse.json({ status: "success", ...summary }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[supervisor:audit:court-revenue:manual-review]", error instanceof Error ? error.message : "error");
    return jsonError("Gagal memuat daftar butuh adjust manual.", 500);
  }
}
