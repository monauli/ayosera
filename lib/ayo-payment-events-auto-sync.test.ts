import assert from "node:assert/strict";
import test from "node:test";
import { maybeSyncAyoPaymentEvents, PAYMENT_EVENT_SYNC_RUN_ID, syncAyoPaymentEventsAutomatically, resolvePaymentEventSyncWindow } from "./ayo-payment-events-auto-sync.ts";
import { normalizeAyoPaymentEvent } from "./ayo-payment-events.ts";

const now = new Date("2026-09-10T12:00:00Z");
const event = (id: number, reservation = `RP-${id}`, total = 100) => normalizeAyoPaymentEvent({ source_table: "order_detail", booking_id: "BK-OLD", reservation_payment_id: reservation, id, payment_date: "2026-09-09T10:00:00Z", total, final_status: "PAID" }, now);

function fake(options: { state?: Record<string, unknown>; existing?: ReturnType<typeof event>[]; fetch?: () => Promise<unknown>; failUpsert?: boolean } = {}) {
  const state: Record<string, unknown> = { _id: "ayo-payment-events-auto-sync", lockUntil: new Date(0), lastSuccessfulSyncAt: null, ...options.state };
  const rows = [...(options.existing ?? [])].map((payload) => ({ ...payload, _id: `${PAYMENT_EVENT_SYNC_RUN_ID}:${payload._id}`, runId: PAYMENT_EVENT_SYNC_RUN_ID, period: "2026-09", eventIdentity: payload.identity, payload, fetchedAt: now }));
  let fetches = 0; let writes = 0;
  const context = {
    state: {
      async findOne() { return state as never; },
      async findOneAndUpdate(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) {
        const expiry = ((filter.$or as Array<{ lockUntil?: { $lte?: Date } }> | undefined)?.[0]?.lockUntil?.$lte) ?? now;
        if (state.lockUntil instanceof Date && state.lockUntil > expiry) return state as never;
        Object.assign(state, update.$set); return state as never;
      },
      async updateOne(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) { if (!filter.runId || filter.runId === state.runId) Object.assign(state, update.$set); },
    },
    events: {
      find() { return { async toArray() { return rows as never; } }; },
      async bulkWrite(operations: unknown[]) { writes += 1; if (options.failUpsert) throw new Error("mongodb://secret-host/write failed AYO_MOBILE_TOKEN=secret"); for (const operation of operations as Array<{ updateOne: { update: { $set: Record<string, unknown> } } }>) { const next = operation.updateOne.update.$set; const index = rows.findIndex((row) => row._id === next._id); if (index < 0) rows.push(next as never); else rows[index] = next as never; } },
    },
    runs: { async updateOne(_filter: Record<string, unknown>, _update: Record<string, unknown>) {} },
    fetch: async () => { fetches += 1; return options.fetch ? await options.fetch() as never : { events: [event(1)], expectedTotalTransaction: 1, expectedTotal: 100 }; },
    now: () => now,
    env: { AYO_PAYMENT_EVENTS_SYNC_START_DATE: "2026-09-01" },
  };
  return { context, state, rows, stats: () => ({ fetches, writes }) };
}

test("overlap seven days, first-run bound, and calendar transitions are deterministic", () => {
  assert.deepEqual(resolvePaymentEventSyncWindow(new Date("2026-09-03T12:00:00Z"), now), { start: "2026-08-27", end: "2026-09-10" });
  assert.deepEqual(resolvePaymentEventSyncWindow(null, new Date("2026-08-05T12:00:00Z"), "2026-08-03"), { start: "2026-08-03", end: "2026-08-05" });
  assert.deepEqual(resolvePaymentEventSyncWindow(new Date("2026-01-03T12:00:00Z"), new Date("2026-01-05T12:00:00Z")), { start: "2025-12-27", end: "2026-01-05" });
});

test("concurrent or unexpired lock skips without double fetch/upsert; expired lock recovers", async () => {
  const locked = fake({ state: { lockUntil: new Date("2026-09-10T12:01:00Z"), runId: "other" } });
  assert.deepEqual(await syncAyoPaymentEventsAutomatically(locked.context), { skipped: true, reason: "locked" });
  assert.deepEqual(locked.stats(), { fetches: 0, writes: 0 });
  const expired = fake({ state: { lockUntil: new Date("2026-09-10T11:00:00Z"), runId: "old" } });
  const result = await syncAyoPaymentEventsAutomatically(expired.context);
  assert.equal(result.skipped, false); assert.deepEqual(expired.stats(), { fetches: 1, writes: 1 });
});

test("overlap rerun is unchanged, a new payment on old booking inserts, and changed payload updates", async () => {
  const unchanged = fake({ existing: [event(1)] });
  const first = await syncAyoPaymentEventsAutomatically(unchanged.context); assert.equal(first.inserted, 0); assert.equal(first.unchanged, 1);
  const added = fake({ existing: [event(1)], fetch: async () => ({ events: [event(1), event(2, "RP-NEW", 200)], expectedTotalTransaction: 2, expectedTotal: 300 }) });
  const second = await syncAyoPaymentEventsAutomatically(added.context); assert.equal(second.inserted, 1); assert.equal(added.rows.length, 2);
  const changed = fake({ existing: [event(1)], fetch: async () => ({ events: [event(1, "RP-1", 150)], expectedTotalTransaction: 1, expectedTotal: 150 }) });
  const third = await syncAyoPaymentEventsAutomatically(changed.context); assert.equal(third.updated, 1); assert.equal(third.inserted, 0);
});

test("fetch or upsert failure keeps checkpoint, sanitizes error, and releases lock for retry", async () => {
  const fetchFailed = fake({ state: { lastSuccessfulSyncAt: new Date("2026-09-03T12:00:00Z") }, fetch: async () => { throw new Error("Token AYO invalid secret-token"); } });
  await assert.rejects(() => syncAyoPaymentEventsAutomatically(fetchFailed.context));
  assert.equal((fetchFailed.state.lastSuccessfulSyncAt as Date).toISOString(), "2026-09-03T12:00:00.000Z"); assert.equal((fetchFailed.state.lockUntil as Date).getTime(), 0);
  const writeFailed = fake({ failUpsert: true }); await assert.rejects(() => syncAyoPaymentEventsAutomatically(writeFailed.context));
  assert.equal(writeFailed.state.lastSuccessfulSyncAt, null); assert.match(String(writeFailed.state.lastError), /redacted/); assert.equal((writeFailed.state.lockUntil as Date).getTime(), 0);
});

test("flag false creates no state/lock and true is reserved for exactly one controlled subtask", async () => {
  assert.deepEqual(await maybeSyncAyoPaymentEvents({ env: {} }), { skipped: true, reason: "disabled" });
  assert.deepEqual(await maybeSyncAyoPaymentEvents({ env: { AYO_PAYMENT_EVENTS_SYNC_ENABLED: "false" } }), { skipped: true, reason: "disabled" });
});

test("rolling run upsert keeps createdAt only on insert and updatedAt only on update", async () => {
  let update: Record<string, Record<string, unknown>> | undefined;
  const sample = fake();
  sample.context.runs = { async updateOne(_filter, value) { update = value as Record<string, Record<string, unknown>>; } };
  await syncAyoPaymentEventsAutomatically(sample.context);
  assert.ok(update?.$setOnInsert.createdAt);
  assert.equal(update?.$setOnInsert.updatedAt, undefined);
  assert.ok(update?.$set.updatedAt);
});
