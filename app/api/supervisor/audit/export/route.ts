import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { getLatestSystemAudit } from "@/lib/system-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSupervisor();
    const audit = await getLatestSystemAudit();
    if (!audit) return NextResponse.json({ status: "unavailable", message: "Belum ada hasil audit." }, { status: 404 });
    return new Response(JSON.stringify(audit, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="system-audit-${audit.storeId}.json"`, "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ status: "failed", message: "Export audit gagal." }, { status: 500 });
  }
}
