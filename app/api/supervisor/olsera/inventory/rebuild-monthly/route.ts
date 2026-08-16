import { NextResponse } from "next/server";
import { requireModule, requireSupervisor } from "@/lib/auth";
import { rebuildMonthlyInventory } from "@/lib/rebuild-monthly-inventory";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireModule("olsera");
    await requireSupervisor();
    const body = await request.json() as Record<string, unknown>;
    const year = Number(body.year); const month = Number(body.month);
    const mode = body.mode === "write" ? "write" : body.mode === "dryRun" ? "dryRun" : null;
    if (!mode || !Number.isInteger(year) || !Number.isInteger(month)) return NextResponse.json({ error: "year, month, dan mode wajib valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    const result = await rebuildMonthlyInventory({ year, month, mode });
    return NextResponse.json({ data: result }, { status: result.ok ? 200 : 422, headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[inventory:rebuild-monthly]", error);
    return NextResponse.json({ error: "Gagal membangun ulang inventori bulanan." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
