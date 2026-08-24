import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { startFinancialSync } from "@/lib/olsera-financial-sync";
import { withOlseraSyncLock } from "@/lib/olsera-cron-lock";
import { validatePeriod } from "@/lib/olsera-financial-core";
import { currentStoreId } from "@/lib/olsera-store-id";
import { assertOmzetPeriodNotLocked, OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
const MANUAL_FINANCIAL_LEASE_MS = 5 * 60 * 1000;
export async function POST(req: Request) { try { await requireModule("olsera"); const body = await req.json(); const period = validatePeriod(String(body.year), String(body.month)); await assertOmzetPeriodNotLocked(currentStoreId(), period); const outcome = await withOlseraSyncLock("financial", "manual", MANUAL_FINANCIAL_LEASE_MS, () => startFinancialSync(body.year, body.month)); if (outcome.locked) return NextResponse.json({ status: "sync-in-progress", activeModule: outcome.activeModule, runId: outcome.runId }, { status: 409, headers: NO_CACHE_HEADERS }); const run = outcome.result; return NextResponse.json({ status: "running", runId: run._id, period: run.period, phase: run.phase, accounts: run.accountCodes.length }, { headers: NO_CACHE_HEADERS }); } catch (error) { if (error instanceof Response) return error; if (error instanceof OmzetPeriodLockError) return NextResponse.json({ error: error.message }, { status: 423, headers: NO_CACHE_HEADERS }); return NextResponse.json({ status: "upstream-error", message: "Sync laporan keuangan gagal." }, { status: 200, headers: NO_CACHE_HEADERS }); } }
