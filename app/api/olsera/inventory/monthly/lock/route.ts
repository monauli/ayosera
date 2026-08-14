import { NextResponse } from "next/server";
import { requireModule, requireSupervisor } from "@/lib/auth";
import { currentStoreId } from "@/lib/olsera-store-id";
import { InventoryMonthlyPeriodLockError, lockInventoryMonthlyPeriod, unlockInventoryMonthlyPeriod } from "@/lib/inventory-monthly-period-lock";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireModule("olsera");
    const user = await requireSupervisor();
    const body = await request.json() as Record<string, unknown>;
    const year = Number(body.year); const month = Number(body.month);
    const result = body.action === "unlock"
      ? await unlockInventoryMonthlyPeriod({ storeId: currentStoreId(), year, month, actor: user.email, reason: String(body.reason ?? "") })
      : await lockInventoryMonthlyPeriod({ storeId: currentStoreId(), year, month, actor: user.email, reason: typeof body.reason === "string" ? body.reason : undefined });
    return NextResponse.json({ data: result }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof InventoryMonthlyPeriodLockError) return NextResponse.json({ error: error.message }, { status: 400, headers: NO_CACHE_HEADERS });
    console.error("[inventory:monthly-lock]", error);
    return NextResponse.json({ error: "Gagal memproses lock periode inventori." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
