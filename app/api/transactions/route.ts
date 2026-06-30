import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { buildBookingFilter } from "@/lib/booking-query";
import { toTransactionRow } from "@/lib/booking-mapper";
import { collections, type BookingDocument, withMongo } from "@/lib/mongodb";
import { isDisplayEligibleTransaction, sumRevenue } from "@/lib/revenue";

export async function GET(request: Request) {
  try {
    await requireUser();
    const { searchParams } = new URL(request.url);

    const { data, summary } = await withMongo(async () => {
      const { bookings } = await collections();
      const filter = buildBookingFilter(searchParams);
      const [rows, allRevenueRows] = await Promise.all([
        bookings.find(filter).sort({ date: 1, start_time: 1 }).toArray(),
        bookings
          .find({})
          .project<Pick<BookingDocument, "status" | "raw" | "total_price" | "booker_name" | "note">>({
            status: 1,
            raw: 1,
            total_price: 1,
            booker_name: 1,
            note: 1,
          })
          .toArray(),
      ]);
      const displayRows = rows.filter(isDisplayEligibleTransaction);
      const allDisplayRows = allRevenueRows.filter(isDisplayEligibleTransaction);
      const filteredRevenue = sumRevenue(displayRows);

      return {
        data: displayRows.map(toTransactionRow),
        summary: {
          totalRevenue: sumRevenue(allDisplayRows),
          totalCount: allDisplayRows.length,
          filteredRevenue,
          filteredCount: displayRows.length,
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
