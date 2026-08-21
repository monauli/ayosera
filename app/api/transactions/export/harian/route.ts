import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { collections, withMongo, type BookingDocument, type FieldDocument } from "@/lib/mongodb";
import { resolveVenueName } from "@/lib/booking-mapper";
import { buildOmzetHarianWorkbook } from "@/lib/omzet-export";
import { readActiveStagedPaymentEvents } from "@/lib/ayo-payment-event-staging";
import { isPaymentEventsReadEnabled } from "@/lib/ayo-payment-events-engine";
import { dashboardPaymentTypeByBooking } from "@/lib/dashboard-payment-metrics";
import { aggregateBookingPayments, withBookingPaymentTotals } from "@/lib/booking-payment-aggregate";

export const runtime = "nodejs";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
    const date = searchParams.get("date") || todayJakarta();
    if (!DATE_PATTERN.test(date)) {
      return NextResponse.json({ error: "date must use YYYY-MM-DD format" }, { status: 400 });
    }
    const monthPrefix = date.slice(0, 7);
    const monthStart = `${monthPrefix}-01`;
    const monthEnd = `${monthPrefix}-${String(new Date(Number(monthPrefix.slice(0, 4)), Number(monthPrefix.slice(5, 7)), 0).getDate()).padStart(2, "0")}`;

    const { dayBookings, monthBookings, sportByFieldId, venueName, paymentTypeByBooking } = await withMongo(async () => {
      const { bookings, fields, ayoPaymentEventStagingRuns, ayoPaymentEventStagingEvents, ayoPaymentEventActivation } = await collections();
      const [day, month, fieldRows] = await Promise.all([
        bookings.find({ date }).sort({ field_name: 1, start_time: 1 }).toArray(),
        bookings.find({ date: { $regex: `^${monthPrefix}` } }).toArray(),
        fields.find({}).project<FieldDocument>({ id: 1, sport_name: 1 }).toArray(),
      ]);
      const map = new Map<number, string>();
      for (const f of fieldRows) if (f.id && f.sport_name) map.set(f.id, f.sport_name);
      // Sama seperti Transaksi AYO (app/api/transactions/route.ts): pakai
      // aggregateBookingPayments()/withBookingPaymentTotals() dari
      // lib/booking-payment-aggregate.ts, bukan resolver terpisah — booking
      // split-payment (mis. MN/2428/260809/0002994, 2 pembayaran) tidak lagi
      // bisa dapat total yang divergen antara Transaksi AYO dan Export.
      const staged = isPaymentEventsReadEnabled()
        ? await readActiveStagedPaymentEvents(monthStart, monthEnd, {
          runs: ayoPaymentEventStagingRuns,
          events: ayoPaymentEventStagingEvents,
          activation: ayoPaymentEventActivation,
        })
        : null;
      // TEMPORARY DEBUG (remove before merging to main) — tracing 0002994 under-report.
      console.log("[debug-0002994] isPaymentEventsReadEnabled=", isPaymentEventsReadEnabled(), "monthStart=", monthStart, "monthEnd=", monthEnd);
      console.log("[debug-0002994] staged=", staged ? "present" : "null", "staged.events.length=", staged?.events.length, "staged.run._id=", staged?.run._id, "staged.run.status=", staged?.run.status);
      if (staged) {
        const matching = staged.events.filter((e) => e.bookingId?.includes("0002994"));
        console.log("[debug-0002994] matching events (bookingId contains 0002994):", JSON.stringify(matching, null, 2));
      }
      const paymentAggregate = staged ? aggregateBookingPayments(staged.events) : null;
      if (paymentAggregate) {
        const entry = paymentAggregate.get("MN/2428/260809/0002994");
        console.log("[debug-0002994] paymentAggregate.get('MN/2428/260809/0002994')=", entry ? { totalAmount: entry.totalAmount, paymentCount: entry.paymentCount } : "NOT FOUND (undefined)");
      }
      return {
        dayBookings: (paymentAggregate ? withBookingPaymentTotals(day as BookingDocument[], paymentAggregate) : day) as BookingDocument[],
        monthBookings: (paymentAggregate ? withBookingPaymentTotals(month as BookingDocument[], paymentAggregate) : month) as BookingDocument[],
        sportByFieldId: map,
        venueName: resolveVenueName(),
        paymentTypeByBooking: staged ? dashboardPaymentTypeByBooking(staged.events) : undefined,
      };
    });

    const buffer = await buildOmzetHarianWorkbook({
      date,
      venueName,
      dayBookings,
      monthBookings,
      sportByFieldId,
      paymentTypeByBooking,
    });

    const filename = `Omzet Harian ${date}.xlsx`;
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
    return NextResponse.json({ error: "Unable to export omzet harian" }, { status: 500 });
  }
}
