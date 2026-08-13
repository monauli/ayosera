import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { appendAnd, buildBookingFilter } from "@/lib/booking-query";
import { toTransactionRow } from "@/lib/booking-mapper";
import { collections, withMongo } from "@/lib/mongodb";
import { isCancelledTransaction, isDisplayEligibleTransaction } from "@/lib/revenue";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { readActiveStagedPaymentEvents } from "@/lib/ayo-payment-event-staging";
import { isPaymentEventsReadEnabled } from "@/lib/ayo-payment-events-engine";
import { aggregateBookingPayments, withBookingPaymentTotals, paymentDetailsFor } from "@/lib/booking-payment-aggregate";

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
    await requireModule("transaksi");
    const searchParams = new URL(request.url).searchParams;

    const page = Math.max(1, Math.floor(Number(searchParams.get("page")) || 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(searchParams.get("limit")) || 50)));

    // Filter lapangan dikirim sebagai "court"; petakan ke param "branch" milik buildBookingFilter.
    const court = searchParams.get("court");
    if (court) searchParams.set("branch", court);

    const filter = buildBookingFilter(searchParams);

    // Status "cancelled" tidak difilter di level MongoDB (lihat buildBookingFilter) —
    // deteksi memakai isCancelledTransaction() di JS, sumber kebenaran yang sama
    // dengan Dashboard, supaya angka Cancelled selalu identik di kedua halaman.
    const normalizedStatus = searchParams.get("status")?.toLowerCase();
    const isCancelledStatusFilter = Boolean(
      normalizedStatus && ["cancelled", "canceled", "dibatalkan", "batal"].includes(normalizedStatus),
    );

    const bookingId = searchParams.get("bookingId")?.trim();
    if (bookingId) {
      appendAnd(filter, { booking_id: { $regex: escapeRegex(bookingId), $options: "i" } });
    }

    const search = searchParams.get("search")?.trim();
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      appendAnd(filter, { $or: [{ booker_name: rx }, { booker_phone: rx }, { booking_id: rx }] });
    }

    // Filter kolom "Perubahan"; "none" berarti tidak ada perubahan tercatat (termasuk dokumen lama).
    const change = searchParams.get("change")?.trim();
    if (change) {
      if (change === "none") {
        appendAnd(filter, { $or: [{ changeType: { $exists: false } }, { changeType: null }] });
      } else {
        appendAnd(filter, { changeType: change });
      }
    }

    const sortSpec = buildSort(searchParams.get("sort"), searchParams.get("dir"));

    // Rentang tanggal eksplisit dipakai untuk mengambil payment events yang
    // sama seperti Dashboard/Export — booking_id yang punya >1 payment event
    // (split/bertahap) tidak lagi kehilangan payment sebelumnya (lihat
    // bookings.total_price yang di-overwrite per sync, lib/booking-sync.ts).
    const explicitDate = searchParams.get("date");
    const explicitStart = explicitDate || searchParams.get("start_date");
    const explicitEnd = explicitDate || searchParams.get("end_date");

    const result = await withMongo(async () => {
      const { bookings, ayoPaymentEventStagingRuns, ayoPaymentEventStagingEvents, ayoPaymentEventActivation } = await collections();
      // Query sudah dibatasi rentang tanggal + filter, jadi set ini terbatas.
      const matched = await bookings.find(filter).sort(sortSpec).toArray();

      const staged = isPaymentEventsReadEnabled() && explicitStart && explicitEnd
        ? await readActiveStagedPaymentEvents(explicitStart, explicitEnd, {
          runs: ayoPaymentEventStagingRuns,
          events: ayoPaymentEventStagingEvents,
          activation: ayoPaymentEventActivation,
        })
        : null;
      // Booking tanpa payment event yang cocok (mis. periode belum tercakup
      // payment-events) tetap memakai bookings.total_price sebagai fallback —
      // baris tidak pernah dibuang, beda dengan withCanonicalPaymentAmounts()
      // yang dipakai jalur export.
      const paymentAggregate = staged ? aggregateBookingPayments(staged.events) : null;
      const withPayments = paymentAggregate ? withBookingPaymentTotals(matched, paymentAggregate) : matched;

      // Eligibility tampil (Rp0 / Internal Use) memakai rule yang sama seperti dashboard.
      const displayRows = withPayments
        .filter(isDisplayEligibleTransaction)
        .filter((booking) => !isCancelledStatusFilter || isCancelledTransaction(booking));
      const total = displayRows.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const safePage = Math.min(page, totalPages);
      const pageRows = displayRows.slice((safePage - 1) * limit, safePage * limit);

      // Detail per payment (untuk expand UI "N pembayaran") diturunkan dari
      // aggregate YANG SAMA yang sudah mengoverwrite total_price di atas —
      // tidak ada query/sumber terpisah, jadi total baris dan jumlah detail
      // tidak pernah divergen.
      return {
        matchedCount: matched.length,
        data: pageRows.map((booking) => {
          const match = paymentAggregate?.get(booking.booking_id);
          return toTransactionRow(booking, match ? { count: match.paymentCount, details: paymentDetailsFor(match) } : undefined);
        }),
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
