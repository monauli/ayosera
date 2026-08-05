import { NextResponse } from "next/server";
import { compareAyoGap, type AyoGapSource, type GapRow } from "@/lib/ayo-data-gap";
import { fetchAyoBookingsByDateRange } from "@/lib/ayo";
import { normalizeBooking } from "@/lib/booking-mapper";
import { fetchAyoPaymentEvents, paymentEventIdentity } from "@/lib/ayo-payment-events";
import { fetchOlseraSalesAuditSource } from "@/lib/olsera-sync";
import { compareOlseraSalesGap, type OlseraAuditItem, type OlseraAuditOrder } from "@/lib/olsera-sales-gap";
import { collections, getDb } from "@/lib/mongodb";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";
import { integrationTokenHealth } from "@/lib/private-integration-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function check(source: AyoGapSource, startDate: string, endDate: string) {
  const dbCollections = await collections();
  const key = (row: GapRow) => source === "ayo-booking" && "booking_id" in row ? row.booking_id || null : source === "ayo-payment-events" && "identity" in row ? row.identity || paymentEventIdentity(row.raw) : null;
  const rows = source === "ayo-booking"
    ? { sourceRows: (await fetchAyoBookingsByDateRange({ start_date: startDate, end_date: endDate })).data.map(normalizeBooking), localRows: await dbCollections.bookings.find({ date: { $gte: startDate, $lte: endDate } }).toArray() }
    : { sourceRows: (await fetchAyoPaymentEvents(startDate, endDate)).events, localRows: await dbCollections.ayoPaymentEvents.find({ date: { $gte: startDate, $lte: endDate } }).toArray() };
  const result = compareAyoGap(rows.sourceRows, rows.localRows, key);
  await (await getDb()).collection("data_gap_audit_runs").insertOne({ source, action: "weekly-check", status: result.status, range: { startDate, endDate }, counts: result, actor: "cron:integration-audit", createdAt: new Date() });
  return { source, ...result };
}

async function checkOlsera(startDate: string, endDate: string) {
  const dbCollections = await collections(); const source = await fetchOlseraSalesAuditSource(startDate, endDate);
  const docs = await dbCollections.olseraOrderItems.find({ date: { $gte: startDate, $lte: endDate } }).toArray();
  const localItems: OlseraAuditItem[] = docs.map((row) => ({ identity: String(row._id), orderIdentity: row.orderNo, productId: row.productId ?? null, variantId: row.variantId ?? null, sku: row.sku ?? null, qty: row.qty, amount: row.amount }));
  const totals = new Map<string, number>(); for (const row of localItems) totals.set(row.orderIdentity, (totals.get(row.orderIdentity) ?? 0) + row.amount);
  const localOrders: OlseraAuditOrder[] = [...totals].map(([identity, total]) => ({ identity, total, status: null }));
  const result = compareOlseraSalesGap(source.orders, localOrders, source.items, localItems);
  await (await getDb()).collection<Record<string, unknown>>("data_gap_audit_runs").insertOne({ source: "olsera", action: "weekly-check", status: result.status, range: { startDate, endDate }, counts: result, actor: "cron:integration-audit", createdAt: new Date() });
  return { source: "olsera", ...result };
}

/** Read-only weekly audit. It never invokes repair, sync, or an Olsera operation. */
export async function POST(request: Request) {
  const auth = verifyCronSecret(request.headers.get("authorization"));
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
  const end = new Date(); const start = new Date(end); start.setUTCDate(start.getUTCDate() - 29);
  const startDate = start.toISOString().slice(0, 10); const endDate = end.toISOString().slice(0, 10);
  try {
    const results = await Promise.all([check("ayo-booking", startDate, endDate), check("ayo-payment-events", startDate, endDate), checkOlsera(startDate, endDate)]);
    return NextResponse.json({ status: results.some((result) => result.status !== "SYNCED") ? "MANUAL_REVIEW_REQUIRED" : "SYNCED", checkedAt: new Date().toISOString(), range: { startDate, endDate }, results, tokenHealth: integrationTokenHealth(), repaired: 0 });
  } catch {
    return NextResponse.json({ status: "SOURCE_INCOMPLETE", checkedAt: new Date().toISOString(), range: { startDate, endDate }, repaired: 0, message: "Audit mingguan gagal lengkap dan tidak melakukan perbaikan." });
  }
}
