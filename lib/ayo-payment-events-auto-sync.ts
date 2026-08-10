import "server-only";
import { randomUUID } from "node:crypto";
import { planBackfill } from "./ayo-payment-events-backfill.ts";
import { aggregatePaymentEvents, planPaymentEventUpsert } from "./ayo-payment-events-engine.ts";
import { fetchAyoPaymentEvents, validatePaymentPeriod } from "./ayo-payment-events.ts";
import type { AyoPaymentEventStagingEvent, AyoPaymentEventStagingRun } from "./ayo-payment-event-staging.ts";
import type { AyoPaymentEventSyncStateDocument } from "./mongodb.ts";

export const PAYMENT_EVENT_SYNC_STATE_ID = "ayo-payment-events-auto-sync" as const;
export const PAYMENT_EVENT_SYNC_RUN_ID = "ayo-sync:rolling";
export const PAYMENT_EVENT_SYNC_OVERLAP_DAYS = 7;
const LOCK_MS = 55_000;

export function isPaymentEventsSyncEnabled(env: Record<string, string | undefined> = process.env) { return env.AYO_PAYMENT_EVENTS_SYNC_ENABLED === "true"; }

function jakartaDate(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function shiftDays(date: string, days: number) { const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function safeError(error: unknown) { return (error instanceof Error ? error.message : "AYO payment-event sync gagal.").replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "mongodb://[redacted]").replace(/AYO_MOBILE_TOKEN\s*[=:]\s*[^\s&]+/gi, "AYO_MOBILE_TOKEN=[redacted]"); }

export function resolvePaymentEventSyncWindow(lastSuccessfulSyncAt: Date | null, now: Date, initialStart?: string) {
  const end = jakartaDate(now);
  const configured = initialStart && /^\d{4}-\d{2}-\d{2}$/.test(initialStart) ? initialStart : `${end.slice(0, 7)}-01`;
  const start = lastSuccessfulSyncAt ? shiftDays(lastSuccessfulSyncAt.toISOString().slice(0, 10), -PAYMENT_EVENT_SYNC_OVERLAP_DAYS) : configured;
  return { start: start > end ? end : start, end };
}

type State = Partial<AyoPaymentEventSyncStateDocument> & { _id: typeof PAYMENT_EVENT_SYNC_STATE_ID; lockUntil?: Date };
type StateCollection = { findOne(filter: Record<string, unknown>): Promise<State | null>; findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, options: { upsert: true; returnDocument: "after" }): Promise<State | null>; updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: { upsert?: boolean }): Promise<unknown> };
type EventsCollection = { find(filter: Record<string, unknown>): { toArray(): Promise<AyoPaymentEventStagingEvent[]> }; bulkWrite(operations: unknown[]): Promise<unknown> };
type RunsCollection = { updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options: { upsert: true }): Promise<unknown> };
export type PaymentEventAutoSyncContext = { state: StateCollection; events: EventsCollection; runs: RunsCollection; fetch?: typeof fetchAyoPaymentEvents; now?: () => Date; env?: Record<string, string | undefined> };

