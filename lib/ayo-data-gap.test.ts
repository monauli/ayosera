import assert from "node:assert/strict";
import test from "node:test";
import { compareAyoGap, type GapRow } from "./ayo-data-gap";

const booking = (booking_id: string, raw: Record<string, unknown> = { booking_id }): GapRow => ({ booking_id, raw });
const event = (identity: string, raw: Record<string, unknown> = { identity }): GapRow => ({ identity, raw, normalizedPayload: raw });

test("booking gap audit detects missing local identities without changing source rows", () => {
  const source = [booking("B-1"), booking("B-2")];
  const result = compareAyoGap(source, [booking("B-1")], (row) => "booking_id" in row ? row.booking_id : null);
  assert.equal(result.status, "GAP_FOUND"); assert.deepEqual(result.missingIdentities, ["B-2"]); assert.equal((source[1] as { booking_id: string }).booking_id, "B-2");
});

test("payment events use full payment identity, not booking id", () => {
  const result = compareAyoGap([event("reservation:BK-1:pay-1"), event("reservation:BK-1:pay-2")], [event("reservation:BK-1:pay-1")], (row) => "identity" in row ? row.identity : null);
  assert.equal(result.missingLocalCount, 1); assert.deepEqual(result.missingIdentities, ["reservation:BK-1:pay-2"]);
});

test("duplicate, incomplete, and conflicting source data cannot be repaired", () => {
  assert.equal(compareAyoGap([booking("B-1"), booking("B-1")], [], (row) => "booking_id" in row ? row.booking_id : null).status, "DUPLICATE_FOUND");
  assert.equal(compareAyoGap([booking("")], [], (row) => "booking_id" in row ? row.booking_id : null).status, "SOURCE_INCOMPLETE");
  assert.equal(compareAyoGap([booking("B-1", { v: 1 })], [booking("B-1", { v: 2 })], (row) => "booking_id" in row ? row.booking_id : null).status, "MANUAL_REVIEW_REQUIRED");
});
