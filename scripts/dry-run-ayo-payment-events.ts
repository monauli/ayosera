import { readFile } from "node:fs/promises";
import { fetchAyoPaymentEvents, validatePaymentPeriod, type AyoPaymentEvent } from "../lib/ayo-payment-events.ts";

const PERIODS = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];

async function loadLocalEnv() {
  const contents = await readFile(".env.local", "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(AYO_MOBILE_TOKEN|MONGODB_URI)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function monthRange(period: string) {
  const [year, month] = period.split("-").map(Number);
  return { startDate: `${period}-01`, endDate: `${period}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}` };
}

function duplicateAndConflict(events: readonly AyoPaymentEvent[]) {
  const seen = new Map<string, string>();
  let duplicate = 0;
  let conflict = 0;
  for (const event of events) {
    const raw = JSON.stringify({ bookingId: event.bookingId, sourceTable: event.sourceTable, reservationPaymentId: event.reservationPaymentId, nativeId: event.nativeId, paymentType: event.paymentType, detailStatus: event.detailStatus, finalStatus: event.finalStatus, fieldName: event.fieldName, date: event.date, startTime: event.startTime, endTime: event.endTime, total: event.total, finalFeeAyo: event.finalFeeAyo, isCredit: event.isCredit });
    const previous = seen.get(event._id);
    if (previous !== undefined) {
      duplicate += 1;
      if (previous !== raw) conflict += 1;
    } else seen.set(event._id, raw);
  }
  return { duplicate, conflict };
}

function auditCandidate(events: readonly AyoPaymentEvent[], candidate: "a" | "b" | "c") {
  const identities = new Map<string, string[]>();
  let missingFieldCount = 0;
  for (const event of events) {
    const source = event.sourceTable;
    const booking = event.bookingId;
    const reservation = event.reservationPaymentId ?? "";
    const nativeId = event.nativeId;
    const missing = !source || !booking || (candidate !== "c" && !reservation) || (candidate !== "a" && !nativeId);
    if (missing) { missingFieldCount += 1; continue; }
    const identity = candidate === "a" ? `${source}:${booking}:${reservation}` : candidate === "b" ? `${source}:${booking}:${reservation}:${nativeId}` : `${source}:${booking}:${nativeId}`;
    const canonical = JSON.stringify({ booking, reservation, nativeId, fieldName: event.fieldName, date: event.date, startTime: event.startTime, endTime: event.endTime, total: event.total, finalFeeAyo: event.finalFeeAyo, paymentType: event.paymentType, detailStatus: event.detailStatus, finalStatus: event.finalStatus, isCredit: event.isCredit });
    identities.set(identity, [...(identities.get(identity) ?? []), canonical]);
  }
  let duplicateIdentityCount = 0;
  let exactDuplicateCount = 0;
  let conflictCount = 0;
  for (const values of identities.values()) {
    if (values.length < 2) continue;
    duplicateIdentityCount += 1;
    exactDuplicateCount += values.length - new Set(values).size;
    if (new Set(values).size > 1) conflictCount += 1;
  }
  return { duplicateIdentityCount, exactDuplicateCount, conflictCount, missingFieldCount, stable: conflictCount === 0 && missingFieldCount === 0 };
}

await loadLocalEnv();
if (!process.env.AYO_MOBILE_TOKEN) throw new Error("AYO_MOBILE_TOKEN tidak tersedia di .env.local.");

for (const period of PERIODS) {
  const { startDate, endDate } = monthRange(period);
  try {
    const result = await fetchAyoPaymentEvents(startDate, endDate);
    const counts = duplicateAndConflict(result.events);
    const identityAudit = { a: auditCandidate(result.events, "a"), b: auditCandidate(result.events, "b"), c: auditCandidate(result.events, "c") };
    const validation = validatePaymentPeriod({ startDate, endDate, events: result.events, expectedTotalTransaction: result.expectedTotalTransaction, expectedTotal: result.expectedTotal, conflictCount: counts.conflict });
    const finalCounts = identityAudit.a;
    const finalValidation = validatePaymentPeriod({ startDate, endDate, events: result.events, expectedTotalTransaction: result.expectedTotalTransaction, expectedTotal: result.expectedTotal, conflictCount: finalCounts.conflictCount });
    console.log(JSON.stringify({ period, identityAudit, fetchedRows: result.events.length, expectedTotalTransaction: result.expectedTotalTransaction, calculatedTotal: validation.calculatedTotal, expectedTotal: result.expectedTotal, duplicate: finalCounts.duplicateIdentityCount, conflict: finalCounts.conflictCount, validationStatus: finalValidation.status }));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "ERROR";
    console.log(JSON.stringify({ period, fetchedRows: null, expectedTotalTransaction: null, calculatedTotal: null, expectedTotal: null, duplicate: null, conflict: null, validationStatus: code === "TOKEN_INVALID" ? "token-invalid" : "error", errorCode: code }));
  }
}
