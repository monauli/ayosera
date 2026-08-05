import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBackfillWriteAllowed, planBackfill } from "./ayo-payment-events-backfill.ts";
import { normalizeAyoPaymentEvent } from "./ayo-payment-events.ts";
import { readValidatedPaymentEvents } from "./ayo-payment-events-sync.ts";

const event = (extra: Record<string, unknown> = {}) => normalizeAyoPaymentEvent({ source_table: "order_detail", booking_id: "BK-1", reservation_payment_id: "RP-1", id: 1, date: "2026-06-01", field_name: "Court No 1", total: 100, final_status: "PAID", ...extra });

test("write guard membutuhkan confirmation exact", () => {
  assert.throws(() => assertBackfillWriteAllowed({ write: true }), /BACKFILL_AYO_PAYMENT_EVENTS/);
  assert.doesNotThrow(() => assertBackfillWriteAllowed({ write: true, confirm: "BACKFILL_AYO_PAYMENT_EVENTS" }));
});

test("plan idempotent membedakan insert/update/unchanged tanpa delete", () => {
  const current = event();
  const plan = planBackfill([current], [current]);
  assert.equal(plan.wouldInsert, 0);
  assert.equal(plan.wouldUpdate, 0);
  assert.equal(plan.unchanged, 1);
});

test("conflict identity terdeteksi dan tidak dihapus", () => {
  const plan = planBackfill([event(), event({ total: 200 })], []);
  assert.equal(plan.conflict, 1);
  assert.equal(plan.finalProjectedRows, 1);
});

test("payment-event collection gagal dibaca -> fallback null, bukan exception dashboard", async () => {
  const result = await readValidatedPaymentEvents("2026-06-01", "2026-06-30", {
    periods: { findOne: async () => { throw new Error("collection unavailable"); }, updateOne: async () => undefined },
    events: { find: () => ({ toArray: async () => { throw new Error("query failed"); } }) },
  });
  assert.equal(result, null);
});

test("metadata periode belum ada -> fallback null", async () => {
  const result = await readValidatedPaymentEvents("2026-06-01", "2026-06-30", {
    periods: { findOne: async () => null, updateOne: async () => undefined },
    events: { find: () => ({ toArray: async () => [] }) },
  });
  assert.equal(result, null);
});
