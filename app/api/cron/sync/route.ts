import { NextResponse } from "next/server";
import { logSyncFailure } from "@/lib/booking-sync";
import { syncProductionListBookings } from "@/lib/production-sync";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";

export const runtime = "nodejs";
// Vercel Hobby membatasi durasi function hingga 60 detik, jadi cron menarik
// rentang kecil (kemarin -> hari ini) agar tidak timeout.
export const maxDuration = 60;

function formatJakartaDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Endpoint cron untuk auto-sync transaksi AYO ke database.
 *
 * Dipanggil otomatis oleh Vercel Cron 1x sehari (lihat vercel.json, jadwal
 * `0 17 * * *` = 00:00 WIB). Vercel menyisipkan header
 * `Authorization: Bearer <CRON_SECRET>` bila env CRON_SECRET diset, jadi
 * endpoint ini tidak butuh sesi login admin.
 *
 * Karena cron jalan tepat saat hari baru dimulai (WIB), range yang ditarik =
 * kemarin s/d hari ini supaya transaksi hari yang baru selesai ikut tersinkron.
 * Sync manual dari dashboard tetap memakai /api/sync dan tidak terpengaruh.
 */
export async function GET(request: Request) {
  const startedAt = new Date();

  const auth = verifyCronSecret(request.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ success: false, mode: "cron", message: auth.message }, { status: auth.status });
  }

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const start_date = formatJakartaDate(yesterday);
  const end_date = formatJakartaDate(now);

  try {
    const result = await syncProductionListBookings({
      start_date,
      end_date,
      type: "scheduled",
      startedAt,
      logProgress: true,
    });

    return NextResponse.json({
      success: true,
      mode: "cron",
      message: result.message || "Cron sync completed",
      range: { start_date, end_date },
      inserted: result.inserted,
      updated: result.updated,
      total: result.total_received,
      details: result,
    });
  } catch (error) {
    await logSyncFailure({ type: "scheduled", startedAt, error });
    console.error("[cron:sync] failed", error);
    return NextResponse.json(
      { success: false, mode: "cron", message: "Scheduled sync failed" },
      { status: 500 },
    );
  }
}
