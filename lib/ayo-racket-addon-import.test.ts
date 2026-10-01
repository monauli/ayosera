import assert from "node:assert/strict";
import test from "node:test";
import { parseRacketAddonRows } from "./ayo-racket-addon-import.ts";

test("parseRacketAddonRows mengambil Booking ID dan nilai Sewa Raket Add On", () => {
  const result = parseRacketAddonRows([
    ["Laporan transaksi"],
    ["Booking ID", "Date of Booking", "Sewa Raket Add On", "Payment ID"],
    ["BK/1", "2026-09-26", 50000, "PAY-1"],
    ["BK/2", "2026-09-26", "100.000", "PAY-1"],
    ["BK/3", "2026-09-26", 0, "PAY-2"],
  ]);

  assert.deepEqual(result.rows, [
    { bookingId: "BK/1", date: "2026-09-26", amount: 50000, paymentId: "PAY-1" },
    { bookingId: "BK/2", date: "2026-09-26", amount: 100000, paymentId: "PAY-1" },
    { bookingId: "BK/3", date: "2026-09-26", amount: 0, paymentId: "PAY-2" },
  ]);
  assert.equal(result.addonCount, 2);
  assert.equal(result.totalAmount, 150000);
});

test("parseRacketAddonRows: header tidak ada -> headerFound false, tanpa baris", () => {
  const result = parseRacketAddonRows([["Booking ID", "Total"], ["BK/1", 1000]]);
  assert.equal(result.headerFound, false);
  assert.deepEqual(result.rows, []);
});

test("parseRacketAddonRows: format angka ID/EN dan nilai negatif/invalid", () => {
  const result = parseRacketAddonRows([
    ["Booking ID", "Date of Booking", "Sewa Raket Add On", "Payment ID"],
    ["BK/1", "2026-09-26", "1.500,50", "P1"],
    ["BK/2", "2026-09-26", "1,500", "P2"],
    ["BK/3", "2026-09-26", -5000, "P3"],
    ["BK/4", "2026-09-26", "abc", "P4"],
  ]);
  assert.deepEqual(result.rows.map((row) => row.amount), [1500.5, 1500, 0, 0]);
  assert.equal(result.addonCount, 2);
});
