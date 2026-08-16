import { NextResponse } from "next/server";
import { runOlseraFinancialCron } from "@/lib/cron-olsera-financial";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Cron historical Financial terpisah. Satu invocation memilih satu backlog
 * historis melalui checkpoint existing dan otomatis no-op setelah backlog habis.
 */
export async function POST(request: Request) {
  const { status, body } = await runOlseraFinancialCron(request.headers.get("authorization"), { scope: "historical" });
  return NextResponse.json(body, { status });
}
