import type { AyoPaymentEvent } from "./ayo-payment-events.ts";

/** Payment events are a separate dataset from bookings: never apply booking-status eligibility here. */
export function buildDashboardPaymentMetrics(input: { bookingTotal: number; fallbackTransactions: number; fallbackRevenue: number; paymentEvents: readonly AyoPaymentEvent[] | null }) {
  if (!input.paymentEvents) return { totalTransactions: input.fallbackTransactions, revenueMonth: input.fallbackRevenue, bookingTotal: input.bookingTotal };
  const unique = new Map<string, AyoPaymentEvent>();
  for (const event of input.paymentEvents) unique.set(event.identity, event);
  return {
    totalTransactions: unique.size,
    revenueMonth: [...unique.values()].reduce((sum, event) => sum + event.amount, 0),
    bookingTotal: input.bookingTotal,
  };
}
