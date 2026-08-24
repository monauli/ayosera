import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAnyModule } from "@/lib/auth";
import { logSyncFailure } from "@/lib/booking-sync";
import { syncProductionListBookings } from "@/lib/production-sync";
import { maybeSyncAyoPaymentEvents } from "@/lib/ayo-payment-events-auto-sync";
import { currentStoreId } from "@/lib/olsera-store-id";
import { assertOmzetRangeNotLocked, OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock";

export const runtime = "nodejs";

const syncSchema = z.object({
  booking_id: z.string().optional(),
  field_name: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  booking_source: z.enum(["order", "orders", "reservation"]).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(["SUCCESS", "FINISHED", "PENDING", "CANCELLED"]).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

function formatJakartaDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function monthStartJakarta() {
  const today = formatJakartaDate(new Date());
  return `${today.slice(0, 7)}-01`;
}

export async function POST(request: Request) {
  const startedAt = new Date();
  try {
    // Sync AYO boleh dipakai semua user yang punya modul dasbor/transaksi (tidak lagi wajib supervisor).
    await requireAnyModule("dasbor", "transaksi");

    const body = syncSchema.parse(await request.json().catch(() => ({})));
    const shouldUseDefaultRange = !body.date && !body.start_date && !body.end_date && !body.booking_id;
    const filters = {
      ...(shouldUseDefaultRange
        ? {
            start_date: monthStartJakarta(),
            end_date: formatJakartaDate(new Date()),
          }
        : {}),
      ...body,
    };

    if (filters.start_date && filters.end_date && filters.start_date > filters.end_date) {
      return NextResponse.json({ error: "start_date must be before or equal to end_date" }, { status: 400 });
    }

    // Tolak tulis ke periode omzet yang sudah dikunci — rentang eksplisit
    // (start_date/end_date) diprioritaskan, fallback ke `date` tunggal bila
    // itu satu-satunya sinyal tanggal yang dikirim. Query tanpa tanggal sama
    // sekali (mis. booking_id saja) tidak bisa dipetakan ke periode, jadi
    // tidak dicek di sini.
    if (filters.start_date && filters.end_date) {
      await assertOmzetRangeNotLocked(currentStoreId(), filters.start_date, filters.end_date);
    } else if (filters.date) {
      await assertOmzetRangeNotLocked(currentStoreId(), filters.date, filters.date);
    }

    const result = await syncProductionListBookings({
      ...filters,
      type: "manual",
      startedAt,
      logProgress: true,
    });

    const paymentEvents = await maybeSyncAyoPaymentEvents().catch((error) => ({ skipped: false, reason: "failed", error: error instanceof Error ? error.message.replace(/AYO_MOBILE_TOKEN\s*[=:]\s*[^\s&]+/gi, "AYO_MOBILE_TOKEN=[redacted]") : "failed" }));
    return NextResponse.json({ ...result, paymentEvents });
  } catch (error) {
    await logSyncFailure({ type: "manual", startedAt, error });

    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid sync filter payload" }, { status: 400 });
    }
    if (error instanceof OmzetPeriodLockError) {
      return NextResponse.json({ error: error.message }, { status: 423 });
    }
    console.error(error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
