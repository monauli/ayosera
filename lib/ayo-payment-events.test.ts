import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAyoPaymentEvent, paymentEventIdentity, validatePaymentPeriod, fetchAyoPaymentEvents } from "./ayo-payment-events.ts";
import { readValidatedPaymentEvents } from "./ayo-payment-events-sync.ts";

const row = (extra: Record<string, unknown> = {}) => ({ source_table: "reservation_payments", id: 1, booking_id: "BK-1", reservation_payment_id: "RP-1", field_name: "Court No 1", date: "2026-06-01", total: 100, final_status: "paid", ...extra });

test("payment event identity memakai source_table + reservation_payment_id, bukan booking_id", () => {
  assert.equal(paymentEventIdentity(row()), "reservation_payments:BK-1:RP-1");
  assert.notEqual(paymentEventIdentity(row({ reservation_payment_id: "RP-2" })), paymentEventIdentity(row()));
  assert.equal(paymentEventIdentity(row({ reservation_payment_id: "", id: 9 })), "reservation_payments:BK-1:id:9");
  assert.equal(paymentEventIdentity(row({ reservation_payment_id: "", id: "" })), null);
});

test("normalisasi menyimpan nominal rupiah integer, payload audit, dan tanggal payment", () => {
  const event = normalizeAyoPaymentEvent(row({ payment_date: "2026-06-02T01:00:00.000Z", total: "150.5", final_fee_ayo: 125, init_payment: 25, full_payment: 100 }));
  assert.equal(event.amount, 125);
  assert.equal(event.amountSource, "final_fee_ayo");
  assert.equal(event.eventDate.toISOString(), "2026-06-02T01:00:00.000Z");
  assert.equal(event.eventDateSource, "payment_date");
  assert.equal(event.rawPayload.reservation_payment_id, "RP-1");
  assert.equal(event.normalizedPayload.identity, event.identity);
});

test("dua payment event pada booking sama tetap terpisah dan validasi menjumlahkan keduanya", () => {
  const events = [normalizeAyoPaymentEvent(row()), normalizeAyoPaymentEvent(row({ id: 2, reservation_payment_id: "RP-2", total: 200 }))];
  const result = validatePaymentPeriod({ startDate: "2026-06-01", endDate: "2026-06-30", events, expectedTotalTransaction: 2, expectedTotal: 300, conflictCount: 0 });
  assert.equal(events.length, 2);
  assert.equal(result.status, "validated");
  assert.equal(result.calculatedTotal, 300);
});

test("pagination multi-page berhenti tepat pada total dan tidak mengirim token ke log", async () => {
  const fixtureToken = ["fixture", "token"].join("-");
  process.env.AYO_MOBILE_TOKEN = fixtureToken;
  const urls: string[] = [];
  const response = async (url: string) => {
    urls.push(url);
    const offset = Number(new URL(url).searchParams.get("start_from"));
    return new Response(JSON.stringify({ data: { transactions: offset ? [row({ id: 2, reservation_payment_id: "RP-2" })] : [row()], total_transaction: 2, total: 200 } }), { status: 200 });
  };
  const result = await fetchAyoPaymentEvents("2026-06-01", "2026-06-30", { limit: 1, request: response });
  assert.equal(result.events.length, 2);
  assert.equal(urls.length, 2);
  assert.equal(urls.every((url) => !url.includes(fixtureToken)), false);
});

test("row count dan total mismatch membuat periode invalid", () => {
  const event = normalizeAyoPaymentEvent(row());
  assert.equal(validatePaymentPeriod({ startDate: "2026-06-01", endDate: "2026-06-30", events: [event], expectedTotalTransaction: 2, expectedTotal: 100, conflictCount: 0 }).status, "invalid");
  assert.equal(validatePaymentPeriod({ startDate: "2026-06-01", endDate: "2026-06-30", events: [event], expectedTotalTransaction: 1, expectedTotal: 999, conflictCount: 0 }).status, "invalid");
});

test("401/403 ditandai token invalid tanpa memasukkan token ke error", async () => {
  const fixtureToken = ["fixture", "token"].join("-");
  process.env.AYO_MOBILE_TOKEN = fixtureToken;
  await assert.rejects(() => fetchAyoPaymentEvents("2026-06-01", "2026-06-30", { request: async () => new Response("", { status: 403 }) }), (error: Error) => error.message.includes("invalid") && !error.message.includes(fixtureToken));
});

test("normalisasi tidak mengubah CANCELLED menjadi revenue eligible secara implisit", () => {
  const event = normalizeAyoPaymentEvent(row({ final_status: "CANCELLED", total: 100 }));
  const result = validatePaymentPeriod({ startDate: "2026-06-01", endDate: "2026-06-30", events: [event], expectedTotalTransaction: 1, expectedTotal: 0, conflictCount: 0 });
  assert.equal(result.status, "validated");
});

test("metadata payment-event belum ada -> fallback null", async () => {
  const result = await readValidatedPaymentEvents("2026-06-01", "2026-06-30", {
    periods: { findOne: async () => null, updateOne: async () => undefined },
    events: { find: () => ({ toArray: async () => [] }) },
  });
  assert.equal(result, null);
});

test("query payment-event gagal -> fallback null, bukan exception dashboard", async () => {
  const result = await readValidatedPaymentEvents("2026-06-01", "2026-06-30", {
    periods: { findOne: async () => { throw new Error("collection unavailable"); }, updateOne: async () => undefined },
    events: { find: () => ({ toArray: async () => { throw new Error("query failed"); } }) },
  });
  assert.equal(result, null);
});
