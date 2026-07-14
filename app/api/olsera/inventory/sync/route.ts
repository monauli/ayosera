import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { getInventorySyncStatus, startInventorySync, stepInventorySync } from "@/lib/olsera-inventory";

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
      const run = await startInventorySync();
      return NextResponse.json({ run }, { headers: NO_CACHE_HEADERS });
    }

    const result = await stepInventorySync();
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
