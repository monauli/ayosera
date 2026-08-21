import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { collections, withMongo, type BookingDocument, type FieldDocument } from "@/lib/mongodb";
import { resolveVenueName } from "@/lib/booking-mapper";
import { buildOmzetPeriodWorkbook, dateRange, periodLabelRange } from "@/lib/omzet-export";
import { validateDateRangeQuery } from "@/lib/date-range-validation";
import { readActiveStagedPaymentEvents } from "@/lib/ayo-payment-event-staging";
import { isPaymentEventsReadEnabled } from "@/lib/ayo-payment-events-engine";
import { dashboardPaymentTypeByBooking } from "@/lib/dashboard-payment-metrics";
import { aggregateBookingPayments, withBookingPaymentTotals } from "@/lib/booking-payment-aggregate";

export const runtime = "nodejs";

const MAX_RANGE_DAYS = 366;

function todayJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function GET(request: Request) {
  try {
    await requireModule("transaksi");
    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start") || "";
    const end = searchParams.get("end") || start;
    const validation = validateDateRangeQuery(start, end, MAX_RANGE_DAYS);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { periodBookings, sportByFieldId, venueName, paymentTypeByBooking } = await withMongo(async () => {
      const { bookings, fields, ayoPaymentEventStagingRuns, ayoPaymentEventStagingEvents, ayoPaymentEventActivation } = await collections();
      const [rows, fieldRows] = await Promise.all([
        bookings
          .find({ date: { $gte: start, $lte: end } })
          .sort({ date: 1, field_name: 1, start_time: 1 })
          .toArray(),
        fields.find({}).project<FieldDocument>({ id: 1, sport_name: 1 }).toArray(),
      ]);
      const map = new Map<number, string>();
      for (const f of fieldRows) if (f.id && f.sport_name) map.set(f.id, f.sport_name);
      // readActiveStagedPaymentEvents() menolak endDate > hari ini. Rentang custom
      // bisa berakhir di tanggal masa depan (tidak divalidasi oleh
      // validateDateRangeQuery) — pakai hari ini sebagai batas atas KHUSUS untuk
      // query ini; `end`/workbook tetap rentang asli seperti biasa.
      const paymentEventsEnd = end < todayJakarta() ? end : todayJakarta();
      const staged = isPaymentEventsReadEnabled() && start <= paymentEventsEnd
        ? await readActiveStagedPaymentEvents(start, paymentEventsEnd, { runs: ayoPaymentEventStagingRuns, events: ayoPaymentEventStagingEvents, activation: ayoPaymentEventActivation })
        : null;
      return {
        periodBookings: staged ? withBookingPaymentTotals(rows as BookingDocument[], aggregateBookingPayments(staged.events)) : rows as BookingDocument[],
        sportByFieldId: map,
        venueName: resolveVenueName(),
        paymentTypeByBooking: staged ? dashboardPaymentTypeByBooking(staged.events) : undefined,
      };
    });

    const buffer = await buildOmzetPeriodWorkbook({
      date: start,
      venueName,
      dayBookings: periodBookings,
      monthBookings: periodBookings,
      sportByFieldId,
      periodLabel: periodLabelRange(start, end),
      dateList: dateRange(start, end),
      paymentTypeByBooking,
    });

    const filename = start === end ? `Omzet ${start}.xlsx` : `Omzet ${start} sd ${end}.xlsx`;
    // cast: TS 5.7 menganggap Uint8Array<ArrayBufferLike> tak cocok BodyInit (false positive)
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Unable to export omzet range" }, { status: 500 });
  }
}
