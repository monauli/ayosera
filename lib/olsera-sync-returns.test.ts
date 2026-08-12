import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOlseraItem } from "./olsera-sync.ts";

test("retur Olsera mengurangi qty dan nominal secara generic", () => {
  assert.deepEqual(
    normalizeOlseraItem({ qty: 1, amount: 21250, return_qty: 1, return_amount: 21250 }),
    { qty: 0, amount: 0, originalCategoryId: null, originalCategoryName: null },
  );
  assert.deepEqual(
    normalizeOlseraItem({ qty: -2, amount: -60000 }),
    { qty: -2, amount: -60000, originalCategoryId: null, originalCategoryName: null },
  );
});

test("kategori asli item transaksi mengalahkan katalog yang berubah", () => {
  assert.deepEqual(
    normalizeOlseraItem({ qty: 1, amount: 20000, category_id: 99, category_name: "CUSTOM" }),
    { qty: 1, amount: 20000, originalCategoryId: "99", originalCategoryName: "CUSTOM" },
  );
});

test("bukti resmi Februari: dua order retur netral di kategori yang sama", () => {
  const labers = [
    { qty: 1, amount: 21250, category_name: "LABERS" },
    { qty: -1, amount: -21250, category_name: "LABERS" },
  ].map(normalizeOlseraItem);
  const sewa = [
    { qty: 2, amount: 60000, category_name: "SEWA RAKET" },
    { qty: -2, amount: -60000, category_name: "SEWA RAKET" },
    { qty: 1, amount: 50000, category_name: "SEWA RAKET" },
  ].map(normalizeOlseraItem);
  assert.deepEqual(labers.reduce((s, x) => ({ qty: s.qty + x.qty, amount: s.amount + x.amount }), { qty: 0, amount: 0 }), { qty: 0, amount: 0 });
  assert.deepEqual(sewa.reduce((s, x) => ({ qty: s.qty + x.qty, amount: s.amount + x.amount }), { qty: 0, amount: 0 }), { qty: 1, amount: 50000 });
});
