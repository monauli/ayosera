import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { collections, withMongo, type BookingDocument, type FieldDocument } from "@/lib/mongodb";
import { buildOmzetHarianWorkbook } from "@/lib/omzet-export";

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
    await requireUser();
    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date") || todayJakarta();
    if (!DATE_PATTERN.test(date)) {
      return NextResponse.json({ error: "date must use YYYY-MM-DD format" }, { status: 400 });
    }
    const monthPrefix = date.slice(0, 7);

    const { dayBookings, monthBookings, sportByFieldId, venueName } = await withMongo(async () => {
      const { bookings, fields } = await collections();
      const [day, month, fieldRows] = await Promise.all([
        bookings.find({ date }).sort({ field_name: 1, start_time: 1 }).toArray(),
        bookings.find({ date: { $regex: `^${monthPrefix}` } }).toArray(),
        fields.find({}).project<FieldDocument>({ id: 1, sport_name: 1 }).toArray(),
      ]);
      const map = new Map<number, string>();
      for (const f of fieldRows) if (f.id && f.sport_name) map.set(f.id, f.sport_name);
      const venue =
        day[0]?.branch_name ||
        month[0]?.branch_name ||
        process.env.AYO_BRANCH_NAME ||
        "AYO";
      return {
        dayBookings: day as BookingDocument[],
        monthBookings: month as BookingDocument[],
        sportByFieldId: map,
        venueName: venue,
      };
    });

    const buffer = await buildOmzetHarianWorkbook({
      date,
      venueName,
      dayBookings,
      monthBookings,
      sportByFieldId,
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
