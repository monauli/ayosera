import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { currentStoreId } from "@/lib/reconciliation-store";
import { loadLatestMappingSources, tagMappingSourcePeriod } from "@/lib/mapping-source-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  try {
    await requireModule("mapping");
    const body = await request.json();
    const url = typeof body.url === "string" ? body.url : "";
    const period = typeof body.period === "string" ? body.period : "";
    if (!url || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return NextResponse.json({ error: "Sumber PDF atau periode tidak valid." }, { status: 400 });
    await tagMappingSourcePeriod(currentStoreId(), url, period);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Gagal menyimpan periode PDF." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    await requireModule("mapping");
    const params = new URL(request.url).searchParams;
    const requestedPeriod = params.get("period");
    const requestedUrl = params.get("url");
    const source = (await loadLatestMappingSources(currentStoreId())).find((item) => item.kind === "pdf" && (requestedUrl ? item.url === requestedUrl : requestedPeriod ? item.period === requestedPeriod : true));
    if (!source) return NextResponse.json({ error: "PDF tersimpan tidak ditemukan." }, { status: 404 });
    const response = await fetch(source.url, { cache: "no-store" });
    if (!response.ok || !response.body) return NextResponse.json({ error: "PDF tersimpan tidak bisa diambil." }, { status: 502 });
    return new NextResponse(response.body, { headers: { "content-type": source.mimeType, "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Gagal mengambil PDF tersimpan." }, { status: 500 });
  }
}
