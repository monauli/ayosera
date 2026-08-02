// GET Historical Data Audit (Milestone 4 Bagian A/E) — 8 kategori data
// historis, read-only, dihitung langsung dari MongoDB saat ini (tidak
// bergantung pada run tersimpan), supaya angka selalu mencerminkan state
// terkini termasuk setelah backfill dijalankan.
import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { buildHistoricalDataSummary, jsonError } from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    await requireSupervisor();
    const summary = await buildHistoricalDataSummary();
    return NextResponse.json({ status: "success", ...summary }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[supervisor:audit:historical-data]", error instanceof Error ? error.message : "error");
    return jsonError("Gagal memuat audit data historis.", 500);
  }
}
