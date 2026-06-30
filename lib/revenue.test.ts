import assert from "node:assert/strict";
import test from "node:test";
import {
  getRevenueAmount,
  isCancelledTransaction,
  isRevenueEligibleTransaction,
  sumRevenue,
} from "./revenue.ts";

const cancelledValues = ["CANCELLED", "canceled", "Dibatalkan", "batal", "VOID", "refund", "REFUNDED"];

test("mendeteksi semua variasi status cancelled secara case-insensitive", () => {
  for (const status of cancelledValues) {
    const transaction = { status, total_price: 150_000 };
    assert.equal(isCancelledTransaction(transaction), true, status);
    assert.equal(isRevenueEligibleTransaction(transaction), false, status);
    assert.equal(getRevenueAmount(transaction), 0, status);
  }
});

test("mendeteksi status cancelled dari raw provider dan payment nested", () => {
  assert.equal(isCancelledTransaction({ status: "SUCCESS", raw: { status_label: "Dibatalkan" } }), true);
  assert.equal(isCancelledTransaction({ status: "SUCCESS", raw: { payment: { status: "refunded" } } }), true);
  assert.equal(isCancelledTransaction({ status: "SUCCESS", raw: { source_status: "void by Olsera" } }), true);
});

test("menjumlahkan semua transaksi non-cancelled dan mempertahankan nominal asli", () => {
  const transactions = [
    { status: "SUCCESS", total_price: 300_000 },
    { status: "PENDING", total_price: 200_000 },
    { status: "CANCELLED", total_price: 1_443_000 },
  ];

  assert.equal(sumRevenue(transactions), 500_000);
  assert.equal(transactions[2].total_price, 1_443_000);
});

test("mendukung amountValue untuk perhitungan frontend", () => {
  assert.equal(getRevenueAmount({ status: "Completed", amountValue: 98_000 }), 98_000);
  assert.equal(getRevenueAmount({ status: "Cancelled", amountValue: 98_000 }), 0);
});
