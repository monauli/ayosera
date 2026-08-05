import "server-only";
import { fetchAyoPaymentEvents, paymentEventRevenue, validatePaymentPeriod, type AyoPaymentEvent, type AyoPaymentPeriodMetadata } from "./ayo-payment-events.ts";

export type PaymentEventReadCollection = {
  find(filter: Record<string, unknown>): { toArray(): Promise<AyoPaymentEvent[]> };
};
export type PaymentEventCollection = PaymentEventReadCollection & {
  bulkWrite(operations: unknown[]): Promise<unknown>;
};

export type PaymentPeriodCollection = {
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options: { upsert: true }): Promise<unknown>;
  findOne(filter: Record<string, unknown>): Promise<AyoPaymentPeriodMetadata | null>;
};

export function periodId(startDate: string, endDate: string) { return `${startDate}:${endDate}`; }

export async function syncAyoPaymentEvents(startDate: string, endDate: string, context?: { events: PaymentEventCollection; periods: PaymentPeriodCollection }) {
  const { events, expectedTotalTransaction, expectedTotal } = await fetchAyoPaymentEvents(startDate, endDate);
  const unique = new Map<string, AyoPaymentEvent>();
  let conflictCount = 0;
  for (const event of events) {
    if (unique.has(event._id) && JSON.stringify(unique.get(event._id)?.raw) !== JSON.stringify(event.raw)) conflictCount += 1;
    unique.set(event._id, event);
  }
  const normalized = [...unique.values()];
  const validation = validatePaymentPeriod({ startDate, endDate, events: normalized, expectedTotalTransaction, expectedTotal, conflictCount });
  const now = new Date();
  const metadata: AyoPaymentPeriodMetadata = { _id: periodId(startDate, endDate), startDate, endDate, fetchedRows: normalized.length, expectedTotalTransaction, calculatedTotal: validation.calculatedTotal, expectedTotal, validationStatus: validation.status, lastSuccessfulSyncAt: validation.status === "validated" ? now : null, errorCode: validation.reason, errorMessage: validation.reason, conflictCount, updatedAt: now };
  if (context) {
    if (normalized.length) await context.events.bulkWrite(normalized.map((event) => ({ updateOne: { filter: { _id: event._id }, update: { $set: event }, upsert: true } })));
    await context.periods.updateOne({ _id: metadata._id }, { $set: metadata }, { upsert: true });
  }
  return metadata;
}

export async function syncAyoPaymentEventsFromMongo(startDate: string, endDate: string) {
  const { collections } = await import("./mongodb.ts");
  const c = await collections();
  try {
    return await syncAyoPaymentEvents(startDate, endDate, { events: c.ayoPaymentEvents as unknown as PaymentEventCollection, periods: c.ayoPaymentPeriods });
  } catch (error) {
    const safe = error instanceof Error ? error : new Error("AYO payment-event sync gagal.");
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "ERROR";
    const now = new Date();
    await c.ayoPaymentPeriods.updateOne({ _id: periodId(startDate, endDate) }, { $set: { _id: periodId(startDate, endDate), startDate, endDate, fetchedRows: 0, expectedTotalTransaction: 0, calculatedTotal: 0, expectedTotal: 0, validationStatus: code === "TOKEN_INVALID" ? "token-invalid" : "error", lastSuccessfulSyncAt: null, errorCode: code, errorMessage: safe.message, conflictCount: 0, updatedAt: now } }, { upsert: true });
    throw error;
  }
}

export async function readValidatedPaymentEvents(startDate: string, endDate: string, context?: { events: PaymentEventReadCollection; periods: PaymentPeriodCollection }): Promise<{ metadata: AyoPaymentPeriodMetadata; events: AyoPaymentEvent[] } | null> {
  // Legacy collections may contain a partial historical backfill. They are
  // deliberately inactive: consumers must fall back to bookings until a
  // complete, atomically activated staging run is available.
  void startDate; void endDate; void context;
  return null;
}

export function paymentEventAsBooking(event: AyoPaymentEvent) {
  return {
    order_detail_id: Number(event.nativeId) || 0,
    booking_id: event.bookingId,
    field_id: 0,
    field_name: event.fieldName,
    date: event.date,
    start_time: event.startTime ?? "",
    end_time: event.endTime ?? "",
    total_price: paymentEventRevenue(event),
    status: event.finalStatus ?? event.detailStatus ?? "",
    booker_name: "",
    booker_phone: "",
    booker_email: "",
    booking_source: event.bookingId.startsWith("MN") ? "manual" : "order",
    branch_name: "",
    created_at: event.date,
    raw: event.raw,
    syncedAt: event.syncedAt,
    updatedAt: event.syncedAt,
  };
}
