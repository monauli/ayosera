import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { getDb } from "@/lib/mongodb";
import { fetchAyoPaymentEvents, paymentEventRevenue, validatePaymentPeriod, type AyoPaymentEvent, type AyoPaymentPeriodMetadata } from "@/lib/ayo-payment-events";
import { assertBackfillWriteAllowed, BACKFILL_CONFIRM, planBackfill } from "@/lib/ayo-payment-events-backfill";

const TARGETS: Record<string, { rows: number; total: number }> = {
  "2026-02": { rows: 375, total: 107593500 }, "2026-03": { rows: 745, total: 197855000 },
  "2026-04": { rows: 1160, total: 242129999 }, "2026-05": { rows: 1515, total: 277457500 },
  "2026-06": { rows: 1421, total: 242895499 }, "2026-07": { rows: 1359, total: 237491000 },
};

function dates(period: string) {
  const [year, month] = period.split("-").map(Number);
  return { start: `${period}-01`, end: `${period}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}` };
}

export async function POST(request: Request) {
  try {
    await requireSupervisor();
    const body = await request.json() as { month?: unknown; dryRun?: unknown; confirm?: unknown };
    const month = typeof body.month === "string" ? body.month : "";
    if (!TARGETS[month]) return NextResponse.json({ error: "month harus 2026-02 sampai 2026-07" }, { status: 400 });
    const dryRun = body.dryRun === true;
    if (body.dryRun !== true && body.dryRun !== false) return NextResponse.json({ error: "dryRun wajib boolean" }, { status: 400 });
    assertBackfillWriteAllowed({ write: !dryRun, confirm: typeof body.confirm === "string" ? body.confirm : undefined });

    const { start, end } = dates(month);
    const api = await fetchAyoPaymentEvents(start, end);
    const db = await getDb();
    const events = db.collection<AyoPaymentEvent>("ayo_payment_events");
    const periods = db.collection<AyoPaymentPeriodMetadata>("ayo_payment_periods");
    const audit = db.collection("ayo_payment_event_backfill_audit_logs");
    const existing = await events.find({ date: { $gte: start, $lte: end } }).toArray();
    const plan = planBackfill(api.events, existing);
    const calculatedTotal = plan.finalProjectedEvents.reduce((sum, event) => sum + paymentEventRevenue(event), 0);
    const target = TARGETS[month];
    const validation = validatePaymentPeriod({ startDate: start, endDate: end, events: plan.finalProjectedEvents, expectedTotalTransaction: target.rows, expectedTotal: target.total, conflictCount: plan.conflict });
    const validationStatus = api.expectedTotalTransaction === target.rows && api.expectedTotal === target.total && validation.status === "validated" ? "validated" : "invalid";
    const result = { apiRows: api.events.length, apiTotal: api.expectedTotal, existingEvents: existing.length, inserted: plan.wouldInsert, updated: plan.wouldUpdate, unchanged: plan.unchanged, conflict: plan.conflict, finalRows: plan.finalProjectedRows, finalTotal: calculatedTotal, validationStatus };
    if (dryRun || validationStatus !== "validated") return NextResponse.json(result, { status: validationStatus === "validated" ? 200 : 422 });

    const runId = `backfill-ayo-payment-events:${month}:${new Date().toISOString()}`;
    const now = new Date();
    if (plan.finalProjectedEvents.length) await events.bulkWrite(plan.finalProjectedEvents.map((event) => ({ updateOne: { filter: { _id: event._id }, update: { $set: event }, upsert: true } })));
    await periods.updateOne({ _id: `${start}:${end}` }, { $set: { _id: `${start}:${end}`, startDate: start, endDate: end, fetchedRows: plan.finalProjectedRows, expectedTotalTransaction: target.rows, calculatedTotal, expectedTotal: target.total, validationStatus: "validated", lastSuccessfulSyncAt: now, errorCode: null, errorMessage: null, conflictCount: 0, updatedAt: now } }, { upsert: true });
    await audit.insertOne({ runId, period: month, inserted: plan.wouldInsert, updated: plan.wouldUpdate, unchanged: plan.unchanged, duplicate: plan.duplicate, conflict: plan.conflict, status: "success", createdAt: now });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Backfill AYO gagal.";
    return NextResponse.json({ error: message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "mongodb://[redacted]").replace(/AYO_MOBILE_TOKEN\s*[=:]\s*[^\s&]+/gi, "AYO_MOBILE_TOKEN=[redacted]") }, { status: 500 });
  }
}
