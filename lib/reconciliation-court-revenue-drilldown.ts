// Level 4 (Jam/slot) & Level 5 (Booking/transaksi) — drill-down READ-ONLY,
// BUKAN rule matching otomatis (lihat docs/reconciliation-ayo-olsera-scope.md
// §4 "Batasan Jujur"): tidak ada identifier bersama antara booking AYO dan
// transaksi Olsera, jadi modul ini TIDAK PERNAH mengklaim MATCH pasti — hanya
// menyajikan data berdampingan (Level 4) atau kandidat pasangan dengan
// mappingConfidence LOW/MEDIUM untuk ditinjau manusia (Level 5). MURNI (tanpa
// MongoDB) — pemanggil menyediakan baris booking/order yang SUDAH difilter ke
// (tanggal, court-bucket) yang sama.
import { ayoCourtBucket, olseraCourtBucket } from "./court-mapping.ts";
import { getRevenueAmount, isRevenueEligibleTransaction } from "./revenue.ts";
import type { BookingDocument, OlseraOrderItemDocument } from "./mongodb.ts";

// ---------------------------------------------------------------------------
// Level 4 — Jam/slot
// ---------------------------------------------------------------------------

export type HourlySlotRow = {
  hour: number; // 0-23, dari sisi AYO (start_time) ATAU Olsera (orderDate) — lihat field terpisah di bawah
  ayoRevenue: number;
  ayoCount: number;
  olseraRevenue: number;
  olseraCount: number;
};

function hourFromTime(value: string | undefined): number | null {
  const match = value?.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  return hour >= 0 && hour <= 23 ? hour : null;
}

/** AYO dikelompokkan per jam MULAI booking (jadwal main); Olsera per jam ORDER dibuat (kasir) — TIDAK diklaim sama, lihat docs §4. */
export function buildHourlySlotDrilldown(date: string, courtKey: string, bookings: BookingDocument[], orderItems: OlseraOrderItemDocument[]): HourlySlotRow[] {
  const rows = new Map<number, HourlySlotRow>();
  const getRow = (hour: number) => {
    const existing = rows.get(hour);
    if (existing) return existing;
    const created: HourlySlotRow = { hour, ayoRevenue: 0, ayoCount: 0, olseraRevenue: 0, olseraCount: 0 };
    rows.set(hour, created);
    return created;
  };

  for (const booking of bookings) {
    if (booking.date !== date) continue;
    if (ayoCourtBucket(booking.field_name)?.courtKey !== courtKey) continue;
    if (!isRevenueEligibleTransaction(booking)) continue;
    const hour = hourFromTime(booking.start_time);
    if (hour === null) continue;
    const row = getRow(hour);
    row.ayoRevenue += getRevenueAmount(booking);
    row.ayoCount += 1;
  }

  for (const item of orderItems) {
    if (item.date !== date) continue;
    if (olseraCourtBucket(item.itemName, item.resolvedCategoryName)?.courtKey !== courtKey) continue;
    const hour = hourFromTime(item.orderDate?.split(" ")[1]);
    if (hour === null) continue;
    const row = getRow(hour);
    row.olseraRevenue += item.amount;
    row.olseraCount += 1;
  }

  return [...rows.values()].sort((a, b) => a.hour - b.hour);
}

// ---------------------------------------------------------------------------
// Level 5 — Booking/transaksi (kandidat korelasi, BUKAN matching pasti)
// ---------------------------------------------------------------------------

export type BookingTransactionCandidate = {
  bookingId: string | null;
  orderNo: string | null;
  amount: number | null;
  ayoTime: string | null;
  olseraTime: string | null;
  minuteGap: number | null;
  status: "NEEDS_MANUAL_REVIEW" | "NOT_COMPARABLE";
  /** TIDAK PERNAH "HIGH" — lihat docs §4, tidak ada identifier bersama untuk dipastikan. */
  mappingConfidence: "LOW" | "MEDIUM" | null;
};

const CANDIDATE_MAX_MINUTE_GAP = 60;
const HIGH_CONFIDENCE_MINUTE_GAP = 15;

function parseMinutesSinceMidnight(value: string | undefined | null): number | null {
  const match = value?.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Tawarkan kandidat pasangan booking AYO <-> transaksi Olsera pada
 * (tanggal, court-bucket) yang sama: nominal SAMA PERSIS + jam order Olsera
 * dalam +-60 menit dari jam mulai booking. Greedy nearest-time (bukan optimal
 * assignment) — cukup untuk BANTUAN tinjauan manual, BUKAN kebenaran mutlak.
 * Booking/transaksi tanpa kandidat yang memenuhi syarat -> NOT_COMPARABLE.
 */
export function buildBookingTransactionCandidates(date: string, courtKey: string, bookings: BookingDocument[], orderItems: OlseraOrderItemDocument[]): BookingTransactionCandidate[] {
  const ayoRows = bookings
    .filter((b) => b.date === date && ayoCourtBucket(b.field_name)?.courtKey === courtKey && isRevenueEligibleTransaction(b))
    .map((b) => ({ bookingId: b.booking_id, amount: getRevenueAmount(b), minutes: parseMinutesSinceMidnight(b.start_time), time: b.start_time }));

  const olseraRows = orderItems
    .filter((i) => i.date === date && olseraCourtBucket(i.itemName, i.resolvedCategoryName)?.courtKey === courtKey)
    .map((i) => ({ orderNo: i.orderNo, amount: i.amount, minutes: parseMinutesSinceMidnight(i.orderDate?.split(" ")[1]), time: i.orderDate }));

  const usedOlsera = new Set<number>();
  const results: BookingTransactionCandidate[] = [];

  for (const ayo of ayoRows) {
    let bestIndex = -1;
    let bestGap = Infinity;
    olseraRows.forEach((olsera, index) => {
      if (usedOlsera.has(index)) return;
      if (olsera.amount !== ayo.amount) return;
      if (ayo.minutes === null || olsera.minutes === null) return;
      const gap = Math.abs(olsera.minutes - ayo.minutes);
      if (gap <= CANDIDATE_MAX_MINUTE_GAP && gap < bestGap) {
        bestGap = gap;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0) {
      usedOlsera.add(bestIndex);
      const olsera = olseraRows[bestIndex];
      results.push({
        bookingId: ayo.bookingId,
        orderNo: olsera.orderNo,
        amount: ayo.amount,
        ayoTime: ayo.time ?? null,
        olseraTime: olsera.time ?? null,
        minuteGap: bestGap,
        status: "NEEDS_MANUAL_REVIEW",
        mappingConfidence: bestGap <= HIGH_CONFIDENCE_MINUTE_GAP ? "MEDIUM" : "LOW",
      });
    } else {
      results.push({ bookingId: ayo.bookingId, orderNo: null, amount: ayo.amount, ayoTime: ayo.time ?? null, olseraTime: null, minuteGap: null, status: "NOT_COMPARABLE", mappingConfidence: null });
    }
  }

  olseraRows.forEach((olsera, index) => {
    if (usedOlsera.has(index)) return;
    results.push({ bookingId: null, orderNo: olsera.orderNo, amount: olsera.amount, ayoTime: null, olseraTime: olsera.time ?? null, minuteGap: null, status: "NOT_COMPARABLE", mappingConfidence: null });
  });

  return results;
}
