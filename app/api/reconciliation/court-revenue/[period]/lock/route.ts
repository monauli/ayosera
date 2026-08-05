import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Legacy lock endpoint deliberately retired. The audited finalization route
 * requires an attachment, preview, reason, and optimistic version guard.
 */
export async function POST() {
  try {
    await requireSupervisor();
    return NextResponse.json({ error: "Endpoint lock lama dinonaktifkan. Gunakan finalisasi periode dengan berita acara." }, { status: 410, headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue:legacy-lock]", error);
    return NextResponse.json({ error: "Gagal memproses permintaan lock." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
