import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isActivatableRun, readActiveStagedPaymentEvents, validateStagingPeriod, type AyoPaymentEventStagingRun } from "./ayo-payment-event-staging.ts";
import type { AyoPaymentEvent } from "./ayo-payment-events.ts";

function event(id: string, amount: number): AyoPaymentEvent {
  return { _id: id, bookingId: `BK${id}`, sourceTable: "order_detail", reservationPaymentId: id, nativeId: id, paymentType: null, paymentNote: null, detailStatus: "SUCCESS", finalStatus: "SUCCESS", fieldName: "Padel", date: "2026-06-01", startTime: null, endTime: null, total: amount, finalFeeAyo: 0, isCredit: false, raw: {}, syncedAt: new Date() };
}
function valid(period: "2026-06" | "2026-07", rows: number, total: number) {
  const events = Array.from({ length: rows }, (_, index) => event(`${period}-${index}`, index + 1 === rows ? total : 0));
  return validateStagingPeriod(period, events, 0, 0);
}
function run(periods: AyoPaymentEventStagingRun["periods"]): AyoPaymentEventStagingRun { return { _id: "run-a", periods, status: "validated", createdAt: new Date(), updatedAt: new Date(), createdBy: "supervisor" }; }

test("Juni parsial atau Juli belum ada tidak dapat diaktifkan", () => {
  assert.equal(isActivatableRun(run({ "2026-06": { rows: 1, total: 1, duplicate: 0, conflict: 0, validationStatus: "invalid" } })), false);
  assert.equal(isActivatableRun(run({ "2026-06": valid("2026-06", 1421, 242895499) })), false);
});

test("kedua bulan valid dapat aktif; duplicate atau conflict menolak run", () => {
  const periods = { "2026-06": valid("2026-06", 1421, 242895499), "2026-07": valid("2026-07", 1359, 237491000) };
  assert.equal(isActivatableRun(run(periods)), true);
  assert.equal(isActivatableRun(run({ ...periods, "2026-07": { ...periods["2026-07"], conflict: 1, validationStatus: "invalid" } })), false);
});

test("hanya pointer run aktif tervalidasi dibaca; Mei, run lain, dan error Mongo fallback null", async () => {
  const periods = { "2026-06": valid("2026-06", 1421, 242895499), "2026-07": valid("2026-07", 1359, 237491000) };
  const context = {
    activation: { findOne: async () => ({ _id: "ayo-payment-events-active" as const, activeRunId: "run-a", activatedAt: new Date(), activatedBy: "supervisor" }) },
    runs: { findOne: async () => run(periods) },
    events: { find: (filter: Record<string, unknown>) => ({ toArray: async () => filter.runId === "run-a" && filter.period === "2026-06" ? Array.from({ length: 1421 }, (_, index) => ({ ...event(String(index), index + 1 === 1421 ? 242895499 : 0), _id: `run-a:${index}`, runId: "run-a", period: "2026-06" as const, eventIdentity: String(index), payload: event(String(index), index + 1 === 1421 ? 242895499 : 0), fetchedAt: new Date() })) : [] }) },
  };
  assert.equal((await readActiveStagedPaymentEvents("2026-05-01", "2026-05-31", context)) === null, true);
  assert.equal((await readActiveStagedPaymentEvents("2026-06-01", "2026-06-30", context))?.events.length, 1421);
  const broken = { ...context, events: { find: () => ({ toArray: async () => { throw new Error("Mongo error"); } }) } };
  assert.equal(await readActiveStagedPaymentEvents("2026-06-01", "2026-06-30", broken), null);
});

test("dashboard memakai staging aktif, bukan koleksi payment-event lama", async () => {
  const source = await readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8");
  assert.match(source, /readActiveStagedPaymentEvents/);
  assert.doesNotMatch(source, /ayoPaymentEvents|ayoPaymentPeriods|readValidatedPaymentEvents/);
});

test("aktivasi memakai satu pointer atomik, rollback tidak menghapus, dan Olsera tidak memakai staging", async () => {
  const [route, courtSource, ledger] = await Promise.all([
    readFile(new URL("../app/api/supervisor/ayo-payment-events/backfill/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./reconciliation-court-revenue-source.ts", import.meta.url), "utf8"),
    readFile(new URL("./reconciliation-omzet-ledger.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /findOneAndUpdate\(\{ _id: "ayo-payment-events-active" \}/);
  assert.match(route, /activeRunId: rollbackToRunId/);
  assert.doesNotMatch(route, /deleteMany|deleteOne|drop\(|createIndex/);
  assert.doesNotMatch(courtSource, /ayoPaymentEventStaging/);
  assert.doesNotMatch(ledger, /ayoPaymentEventStaging/);
});
