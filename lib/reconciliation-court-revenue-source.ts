// Source adapter — Rekonsiliasi AYO vs Olsera granular (Milestone 3,
// CROSS_SYSTEM_COURT_REVENUE, domain COURT_REVENUE). Pola sama dengan
// lib/reconciliation-sources.ts (Phase 5B, INTERNAL_OLSERA) tapi membaca DUA
// sumber (bookings + olsera_order_items) dan mengelompokkan per
// (tanggal, court-bucket) — lihat docs/reconciliation-ayo-olsera-scope.md
// untuk formula & keputusan desain lengkap. Read-only, tidak pernah menulis.
import "server-only";
import { evaluateCourtRevenue, type CourtRevenueComparisonInput, type CourtRevenueSideData, type RuleEvaluation } from "./reconciliation-rules.ts";
import { ayoCourtBucket, allCourtKeys, olseraCourtBucket, PADEL_UNIDENTIFIED_BUCKET, type CourtMappingConfidence } from "./court-mapping.ts";
import { getRevenueAmount, isRevenueEligibleTransaction } from "./revenue.ts";
import type { BookingDocument, OlseraOrderItemDocument } from "./mongodb.ts";
import { readActiveStagedPaymentEvents, type StagingReadContext } from "./ayo-payment-event-staging.ts";

const MAX_SAMPLE_REFS = 8;

export type CourtRevenueFinding = RuleEvaluation & {
  domain: "COURT_REVENUE";
  date: string;
  courtKey: string;
  entityKey: string;
  sourceRefs: { ayoBookingIds: string[]; ayoBookingCount: number; olseraOrderNos: string[]; olseraOrderCount: number };
  /**
   * Nominal mentah tiap sisi — disimpan TERPISAH dari `expected`/`actual` bawaan
   * rule engine karena bentuk `expected`/`actual` BERBEDA-BEDA per status (mis.
   * cabang BUTUH_ADJUST_MANUAL/unmapped sengaja mengosongkan `actual`, lihat
   * evaluateCourtRevenue) — kode agregasi Level 1/2 (bulanan/harian) TIDAK
   * PERNAH menebak bentuk expected/actual, selalu pakai field eksplisit ini.
   */
  ayoRevenue: number;
  olseraRevenue: number;
};

export type MinimalReadCollection<T> = {
  find(filter: Record<string, unknown>): { toArray(): Promise<T[]> };
};

export type CourtRevenueSourceContext = {
  bookings: MinimalReadCollection<BookingDocument>;
  orderItems: MinimalReadCollection<OlseraOrderItemDocument>;
  staging?: StagingReadContext;
};

export async function resolveCourtRevenueSourceContext(context?: CourtRevenueSourceContext): Promise<CourtRevenueSourceContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { bookings, olseraOrderItems, ayoPaymentEventStagingRuns, ayoPaymentEventStagingEvents, ayoPaymentEventActivation } = await collections();
  return { bookings, orderItems: olseraOrderItems, staging: { runs: ayoPaymentEventStagingRuns, events: ayoPaymentEventStagingEvents, activation: ayoPaymentEventActivation } };
}

type SideAccumulator = { revenue: number; count: number; refs: string[]; confidence: CourtMappingConfidence };

function addRef(list: string[], ref: string): void {
  if (list.length < MAX_SAMPLE_REFS) list.push(ref);
}

/**
 * Muat & bandingkan omzet lapangan AYO vs Olsera untuk seluruh tanggal dalam
 * rentang [startDate, endDate] (YYYY-MM-DD, inklusif). Satu finding per
 * (tanggal, court-bucket) — court-bucket lihat lib/court-mapping.ts.
 */
