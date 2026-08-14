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
import { computeInventoryValidation, computeFinancialValidation, failedSection, periodEnd, type ValidationStatus } from "@/lib/olsera-validation-sections";
import { ensureMonthlySnapshotChain } from "@/lib/olsera-inventory-monthly-snapshot-store";
import { startFinancialSync, stepFinancialSync, getFinancialSyncStatus } from "@/lib/olsera-financial-sync";
import { financialSyncRunId, getFinancialSyncRun } from "@/lib/olsera-financial-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Recovery Inventori (ensureMonthlySnapshotChain) dan Financial
// (startFinancialSync/stepFinancialSync loop, Phase 5) memanggil Olsera live
// berkali-kali untuk satu bulan penuh — arsitektur sama dengan cron sync
// bulanan sejenis, yang diberi maxDuration 300s.
export const maxDuration = 300;

const schema = z.object({
  source: z.enum(["olsera", "ayo-booking", "ayo-payment-events", "olsera-inventory", "olsera-financial"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  action: z.enum(["check", "repair"]),
});
const maxRangeDays = 31;
const stateId = (source: AyoGapSource, startDate: string, endDate: string) => `ayo-gap:${source}:${startDate}:${endDate}`;
const lockId = (source: string, startDate: string, endDate: string) => `${source}-gap-lock:${startDate}:${endDate}`;
const olseraStateId = (startDate: string, endDate: string) => `olsera-sales-gap:${startDate}:${endDate}`;
const periodGapStateId = (source: "olsera-inventory" | "olsera-financial", period: string) => `${source}-gap:${period}`;
// Inventori/Financial (Phase 4/5) dibandingkan per PERIODE bulan (sama dengan
// GET /api/audit/olsera-validation), bukan rentang tanggal bebas seperti
// AYO Booking/Payment Events/Kategori Penjualan — startDate/endDate dari UI
// yang sama harus berada di bulan kalender yang sama.
function periodFromSameMonthRange(startDate: string, endDate: string): string | null {
  const startMonth = startDate.slice(0, 7);
  if (endDate.slice(0, 7) !== startMonth || startDate.slice(8) !== "01" || endDate !== periodEnd(startMonth)) return null;
  return startMonth;
}
// Budget re-fetch Financial (start + loop step) — jauh di bawah maxDuration
// 300s supaya masih ada waktu menulis run log/response sebelum function di-kill.
const FINANCIAL_RECOVERY_BUDGET_MS = 240_000;
const FRESH_AUDIT_WINDOW_MS = 15 * 60_000;

type PeriodGapResult = {
  source: "olsera-inventory" | "olsera-financial";
  period: string;
  checkedAt: string;
  startedBy: string;
  repaired: number;
  status: ValidationStatus;
  [key: string]: unknown;
};
type StoredPeriodGap = PeriodGapResult & { _id: string; completedAt: Date };

async function runInventoryGapAudit(period: string, actor: string): Promise<PeriodGapResult> {
  const [year, month] = period.split("-").map(Number);
  const validation = await computeInventoryValidation(year, month, `${period}-01`, periodEnd(period));
  const result: PeriodGapResult = { ...validation, source: "olsera-inventory", period, checkedAt: new Date().toISOString(), startedBy: actor, repaired: 0 };
  const db = await getDb();
  await db.collection<StoredPeriodGap>("data_gap_audit_state").updateOne({ _id: periodGapStateId("olsera-inventory", period) }, { $set: { ...result, _id: periodGapStateId("olsera-inventory", period), completedAt: new Date() } }, { upsert: true });
  await db.collection("data_gap_audit_runs").insertOne({ source: "olsera-inventory", action: "check", status: result.status, period, actor, createdAt: new Date() });
  return result;
}

async function requireFreshGap(source: "olsera-inventory" | "olsera-financial", period: string) {
  const db = await getDb();
  const stored = await db.collection<StoredPeriodGap>("data_gap_audit_state").findOne({ _id: periodGapStateId(source, period) });
  if (!stored || stored.status !== "Selisih" || Date.now() - stored.completedAt.getTime() > FRESH_AUDIT_WINDOW_MS) throw new Error("REPAIR_REQUIRES_FRESH_GAP_AUDIT");
  return db;
}

/**
 * Recovery Inventori = ensureMonthlySnapshotChain (self-healing rebuild yang
 * SUDAH dipakai di jalur export/monitoring lain, lihat lib/olsera-inventory-monthly-snapshot-store.ts).
 * TIDAK PERNAH membuat movement palsu. Untuk bulan "historical" yang sudah
 * pernah difinalisasi, fungsi ini SENGAJA tidak menghitung ulang (melindungi
 * data final) — bila 2 produk masih Selisih setelah recovery, itu berarti
 * datanya memang dilindungi/butuh review manual, BUKAN gagal recovery; hasil
 * validator setelahnya tetap dilaporkan apa adanya (Selisih), tidak dipaksa Cocok.
 */
async function repairInventoryGap(period: string, actor: string): Promise<PeriodGapResult> {
  const db = await requireFreshGap("olsera-inventory", period);
  const release = await acquireLock("olsera-inventory", `${period}-01`, periodEnd(period), actor);
  try {
    const [year, month] = period.split("-").map(Number);
    const rebuild = await ensureMonthlySnapshotChain({ year, month });
    if (!rebuild.ok) {
      const failure = failedSection("inventory", new Error(rebuild.error));
      const result: PeriodGapResult = { ...failure, source: "olsera-inventory", period, checkedAt: new Date().toISOString(), startedBy: actor, repaired: 0 };
      await db.collection("data_gap_audit_runs").insertOne({ source: "olsera-inventory", action: "repair", status: result.status, period, actor, createdAt: new Date(), error: rebuild.error });
      return result;
    }
    const after = await runInventoryGapAudit(period, actor);
    const result: PeriodGapResult = { ...after, repaired: rebuild.docs.length };
    await db.collection("data_gap_audit_runs").insertOne({ source: "olsera-inventory", action: "repair", status: result.status, period, actor, createdAt: new Date(), repaired: result.repaired });
    return result;
  } finally { await release(); }
}

async function runFinancialGapAudit(period: string, actor: string): Promise<PeriodGapResult> {
  const validation = await computeFinancialValidation(period);
  const result: PeriodGapResult = { ...validation, source: "olsera-financial", period, checkedAt: new Date().toISOString(), startedBy: actor, repaired: 0 };
  const db = await getDb();
  await db.collection<StoredPeriodGap>("data_gap_audit_state").updateOne({ _id: periodGapStateId("olsera-financial", period) }, { $set: { ...result, _id: periodGapStateId("olsera-financial", period), completedAt: new Date() } }, { upsert: true });
  await db.collection("data_gap_audit_runs").insertOne({ source: "olsera-financial", action: "check", status: result.status, period, actor, createdAt: new Date() });
  return result;
}

/**
 * Recovery Financial = drive startFinancialSync/stepFinancialSync (checkpoint
 * existing dari lib/olsera-financial-sync.ts, dipakai jalur manual sync/cron
 * juga) sampai selesai atau budget habis. runId DETERMINISTIK per periode
 * (financialSyncRunId) — bila run sebelumnya masih "running"/"partial"
 * (mis. timeout di percobaan lalu), lanjutkan run YANG SAMA (resume), TIDAK
 * restart dari awal. Setiap report/akun ditulis via upsert (lihat
 * upsertMonthlyReport/upsertAccounts) — snapshot lama valid tidak pernah
 * dihapus sebelum data baru berhasil diambil untuk report/akun itu.
 */
async function repairFinancialGap(period: string, actor: string): Promise<PeriodGapResult> {
  const db = await requireFreshGap("olsera-financial", period);
  const release = await acquireLock("olsera-financial", `${period}-01`, periodEnd(period), actor);
  try {
    const runId = financialSyncRunId(period);
    const existing = await getFinancialSyncRun(runId);
    if (!existing || existing.status === "success" || existing.finalized) {
      const [year, month] = period.split("-").map(Number);
      await startFinancialSync(year, month);
    }
    const deadline = Date.now() + FINANCIAL_RECOVERY_BUDGET_MS;
    let status = await getFinancialSyncStatus(runId);
    let lastProcessed = -1;
    // Berhenti bila stagnan (mis. status "partial"+finalized: beberapa akun
    // gagal permanen setelah retry, step berikutnya tidak lagi maju) — jangan
    // menghabiskan seluruh budget pada run yang sudah tidak bisa progress lagi.
    while (status && (status.status === "running" || status.status === "partial") && status.progress.accountsProcessed !== lastProcessed && Date.now() < deadline) {
      lastProcessed = status.progress.accountsProcessed;
      await stepFinancialSync(runId);
      status = await getFinancialSyncStatus(runId);
    }
    if (!status || status.status !== "success") {
      const result: PeriodGapResult = {
        source: "olsera-financial", period, checkedAt: new Date().toISOString(), startedBy: actor, repaired: 0,
        status: "Gagal Dicek", stage: "financial", code: "SYNC_IN_PROGRESS",
        detail: `Sinkronisasi Financial belum selesai (${status?.progress.accountsProcessed ?? 0}/${status?.progress.accountsTotal ?? 0} akun) — klik Pulihkan Data lagi untuk melanjutkan, checkpoint tersimpan.`,
      };
      await db.collection("data_gap_audit_runs").insertOne({ source: "olsera-financial", action: "repair", status: result.status, period, actor, createdAt: new Date(), progress: status?.progress ?? null });
      return result;
    }
    const after = await runFinancialGapAudit(period, actor);
    const result: PeriodGapResult = { ...after, repaired: status.progress.accountsProcessed };
    await db.collection("data_gap_audit_runs").insertOne({ source: "olsera-financial", action: "repair", status: result.status, period, actor, createdAt: new Date(), repaired: result.repaired });
    return result;
  } finally { await release(); }
}

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
    if (body.source === "olsera-inventory" || body.source === "olsera-financial") {
      const period = periodFromSameMonthRange(body.startDate, body.endDate);
      if (!period) return NextResponse.json({ error: "Inventori/Financial hanya mendukung satu periode bulan penuh (tanggal awal dan akhir harus di bulan kalender yang sama)." }, { status: 400 });
      const result = body.source === "olsera-inventory"
        ? body.action === "repair" ? await repairInventoryGap(period, user.id) : await runInventoryGapAudit(period, user.id)
        : body.action === "repair" ? await repairFinancialGap(period, user.id) : await runFinancialGapAudit(period, user.id);
      return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
    }
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
