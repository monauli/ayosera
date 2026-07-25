import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { getInventorySyncStatus, startInventorySync, stepInventorySync } from "@/lib/olsera-inventory";
import { withOlseraSyncLock } from "@/lib/olsera-cron-lock";

const MANUAL_INVENTORY_LEASE_MS = 6 * 60 * 1000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Satu step = katalog produk penuh ATAU satu tanggal mutasi — jauh di bawah batas.
export const maxDuration = 300;

const bodySchema = z.object({ action: z.enum(["start", "step"]) });

export async function GET() {
  try {
    await requireModule("olsera");
    const status = await getInventorySyncStatus();
    return NextResponse.json(status, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json(
      { error: "Gagal memuat status sync inventori Olsera." },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }
}

export async function POST(request: Request) {
  try {
    await requireModule("olsera");
    const body = bodySchema.parse(await request.json().catch(() => ({})));

    if (body.action === "start") {
      const outcome = await withOlseraSyncLock("inventory", "manual", MANUAL_INVENTORY_LEASE_MS, () => startInventorySync());
      if (outcome.locked) {
        return NextResponse.json(
          { status: "sync-in-progress", activeModule: outcome.activeModule, runId: outcome.runId },
          { status: 409, headers: NO_CACHE_HEADERS },
        );
      }
      return NextResponse.json({ run: outcome.result }, { headers: NO_CACHE_HEADERS });
    }

    const outcome = await withOlseraSyncLock("inventory", "manual", MANUAL_INVENTORY_LEASE_MS, () => stepInventorySync());
    if (outcome.locked) {
      return NextResponse.json(
        { status: "sync-in-progress", activeModule: outcome.activeModule, runId: outcome.runId },
        { status: 409, headers: NO_CACHE_HEADERS },
      );
    }
    const result = outcome.result;
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 409, headers: NO_CACHE_HEADERS });
    }
    return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Payload sync inventori tidak valid" }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Sync inventori Olsera gagal" }, { status: 500 });
  }
}
