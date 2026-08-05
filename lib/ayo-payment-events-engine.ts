import { canonicalPaymentEvent } from "./ayo-payment-events-backfill.ts";
import { paymentEventRevenue, type AyoPaymentEvent } from "./ayo-payment-events.ts";

export const PAYMENT_EVENT_RELEASE_GUARD = {
  productionActivationBlocked: true,
  reason: "Production activation blocked until the previous activeRunId is officially rolled back to null.",
} as const;

/** Server-only opt-in. Missing or malformed configuration intentionally keeps bookings as the dashboard source. */
export function isPaymentEventsReadEnabled(env: Record<string, string | undefined> = process.env) {
  return env.AYO_PAYMENT_EVENTS_READ_ENABLED === "true";
}

export type PaymentEventAggregate = { eventCount: number; totalAmount: number };
export type PaymentEventCheckpoint = { lastSuccessfulPaymentEventSyncAt: Date | null; lastAttemptAt: Date; lastError: string | null; rowsFetched: number; eventsInserted: number; eventsUpdated: number; duplicates: number; conflicts: number; periodStart: string; periodEnd: string };
export type PaymentEventTokenStatus = "configured" | "missing" | "expired" | "unauthorized" | "temporary" | "manual-import-required";

export function aggregatePaymentEvents(events: readonly AyoPaymentEvent[], range?: { start: Date; end: Date }): PaymentEventAggregate {
  const included = range ? events.filter((event) => event.eventDate >= range.start && event.eventDate <= range.end) : events;
  return { eventCount: included.length, totalAmount: included.reduce((sum, event) => sum + paymentEventRevenue(event), 0) };
}

export function planPaymentEventUpsert(events: readonly AyoPaymentEvent[]) {
  const byIdentity = new Map<string, AyoPaymentEvent>();
  let duplicates = 0;
  let conflicts = 0;
  let invalid = 0;
  for (const event of events) {
    if (!event.identity || !event.sourceTable || !event.bookingId || (!event.reservationPaymentId && !event.sourceId)) { invalid += 1; continue; }
    const previous = byIdentity.get(event.identity);
    if (!previous) byIdentity.set(event.identity, event);
    else if (canonicalPaymentEvent(previous) === canonicalPaymentEvent(event)) duplicates += 1;
    else conflicts += 1;
  }
  return { events: [...byIdentity.values()], duplicates, conflicts, invalid };
}

export function incrementalWindow(lastSuccessfulPaymentEventSyncAt: Date | null, now: Date, overlapDays = 2) {
  const start = lastSuccessfulPaymentEventSyncAt ? new Date(lastSuccessfulPaymentEventSyncAt.getTime() - overlapDays * 86_400_000) : new Date(now.getFullYear(), now.getMonth(), 1);
  return { start, end: now };
}

/** Reports configuration state only; values are intentionally never returned or logged. */
export function tokenHealth(input: { officialApiKey?: string; temporaryToken?: string; lastErrorCode?: string; manualImportEnabled?: boolean }): PaymentEventTokenStatus {
  if (input.lastErrorCode === "TOKEN_INVALID") return "expired";
  if (input.lastErrorCode === "UNAUTHORIZED") return "unauthorized";
  if (input.officialApiKey?.trim()) return "configured";
  if (input.temporaryToken?.trim()) return "temporary";
  return input.manualImportEnabled ? "manual-import-required" : "missing";
}
