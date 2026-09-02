import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildDashboardPaymentMetrics, dashboardPaymentAmountsByBooking } from "./dashboard-payment-metrics.ts";
import type { AyoPaymentEvent } from "./ayo-payment-events.ts";
import { paymentEventAsBooking } from "./ayo-payment-events-sync.ts";
import { isDisplayEligibleTransaction } from "./revenue.ts";

function event(id: string, amount: number): AyoPaymentEvent {
  const now = new Date("2026-06-01T00:00:00.000Z");
  return { _id: id, identity: `order_detail:BK-${id}:RP-${id}`, bookingId: `BK-${id}`, sourceTable: "order_detail", reservationPaymentId: `RP-${id}`, nativeId: id, sourceId: id, eventDate: now, eventDateSource: "payment_date", amount, amountSource: "final_fee_ayo", bookingPrefix: "BK", paymentStatus: "SUCCESS", bookingStatus: "FINISHED", source: "ayo-report-transactions", rawPayload: {}, normalizedPayload: {}, createdAt: now, updatedAt: now, paymentType: null, paymentNote: null, detailStatus: "SUCCESS", finalStatus: "SUCCESS", fieldName: "Court", date: "2026-06-01", startTime: null, endTime: null, total: amount, finalFeeAyo: amount, isCredit: false, raw: {}, syncedAt: now };
}
function fixture(rows: number, total: number, legacyEligible = rows) {
  return Array.from({ length: rows }, (_, index) => event(String(index), index < legacyEligible ? (index === legacyEligible - 1 ? total - legacyEligible + 1 : 1) : 0));
}

test("Juni payment metrics tidak dipotong filter booking; status total tetap booking", () => {
  const events = fixture(1421, 242895499, 1006);
  assert.equal(events.map(paymentEventAsBooking).filter(isDisplayEligibleTransaction).length, 1006);
  const result = buildDashboardPaymentMetrics({ bookingTotal: 1596, fallbackTransactions: 1596, fallbackRevenue: 0, paymentEvents: events });
  assert.deepEqual(result, { totalTransactions: 1421, revenueMonth: 242895499, bookingTotal: 1596 });
  assert.notEqual(result.totalTransactions, 1006);
});

test("Juli payment metrics tidak dipotong filter booking; status total tetap booking", () => {
  const events = fixture(1359, 237491000, 977);
  assert.equal(events.map(paymentEventAsBooking).filter(isDisplayEligibleTransaction).length, 977);
  const result = buildDashboardPaymentMetrics({ bookingTotal: 1560, fallbackTransactions: 1560, fallbackRevenue: 0, paymentEvents: events });
  assert.deepEqual(result, { totalTransactions: 1359, revenueMonth: 237491000, bookingTotal: 1560 });
  assert.notEqual(result.totalTransactions, 977);
});

test("Agustus dedupe identity dan fallback booking tetap terpisah", () => {
  const historical = fixture(221, 37625000);
  const union = [...historical, ...historical, event("new", 1)];
  assert.deepEqual(buildDashboardPaymentMetrics({ bookingTotal: 251, fallbackTransactions: 251, fallbackRevenue: 99, paymentEvents: historical }), { totalTransactions: 221, revenueMonth: 37625000, bookingTotal: 251 });
  assert.equal(buildDashboardPaymentMetrics({ bookingTotal: 251, fallbackTransactions: 251, fallbackRevenue: 99, paymentEvents: union }).totalTransactions, 222);
  assert.deepEqual(buildDashboardPaymentMetrics({ bookingTotal: 251, fallbackTransactions: 251, fallbackRevenue: 99, paymentEvents: null }), { totalTransactions: 251, revenueMonth: 99, bookingTotal: 251 });
});

test("route dan donut memakai kontrak payment-versus-booking yang terpisah", async () => {
  const [route, exportRoute, page] = await Promise.all([
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/transactions/export/bulanan/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /buildDashboardPaymentMetrics/);
  assert.doesNotMatch(route, /paymentEventAsBooking/);
  assert.match(route, /bookingTotal: paymentMetrics\.bookingTotal/);
  assert.match(exportRoute, /readActiveStagedPaymentEvents/);
  // Koreksi 20 Agustus: export bulanan sekarang pakai aggregateBookingPayments
  // + withBookingPaymentTotals (lib/booking-payment-aggregate.ts) — resolver
  // yang sama dengan Transaksi AYO — bukan lagi dashboardPaymentAmountsByBooking
  // + withCanonicalPaymentAmounts, yang terbukti bisa divergen dari Transaksi
  // AYO untuk booking split-payment.
  assert.match(exportRoute, /aggregateBookingPayments/);
  assert.match(exportRoute, /withBookingPaymentTotals/);
  assert.match(page, /const totalBookings = metrics\?\.bookingTotal \?\? 0/);
});

test("agregasi export memakai identity Dashboard: payment berbeda dijumlahkan, duplicate identity tidak", () => {
  const first = event("first", 150000);
  first.bookingId = "MN/2428/260729/0002761";
  const second = event("second", 50000);
  second.bookingId = "MN/2428/260729/0002761";
  const duplicateLatest = { ...first, amount: 150000 };
  const amounts = dashboardPaymentAmountsByBooking([first, second, duplicateLatest]);
  assert.equal(amounts.get("MN/2428/260729/0002761"), 200000);
  assert.equal(amounts.size, 1);
  // totalTransactions = 1 (bukan 2): split-payment satu booking dihitung sebagai
  // satu transaksi, sama seperti Court Performance (dashboardPaymentAmountsByBooking).
  assert.deepEqual(
    buildDashboardPaymentMetrics({ bookingTotal: 1, fallbackTransactions: 1, fallbackRevenue: 50000, paymentEvents: [first, second, duplicateLatest] }),
    { totalTransactions: 1, revenueMonth: 200000, bookingTotal: 1 },
  );
});

test("chart Pendapatan Bulanan menyediakan ruang penuh untuk label sumbu-Y tanpa mengubah konfigurasi data", async () => {
  const chart = await readFile(new URL("../components/redesign/annual-revenue-chart.tsx", import.meta.url), "utf8");
  assert.match(chart, /<BarChart data=\{data\} margin=\{\{ top: 4, right: 4, left: 8, bottom: 0 \}\}>/);
  assert.match(chart, /<YAxis[\s\S]*?width=\{64\}[\s\S]*?tickFormatter=\{\(value: number\) => formatRupiahCompact\(value\)\}/);
  assert.match(chart, /<Tooltip content=\{<RevenueTooltip \/>} cursor=\{\{ fill: "rgba\(255,255,255,0\.04\)" \}\} \/>/);
  assert.match(chart, /<Bar dataKey="amount" radius=\{\[5, 5, 0, 0\]\} maxBarSize=\{34\}/);
});
