import type { BookingDocument, FieldDocument } from "./mongodb.ts";
import { isCancelledTransaction } from "./revenue.ts";

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

/** Rincian pembayaran opsional (lihat lib/booking-payment-aggregate.ts paymentDetailsFor). */
export type TransactionRowPayment = { count: number; details: { referenceId: string; amount: number }[] };

const currencyFormat = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

/**
 * `payment` bila diberikan HARUS diturunkan dari aggregate yang sama yang
 * mengoverwrite `booking.total_price` (lihat withBookingPaymentTotals) —
 * supaya total baris ini dan jumlah nominal `paymentDetails` selalu identik,
 * tidak pernah dihitung dari sumber terpisah yang bisa divergen. Hanya
 * disertakan ke output bila `count > 1`; booking dengan 1 payment (atau tanpa
 * payment-events sama sekali, fallback ke bookings.total_price) tetap tampil
 * seperti sebelumnya, tanpa field payment tambahan.
 */
export function toTransactionRow(booking: BookingDocument, payment?: TransactionRowPayment) {
  const paymentFields =
    payment && payment.count > 1
      ? {
          paymentCount: payment.count,
          paymentDetails: payment.details.map((detail) => ({
            referenceId: detail.referenceId,
            amount: currencyFormat.format(detail.amount),
            amountValue: detail.amount,
          })),
        }
      : {};
  return {
    id: booking.booking_id,
    orderDetailId: booking.order_detail_id ? String(booking.order_detail_id) : "-",
    date: booking.date || "-",
    customer: booking.booker_name || "-",
    phone: booking.booker_phone || "-",
    email: booking.booker_email || "-",
    branch: resolveVenueName(),
    service: booking.field_name,
    fieldId: booking.field_id ? String(booking.field_id) : "-",
    amount: currencyFormat.format(booking.total_price),
    amountValue: booking.total_price,
    payment: booking.booking_source === "reservation" ? "Reservation" : "AYO Order",
    bookingSource: booking.booking_source || "-",
    status: isCancelledTransaction(booking) ? "Cancelled" : mapStatus(booking.status),
    time: booking.start_time?.slice(0, 5) || "-",
    endTime: booking.end_time?.slice(0, 5) || "-",
    rawStatus: booking.status,
    createdAt: booking.created_at || "-",
    syncedAt: booking.syncedAt?.toISOString?.() || "-",
    note: booking.note || "-",
    changeType: booking.changeType ?? null,
    changedAt: booking.changedAt?.toISOString?.() || undefined,
    previousSchedule: booking.previousSchedule,
    fieldChanges: booking.fieldChanges,
    ...paymentFields,
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

/**
 * Nama venue human-readable untuk ditampilkan (kolom "Venue" pada export &
 * field "branch" pada tabel Transaksi).
 *
 * PENTING: API AYO list-bookings TIDAK mengembalikan nama venue di payload —
 * venue hanya diwakili kode di URL (AYO_VENUE_CODE, mis. "JBoHLrgHzK"), dan
 * seluruh 7000+ booking di DB tidak punya field raw venue apa pun. Jadi satu-
 * satunya sumber nama manusiawi adalah env AYO_BRANCH_NAME. Sengaja TIDAK jatuh
 * ke AYO_VENUE_CODE supaya kode acak tidak pernah bocor ke laporan; bila env
 * kosong kembalikan "—" sebagai fallback yang jelas.
 */
export function resolveVenueName() {
  return process.env.AYO_BRANCH_NAME?.trim() || "—";
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
