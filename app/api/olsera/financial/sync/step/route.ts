import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { stepFinancialSync } from "@/lib/olsera-financial-sync";
import { withOlseraSyncLock } from "@/lib/olsera-cron-lock";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
const MANUAL_FINANCIAL_LEASE_MS = 5 * 60 * 1000;
export async function POST(req: Request) { try { await requireModule("olsera"); const body = await req.json(); const outcome = await withOlseraSyncLock("financial", "manual", MANUAL_FINANCIAL_LEASE_MS, () => stepFinancialSync(String(body.runId))); if (outcome.locked) return NextResponse.json({ status: "sync-in-progress", activeModule: outcome.activeModule, runId: outcome.runId }, { status: 409, headers: NO_CACHE_HEADERS }); const run = outcome.result; return NextResponse.json({ status: run?.status ?? "failed", runId: run?._id ?? body.runId, phase: run?.phase ?? "completed", accountsProcessed: run?.accountsProcessed ?? 0, recordsProcessed: run?.recordsProcessed ?? 0 }, { headers: NO_CACHE_HEADERS }); } catch (error) { if (error instanceof Response) return error; return NextResponse.json({ status: "upstream-error", message: "Step sync laporan keuangan gagal." }, { status: 200, headers: NO_CACHE_HEADERS }); } }
