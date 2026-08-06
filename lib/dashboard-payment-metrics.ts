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

/** Payment events are a separate dataset from bookings: never apply booking-status eligibility here. */
export function buildDashboardPaymentMetrics(input: { bookingTotal: number; fallbackTransactions: number; fallbackRevenue: number; paymentEvents: readonly AyoPaymentEvent[] | null }) {
  if (!input.paymentEvents) return { totalTransactions: input.fallbackTransactions, revenueMonth: input.fallbackRevenue, bookingTotal: input.bookingTotal };
  const unique = uniqueDashboardPaymentEvents(input.paymentEvents);
  return {
    totalTransactions: unique.length,
    revenueMonth: unique.reduce((sum, event) => sum + event.amount, 0),
    bookingTotal: input.bookingTotal,
  };
}
