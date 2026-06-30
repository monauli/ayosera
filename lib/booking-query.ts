import type { BookingDocument } from "@/lib/mongodb";
import { CANCELLED_STATUS_PATTERN_SOURCE } from "@/lib/revenue";

const CANCELLED_STATUS_FIELDS = [
  "status",
  "payment",
  "status_label",
  "source_status",
  "payment_status",
  "raw.status",
  "raw.payment",
  "raw.payment.status",
  "raw.payment.status_label",
  "raw.payment_status",
  "raw.status_label",
  "raw.source_status",
];

export function buildBookingFilter(searchParams: URLSearchParams) {
  const status = searchParams.get("status");
  const date = searchParams.get("date");
  const startDate = searchParams.get("start_date");
  const endDate = searchParams.get("end_date");
  const court = searchParams.get("branch");
  const q = searchParams.get("q");
  const filter: Record<string, unknown> = {};

  if (status && status !== "all") {
    const normalizedStatus = status.toLowerCase();
    const statusMap: Record<string, string[]> = {
      Completed: ["SUCCESS", "FINISHED"],
      Pending: ["PENDING"],
    };
    if (["cancelled", "canceled", "dibatalkan", "batal"].includes(normalizedStatus)) {
      appendAnd(filter, {
        $or: CANCELLED_STATUS_FIELDS.map((field) => ({
          [field]: { $regex: CANCELLED_STATUS_PATTERN_SOURCE, $options: "i" },
        })),
      });
    } else {
      filter.status = statusMap[status] ? { $in: statusMap[status] } : status;
    }
  }

  if (date) filter.date = date;
  if (!date && (startDate || endDate)) {
    filter.date = {
      ...(startDate ? { $gte: startDate } : {}),
      ...(endDate ? { $lte: endDate } : {}),
    };
  }

  if (court && court !== "all") {
    appendAnd(filter, {
      $or: [
        { field_name: court },
        { "raw.field_name": court },
        { "raw.field.name": court },
        { "raw.court_name": court },
        { "raw.court.name": court },
      ],
    });
  }

  if (q) {
    appendAnd(filter, {
      $or: [
        { booking_id: { $regex: q, $options: "i" } },
        { booker_name: { $regex: q, $options: "i" } },
        { field_name: { $regex: q, $options: "i" } },
      ],
    });
  }

  return filter;
}

function appendAnd(filter: Record<string, unknown>, condition: Record<string, unknown>) {
  filter.$and = [...((filter.$and as Record<string, unknown>[]) || []), condition];
}

export function toCourtOptions(bookings: Array<Pick<BookingDocument, "field_name">>) {
  return Array.from(new Set(bookings.map((booking) => booking.field_name).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ label: name, value: name }));
}
