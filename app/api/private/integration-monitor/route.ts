import { NextResponse } from "next/server";
import { z } from "zod";
import { compareAyoGap, type AyoGapSource, type AyoGapStatus, type GapComparison, type GapRow } from "@/lib/ayo-data-gap";
import { fetchAyoBookingsByDateRange } from "@/lib/ayo";
import { normalizeBooking } from "@/lib/booking-mapper";
import { fetchAyoPaymentEvents, paymentEventIdentity } from "@/lib/ayo-payment-events";
import { fetchOlseraSalesAuditSource, OlseraSalesAuditSourceError } from "@/lib/olsera-sync";
import { compareOlseraSalesGap, type OlseraAuditItem, type OlseraAuditOrder } from "@/lib/olsera-sales-gap";
import { collections, getDb } from "@/lib/mongodb";
import { integrationTokenHealth, classifyAyoMobileToken } from "@/lib/private-integration-monitor";
import { getConnectionHealthSummary } from "@/lib/connection-health";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  source: z.enum(["olsera", "ayo-booking", "ayo-payment-events"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  action: z.enum(["check", "repair"]),
});
const maxRangeDays = 31;
const stateId = (source: AyoGapSource, startDate: string, endDate: string) => `ayo-gap:${source}:${startDate}:${endDate}`;
const lockId = (source: string, startDate: string, endDate: string) => `${source}-gap-lock:${startDate}:${endDate}`;
const olseraStateId = (startDate: string, endDate: string) => `olsera-sales-gap:${startDate}:${endDate}`;

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

