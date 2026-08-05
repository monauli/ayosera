import type { AyoPaymentEvent } from "./ayo-payment-events";
import type { BookingDocument } from "./mongodb";

export type AyoGapSource = "ayo-booking" | "ayo-payment-events";
export type AyoGapStatus = "SYNCED" | "GAP_FOUND" | "SOURCE_INCOMPLETE" | "DUPLICATE_FOUND" | "MANUAL_REVIEW_REQUIRED" | "REPAIRED";
export type GapRow = Pick<BookingDocument, "booking_id" | "raw"> | Pick<AyoPaymentEvent, "identity" | "raw" | "normalizedPayload">;

export type GapComparison = {
  status: Exclude<AyoGapStatus, "REPAIRED">;
  sourceCount: number;
  localCount: number;
  matchedCount: number;
  missingLocalCount: number;
  localOnlyCount: number;
  conflictCount: number;
  duplicateIdentityCount: number;
  sourceIncompleteCount: number;
  missingIdentities: string[];
};

/** Compares identities only; it never changes the source rows or local records. */
export function compareAyoGap(sourceRows: readonly GapRow[], localRows: readonly GapRow[], identity: (row: GapRow) => string | null): GapComparison {
  const source = new Map<string, GapRow>();
  const local = new Map<string, GapRow>();
  let duplicateIdentityCount = 0;
  let sourceIncompleteCount = 0;
  for (const row of sourceRows) {
    const key = identity(row);
    if (!key) { sourceIncompleteCount += 1; continue; }
    if (source.has(key)) { duplicateIdentityCount += 1; continue; }
    source.set(key, row);
  }
  for (const row of localRows) {
    const key = identity(row);
    if (!key) { duplicateIdentityCount += 1; continue; }
    if (local.has(key)) { duplicateIdentityCount += 1; continue; }
    local.set(key, row);
  }
  const missingIdentities = [...source.keys()].filter((key) => !local.has(key));
  const localOnlyCount = [...local.keys()].filter((key) => !source.has(key)).length;
  let conflictCount = 0;
  for (const [key, sourceRow] of source) {
    const localRow = local.get(key);
    if (localRow && JSON.stringify(payload(localRow)) !== JSON.stringify(payload(sourceRow))) conflictCount += 1;
  }
  const status = sourceIncompleteCount > 0 ? "SOURCE_INCOMPLETE"
    : duplicateIdentityCount > 0 ? "DUPLICATE_FOUND"
    : conflictCount > 0 ? "MANUAL_REVIEW_REQUIRED"
    : missingIdentities.length > 0 ? "GAP_FOUND" : "SYNCED";
  return { status, sourceCount: source.size, localCount: local.size, matchedCount: source.size - missingIdentities.length - conflictCount, missingLocalCount: missingIdentities.length, localOnlyCount, conflictCount, duplicateIdentityCount, sourceIncompleteCount, missingIdentities };
}

function payload(row: GapRow) {
  return "normalizedPayload" in row ? row.normalizedPayload : row.raw;
}

export function canRepairGap(result: Pick<GapComparison, "status" | "missingIdentities">) {
  return result.status === "GAP_FOUND" && result.missingIdentities.length > 0;
}
