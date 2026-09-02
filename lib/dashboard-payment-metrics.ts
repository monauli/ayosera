import type { AyoPaymentEvent } from "./ayo-payment-events.ts";

/** Canonical Dashboard identity rule: one latest row per payment identity. */
export function uniqueDashboardPaymentEvents(paymentEvents: readonly AyoPaymentEvent[]) {
  const unique = new Map<string, AyoPaymentEvent>();
  for (const event of paymentEvents) unique.set(event.identity, event);
  return [...unique.values()];
}

/**
 * Canonical Dashboard revenue grouped by booking metadata reference.
 * Multiple successful payment records for one booking intentionally remain
 * separate before this aggregation; only duplicate payment identities collapse.
 */
export function dashboardPaymentAmountsByBooking(paymentEvents: readonly AyoPaymentEvent[]) {
  const amounts = new Map<string, number>();
  for (const event of uniqueDashboardPaymentEvents(paymentEvents)) {
    if (!event.bookingId) continue;
    amounts.set(event.bookingId, (amounts.get(event.bookingId) ?? 0) + event.amount);
  }
  return amounts;
}

/**
 * booking_id -> paymentType (lib/ayo-payment-events.ts, canonical field from
 * the payment event, never guessed) — dipakai lib/omzet-export.ts
 * classifyBookingExportSource untuk membedakan booking "MN" yang dibayar
 * lewat Payment Link (tetap AYO) dari yang benar-benar manual/Walk In.
 */
export function dashboardPaymentTypeByBooking(paymentEvents: readonly AyoPaymentEvent[]) {
  const types = new Map<string, string | null>();
  for (const event of uniqueDashboardPaymentEvents(paymentEvents)) {
    if (!event.bookingId || types.has(event.bookingId)) continue;
    types.set(event.bookingId, event.paymentType);
  }
  return types;
}

/**
 * Card metrics must match Court Performance's counting unit: one transaction
 * per booking (dashboardPaymentAmountsByBooking sums split-payment events
 * together), excluding events whose booking is cancelled — same
 * isCancelledTransaction rule Court Performance already applies via
 * `revenueEligible` in app/api/dashboard/route.ts, passed in here as
 * `cancelledBookingIds` instead of re-derived. Events with no bookingId can't
 * be matched to a booking's status, so they still count individually.
 */
export function buildDashboardPaymentMetrics(input: { bookingTotal: number; fallbackTransactions: number; fallbackRevenue: number; paymentEvents: readonly AyoPaymentEvent[] | null; cancelledBookingIds?: ReadonlySet<string> }) {
  if (!input.paymentEvents) return { totalTransactions: input.fallbackTransactions, revenueMonth: input.fallbackRevenue, bookingTotal: input.bookingTotal };
  const cancelledBookingIds = input.cancelledBookingIds ?? new Set<string>();
  const unique = uniqueDashboardPaymentEvents(input.paymentEvents).filter(
    (event) => !event.bookingId || !cancelledBookingIds.has(event.bookingId),
  );
  const amountsByBooking = dashboardPaymentAmountsByBooking(unique);
  const unlinked = unique.filter((event) => !event.bookingId);
  return {
    totalTransactions: amountsByBooking.size + unlinked.length,
    revenueMonth: [...amountsByBooking.values()].reduce((sum, amount) => sum + amount, 0) + unlinked.reduce((sum, event) => sum + event.amount, 0),
    bookingTotal: input.bookingTotal,
  };
}
