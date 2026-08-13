import assert from "node:assert/strict";
import test from "node:test";
import { hasMultiPayment } from "./booking-payment-detail-ui.ts";

test("1 payment (fallback bookings.total_price, tanpa payment-events) -> tidak ada badge/expand", () => {
  assert.equal(hasMultiPayment({ id: "BK-1" }), false);
});

test("1 payment (paymentCount 1 dari aggregate) -> tidak ada badge/expand", () => {
  assert.equal(
    hasMultiPayment({ id: "BK-1", paymentCount: 1, paymentDetails: [{ referenceId: "1001", amount: "Rp75.000" }] }),
    false,
  );
});

test("2 payment -> badge/expand aktif", () => {
  assert.equal(
    hasMultiPayment({
      id: "MN/2428/260809/0002994",
      paymentCount: 2,
      paymentDetails: [
        { referenceId: "2742703", amount: "Rp150.000" },
        { referenceId: "2760168", amount: "Rp50.000" },
      ],
    }),
    true,
  );
});

test("3 payment -> badge/expand aktif", () => {
  assert.equal(
    hasMultiPayment({
      id: "BK-3",
      paymentCount: 3,
      paymentDetails: [
        { referenceId: "3001", amount: "Rp100.000" },
        { referenceId: "3002", amount: "Rp25.000" },
        { referenceId: "3003", amount: "Rp5.000" },
      ],
    }),
    true,
  );
});

test("paymentCount tidak konsisten dengan panjang paymentDetails (data cacat) -> tetap aman, tidak crash", () => {
  assert.equal(hasMultiPayment({ id: "BK-X", paymentCount: 2, paymentDetails: [{ referenceId: "1", amount: "Rp1" }] }), false);
});
