import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { getInventoryConsistency } from "@/lib/olsera-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireModule("olsera");
    const result = await getInventoryConsistency();
    return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json(
      { error: "Gagal memuat konsistensi inventori." },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }
}
