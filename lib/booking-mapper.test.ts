import assert from "node:assert/strict";
import test from "node:test";
import { toTransactionRow, type TransactionRowPayment } from "./booking-mapper.ts";
import type { BookingDocument } from "./mongodb.ts";

// Fixture example only (real production booking from the 2026-08-13 audit) —
// toTransactionRow never branches on any specific booking_id.
const SPLIT_PAYMENT_BOOKING_ID = "MN/2428/260809/0002994";

function booking(overrides: Partial<BookingDocument> = {}): BookingDocument {
  return {
    order_detail_id: 1,
    booking_id: "BK-1",
    field_id: 1,
    field_name: "Court 1",
    date: "2026-08-12",
    start_time: "18:00:00",
    end_time: "19:00:00",
    total_price: 50000,
    status: "SUCCESS",
    booker_name: "Ade",
    booker_phone: "0800000000",
    booker_email: "",
    booking_source: "reservation",
    branch_name: "BC Padel Club",
    created_at: "2026-08-09T09:19:47.000000Z",
    raw: {},
    syncedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

test("tanpa payment aggregate -> tidak ada field paymentCount/paymentDetails sama sekali", () => {
  const row = toTransactionRow(booking());
  assert.equal("paymentCount" in row, false);
  assert.equal("paymentDetails" in row, false);
});

test("payment.count = 1 -> tidak ada badge/expand (field payment tidak disertakan)", () => {
  const payment: TransactionRowPayment = { count: 1, details: [{ referenceId: "1001", amount: 50000 }] };
  const row = toTransactionRow(booking({ total_price: 50000 }), payment);
  assert.equal("paymentCount" in row, false);
  assert.equal("paymentDetails" in row, false);
});

test("payment.count = 2 -> paymentCount dan paymentDetails terformat disertakan, total tetap sama dengan amountValue", () => {
  const payment: TransactionRowPayment = {
    count: 2,
    details: [
      { referenceId: "2742703", amount: 150000 },
      { referenceId: "2760168", amount: 50000 },
    ],
  };
  const row = toTransactionRow(booking({ booking_id: SPLIT_PAYMENT_BOOKING_ID, total_price: 200000 }), payment);
  assert.equal(row.paymentCount, 2);
  assert.equal(row.amountValue, 200000);
  assert.equal(
    row.paymentDetails?.reduce((sum, d) => sum + d.amountValue, 0),
    row.amountValue,
  );
  assert.deepEqual(
    row.paymentDetails?.map((d) => d.referenceId),
    ["2742703", "2760168"],
  );
  assert.match(row.paymentDetails?.[0].amount ?? "", /Rp\s?150\.000/);
  assert.match(row.paymentDetails?.[1].amount ?? "", /Rp\s?50\.000/);
});

test("payment.count = 3 -> 3 detail disertakan", () => {
  const payment: TransactionRowPayment = {
    count: 3,
    details: [
      { referenceId: "3001", amount: 100000 },
      { referenceId: "3002", amount: 25000 },
      { referenceId: "3003", amount: 5000 },
    ],
  };
  const row = toTransactionRow(booking({ total_price: 130000 }), payment);
  assert.equal(row.paymentCount, 3);
  assert.equal(row.paymentDetails?.length, 3);
});
