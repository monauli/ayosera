import crypto from "node:crypto";
import type { BookingDocument } from "./mongodb.ts";
import { getRevenueAmount, isRevenueEligibleTransaction } from "./revenue.ts";

export type AyoPaymentEventDocument = {
  _id: string;
  booking_id: string;
  event_id: string;
  event_id_source: "native" | "fallback-hash";
  date: string;
  total_price: number;
  status: string;
  booking_source: string;
  created_at: string;
  raw: Record<string, unknown>;
  syncedAt: Date;
};

const NATIVE_EVENT_KEYS = [
  "payment_id",
  "paymentId",
  "payment_event_id",
  "paymentEventId",
  "transaction_id",
  "transactionId",
  "transaction_detail_id",
  "transactionDetailId",
  "revenue_id",
  "revenueId",
  "invoice_id",
  "invoiceId",
] as const;

const FALLBACK_STABLE_KEYS = [
  "booking_id",
  "total_price",
  "date",
  "start_time",
  "end_time",
  "field_id",
  "field_name",
  "booking_source",
  "created_at",
  "user_id",
  "order_detail_id",
  "payment_amount",
  "payment_date",
  "payment_type",
  "payment_sequence",
  "installment_no",
  "receipt_no",
] as const;

export function resolveAyoPaymentEventIdentity(raw: Record<string, unknown>) {
  for (const key of NATIVE_EVENT_KEYS) {
    const value = findField(raw, key);
    if (typeof value === "string" || typeof value === "number") {
      const normalized = String(value).trim();
      if (normalized) return { eventId: normalized, source: "native" as const };
    }
  }

  return {
    eventId: crypto.createHash("sha256").update(stableJson(pickFallbackIdentity(raw))).digest("hex"),
    source: "fallback-hash" as const,
  };
}

export function pickFallbackIdentity(raw: Record<string, unknown>) {
  return Object.fromEntries(
    FALLBACK_STABLE_KEYS
      .map((key) => [key, findField(raw, key)] as const)
      .filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function findField(value: unknown, wantedKey: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findField(item, wantedKey);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (wantedKey in record) return record[wantedKey];
  for (const nested of Object.values(record)) {
    const found = findField(nested, wantedKey);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function toAyoPaymentEvent(booking: BookingDocument): AyoPaymentEventDocument {
  const identity = resolveAyoPaymentEventIdentity(booking.raw);
  return {
    _id: `${booking.booking_id}:${identity.eventId}`,
    booking_id: booking.booking_id,
    event_id: identity.eventId,
    event_id_source: identity.source,
    date: booking.date,
    total_price: booking.total_price,
    status: booking.status,
    booking_source: booking.booking_source,
    created_at: booking.created_at,
    raw: booking.raw,
    syncedAt: booking.syncedAt,
  };
}

export function sumAyoPaymentEvents(events: Iterable<Pick<AyoPaymentEventDocument, "total_price" | "status" | "date" | "raw">>) {
  let count = 0;
  let revenue = 0;
  for (const event of events) {
    if (!isRevenueEligibleTransaction({ ...event.raw, total_price: event.total_price, status: event.status })) continue;
    count += 1;
    revenue += getRevenueAmount({ ...event.raw, total_price: event.total_price, status: event.status });
  }
  return { count, revenue };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortJsonValue(nested)]));
}
