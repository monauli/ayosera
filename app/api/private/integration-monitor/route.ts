import { NextResponse } from "next/server";
import { z } from "zod";
import { compareAyoGap, type AyoGapSource, type AyoGapStatus, type GapComparison, type GapRow } from "@/lib/ayo-data-gap";
import { fetchAyoBookingsByDateRange } from "@/lib/ayo";
import { normalizeBooking } from "@/lib/booking-mapper";
import { fetchAyoPaymentEvents, paymentEventIdentity } from "@/lib/ayo-payment-events";
import { collections, getDb } from "@/lib/mongodb";
import { integrationTokenHealth, requirePrivateToolsUser } from "@/lib/private-integration-monitor";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  source: z.enum(["ayo-booking", "ayo-payment-events"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  action: z.enum(["check", "repair"]),
});
const maxRangeDays = 31;
const stateId = (source: AyoGapSource, startDate: string, endDate: string) => `ayo-gap:${source}:${startDate}:${endDate}`;
const lockId = (source: AyoGapSource, startDate: string, endDate: string) => `ayo-gap-lock:${source}:${startDate}:${endDate}`;

type StoredAudit = GapComparison & {
  _id: string;
  source: AyoGapSource;
  checkedAt: string;
  range: { startDate: string; endDate: string };
  startedBy: string;
  completedAt: Date;
};
type AuditResult = Omit<GapComparison, "status"> & {
  source: AyoGapSource;
  checkedAt: string;
  range: { startDate: string; endDate: string };
  startedBy: string;
  repaired: number;
  status: AyoGapStatus;
};

function rangeIsValid(startDate: string, endDate: string) {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start && ((end - start) / 86_400_000) + 1 <= maxRangeDays;
}

async function acquireLock(source: AyoGapSource, startDate: string, endDate: string, actor: string) {
  const locks = (await getDb()).collection<{ _id: string; lockedUntil: Date; actor: string }>("data_gap_audit_locks");
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + 5 * 60_000);
  let result;
  try {
    result = await locks.findOneAndUpdate(
      { _id: lockId(source, startDate, endDate), $or: [{ lockedUntil: { $lte: now } }, { lockedUntil: { $exists: false } }] },
      { $set: { lockedUntil, actor } },
      { upsert: true, returnDocument: "after" },
    );
  } catch { throw new Error("AUDIT_LOCKED"); }
  if (!result || result.actor !== actor || result.lockedUntil.getTime() !== lockedUntil.getTime()) throw new Error("AUDIT_LOCKED");
  return async () => { await locks.updateOne({ _id: lockId(source, startDate, endDate), actor }, { $set: { lockedUntil: new Date(0) } }); };
}

async function loadRows(source: AyoGapSource, startDate: string, endDate: string): Promise<{ sourceRows: GapRow[]; localRows: GapRow[] }> {
  const dbCollections = await collections();
  if (source === "ayo-booking") {
    const api = await fetchAyoBookingsByDateRange({ start_date: startDate, end_date: endDate });
    return { sourceRows: api.data.map(normalizeBooking), localRows: await dbCollections.bookings.find({ date: { $gte: startDate, $lte: endDate } }).toArray() };
  }
  const api = await fetchAyoPaymentEvents(startDate, endDate);
  return { sourceRows: api.events, localRows: await dbCollections.ayoPaymentEvents.find({ date: { $gte: startDate, $lte: endDate } }).toArray() };
}

function identity(source: AyoGapSource, row: GapRow) {
  if (source === "ayo-booking" && "booking_id" in row) return row.booking_id || null;
  if (source === "ayo-payment-events" && "identity" in row) return row.identity || paymentEventIdentity(row.raw);
  return null;
}

async function runAyoGapAudit(source: AyoGapSource, startDate: string, endDate: string, actor: string, acquire = true): Promise<AuditResult> {
  const release = acquire ? await acquireLock(source, startDate, endDate, actor) : null;
  try {
    const { sourceRows, localRows } = await loadRows(source, startDate, endDate);
    const compared = compareAyoGap(sourceRows, localRows, (row) => identity(source, row));
    const result: AuditResult = { ...compared, source, checkedAt: new Date().toISOString(), range: { startDate, endDate }, startedBy: actor, repaired: 0 };
    const db = await getDb();
    await db.collection<StoredAudit>("data_gap_audit_state").updateOne(
      { _id: stateId(source, startDate, endDate) },
      { $set: { ...result, status: compared.status, _id: stateId(source, startDate, endDate), completedAt: new Date() } },
      { upsert: true },
    );
    await db.collection("data_gap_audit_runs").insertOne({ source, action: "check", status: result.status, range: result.range, counts: auditCounts(result), actor, createdAt: new Date() });
    return result;
  } finally { if (release) await release(); }
}

