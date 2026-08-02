// POST Safe Backfill — Milestone 4 Bagian C. HANYA baris "Exact Match" (HIGH
// CONFIDENCE) yang pernah dibackfill; lihat lib/historical-order-item-backfill.ts
// untuk syarat keamanan lengkap. `dryRun` default TRUE (aman) — hanya
// mengembalikan rencana untuk direview manusia. Menulis (`dryRun: false`)
// WAJIB `confirmed: true` eksplisit, pola sama app/api/supervisor/audit/actions/route.ts.
import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { collections } from "@/lib/mongodb";
import { currentStoreId } from "@/lib/reconciliation-store";
import { loadHistoricalOrderItemIdentityAudit } from "@/lib/historical-order-item-source";
import { planExactMatchBackfill, runOrderItemIdentityBackfill } from "@/lib/historical-order-item-backfill";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const actor = await requireSupervisor();
    const body = await request.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false; // default true (aman)
    if (!dryRun && body?.confirmed !== true) {
      return NextResponse.json({ status: "blocked", message: "Konfirmasi eksplisit wajib diberikan sebelum write (dryRun: false butuh confirmed: true)." }, { status: 400, headers: NO_CACHE_HEADERS });
    }

    const storeId = currentStoreId();
    const { rows } = await loadHistoricalOrderItemIdentityAudit();
    const plan = planExactMatchBackfill(rows);
    const result = await runOrderItemIdentityBackfill({ storeId, plan, dryRun, triggeredBy: `supervisor:${actor.id}` });

    if (!dryRun) {
      const c = await collections();
      await c.systemAuditActions.insertOne({
        _id: `system-action:${storeId}:${Date.now()}:${crypto.randomUUID()}`,
        storeId, actorId: actor.id, action: "historical-backfill-run",
        scope: { storeId, runId: result.runId },
        status: "success", reason: null,
        before: null, after: { planned: result.planned, updated: result.updated, skippedAlreadyFilled: result.skippedAlreadyFilled },
        createdAt: new Date(),
      });
    }

    return NextResponse.json({ status: "success", ...result }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[supervisor:audit:historical-data:backfill]", error instanceof Error ? error.message : "error");
    return NextResponse.json({ status: "failed", message: "Backfill gagal; tidak ada baris lain yang diproses." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
