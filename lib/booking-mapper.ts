import type { BookingDocument, FieldDocument } from "@/lib/mongodb";

export function normalizeBooking(raw: Record<string, unknown>): BookingDocument {
  const now = new Date();
  const branchName = getRawBranchName(raw);

  return {
    order_detail_id: Number(raw.order_detail_id || 0),
    booking_id: String(raw.booking_id || ""),
    field_id: Number(raw.field_id || 0),
    field_name: String(raw.field_name || "Unknown Field"),
    date: String(raw.date || ""),
    start_time: String(raw.start_time || ""),
    end_time: String(raw.end_time || ""),
    total_price: Number(raw.total_price || 0),
    status: String(raw.status || "UNKNOWN"),
    booker_name: String(raw.booker_name || "-"),
    booker_phone: String(raw.booker_phone || "-"),
    booker_email: String(raw.booker_email || ""),
    booking_source: String(raw.booking_source || "order"),
    branch_name: branchName,
    created_at: String(raw.created_at || ""),
    note: raw.note ? String(raw.note) : undefined,
    raw,
    syncedAt: now,
    updatedAt: now,
  };
}

export function normalizeField(raw: Record<string, unknown>): FieldDocument {
  return {
    id: Number(raw.id || 0),
    name: String(raw.name || "Unknown Field"),
    status: String(raw.status || "UNKNOWN"),
    is_active: Number(raw.is_active || 0),
    is_permanent_active: Number(raw.is_permanent_active || 0),
    sport_name: String(raw.sport_name || ""),
    raw,
    syncedAt: new Date(),
  };
}

export function toTransactionRow(booking: BookingDocument) {
  return {
    id: booking.booking_id,
    orderDetailId: booking.order_detail_id ? String(booking.order_detail_id) : "-",
    date: booking.date || "-",
    customer: booking.booker_name || "-",
    phone: booking.booker_phone || "-",
    email: booking.booker_email || "-",
    branch: getBookingBranchName(booking),
    service: booking.field_name,
    fieldId: booking.field_id ? String(booking.field_id) : "-",
    amount: new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(booking.total_price),
    payment: booking.booking_source === "reservation" ? "Reservation" : "AYO Order",
    bookingSource: booking.booking_source || "-",
    status: mapStatus(booking.status),
    time: booking.start_time?.slice(0, 5) || "-",
    endTime: booking.end_time?.slice(0, 5) || "-",
    rawStatus: booking.status,
    createdAt: booking.created_at || "-",
    syncedAt: booking.syncedAt?.toISOString?.() || "-",
    note: booking.note || "-",
  };
}

export function mapStatus(status: string) {
  if (["SUCCESS", "FINISHED"].includes(status)) return "Completed";
  if (status === "PENDING") return "Pending";
  if (status === "CANCELLED") return "Cancelled";
  return status || "Unknown";
}

export function getBookingBranchName(booking: Pick<BookingDocument, "branch_name" | "raw">) {
  return booking.branch_name || getRawBranchName(booking.raw);
}

export function getRawBranchName(raw: Record<string, unknown>) {
  const branch =
    firstString(raw, [
      "branch_name",
      "branch",
      "venue_name",
      "venue",
      "outlet_name",
      "location_name",
      "business_name",
      "merchant_name",
      "company_name",
    ]) ||
    firstNestedString(raw, [
      ["branch", "name"],
      ["venue", "name"],
      ["outlet", "name"],
      ["location", "name"],
      ["merchant", "name"],
      ["field", "branch_name"],
      ["field", "venue_name"],
      ["field", "location_name"],
    ]);

  return branch || process.env.AYO_BRANCH_NAME || process.env.AYO_VENUE_CODE || "AYO";
}

function firstString(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }

  return "";
}

function firstNestedString(raw: Record<string, unknown>, paths: string[][]) {
  for (const path of paths) {
    let cursor: unknown = raw;

    for (const key of path) {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
        cursor = undefined;
        break;
      }

      cursor = (cursor as Record<string, unknown>)[key];
    }

    if (typeof cursor === "string" && cursor.trim()) return cursor.trim();
    if (typeof cursor === "number") return String(cursor);
  }

  return "";
}
