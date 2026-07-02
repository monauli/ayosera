import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { appendAnd, buildBookingFilter } from "@/lib/booking-query";
import { toTransactionRow } from "@/lib/booking-mapper";
import { collections, withMongo } from "@/lib/mongodb";
import { isDisplayEligibleTransaction } from "@/lib/revenue";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

// Data transaksi selalu realtime: nonaktifkan cache Next.js/Vercel.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_LIMIT = 500;

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSort(key: string | null, dir: string | null): Record<string, 1 | -1> {
  const direction: 1 | -1 = dir === "desc" ? -1 : 1;
  switch (key) {
    case "id":
      return { booking_id: direction };
    case "customer":
      return { booker_name: direction };
    case "service":
      return { field_name: direction };
    case "amount":
      return { total_price: direction };
    case "status":
      return { status: direction };
    case "date":
    default:
      return { date: direction, start_time: direction };
  }
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    await requireUser();
    const searchParams = new URL(request.url).searchParams;

    const page = Math.max(1, Math.floor(Number(searchParams.get("page")) || 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(searchParams.get("limit")) || 50)));

    // Filter lapangan dikirim sebagai "court"; petakan ke param "branch" milik buildBookingFilter.
    const court = searchParams.get("court");
    if (court) searchParams.set("branch", court);

    const filter = buildBookingFilter(searchParams);

    const bookingId = searchParams.get("bookingId")?.trim();
    if (bookingId) {
      appendAnd(filter, { booking_id: { $regex: escapeRegex(bookingId), $options: "i" } });
    }

    const search = searchParams.get("search")?.trim();
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      appendAnd(filter, { $or: [{ booker_name: rx }, { booker_phone: rx }, { booking_id: rx }] });
    }

    const sortSpec = buildSort(searchParams.get("sort"), searchParams.get("dir"));

    const result = await withMongo(async () => {
      const { bookings } = await collections();
      // Query sudah dibatasi rentang tanggal + filter, jadi set ini terbatas.
      const matched = await bookings.find(filter).sort(sortSpec).toArray();
      // Eligibility tampil (Rp0 / Internal Use) memakai rule yang sama seperti dashboard.
      const displayRows = matched.filter(isDisplayEligibleTransaction);
      const total = displayRows.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const safePage = Math.min(page, totalPages);
      const pageRows = displayRows.slice((safePage - 1) * limit, safePage * limit);

      return {
        matchedCount: matched.length,
        data: pageRows.map(toTransactionRow),
        page: safePage,
        limit,
        total,
        totalPages,
      };
    });

    console.log(
      `[transactions-api] ${Date.now() - startedAt}ms, matched ${result.matchedCount}, page ${result.page}/${result.totalPages}, returned ${result.data.length}`,
    );

    return NextResponse.json(
      { data: result.data, page: result.page, limit: result.limit, total: result.total, totalPages: result.totalPages },
      { headers: NO_CACHE_HEADERS },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Unable to load transactions" }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
