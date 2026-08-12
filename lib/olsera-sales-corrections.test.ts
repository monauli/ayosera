import test from "node:test";
import assert from "node:assert/strict";
import { FEBRUARY_2026_CORRECTIONS } from "./olsera-sales-corrections.ts";

test("approved February corrections are negative, scoped, and provenance-labeled", () => {
  assert.deepEqual(
    FEBRUARY_2026_CORRECTIONS.map(({ orderNo, itemName, qty, amount, category, provenance }) => ({ orderNo, itemName, qty, amount, category, provenance })),
    [
      { orderNo: "DF0226020500000033", itemName: "ICED LEMON TEA", qty: -1, amount: -21250, category: "LABERS", provenance: "official Olsera export / manual-verified" },
      { orderNo: "DF0226021100000399", itemName: "RAKET STANDAR", qty: -2, amount: -60000, category: "SEWA RAKET", provenance: "official Olsera export / manual-verified" },
    ],
  );
  assert.equal(FEBRUARY_2026_CORRECTIONS.some((row) => /PREMIUM/i.test(row.itemName)), false);
});
