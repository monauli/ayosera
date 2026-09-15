import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { currentStoreId } from "@/lib/reconciliation-store";
import { loadLatestMappingSources } from "@/lib/mapping-source-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireModule("mapping");
    const source = (await loadLatestMappingSources(currentStoreId())).find((item) => item.kind === "pdf");
    if (!source) return NextResponse.json({ error: "PDF tersimpan tidak ditemukan." }, { status: 404 });
    const response = await fetch(source.url, { cache: "no-store" });
    if (!response.ok || !response.body) return NextResponse.json({ error: "PDF tersimpan tidak bisa diambil." }, { status: 502 });
    return new NextResponse(response.body, { headers: { "content-type": source.mimeType, "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Gagal mengambil PDF tersimpan." }, { status: 500 });
  }
}