function auditCounts(result: AuditResult) {
  const { sourceCount, localCount, matchedCount, missingLocalCount, localOnlyCount, conflictCount, duplicateIdentityCount, sourceIncompleteCount } = result;
  return { sourceCount, localCount, matchedCount, missingLocalCount, localOnlyCount, conflictCount, duplicateIdentityCount, sourceIncompleteCount };
}

async function repair(source: AyoGapSource, startDate: string, endDate: string, actor: string): Promise<AuditResult> {
  const db = await getDb();
  const stored = await db.collection<StoredAudit>("data_gap_audit_state").findOne({ _id: stateId(source, startDate, endDate) });
  if (!stored || stored.status !== "GAP_FOUND" || !stored.missingIdentities.length || Date.now() - stored.completedAt.getTime() > 15 * 60_000) throw new Error("REPAIR_REQUIRES_FRESH_GAP_AUDIT");
  const release = await acquireLock(source, startDate, endDate, actor);
  try {
    const { sourceRows, localRows } = await loadRows(source, startDate, endDate);
    const byIdentity = new Map(sourceRows.map((row) => [identity(source, row), row]));
    const localIdentities = new Set(localRows.map((row) => identity(source, row)));
    // The stored audit is the sole repair allowlist. A fresh local read merely
    // avoids overwriting a record that another safe process already inserted.
    const auditedRows = stored.missingIdentities.map((key) => byIdentity.get(key)).filter((row): row is GapRow => Boolean(row));
    if (auditedRows.length !== stored.missingIdentities.length) throw new Error("SOURCE_INCOMPLETE");
    const rows = auditedRows.filter((row) => !localIdentities.has(identity(source, row)));
    if (source === "ayo-booking") {
      await (await collections()).bookings.bulkWrite(rows.map((row) => ({ updateOne: { filter: { booking_id: (row as { booking_id: string }).booking_id }, update: { $setOnInsert: row }, upsert: true } })));
    } else {
      const events = rows as Awaited<ReturnType<typeof fetchAyoPaymentEvents>>["events"];
      await (await collections()).ayoPaymentEvents.bulkWrite(events.map((event) => ({ updateOne: { filter: { _id: event._id }, update: { $setOnInsert: event }, upsert: true } })));
    }
    const after = await runAyoGapAudit(source, startDate, endDate, actor, false);
    const result: AuditResult = after.status === "SYNCED" && after.missingLocalCount === 0 ? { ...after, status: "REPAIRED", repaired: rows.length } : after;
    await db.collection("data_gap_audit_runs").insertOne({ source, action: "repair", status: result.status, range: result.range, counts: auditCounts(result), repaired: rows.length, actor, createdAt: new Date() });
    return result;
  } finally { await release(); }
}

export async function GET() {
  try { await requirePrivateToolsUser(); return NextResponse.json({ enabled: true, tokenHealth: integrationTokenHealth() }, { headers: NO_CACHE_HEADERS }); }
  catch (error) { if (error instanceof Response) return error; return NextResponse.json({ error: "Gagal memuat monitoring integritas." }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requirePrivateToolsUser();
    const body = schema.parse(await request.json());
    if (!rangeIsValid(body.startDate, body.endDate)) return NextResponse.json({ error: "Rentang tanggal harus valid dan maksimal 31 hari." }, { status: 400 });
    const result = body.action === "repair" ? await repair(body.source, body.startDate, body.endDate, user.id) : await runAyoGapAudit(body.source, body.startDate, body.endDate, user.id);
    return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Payload audit tidak valid." }, { status: 400 });
    const status = error instanceof Error && error.message === "AUDIT_LOCKED" ? "LOCKED" : error instanceof Error && error.message === "REPAIR_REQUIRES_FRESH_GAP_AUDIT" ? "MANUAL_REVIEW_REQUIRED" : error instanceof Error && /token|unauthorized|401|403/i.test(error.message) ? "TOKEN_ERROR" : "SOURCE_INCOMPLETE";
    return NextResponse.json({ status, error: "Audit sumber gagal atau tidak lengkap." }, { status: 200, headers: NO_CACHE_HEADERS });
  }
}
