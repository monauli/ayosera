import { NextResponse } from "next/server";
import { logSyncFailure } from "@/lib/booking-sync";
import { syncProductionListBookings } from "@/lib/production-sync";

export const runtime = "nodejs";
// Vercel Pro mengizinkan hingga 300 detik; sync default (awal bulan -> hari ini) bisa lama.
export const maxDuration = 300;

/**
 * Endpoint cron untuk auto-sync transaksi AYO ke MongoDB.
 *
 * Dipanggil otomatis oleh Vercel Cron (lihat vercel.json). Vercel menyisipkan
 * header `Authorization: Bearer <CRON_SECRET>` bila env CRON_SECRET diset, jadi
 * endpoint ini tidak butuh sesi login admin.
 *
 * Tanpa query param, range default = awal bulan berjalan s/d hari ini (Asia/Jakarta).
 */
export async function GET(request: Request) {
  const startedAt = new Date();

  const expectedSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (expectedSecret) {
    if (authHeader !== `Bearer ${expectedSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // Jangan biarkan endpoint terbuka di production tanpa secret.
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  try {
    const result = await syncProductionListBookings({
      type: "scheduled",
      startedAt,
      mirrorToMongo: true,
      logProgress: true,
      saveSamples: false,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    await logSyncFailure({ type: "scheduled", startedAt, error });
    console.error("[cron:sync] failed", error);
    return NextResponse.json({ ok: false, error: "Scheduled sync failed" }, { status: 500 });
  }
}
