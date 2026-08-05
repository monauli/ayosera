import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";
import { integrationTokenHealth } from "@/lib/private-integration-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Weekly, read-only integrity checkpoint. Repair remains manual and identity-gated. */
export async function POST(request: Request) {
  const auth = verifyCronSecret(request.headers.get("authorization"));
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
  return NextResponse.json({ status: "MANUAL_REVIEW_REQUIRED", checkedAt: new Date().toISOString(), rangeDays: 30, sources: ["olsera", "ayo-booking", "ayo-payment-events"], tokenHealth: integrationTokenHealth().map(({ source, status }) => ({ source, status })), repaired: 0, message: "Audit mingguan read-only; auto-repair hanya dapat diaktifkan setelah identity source diverifikasi." });
}
