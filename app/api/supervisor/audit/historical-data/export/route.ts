// GET export Excel — Historical Audit (Milestone 4 Bagian F).
import { requireSupervisor } from "@/lib/auth";
import { buildHistoricalDataAuditWorkbook } from "@/lib/historical-data-export";
import { buildHistoricalDataSummary, jsonError } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    await requireSupervisor();
    const auditedAt = new Date();
    const summary = await buildHistoricalDataSummary();
    const buffer = await buildHistoricalDataAuditWorkbook(summary, auditedAt);
    const filename = `historical-audit-${auditedAt.toISOString().slice(0, 10)}.xlsx`;

    return new Response(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[supervisor:audit:historical-data:export]", error instanceof Error ? error.message : "error");
    return jsonError("Gagal membuat berkas export audit historis.", 500);
  }
}
