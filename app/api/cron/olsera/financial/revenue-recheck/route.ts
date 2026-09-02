import { NextResponse } from "next/server";
import { runOlseraRevenueRecheckCron } from "@/lib/cron-olsera-revenue-recheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Endpoint cron server-side terpisah untuk "revenue re-check mingguan" —
 * lihat lib/cron-olsera-revenue-recheck.ts untuk latar belakang lengkap.
 * Dijadwalkan lewat cron-job.org TERPISAH dari cron Financial utama
 * (app/api/cron/olsera/financial/route.ts), disarankan TIAP JAM (mis. menit
 * :15) — kadensi invocation, BUKAN kadensi ronde (ronde sendiri mingguan,
 * lihat REVENUE_RECHECK_ROUND_INTERVAL_MS). Tidak menerima body/parameter.
 */
export async function POST(request: Request) {
  const { status, body } = await runOlseraRevenueRecheckCron(request.headers.get("authorization"));
  return NextResponse.json(body, { status });
}
