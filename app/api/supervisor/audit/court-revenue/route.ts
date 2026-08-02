// GET Rekonsiliasi AYO vs Olsera — Level 1 (Bulanan) + Level 2 (Harian) +
// Level 3 (Per Court), Milestone 3 Bagian D/H. Read-only, dihitung langsung
// dari bookings+olsera_order_items (TIDAK bergantung pada run tersimpan —
// pola sama /reconciliation ledger yang sudah ada), supaya selalu
// mencerminkan data terkini tanpa perlu "Audit Ulang" terlebih dulu.
import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { buildCourtRevenuePeriodData, jsonError, parsePeriod } from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSupervisor();
    const url = new URL(request.url);
    const period = parsePeriod(url);
    if (!period) return jsonError("Parameter period wajib diisi (format YYYY-MM).", 400);

    const { findings, monthly, daily, rootCauses } = await buildCourtRevenuePeriodData(period);

    return NextResponse.json(
      {
        status: "success",
        period,
        monthly,
        daily,
        court: findings.map((f) => ({
          date: f.date,
          courtKey: f.courtKey,
          status: f.status,
          impact: f.impact,
          confidence: f.confidence,
          ayoRevenue: f.ayoRevenue,
          olseraRevenue: f.olseraRevenue,
          difference: f.olseraRevenue - f.ayoRevenue,
          diagnostics: f.diagnostics,
          rootCause: f.rootCause,
          sourceRefs: f.sourceRefs,
        })),
        rootCauses,
      },
      { headers: NO_CACHE_HEADERS },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[supervisor:audit:court-revenue]", error instanceof Error ? error.message : "error");
    return jsonError("Gagal memuat rekonsiliasi AYO vs Olsera.", 500);
  }
}
