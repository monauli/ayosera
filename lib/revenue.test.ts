import assert from "node:assert/strict";
import test from "node:test";
import {
  getRevenueAmount,
  getTransactionAmount,
  isCancelledTransaction,
  isDisplayEligibleTransaction,
  isInternalUseTransaction,
  isRevenueEligibleTransaction,
  isZeroAmountTransaction,
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

test("menganggap null sebagai nol hanya jika tidak ada nominal valid lain", () => {
  assert.equal(getTransactionAmount({ total_price: null, amount: 175_000 }), 175_000);
  assert.equal(getTransactionAmount({ total_price: undefined, payment_amount: 90_000 }), 90_000);
  assert.equal(isZeroAmountTransaction({ nominal: 0 }), true);
  assert.equal(isZeroAmountTransaction({ total: null }), true);
});

test("mendeteksi Internal Use dari field normalisasi dan raw provider", () => {
  assert.equal(isInternalUseTransaction({ booker_name: "Internal Use", total_price: 100_000 }), true);
  assert.equal(isInternalUseTransaction({ customer: "INTERNAL", total_price: 100_000 }), true);
  assert.equal(isInternalUseTransaction({ raw: { ayo_customer: { display_name: "internal" } }, total_price: 100_000 }), true);
  assert.equal(isInternalUseTransaction({ customer: "External Customer", total_price: 100_000 }), false);
});

test("display hanya mengecualikan Rp0 dan internal; revenue juga mengecualikan cancelled", () => {
  assert.equal(isDisplayEligibleTransaction({ status: "CANCELLED", total_price: 150_000 }), true);
  assert.equal(isRevenueEligibleTransaction({ status: "CANCELLED", total_price: 150_000 }), false);
  assert.equal(isDisplayEligibleTransaction({ status: "SUCCESS", total_price: 0 }), false);
  assert.equal(isDisplayEligibleTransaction({ status: "SUCCESS", total_price: 150_000, note: "Internal" }), false);
});
