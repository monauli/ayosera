import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { getInventorySummary, getInventorySyncStatus } from "@/lib/olsera-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireModule("olsera");
    const [summary, status] = await Promise.all([getInventorySummary(), getInventorySyncStatus()]);
    return NextResponse.json({ summary, status }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json(
      { error: "Gagal memuat ringkasan inventori." },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }
}
