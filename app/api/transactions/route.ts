import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { buildBookingFilter } from "@/lib/booking-query";
import { toTransactionRow } from "@/lib/booking-mapper";
import { collections, withMongo } from "@/lib/mongodb";

export async function GET(request: Request) {
  try {
    await requireUser();
    const { searchParams } = new URL(request.url);

    const data = await withMongo(async () => {
      const { bookings } = await collections();
      const filter = buildBookingFilter(searchParams);
      const rows = await bookings.find(filter).sort({ date: -1, start_time: -1 }).limit(100).toArray();
      return rows.map(toTransactionRow);
    });

    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Unable to load transactions" }, { status: 500 });
  }
}
