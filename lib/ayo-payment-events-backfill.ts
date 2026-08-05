import type { AyoPaymentEvent } from "./ayo-payment-events.ts";

export const BACKFILL_CONFIRM = "BACKFILL_AYO_PAYMENT_EVENTS";

export function assertBackfillWriteAllowed(options: { write: boolean; confirm?: string }) {
  if (options.write && options.confirm !== BACKFILL_CONFIRM) throw new Error(`--write wajib memakai --confirm=${BACKFILL_CONFIRM}.`);
}

export function canonicalPaymentEvent(event: AyoPaymentEvent) {
  return JSON.stringify({ _id: event._id, identity: event.identity, bookingId: event.bookingId, sourceTable: event.sourceTable, reservationPaymentId: event.reservationPaymentId, nativeId: event.nativeId, sourceId: event.sourceId, eventDate: event.eventDate.toISOString(), amount: event.amount, amountSource: event.amountSource, paymentStatus: event.paymentStatus, bookingStatus: event.bookingStatus, paymentType: event.paymentType, paymentNote: event.paymentNote, detailStatus: event.detailStatus, finalStatus: event.finalStatus, fieldName: event.fieldName, date: event.date, startTime: event.startTime, endTime: event.endTime, total: event.total, finalFeeAyo: event.finalFeeAyo, isCredit: event.isCredit });
}

export function planBackfill(apiEvents: readonly AyoPaymentEvent[], existingEvents: readonly AyoPaymentEvent[]) {
  const apiById = new Map<string, AyoPaymentEvent>();
  let duplicate = 0;
  let conflict = 0;
  for (const event of apiEvents) {
    const previous = apiById.get(event._id);
    if (previous) {
      duplicate += 1;
      if (canonicalPaymentEvent(previous) !== canonicalPaymentEvent(event)) conflict += 1;
    } else apiById.set(event._id, event);
  }
  const existingById = new Map(existingEvents.map((event) => [event._id, event]));
  let wouldInsert = 0;
  let wouldUpdate = 0;
  let unchanged = 0;
  for (const [id, event] of apiById) {
    const existing = existingById.get(id);
    if (!existing) wouldInsert += 1;
    else if (canonicalPaymentEvent(existing) !== canonicalPaymentEvent(event)) wouldUpdate += 1;
    else unchanged += 1;
  }
  return { apiById, duplicate, conflict, wouldInsert, wouldUpdate, unchanged, finalProjectedRows: apiById.size, finalProjectedEvents: [...apiById.values()] };
}
