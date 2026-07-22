import type { BookingDocument } from "@/lib/mongodb";

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
    // Filter "cancelled" TIDAK dilakukan di level MongoDB query (lihat
    // app/api/transactions/route.ts) — status cancelled ditentukan via
    // isCancelledTransaction() di JS agar identik dengan Dashboard, karena
    // struktur data nested tidak selalu cocok dengan regex path tetap di sini.
    if (!["cancelled", "canceled", "dibatalkan", "batal"].includes(normalizedStatus)) {
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
    const pickleNumber = court.match(/^Pickleball Court No ([12])$/i)?.[1];
    const courtCondition = pickleNumber
      ? { $regex: `pickleball.*(?:no\\.?\\s*)?${pickleNumber}\\b`, $options: "i" }
      : court;
    appendAnd(filter, {
      $or: [
        { field_name: courtCondition },
        { "raw.field_name": courtCondition },
        { "raw.field.name": courtCondition },
        { "raw.court_name": courtCondition },
        { "raw.court.name": courtCondition },
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

export function appendAnd(filter: Record<string, unknown>, condition: Record<string, unknown>) {
  filter.$and = [...((filter.$and as Record<string, unknown>[]) || []), condition];
}

export function toCourtOptions(bookings: Array<Pick<BookingDocument, "field_name">>) {
  return Array.from(new Set(bookings.map((booking) => booking.field_name).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ label: name, value: name }));
}
