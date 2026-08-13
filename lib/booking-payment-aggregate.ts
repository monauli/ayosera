import "server-only";
import type { BookingDocument } from "./mongodb.ts";
import type { AyoPaymentEvent } from "./ayo-payment-events.ts";

/**
 * Shared booking -> payment aggregation. Every consumer that must show a
 * booking's monetary total (Transaksi, Rekonsiliasi, Dashboard detail rows,
 * Export) should compute it through this module so the same booking never
 * shows a different nominal on different pages.
 *
 * `bookings` collection stores exactly one snapshot per booking_id (see
 * lib/booking-sync.ts upsertBookingItems) — a booking with more than one AYO
 * payment event (split/staged payment) loses every payment except the last
 * one synced. `ayo_payment_event_staging_events` instead keeps one row per
 * payment event, identified by paymentEventIdentity() (never booking_id
 * alone), so multiple payments for the same booking are never collapsed.
 */
export type BookingPaymentAggregate = {
  totalAmount: number;
  paymentCount: number;
  events: AyoPaymentEvent[];
};

/**
 * Aggregates payment events per booking_id. Dedupes first by event.identity
 * (paymentEventIdentity) so a re-synced/duplicate row is never counted twice,
 * then sums every distinct payment event that belongs to the same booking.
 */
export function aggregateBookingPayments(
  paymentEvents: readonly AyoPaymentEvent[] | null | undefined,
): Map<string, BookingPaymentAggregate> {
  const aggregate = new Map<string, BookingPaymentAggregate>();
  if (!paymentEvents) return aggregate;

  const uniqueByIdentity = new Map<string, AyoPaymentEvent>();
  for (const event of paymentEvents) uniqueByIdentity.set(event.identity, event);

  for (const event of uniqueByIdentity.values()) {
    if (!event.bookingId) continue;
    const existing = aggregate.get(event.bookingId);
    if (existing) {
      existing.totalAmount += event.amount;
      existing.paymentCount += 1;
      existing.events.push(event);
    } else {
      aggregate.set(event.bookingId, { totalAmount: event.amount, paymentCount: 1, events: [event] });
    }
  }
  return aggregate;
}

/**
 * Applies the aggregated payment total onto each booking's total_price.
 * A booking with no matched payment event (not yet covered by the
 * payment-events source, e.g. before the pipeline's coverage window, or a
 * booking outside the requested payment-event range) keeps its existing
 * bookings.total_price as fallback — rows are never dropped. This differs
 * from lib/omzet-export.ts withCanonicalPaymentAmounts(), which intentionally
 * omits uncovered bookings for export sheets that only render covered rows.
 */
export function withBookingPaymentTotals<T extends Pick<BookingDocument, "booking_id" | "total_price">>(
  bookings: readonly T[],
  aggregate: ReadonlyMap<string, BookingPaymentAggregate>,
): T[] {
  return bookings.map((booking) => {
    const match = aggregate.get(booking.booking_id);
    return match ? { ...booking, total_price: match.totalAmount } : booking;
  });
}

/** Satu payment event, reduksi ke field yang aman ditampilkan di UI Transaksi (bukan payload mentah). */
export type BookingPaymentDetail = {
  /** `reservationPaymentId` bila ada (identitas AYO paling manusiawi); jatuh ke sourceId/nativeId/identity bila kosong. */
  referenceId: string;
  amount: number;
};

/**
 * Rincian payment untuk SATU booking, diturunkan dari `aggregate.events` yang
 * SAMA yang sudah menghasilkan `totalAmount` (bukan query/sumber terpisah),
 * jadi jumlah detail selalu sama dengan total baris utama — tidak pernah bisa
 * divergen.
 *
 * SENGAJA TIDAK menyertakan tanggal/jam: `AyoPaymentEvent.eventDate` untuk
 * `source_table: "internal_reservation"` (satu-satunya sumber kasus
 * multi-payment yang ditemukan pada audit, lihat komponen
 * booking-session-row.tsx) hanya fallback ke tanggal sesi booking — identik
 * untuk setiap payment pada booking yang sama, dikonfirmasi ulang lewat query
 * read-only produksi. Menampilkannya akan terlihat seperti dua tanggal
 * pembayaran berbeda padahal datanya sama persis; keputusan sadar untuk tidak
 * ikut menampilkan field itu di sini, bukan kelalaian.
 */
export function paymentDetailsFor(aggregate: Pick<BookingPaymentAggregate, "events">): BookingPaymentDetail[] {
  return [...aggregate.events]
    .sort((a, b) => {
      const aKey = a.reservationPaymentId ?? a.identity;
      const bKey = b.reservationPaymentId ?? b.identity;
      return aKey.localeCompare(bKey, undefined, { numeric: true });
    })
    .map((event) => ({
      referenceId: event.reservationPaymentId || event.sourceId || event.nativeId || event.identity,
      amount: event.amount,
    }));
}
