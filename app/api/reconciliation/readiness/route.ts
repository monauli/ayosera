import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { getDb, collections } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { isReconciliationWriteEnabled } from "@/lib/reconciliation-operational-readiness";

export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await requireSupervisor(); const db = await getDb(); const c = await collections();
    const [mongo, indexes, snapshot, run, audit] = await Promise.all([
      db.command({ ping: 1 }).then(() => "healthy").catch(() => "unavailable"),
      Promise.all([c.reconciliationRuns.listIndexes().toArray(), c.reconciliationFindings.listIndexes().toArray(), c.reconciliationManualResolutions.listIndexes().toArray(), c.reconciliationAuditLog.listIndexes().toArray()]).then((sets) => ({ status: "checked", count: sets.reduce((sum, set) => sum + set.length, 0) })).catch(() => ({ status: "unavailable", count: 0 })),
      c.olseraInventoryMonthlySnapshots.find({}).sort({ updatedAt: -1 }).limit(1).toArray().then((rows) => rows[0] ?? null),
      c.reconciliationRuns.find({}).sort({ updatedAt: -1 }).limit(1).toArray().then((rows) => rows[0] ?? null),
      c.reconciliationAuditLog.find({}).sort({ createdAt: -1 }).limit(1).toArray().then((rows) => rows[0] ?? null),
    ]);
    return NextResponse.json({ mongodb: mongo, indexes, featureFlag: { name: "RECONCILIATION_WRITE_ENABLED", enabled: isReconciliationWriteEnabled(), default: false }, writeEnabled: false, dryRunDefault: true, snapshotStatus: snapshot ? "available" : "unknown", reconciliationStatus: run?.status ?? "never-run", auditLogStatus: audit ? "available" : "empty", checkedAt: new Date().toISOString() }, { headers: NO_CACHE_HEADERS });
  } catch (error) { if (error instanceof Response) return error; console.error("[reconciliation:readiness]", error); return NextResponse.json({ error: "Gagal memuat operational readiness." }, { status: 500, headers: NO_CACHE_HEADERS }); }
}
