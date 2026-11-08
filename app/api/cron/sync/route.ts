import { NextResponse } from "next/server";
import { logSyncFailure } from "@/lib/booking-sync";
import { syncProductionListBookings } from "@/lib/production-sync";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";
import { maybeSyncAyoPaymentEvents } from "@/lib/ayo-payment-events-auto-sync";
import { ayoBacklogDates } from "@/lib/ayo-backlog-sync";
import { collections, withMongo } from "@/lib/mongodb";
import { currentStoreId } from "@/lib/olsera-store-id";
import { getOmzetPeriodLock } from "@/lib/reconciliation-omzet-period-lock";

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
 * Re-pull one rotating slice of older dates (lib/ayo-backlog-sync.ts) so late
 * payments and price revisions on past bookings are picked up. The rotation
 * index is the number of scheduled runs so far; locked omzet periods are skipped.
 */
async function syncAyoBacklog(today: string) {
  const runIndex = await withMongo(async () => (await collections()).syncLogs.countDocuments({ type: "scheduled" }));
  const lockedPeriods = new Set<string>();
  for (const date of ayoBacklogDates(today, runIndex)) {
    const period = date.slice(0, 7);
    if ((await getOmzetPeriodLock(currentStoreId(), period))?.status === "locked") lockedPeriods.add(period);
  }
  const dates = ayoBacklogDates(today, runIndex).filter((date) => !lockedPeriods.has(date.slice(0, 7)));
  if (!dates.length) return { skipped: true, lockedPeriods: [...lockedPeriods] };
  const result = await syncProductionListBookings({ start_date: dates[0], end_date: dates.at(-1), type: "backfill" });
  return { range: { start_date: dates[0], end_date: dates.at(-1) }, inserted: result.inserted, updated: result.updated, error: result.error };
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
    const backlog = await syncAyoBacklog(end_date).catch((error) => ({ error: error instanceof Error ? error.message : "failed" }));
    const paymentEvents = await maybeSyncAyoPaymentEvents().catch((error) => ({ skipped: false, reason: "failed", error: error instanceof Error ? error.message.replace(/AYO_MOBILE_TOKEN\s*[=:]\s*[^\s&]+/gi, "AYO_MOBILE_TOKEN=[redacted]") : "failed" }));

    return NextResponse.json({
      success: true,
      mode: "cron",
      message: result.message || "Cron sync completed",
      range: { start_date, end_date },
      inserted: result.inserted,
      updated: result.updated,
      total: result.total_received,
      details: result,
      backlog,
      paymentEvents,
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