export async function loadCourtRevenueFindings(
  startDate: string,
  endDate: string,
  context?: CourtRevenueSourceContext,
  options: { minorToleranceIdr?: number } = {},
): Promise<{ findings: CourtRevenueFinding[]; docsRead: number }> {
  const source = await resolveCourtRevenueSourceContext(context);
  const { bookings, orderItems } = source;
  const [bookingRows, itemRows] = await Promise.all([
    bookings.find({ date: { $gte: startDate, $lte: endDate } }).toArray(),
    orderItems.find({ date: { $gte: startDate, $lte: endDate } }).toArray(),
  ]);

  const validated = source.staging ? await readActiveStagedPaymentEvents(startDate, endDate, source.staging) : null;

  const ayoBySlot = new Map<string, SideAccumulator>();
  if (validated) {
    // A payment event is idempotent by its business identity, never bookingId.
    const events = new Map(validated.events.filter((event) => event.bookingId.startsWith("BK")).map((event) => [event.identity, event]));
    for (const event of events.values()) {
      const bucket = ayoCourtBucket(event.fieldName);
      if (!bucket) continue;
      const key = `${event.date}|${bucket.courtKey}`;
      const acc = ayoBySlot.get(key) ?? { revenue: 0, count: 0, refs: [], confidence: bucket.confidence };
      acc.revenue += event.amount;
      acc.count += 1;
      addRef(acc.refs, event.bookingId);
      ayoBySlot.set(key, acc);
    }
  } else for (const booking of bookingRows) {
    const bucket = ayoCourtBucket(booking.field_name);
    if (!bucket) continue; // field_name di luar Padel/Pickleball yang dikenal -> di luar scope court-revenue (lihat docs §2).
    if (!isRevenueEligibleTransaction(booking)) continue;
    const key = `${booking.date}|${bucket.courtKey}`;
    const acc = ayoBySlot.get(key) ?? { revenue: 0, count: 0, refs: [], confidence: bucket.confidence };
    acc.revenue += getRevenueAmount(booking);
    acc.count += 1;
    addRef(acc.refs, booking.booking_id);
    ayoBySlot.set(key, acc);
  }

  const olseraBySlot = new Map<string, SideAccumulator>();
  for (const item of itemRows) {
    const bucket = olseraCourtBucket(item.itemName, item.resolvedCategoryName);
    if (!bucket) continue; // bukan kategori lapangan -> dikecualikan total (lihat classifyCategoryForCourtRevenue).
    const key = `${item.date}|${bucket.courtKey}`;
    const acc = olseraBySlot.get(key) ?? { revenue: 0, count: 0, refs: [], confidence: bucket.confidence };
    acc.revenue += item.amount;
    acc.count += 1;
    addRef(acc.refs, item.orderNo);
    olseraBySlot.set(key, acc);
  }

  // Tanggal yang PUNYA data (AYO atau Olsera) dalam rentang — jangan mengevaluasi tanggal kosong total (buang-buang finding "NOT_CHECKED").
  const datesWithData = new Set<string>();
  for (const key of ayoBySlot.keys()) datesWithData.add(key.split("|")[0]);
  for (const key of olseraBySlot.keys()) datesWithData.add(key.split("|")[0]);

  const findings: CourtRevenueFinding[] = [];
  for (const date of [...datesWithData].sort()) {
    for (const courtKey of allCourtKeys()) {
      const key = `${date}|${courtKey}`;
      const ayoAcc = ayoBySlot.get(key) ?? null;
      const olseraAcc = olseraBySlot.get(key) ?? null;
      if (!ayoAcc && !olseraAcc) continue;

      const courtMappingConfidence: "exact" | "ambiguous" | "unmapped" = courtKey === PADEL_UNIDENTIFIED_BUCKET ? "unmapped" : "exact";
      const ayoSide: CourtRevenueSideData | null = ayoAcc ? { count: ayoAcc.count, revenue: ayoAcc.revenue, paymentStatus: null } : null;
      const olseraSide: CourtRevenueSideData | null = olseraAcc ? { count: olseraAcc.count, revenue: olseraAcc.revenue, paymentStatus: null } : null;

      const input: CourtRevenueComparisonInput = {
        date,
        court: courtKey,
        ayo: ayoSide,
        olsera: olseraSide,
        // Bucket court-revenue di sini SUDAH difilter classifyCategoryForCourtRevenue==="court" oleh olseraCourtBucket
        // sebelum masuk akumulasi manapun — baris yang kategorinya tak pasti tidak pernah sampai ke sini.
        olseraCourtCategoryConfident: true,
        courtMappingConfidence,
      };
      const result = evaluateCourtRevenue(input, options.minorToleranceIdr !== undefined ? { minorToleranceIdr: options.minorToleranceIdr } : {});

      findings.push({
        ...result,
        domain: "COURT_REVENUE",
        date,
        courtKey,
        entityKey: courtKey,
        ayoRevenue: ayoAcc?.revenue ?? 0,
        olseraRevenue: olseraAcc?.revenue ?? 0,
        sourceRefs: {
          ayoBookingIds: ayoAcc?.refs ?? [],
          ayoBookingCount: ayoAcc?.count ?? 0,
          olseraOrderNos: olseraAcc?.refs ?? [],
          olseraOrderCount: olseraAcc?.count ?? 0,
        },
      });
    }
  }

  return { findings, docsRead: bookingRows.length + itemRows.length };
}