export async function syncAyoPaymentEventsAutomatically(context: PaymentEventAutoSyncContext) {
  const now = (context.now ?? (() => new Date()))();
  const runId = randomUUID();
  const lockUntil = new Date(now.getTime() + LOCK_MS);
  const locked = await context.state.findOneAndUpdate({ _id: PAYMENT_EVENT_SYNC_STATE_ID, $or: [{ lockUntil: { $lte: now } }, { lockUntil: { $exists: false } }] }, { $set: { lockUntil, lastAttemptAt: now, source: "ayo-report-transactions", runId } }, { upsert: true, returnDocument: "after" });
  if (!locked || locked.runId !== runId) return { skipped: true as const, reason: "locked" as const };
  try {
    const window = resolvePaymentEventSyncWindow(locked.lastSuccessfulSyncAt ?? null, now, context.env?.AYO_PAYMENT_EVENTS_SYNC_START_DATE);
    const api = await (context.fetch ?? fetchAyoPaymentEvents)(window.start, window.end);
    const normalized = planPaymentEventUpsert(api.events);
    const validation = validatePaymentPeriod({ startDate: window.start, endDate: window.end, events: normalized.events, expectedTotalTransaction: api.expectedTotalTransaction, expectedTotal: api.expectedTotal, conflictCount: normalized.conflicts + normalized.invalid });
    if (validation.status !== "validated") throw new Error(`Payment-event batch invalid: ${validation.reason ?? "unknown"}`);
    const existing = await context.events.find({ runId: PAYMENT_EVENT_SYNC_RUN_ID, eventDate: { $gte: new Date(`${window.start}T00:00:00.000Z`), $lte: new Date(`${window.end}T23:59:59.999Z`) } }).toArray();
    const plan = planBackfill(normalized.events, existing.map((event) => event.payload));
    if (plan.conflict) throw new Error("Payment-event identity conflict.");
    const fetchedAt = (context.now ?? (() => new Date()))();
    await context.events.bulkWrite(plan.finalProjectedEvents.map((event) => ({ updateOne: { filter: { _id: `${PAYMENT_EVENT_SYNC_RUN_ID}:${event._id}` }, update: { $set: { ...event, _id: `${PAYMENT_EVENT_SYNC_RUN_ID}:${event._id}`, runId: PAYMENT_EVENT_SYNC_RUN_ID, period: event.eventDate.toISOString().slice(0, 7), eventIdentity: event.identity, payload: event, fetchedAt } }, upsert: true } })));
    const aggregate = aggregatePaymentEvents(normalized.events);
    const run: Omit<AyoPaymentEventStagingRun, "updatedAt"> = { _id: PAYMENT_EVENT_SYNC_RUN_ID, periods: {}, status: "staging", createdAt: now, createdBy: "auto-sync" };
    await context.runs.updateOne({ _id: PAYMENT_EVENT_SYNC_RUN_ID }, { $setOnInsert: run, $set: { updatedAt: fetchedAt } }, { upsert: true });
    await context.state.updateOne({ _id: PAYMENT_EVENT_SYNC_STATE_ID, runId }, { $set: { lastSuccessfulSyncAt: fetchedAt, periodStart: window.start, periodEnd: window.end, rowsFetched: api.events.length, inserted: plan.wouldInsert, updated: plan.wouldUpdate, unchanged: plan.unchanged, duplicate: normalized.duplicates, conflict: normalized.conflicts + plan.conflict, invalid: normalized.invalid, totalAmount: aggregate.totalAmount, lastError: null, lockUntil: new Date(0), source: "ayo-report-transactions", runId } });
    return { skipped: false as const, window, rowsFetched: api.events.length, inserted: plan.wouldInsert, updated: plan.wouldUpdate, unchanged: plan.unchanged, duplicate: normalized.duplicates, conflict: normalized.conflicts + plan.conflict, invalid: normalized.invalid, totalAmount: aggregate.totalAmount };
  } catch (error) {
    await context.state.updateOne({ _id: PAYMENT_EVENT_SYNC_STATE_ID, runId }, { $set: { lastError: safeError(error), lockUntil: new Date(0) } });
    throw error;
  }
}

export async function maybeSyncAyoPaymentEvents(context?: Partial<PaymentEventAutoSyncContext>) {
  if (!isPaymentEventsSyncEnabled(context?.env)) return { skipped: true as const, reason: "disabled" as const };
  const { collections } = await import("./mongodb.ts");
  const c = await collections();
  return syncAyoPaymentEventsAutomatically({ state: c.ayoPaymentEventSyncState as unknown as StateCollection, events: c.ayoPaymentEventStagingEvents as unknown as EventsCollection, runs: c.ayoPaymentEventStagingRuns as unknown as RunsCollection, ...context });
}
