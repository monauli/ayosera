import { NextResponse } from "next/server";
import { requireModule, requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { stepFinancialSync } from "@/lib/olsera-financial-sync";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: Request) { try { await requireModule("olsera"); await requireSupervisor(); const body = await req.json(); const run = await stepFinancialSync(String(body.runId)); return NextResponse.json({ status: run?.status ?? "failed", runId: run?._id ?? body.runId, phase: run?.phase ?? "completed", accountsProcessed: run?.accountsProcessed ?? 0, recordsProcessed: run?.recordsProcessed ?? 0 }, { headers: NO_CACHE_HEADERS }); } catch (error) { if (error instanceof Response) return error; return NextResponse.json({ status: "upstream-error", message: "Step sync laporan keuangan gagal." }, { status: 200, headers: NO_CACHE_HEADERS }); } }
