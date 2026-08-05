import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { collections } from "@/lib/mongodb";
import { fetchAyoPaymentEvents, type AyoPaymentEvent } from "@/lib/ayo-payment-events";
import { assertBackfillWriteAllowed, planBackfill } from "@/lib/ayo-payment-events-backfill";
import { AYO_STAGING_PERIODS, isActivatableRun, type AyoPaymentEventStagingEvent, type AyoPaymentEventStagingRun, type AyoStagingPeriod, validateStagingPeriod } from "@/lib/ayo-payment-event-staging";

type RequestBody = { action?: unknown; runId?: unknown; month?: unknown; dryRun?: unknown; confirm?: unknown; rollbackToRunId?: unknown };
const mutationActions = new Set(["create", "stage", "activate", "rollback"]);

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Backfill AYO gagal.";
  return message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "mongodb://[redacted]").replace(/AYO_MOBILE_TOKEN\s*[=:]\s*[^\s&]+/gi, "AYO_MOBILE_TOKEN=[redacted]");
}

function isPeriod(value: unknown): value is AyoStagingPeriod { return typeof value === "string" && value in AYO_STAGING_PERIODS; }
function responseStatus(run: AyoPaymentEventStagingRun) { return { runId: run._id, status: run.status, periods: run.periods }; }

export async function POST(request: Request) {
  try {
    const user = await requireSupervisor();
    const body = await request.json() as RequestBody;
    const action = typeof body.action === "string" ? body.action : "";
    const dryRun = body.dryRun === true;
    if (!action || (body.dryRun !== undefined && typeof body.dryRun !== "boolean")) return NextResponse.json({ error: "action dan dryRun tidak valid" }, { status: 400 });
    if (mutationActions.has(action) && !(action === "stage" && dryRun)) assertBackfillWriteAllowed({ write: true, confirm: typeof body.confirm === "string" ? body.confirm : undefined });
    const c = await collections();
    const runs = c.ayoPaymentEventStagingRuns;
    const events = c.ayoPaymentEventStagingEvents;
    const activation = c.ayoPaymentEventActivation;
    const audit = c.ayoPaymentEventStagingAuditLogs;

    if (action === "create") {
      const now = new Date();
      const run: AyoPaymentEventStagingRun = { _id: `ayo-staging:${randomUUID()}`, periods: {}, status: "staging", createdAt: now, updatedAt: now, createdBy: user.id };
      await runs.insertOne(run);
      await audit.insertOne({ runId: run._id, action, actor: user.id, createdAt: now });
      return NextResponse.json(responseStatus(run), { status: 201 });
    }

    const runId = typeof body.runId === "string" ? body.runId : "";
    if (!runId) return NextResponse.json({ error: "runId wajib" }, { status: 400 });
    const run = await runs.findOne({ _id: runId });
    if (!run) return NextResponse.json({ error: "staging run tidak ditemukan" }, { status: 404 });

    if (action === "status") return NextResponse.json(responseStatus(run));

    if (action === "stage") {
      if (!isPeriod(body.month)) return NextResponse.json({ error: "month harus 2026-06 atau 2026-07" }, { status: 400 });
      const period = body.month;
      const { start, end } = { start: `${period}-01`, end: `${period}-${period === "2026-06" ? "30" : "31"}` };
      const api = await fetchAyoPaymentEvents(start, end);
      const existing = await events.find({ runId, period }).toArray();
      const plan = planBackfill(api.events, existing.map((event) => event.payload));
      const status = validateStagingPeriod(period, plan.finalProjectedEvents, plan.duplicate, plan.conflict);
      if (api.expectedTotalTransaction !== AYO_STAGING_PERIODS[period].rows || api.expectedTotal !== AYO_STAGING_PERIODS[period].total) status.validationStatus = "invalid";
      const result = { runId, period, apiRows: api.events.length, apiTotal: api.expectedTotal, existingEvents: existing.length, inserted: plan.wouldInsert, updated: plan.wouldUpdate, unchanged: plan.unchanged, duplicate: plan.duplicate, conflict: plan.conflict, finalRows: status.rows, finalTotal: status.total, validationStatus: status.validationStatus };
      if (dryRun || status.validationStatus !== "validated") return NextResponse.json(result, { status: status.validationStatus === "validated" ? 200 : 422 });
      const now = new Date();
      await events.bulkWrite(plan.finalProjectedEvents.map((event) => ({ updateOne: { filter: { _id: `${runId}:${event._id}` }, update: { $set: toStagingEvent(runId, period, event, now) }, upsert: true } })));
      const periods = { ...run.periods, [period]: status };
      const next = { ...run, periods, status: isActivatableRun({ ...run, periods }) ? "validated" : "staging", updatedAt: now } as AyoPaymentEventStagingRun;
      await runs.updateOne({ _id: runId }, { $set: { periods: next.periods, status: next.status, updatedAt: now } });
      await audit.insertOne({ ...result, action, actor: user.id, createdAt: now });
      return NextResponse.json(result);
    }

    if (action === "activate") {
      if (!isActivatableRun(run)) return NextResponse.json({ error: "Juni dan Juli harus tervalidasi lengkap sebelum aktivasi" }, { status: 422 });
      const now = new Date();
      await activation.findOneAndUpdate({ _id: "ayo-payment-events-active" }, { $set: { activeRunId: runId, activatedAt: now, activatedBy: user.id } }, { upsert: true, returnDocument: "after" });
      await runs.updateOne({ _id: runId }, { $set: { status: "active", updatedAt: now } });
      await audit.insertOne({ runId, action, actor: user.id, createdAt: now });
      return NextResponse.json({ ...responseStatus({ ...run, status: "active" }), activeRunId: runId });
    }

    if (action === "rollback") {
      const rollbackToRunId = body.rollbackToRunId === null ? null : typeof body.rollbackToRunId === "string" ? body.rollbackToRunId : null;
      if (rollbackToRunId) {
        const previous = await runs.findOne({ _id: rollbackToRunId });
        if (!isActivatableRun(previous)) return NextResponse.json({ error: "run rollback tidak valid" }, { status: 422 });
      }
      const now = new Date();
      await activation.findOneAndUpdate({ _id: "ayo-payment-events-active" }, { $set: { activeRunId: rollbackToRunId, activatedAt: now, activatedBy: user.id } }, { upsert: true, returnDocument: "after" });
      await audit.insertOne({ runId, action, rollbackToRunId, actor: user.id, createdAt: now });
      return NextResponse.json({ activeRunId: rollbackToRunId });
    }
    return NextResponse.json({ error: "action tidak dikenal" }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

function toStagingEvent(runId: string, period: AyoStagingPeriod, event: AyoPaymentEvent, fetchedAt: Date): AyoPaymentEventStagingEvent {
  return { ...event, _id: `${runId}:${event._id}`, runId, period, eventIdentity: event._id, payload: event, fetchedAt };
}
