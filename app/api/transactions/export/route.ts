import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { buildBookingFilter } from "@/lib/booking-query";
import { mapStatus, toTransactionRow } from "@/lib/booking-mapper";
import { collections, type BookingDocument, withMongo } from "@/lib/mongodb";

const EXPORT_LIMIT = 5000;

const headers = [
  "Booking ID",
  "Order Detail ID",
  "Date",
  "Start Time",
  "End Time",
  "Customer",
  "Phone",
  "Email",
  "Branch",
  "Field",
  "Booking Source",
  "Status",
  "Raw Status",
  "Total Price",
  "Amount",
  "Created At",
  "Synced At",
  "Note",
];

export async function GET(request: Request) {
  try {
    await requireUser();
    const { searchParams } = new URL(request.url);

    const rows = await withMongo(async () => {
      const { bookings } = await collections();
      return bookings
        .find(buildBookingFilter(searchParams))
        .sort({ date: -1, start_time: -1 })
        .limit(EXPORT_LIMIT)
        .toArray();
    });

    const csv = toCsv(rows);
    const filename = buildFilename(searchParams);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Unable to export transactions" }, { status: 500 });
  }
}

function toCsv(bookings: BookingDocument[]) {
  const lines = [
    headers,
    ...bookings.map((booking) => {
      const row = toTransactionRow(booking);
      return [
        row.id,
        row.orderDetailId,
        row.date,
        row.time,
        row.endTime,
        row.customer,
        row.phone,
        row.email,
        row.branch,
        row.service,
        row.bookingSource,
        mapStatus(booking.status),
        booking.status,
        booking.total_price,
        row.amount,
        row.createdAt,
        row.syncedAt,
        row.note,
      ];
    }),
  ];

  return `\uFEFF${lines.map((line) => line.map(toCsvCell).join(",")).join("\r\n")}\r\n`;
}

function toCsvCell(value: unknown) {
  const text = value === undefined || value === null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildFilename(searchParams: URLSearchParams) {
  const startDate = searchParams.get("start_date") || searchParams.get("date") || "all";
  const endDate = searchParams.get("end_date") || startDate;
  const suffix = startDate === endDate ? startDate : `${startDate}_to_${endDate}`;
  return `ayo-transactions-${suffix}.csv`;
}
