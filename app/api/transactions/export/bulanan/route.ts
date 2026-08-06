import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { collections, withMongo, type BookingDocument, type FieldDocument } from "@/lib/mongodb";
import { resolveVenueName } from "@/lib/booking-mapper";
import { buildOmzetPeriodWorkbook, dateRange, periodLabelMonth, withCanonicalPaymentAmounts } from "@/lib/omzet-export";
import { readActiveStagedPaymentEvents } from "@/lib/ayo-payment-event-staging";
import { isPaymentEventsReadEnabled } from "@/lib/ayo-payment-events-engine";
import { dashboardPaymentAmountsByBooking } from "@/lib/dashboard-payment-metrics";

export const runtime = "nodejs";

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const MONTHS_FILE = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

function monthJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

export async function GET(request: Request) {
  try {
    await requireModule("transaksi");
    const { searchParams } = new URL(request.url);
    const month = searchParams.get("month") || monthJakarta();
    if (!MONTH_PATTERN.test(month)) {
      return NextResponse.json({ error: "month must use YYYY-MM format" }, { status: 400 });
    }
    const [year, mon] = month.split("-").map(Number);
    const lastDay = new Date(year, mon, 0).getDate();
    const start = `${month}-01`;
    const end = `${month}-${String(lastDay).padStart(2, "0")}`;

    const { periodBookings, sportByFieldId, venueName } = await withMongo(async () => {
      const { bookings, fields, ayoPaymentEventStagingRuns, ayoPaymentEventStagingEvents, ayoPaymentEventActivation } = await collections();
      const [rows, fieldRows] = await Promise.all([
        bookings
          .find({ date: { $regex: `^${month}` } })
          .sort({ date: 1, field_name: 1, start_time: 1 })
          .toArray(),
        fields.find({}).project<FieldDocument>({ id: 1, sport_name: 1 }).toArray(),
      ]);
      const map = new Map<number, string>();
      for (const f of fieldRows) if (f.id && f.sport_name) map.set(f.id, f.sport_name);
      // Use exactly the active, validated payment dataset and identity rule that
      // Dashboard uses for an explicit month range. If it is unavailable, keep
      // the existing booking fallback behavior.
      const staged = isPaymentEventsReadEnabled()
        ? await readActiveStagedPaymentEvents(start, end, {
          runs: ayoPaymentEventStagingRuns,
          events: ayoPaymentEventStagingEvents,
          activation: ayoPaymentEventActivation,
        })
        : null;
      return {
        periodBookings: staged
          ? withCanonicalPaymentAmounts(rows as BookingDocument[], dashboardPaymentAmountsByBooking(staged.events))
          : rows as BookingDocument[],
        sportByFieldId: map,
        venueName: resolveVenueName(),
      };
    });

    const buffer = await buildOmzetPeriodWorkbook({
      date: start,
      venueName,
      dayBookings: periodBookings,
      monthBookings: periodBookings,
      sportByFieldId,
      periodLabel: periodLabelMonth(month),
      dateList: dateRange(start, end),
    });

    const filename = `Omzet Bulanan ${MONTHS_FILE[mon - 1]} ${year}.xlsx`;
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
    return NextResponse.json({ error: "Unable to export omzet bulanan" }, { status: 500 });
  }
}
