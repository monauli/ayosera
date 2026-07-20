import { NextResponse } from "next/server";
import { runOlseraCronSync } from "@/lib/cron-olsera-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sync Olsera menarik detail tiap order (retry 429 termasuk) — pakai durasi
// yang sama dengan endpoint manual (app/api/olsera/sync/route.ts).
export const maxDuration = 300;

/**
 * Endpoint cron untuk auto-sync penjualan Olsera ke database.
 *
 * Tidak menjalankan sync inventori — hanya syncOlseraSalesByCategory yang
 * sudah ada di lib/olsera-sync.ts, dipanggil untuk tanggal hari ini (force)
 * agar transaksi baru di hari yang sama selalu ikut tertarik. Endpoint
 * manual (/api/olsera/sync) tidak diubah.
 */
export async function GET(request: Request) {
  const { status, body } = await runOlseraCronSync(request.headers.get("authorization"));
  return NextResponse.json(body, { status });
}
