import assert from "node:assert/strict";
import test from "node:test";
import { aggregatePaymentEvents, incrementalWindow, isPaymentEventsReadEnabled, planPaymentEventUpsert, tokenHealth } from "./ayo-payment-events-engine.ts";
import { normalizeAyoPaymentEvent } from "./ayo-payment-events.ts";

const row = (extra: Record<string, unknown> = {}) => normalizeAyoPaymentEvent({ source_table: "reservation_payments", booking_id: "BK-1", reservation_payment_id: "RP-1", id: 1, date: "2026-06-01", created_at: "2026-06-01T10:00:00.000Z", total: 100, final_status: "PAID", ...extra }, new Date("2026-06-01T11:00:00.000Z"));

test("aggregate keeps multiple payments for one booking and uses payment event date", () => {
  const events = [row(), row({ id: 2, reservation_payment_id: "RP-2", total: 200 }), row({ id: 3, reservation_payment_id: "RP-3", created_at: "2026-07-01T00:00:00.000Z", total: 300 })];
  assert.deepEqual(aggregatePaymentEvents(events, { start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-06-30T23:59:59Z") }), { eventCount: 2, totalAmount: 300 });
  assert.equal(new Set(events.map((event) => event.identity)).size, 3);
});

test("upsert plan reports exact duplicates, conflicts, and invalid payloads without overwriting", () => {
  const first = row();
  const changed = { ...first, amount: 200 };
  const invalid = { ...first, identity: "", reservationPaymentId: null, sourceId: null };
  const plan = planPaymentEventUpsert([first, first, changed, invalid]);
  assert.equal(plan.events.length, 1);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.conflicts, 1);
  assert.equal(plan.invalid, 1);
});

test("incremental sync overlaps two days and token state never exposes a secret", () => {
  const window = incrementalWindow(new Date("2026-08-10T00:00:00Z"), new Date("2026-08-12T12:00:00Z"));
  assert.equal(window.start.toISOString(), "2026-08-08T00:00:00.000Z");
  assert.equal(tokenHealth({}), "missing");
  assert.equal(tokenHealth({ temporaryToken: "fixture-token" }), "temporary");
  assert.equal(tokenHealth({ officialApiKey: "fixture-key" }), "configured");
  assert.equal(tokenHealth({ lastErrorCode: "TOKEN_INVALID" }), "expired");
  assert.equal(tokenHealth({ manualImportEnabled: true }), "manual-import-required");
});

test("payment-event dashboard read flag is opt-in and defaults to booking fallback", () => {
  assert.equal(isPaymentEventsReadEnabled({}), false);
  assert.equal(isPaymentEventsReadEnabled({ AYO_PAYMENT_EVENTS_READ_ENABLED: "false" }), false);
  assert.equal(isPaymentEventsReadEnabled({ AYO_PAYMENT_EVENTS_READ_ENABLED: "TRUE" }), false);
  assert.equal(isPaymentEventsReadEnabled({ AYO_PAYMENT_EVENTS_READ_ENABLED: "true" }), true);
});
