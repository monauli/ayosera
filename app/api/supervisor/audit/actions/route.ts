import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { collections } from "@/lib/mongodb";
import { validatePeriod } from "@/lib/olsera-financial-core";
import { cleanupConfirmedStaleLedgerAccount, reconcileLedgerSummarySnapshot } from "@/lib/olsera-financial-store";
import { startFinancialSync, stepFinancialSync } from "@/lib/olsera-financial-sync";
import { withOlseraSyncLock } from "@/lib/olsera-cron-lock";
import { runCourtRevenueReconciliationRange } from "@/lib/reconciliation-court-revenue-runner";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const LEASE_MS = 5 * 60 * 1000;
const ACTIONS = ["sync-period", "retry-failed", "reconcile", "cleanup-stale", "court-revenue-audit-run"] as const;

function periodToMonthRange(period: string): { start: string; end: string } {
  const [year, month] = period.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return { start: `${period}-01`, end: `${period}-${String(lastDay).padStart(2, "0")}` };
}

export async function POST(request: Request) {
  try {
    const actor = await requireSupervisor();
    const body = await request.json();
    const action = String(body?.action ?? "");
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) return NextResponse.json({ status: "blocked", message: "Aksi tidak tersedia." }, { status: 400, headers: NO_CACHE_HEADERS });
    if (body?.confirmed !== true) return NextResponse.json({ status: "blocked", message: "Konfirmasi eksplisit wajib diberikan sebelum write." }, { status: 400, headers: NO_CACHE_HEADERS });
    const periodParts = String(body?.period ?? "").split("-");
    const period = validatePeriod(periodParts[0], periodParts[1]);
    const accountCode = body?.accountCode == null ? null : String(body.accountCode).trim();
    const runId = body?.runId == null ? null : String(body.runId);
    const scope = { storeId: Number(process.env.OLSERA_INTERNAL_STORE_ID), period, accountCode, runId };
    const c = await collections();
    const actionId = `system-action:${scope.storeId}:${Date.now()}:${crypto.randomUUID()}`;
    const writeAudit = async (status: "success" | "failed" | "blocked", reason: string | null, after: Record<string, unknown> | null) => {
      await c.systemAuditActions.insertOne({ _id: actionId, storeId: scope.storeId, actorId: actor.id, action, scope, status, reason, before: null, after, createdAt: new Date() });
    };
    let result: Record<string, unknown>;
    if (action === "sync-period") {
      const outcome = await withOlseraSyncLock("financial", "manual", LEASE_MS, () => startFinancialSync(period.slice(0, 4), Number(period.slice(5))));
      if (outcome.locked) return NextResponse.json({ status: "blocked", message: "Sync financial lain sedang berjalan." }, { status: 409, headers: NO_CACHE_HEADERS });
      const run = outcome.result;
      result = { runId: run?._id ?? null, status: "running", phase: run?.phase ?? "monthly-reports", accounts: run?.accountCodes.length ?? 0 };
    } else if (action === "retry-failed") {
      if (!runId) return NextResponse.json({ status: "blocked", message: "runId wajib untuk retry akun gagal." }, { status: 400, headers: NO_CACHE_HEADERS });
      const outcome = await withOlseraSyncLock("financial", "manual", LEASE_MS, () => stepFinancialSync(runId));
      if (outcome.locked) return NextResponse.json({ status: "blocked", message: "Sync financial lain sedang berjalan." }, { status: 409, headers: NO_CACHE_HEADERS });
      const run = outcome.result;
      if (!run) return NextResponse.json({ status: "blocked", message: "Run financial tidak ditemukan." }, { status: 404, headers: NO_CACHE_HEADERS });
      result = { runId: run._id, status: run.status, phase: run.phase, failedAccountCodes: run.failedAccountCodes ?? [] };
    } else if (action === "reconcile") {
      await reconcileLedgerSummarySnapshot(period);
      result = { period, reconciled: true };
    } else if (action === "court-revenue-audit-run") {
      const { start, end } = periodToMonthRange(period);
      const runs = await runCourtRevenueReconciliationRange({ storeId: scope.storeId, startDate: start, endDate: end, dryRun: false, triggeredBy: `supervisor:${actor.id}`, runVersion: 1 });
      const totalFindings = runs.reduce((sum, r) => sum + r.findings.length, 0);
      const manualReviewCount = runs.reduce((sum, r) => sum + r.summary.requiresManualAdjustmentCount, 0);
      result = { period, daysAudited: runs.length, totalFindings, manualReviewCount };
    } else {
      if (!accountCode || !/^\d{1,20}$/.test(accountCode)) return NextResponse.json({ status: "blocked", message: "accountCode wajib untuk cleanup scoped." }, { status: 400, headers: NO_CACHE_HEADERS });
      const cleaned = await cleanupConfirmedStaleLedgerAccount(period, accountCode);
      if (!cleaned.confirmed) return NextResponse.json({ status: "blocked", message: "Akun belum memiliki konfirmasi kosong sukses yang sah." }, { status: 409, headers: NO_CACHE_HEADERS });
      result = { period, accountCode, deletedCount: cleaned.deletedCount, reconciled: true };
    }
    await writeAudit("success", null, result);
    return NextResponse.json({ status: "success", action, scope, result }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[supervisor:audit:action]", error instanceof Error ? error.message : "error");
    return NextResponse.json({ status: "failed", message: "Aksi supervisor gagal; tidak ada scope lain yang diproses." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
