import { NextResponse } from "next/server";
import { requireModule, requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { startFinancialSync } from "@/lib/olsera-financial-sync";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: Request) { try { await requireModule("olsera"); await requireSupervisor(); const body = await req.json(); const run = await startFinancialSync(body.year, body.month); return NextResponse.json({ status: "running", runId: run._id, period: run.period, phase: run.phase, accounts: run.accountCodes.length }, { headers: NO_CACHE_HEADERS }); } catch (error) { if (error instanceof Response) return error; return NextResponse.json({ status: "upstream-error", message: "Sync laporan keuangan gagal." }, { status: 200, headers: NO_CACHE_HEADERS }); } }
