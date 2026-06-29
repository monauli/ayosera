import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { buildBookingFilter } from "@/lib/booking-query";
import { toTransactionRow } from "@/lib/booking-mapper";
import { collections, withMongo } from "@/lib/mongodb";

export async function GET(request: Request) {
  try {
    await requireUser();
    const { searchParams } = new URL(request.url);

    const { data, summary } = await withMongo(async () => {
      const { bookings } = await collections();
      const filter = buildBookingFilter(searchParams);
      const rows = await bookings.find(filter).sort({ date: 1, start_time: 1 }).toArray();
      const filteredRevenue = rows.reduce((sum, booking) => sum + (booking.total_price || 0), 0);

      const totalAgg = await bookings
        .aggregate<{ total: number; count: number }>([
          { $group: { _id: null, total: { $sum: "$total_price" }, count: { $sum: 1 } } },
        ])
        .toArray();

      return {
        data: rows.map(toTransactionRow),
        summary: {
          totalRevenue: totalAgg[0]?.total ?? 0,
          totalCount: totalAgg[0]?.count ?? 0,
          filteredRevenue,
          filteredCount: rows.length,
        },
      };
    });

    return NextResponse.json({ data, summary });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Unable to load transactions" }, { status: 500 });
  }
}
