// GET export Excel Rekonsiliasi AYO vs Olsera (6 sheet) — Milestone 3 Bagian I.
import { requireSupervisor } from "@/lib/auth";
import { currentStoreId } from "@/lib/reconciliation-store";
import { buildManualReviewSummary } from "@/lib/reconciliation-manual-review";
import { buildCourtRevenueAuditWorkbook } from "@/lib/reconciliation-court-revenue-export";
import { buildCourtRevenuePeriodData, jsonError, parsePeriod } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    await requireSupervisor();
    const url = new URL(request.url);
    const period = parsePeriod(url);
    if (!period) return jsonError("Parameter period wajib diisi (format YYYY-MM).", 400);

    const auditedAt = new Date();
    const [{ findings, monthly, daily, rootCauses }, manualReviewSummary] = await Promise.all([buildCourtRevenuePeriodData(period), buildManualReviewSummary(currentStoreId())]);
    const manualReview = manualReviewSummary.items.filter((item) => item.period === period || item.period.startsWith(period));

    const buffer = await buildCourtRevenueAuditWorkbook({ period, monthly, daily, courtFindings: findings, manualReview, rootCauses, auditedAt });
    const filename = `rekonsiliasi-ayo-olsera-${period}.xlsx`;

    return new Response(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[supervisor:audit:court-revenue:export]", error instanceof Error ? error.message : "error");
    return jsonError("Gagal membuat berkas export rekonsiliasi.", 500);
  }
}
