import assert from "node:assert/strict";
import test from "node:test";
import { resolveAyoPaymentEventIdentity, sumAyoPaymentEvents } from "./ayo-payment-events.ts";

test("native payment/event id separates multiple payments on one booking", () => {
  const first = resolveAyoPaymentEventIdentity({ booking_id: "MN/1", payment_id: "p1", total_price: 150000 });
  const second = resolveAyoPaymentEventIdentity({ booking_id: "MN/1", payment_id: "p2", total_price: 150000 });
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(first.source, "native");
  assert.equal(second.source, "native");
});

test("fallback identity is deterministic when API has no native event id", () => {
  const a = resolveAyoPaymentEventIdentity({ booking_id: "MN/1", total_price: 150000, status: "SUCCESS" });
  const b = resolveAyoPaymentEventIdentity({ status: "SUCCESS", total_price: 150000, booking_id: "MN/1" });
  assert.equal(a.eventId, b.eventId);
  assert.equal(a.source, "fallback-hash");
});

test("fallback ignores mutable status, updated_at, and sync timestamps", () => {
  const base = { booking_id: "MN/1", total_price: 150000, date: "2026-06-01", created_at: "2026-05-31T01:00:00Z", status: "SUCCESS" };
  const changed = { ...base, status: "CANCELLED", updated_at: "2026-08-04T00:00:00Z", syncedAt: "2026-08-04T00:00:00Z" };
  assert.equal(resolveAyoPaymentEventIdentity(base).eventId, resolveAyoPaymentEventIdentity(changed).eventId);
});

test("fallback separates DP and settlement when stable payment fields differ", () => {
  const dp = { booking_id: "MN/1", total_price: 150000, payment_amount: 50000, payment_date: "2026-06-01", payment_sequence: 1 };
  const settlement = { booking_id: "MN/1", total_price: 150000, payment_amount: 100000, payment_date: "2026-06-02", payment_sequence: 2 };
  assert.notEqual(resolveAyoPaymentEventIdentity(dp).eventId, resolveAyoPaymentEventIdentity(settlement).eventId);
});

test("same payload twice has the same idempotent event identity", () => {
  const payload = { booking_id: "MN/1", total_price: 150000, date: "2026-06-01", created_at: "2026-05-31T01:00:00Z" };
  assert.equal(resolveAyoPaymentEventIdentity(payload).eventId, resolveAyoPaymentEventIdentity({ ...payload }).eventId);
});

test("June and July known payment-event totals are preserved", () => {
  const june = ["1581", "1582", "1835", "1951"].map((id) => ({ date: "2026-06-01", total_price: 150000, status: "SUCCESS", event_id: id, raw: {} }));
  const july = [{ date: "2026-07-29", total_price: 150000, status: "SUCCESS", event_id: "2761", raw: {} }];
  assert.deepEqual(sumAyoPaymentEvents(june), { count: 4, revenue: 600000 });
  assert.deepEqual(sumAyoPaymentEvents(july), { count: 1, revenue: 150000 });
});
