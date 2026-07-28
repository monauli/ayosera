import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { getFinancialSyncStatus } from "@/lib/olsera-financial-sync";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(req: Request) { try { await requireModule("olsera"); const runId = new URL(req.url).searchParams.get("runId") ?? ""; const status = await getFinancialSyncStatus(runId); if (!status) return NextResponse.json({ status: "failed", message: "Sync run tidak ditemukan." }, { headers: NO_CACHE_HEADERS }); return NextResponse.json(status, { headers: NO_CACHE_HEADERS }); } catch (error) { if (error instanceof Response) return error; return NextResponse.json({ status: "failed", message: "Status sync tidak tersedia." }, { headers: NO_CACHE_HEADERS }); } }