async function acquireLock(source: string, startDate: string, endDate: string, actor: string) {
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

type OlseraAuditResult = Omit<ReturnType<typeof compareOlseraSalesGap>, "status"> & { status: import("@/lib/olsera-sales-gap").OlseraGapStatus; source: "olsera"; startedAt: string; checkedAt: string; completedAt: string; range: { startDate: string; endDate: string }; startedBy: string; repaired: number };

async function loadOlseraRows(startDate: string, endDate: string) {
  const source = await fetchOlseraSalesAuditSource(startDate, endDate);
  const localDocs = await (await collections()).olseraOrderItems.find({ date: { $gte: startDate, $lte: endDate } }).toArray();
  const localItems: OlseraAuditItem[] = localDocs.map((row) => ({ identity: String(row._id), orderIdentity: row.orderNo, productId: row.productId ?? null, variantId: row.variantId ?? null, sku: row.sku ?? null, qty: row.qty, amount: row.amount }));
  const orderTotals = new Map<string, number>();
  for (const row of localItems) orderTotals.set(row.orderIdentity, (orderTotals.get(row.orderIdentity) ?? 0) + row.amount);
  const localOrders: OlseraAuditOrder[] = [...orderTotals].map(([identity, total]) => ({ identity, total, status: null }));
  return { source, localDocs, localItems, localOrders };
}

async function runOlseraGapAudit(startDate: string, endDate: string, actor: string): Promise<OlseraAuditResult> {
  const startedAt = new Date().toISOString();
  const release = await acquireLock("olsera-sales", startDate, endDate, actor);
  try {
    const { source, localItems, localOrders } = await loadOlseraRows(startDate, endDate);
    const compared = compareOlseraSalesGap(source.orders, localOrders, source.items, localItems);
    const result: OlseraAuditResult = { ...compared, source: "olsera", startedAt, checkedAt: new Date().toISOString(), completedAt: new Date().toISOString(), range: { startDate, endDate }, startedBy: actor, repaired: 0 };
    const db = await getDb();
    await db.collection<{ _id: string } & Record<string, unknown>>("data_gap_audit_state").updateOne({ _id: olseraStateId(startDate, endDate) }, { $set: { ...result, completedAt: new Date() } }, { upsert: true });
    await db.collection<Record<string, unknown>>("data_gap_audit_runs").insertOne({ source: "olsera", action: "CHECK_COMPLETED", status: result.status, range: result.range, counts: result, actor, createdAt: new Date() });
    return result;
  } finally { await release(); }
}

async function repairOlsera(startDate: string, endDate: string, actor: string): Promise<OlseraAuditResult> {
  const db = await getDb(); const stored = await db.collection<OlseraAuditResult & { _id: string; completedAt: Date }>("data_gap_audit_state").findOne({ _id: olseraStateId(startDate, endDate) });
  if (!stored || stored.status !== "GAP_FOUND" || Date.now() - stored.completedAt.getTime() > 15 * 60_000) throw new Error("REPAIR_REQUIRES_FRESH_GAP_AUDIT");
  const release = await acquireLock("olsera-sales", startDate, endDate, actor);
  try {
    const { source, localDocs } = await loadOlseraRows(startDate, endDate);
    const localIds = new Set(localDocs.map((row) => String(row._id))); const sourceById = new Map(source.items.map((row) => [row.identity, row]));
    const rows = stored.missingItemIdentities.map((id) => sourceById.get(id)).filter((row): row is typeof source.items[number] => Boolean(row));
    if (rows.length !== stored.missingItemIdentities.length) throw new Error("SOURCE_INCOMPLETE");
    await (await collections()).olseraOrderItems.bulkWrite(rows.filter((row) => !localIds.has(row.identity)).map((row) => ({ updateOne: { filter: { _id: Number(row.identity) }, update: { $setOnInsert: { _id: Number(row.identity), date: row.date, orderNo: row.orderIdentity, orderDate: row.date, customerId: null, customerName: null, tableNo: null, salesByName: null, itemName: String(row.raw.product_variant_name ?? row.raw.product_name ?? ""), qty: row.qty, amount: row.amount, costAmount: Number(row.raw.cost_amount ?? 0), discount: Number(row.raw.discount ?? 0), productId: row.productId, variantId: row.variantId, sku: row.sku, raw: row.raw, syncedAt: new Date() } }, upsert: true } })));
    const after = await runOlseraGapAudit(startDate, endDate, actor); return after.status === "SYNCED" ? { ...after, status: "REPAIRED", repaired: rows.length } : after;
  } finally { await release(); }
}

export async function GET() {
  try {
    await requireModule("audit");
    // Status AYO Mobile Token dibaca dari checkpoint sync existing (ayo_payment_event_sync_state),
    // BUKAN dari panggilan baru ke API AYO — tidak menambah beban ke AYO sama sekali.
    const checkpoint = await (await collections()).ayoPaymentEventSyncState.findOne({ _id: "ayo-payment-events-auto-sync" });
    const ayoMobileToken = classifyAyoMobileToken({
      token: process.env.AYO_MOBILE_TOKEN,
      lastAttemptAt: checkpoint?.lastAttemptAt ?? null,
      lastSuccessfulSyncAt: checkpoint?.lastSuccessfulSyncAt ?? null,
      lastError: checkpoint?.lastError ?? null,
    });
    // Kesehatan koneksi (Phase 3D.1): dibaca dari log/checkpoint sync existing per modul,
    // tidak memanggil AYO/Olsera hanya untuk cek koneksi.
    const connectionHealth = await getConnectionHealthSummary();
    return NextResponse.json({ enabled: true, tokenHealth: integrationTokenHealth(), ayoMobileToken, connectionHealth }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Gagal memuat monitoring integritas." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireModule("audit");
    const body = schema.parse(await request.json());
    if (!rangeIsValid(body.startDate, body.endDate)) return NextResponse.json({ error: "Rentang tanggal harus valid dan maksimal 31 hari." }, { status: 400 });
    const result = body.source === "olsera" ? body.action === "repair" ? await repairOlsera(body.startDate, body.endDate, user.id) : await runOlseraGapAudit(body.startDate, body.endDate, user.id) : body.action === "repair" ? await repair(body.source, body.startDate, body.endDate, user.id) : await runAyoGapAudit(body.source, body.startDate, body.endDate, user.id);
    return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Payload audit tidak valid." }, { status: 400 });
    const status = error instanceof Error && error.message === "AUDIT_LOCKED" ? "LOCKED" : error instanceof Error && error.message === "REPAIR_REQUIRES_FRESH_GAP_AUDIT" ? "MANUAL_REVIEW_REQUIRED" : error instanceof OlseraSalesAuditSourceError && error.code === "TOKEN_ERROR" ? "TOKEN_ERROR" : error instanceof Error && /token|unauthorized|401|403/i.test(error.message) ? "TOKEN_ERROR" : "SOURCE_INCOMPLETE";
    return NextResponse.json({ status, error: "Audit sumber gagal atau tidak lengkap." }, { status: 200, headers: NO_CACHE_HEADERS });
  }
}
