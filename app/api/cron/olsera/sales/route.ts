import { NextResponse } from "next/server";
import { runOlseraSalesCron } from "@/lib/cron-olsera-sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Endpoint cron server-side untuk auto-sync Kategori/Penjualan Olsera,
 * dijadwalkan lewat cron-job.org. Terpisah dari endpoint cron lama
 * (app/api/cron/olsera-sync) — endpoint lama TIDAK diubah. Endpoint ini
 * menambahkan distributed lock (Tahap 7) supaya tidak berjalan bersamaan
 * dengan cron Inventori/Keuangan maupun tombol sync manual.
 */
export async function POST(request: Request) {
  const { status, body } = await runOlseraSalesCron(request.headers.get("authorization"));
  return NextResponse.json(body, { status });
}
