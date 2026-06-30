import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { collections, withMongo, type BookingDocument, type FieldDocument } from "@/lib/mongodb";
import { buildOmzetPeriodWorkbook, dateRange, periodLabelRange } from "@/lib/omzet-export";

export const runtime = "nodejs";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    await requireUser();
    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start") || "";
    const end = searchParams.get("end") || start;
    if (!DATE_PATTERN.test(start) || !DATE_PATTERN.test(end)) {
      return NextResponse.json({ error: "start & end must use YYYY-MM-DD format" }, { status: 400 });
    }
    if (start > end) {
      return NextResponse.json({ error: "start must be on or before end" }, { status: 400 });
    }

    const { periodBookings, sportByFieldId, venueName } = await withMongo(async () => {
      const { bookings, fields } = await collections();
      const [rows, fieldRows] = await Promise.all([
        bookings
          .find({ date: { $gte: start, $lte: end } })
          .sort({ date: 1, field_name: 1, start_time: 1 })
          .toArray(),
        fields.find({}).project<FieldDocument>({ id: 1, sport_name: 1 }).toArray(),
      ]);
      const map = new Map<number, string>();
      for (const f of fieldRows) if (f.id && f.sport_name) map.set(f.id, f.sport_name);
      const venue = rows[0]?.branch_name || process.env.AYO_BRANCH_NAME || "AYO";
      return {
        periodBookings: rows as BookingDocument[],
        sportByFieldId: map,
        venueName: venue,
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
