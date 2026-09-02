import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isActivatableRun, readActiveStagedPaymentEvents, resolveStagingRange, validateStagingPeriod, type AyoPaymentEventStagingRun } from "./ayo-payment-event-staging.ts";
import { assertPaymentEventActivationAllowed } from "./ayo-payment-events-engine.ts";
import type { AyoPaymentEvent } from "./ayo-payment-events.ts";

function event(id: string, amount: number): AyoPaymentEvent {
  const now = new Date();
  return { _id: id, identity: id, bookingId: `BK${id}`, sourceTable: "order_detail", reservationPaymentId: id, nativeId: id, sourceId: id, eventDate: now, eventDateSource: "date", amount, amountSource: "total", bookingPrefix: "BK", paymentStatus: "SUCCESS", bookingStatus: null, source: "ayo-report-transactions", rawPayload: {}, normalizedPayload: {}, createdAt: now, updatedAt: now, paymentType: null, paymentNote: null, detailStatus: "SUCCESS", finalStatus: "SUCCESS", fieldName: "Padel", date: "2026-06-01", startTime: null, endTime: null, total: amount, finalFeeAyo: 0, isCredit: false, raw: {}, syncedAt: now };
}
function valid(period: "2026-06" | "2026-07", rows: number, total: number) {
  const events = Array.from({ length: rows }, (_, index) => event(`${period}-${index}`, index + 1 === rows ? total : 0));
  return validateStagingPeriod(period, events, 0, 0);
}
function run(periods: AyoPaymentEventStagingRun["periods"]): AyoPaymentEventStagingRun { return { _id: "run-a", periods, status: "validated", createdAt: new Date(), updatedAt: new Date(), createdBy: "supervisor" }; }

test("Juni parsial atau Juli belum ada tidak dapat diaktifkan", () => {
  assert.equal(isActivatableRun(run({ "2026-06": { rows: 1, total: 1, duplicate: 0, conflict: 0, validationStatus: "invalid" } })), false);
  assert.equal(isActivatableRun(run({ "2026-06": valid("2026-06", 1421, 242895499) })), false);
});

test("kedua bulan valid dapat aktif; duplicate atau conflict menolak run", () => {
  const periods = { "2026-06": valid("2026-06", 1421, 242895499), "2026-07": valid("2026-07", 1359, 237491000) };
  assert.equal(isActivatableRun(run(periods)), true);
  assert.equal(isActivatableRun(run({ ...periods, "2026-07": { ...periods["2026-07"], conflict: 1, validationStatus: "invalid" } })), false);
});

test("periode dinamis menerima Agustus dan bulan valid berikutnya, dengan target resmi tetap khusus Juni/Juli", () => {
  const now = new Date("2026-08-05T12:00:00Z");
  assert.deepEqual(resolveStagingRange({ month: "2026-08" }, now), { range: { period: "2026-08", start: "2026-08-01", end: "2026-08-05" } });
  assert.deepEqual(resolveStagingRange({ month: "2026-09" }, new Date("2026-10-02T12:00:00Z")), { range: { period: "2026-09", start: "2026-09-01", end: "2026-09-30" } });
  assert.deepEqual(resolveStagingRange({ startDate: "2026-08-01", endDate: "2026-08-05" }, now), { range: { period: "2026-08", start: "2026-08-01", end: "2026-08-05" } });
  assert.equal(validateStagingPeriod("2026-08", [event("august", 123)], 0, 0).validationStatus, "pending-official-validation");
  assert.equal(validateStagingPeriod("2026-08", [event("august", 123)], 1, 0).validationStatus, "invalid");
});

test("periode dinamis menolak future, format/rentang invalid, dan membatasi rentang", () => {
  const now = new Date("2026-08-05T12:00:00Z");
  assert.deepEqual(resolveStagingRange({ month: "2026-09" }, now), { error: "bulan masa depan tidak diizinkan" });
  assert.match((resolveStagingRange({ month: "2026-8" }, now) as { error: string }).error, /YYYY-MM/);
  assert.match((resolveStagingRange({ startDate: "2026-08-05", endDate: "2026-08-01" }, now) as { error: string }).error, /tidak boleh sebelum/);
  assert.match((resolveStagingRange({ startDate: "2026-07-01", endDate: "2026-08-05" }, now) as { error: string }).error, /maksimal 31 hari/);
});

test("hanya pointer run aktif tervalidasi dibaca; Mei, run lain, dan error Mongo fallback null", async () => {
  const periods = { "2026-06": valid("2026-06", 1421, 242895499), "2026-07": valid("2026-07", 1359, 237491000) };
  const context = {
    activation: { findOne: async () => ({ _id: "ayo-payment-events-active" as const, activeRunId: "run-a", activatedAt: new Date(), activatedBy: "supervisor" }) },
    runs: { findOne: async () => run(periods) },
    events: { find: (filter: Record<string, unknown>) => ({ toArray: async () => filter.runId === "run-a" ? Array.from({ length: 1421 }, (_, index) => ({ ...event(String(index), index + 1 === 1421 ? 242895499 : 0), _id: `run-a:${index}`, runId: "run-a", period: "2026-06" as const, eventIdentity: String(index), payload: event(String(index), index + 1 === 1421 ? 242895499 : 0), fetchedAt: new Date() })) : [] }) },
  };
  assert.equal((await readActiveStagedPaymentEvents("2026-05-01", "2026-05-31", context)) === null, true);
  assert.equal((await readActiveStagedPaymentEvents("2026-06-01", "2026-06-30", context))?.events.length, 1421);
  const broken = { ...context, events: { find: () => ({ toArray: async () => { throw new Error("Mongo error"); } }) } };
  assert.equal(await readActiveStagedPaymentEvents("2026-06-01", "2026-06-30", broken), null);
});

test("historical dan rolling Agustus di-union berdasarkan identity tanpa double count", async () => {
  const periods = { "2026-06": valid("2026-06", 1421, 242895499), "2026-07": valid("2026-07", 1359, 237491000) };
  const august = event("august", 100); august.eventDate = new Date("2026-08-02T00:00:00.000Z"); august.date = "2026-08-02";
  const extra = event("august-new", 200); extra.eventDate = new Date("2026-08-03T00:00:00.000Z"); extra.date = "2026-08-03";
  const staged = (runId: string, value: AyoPaymentEvent) => ({ ...value, _id: `${runId}:${value._id}`, runId, period: "2026-08", eventIdentity: value.identity, payload: value, fetchedAt: new Date() });
  const context = {
    activation: { findOne: async () => ({ _id: "ayo-payment-events-active" as const, activeRunId: "run-a", activatedAt: new Date(), activatedBy: "supervisor" }) },
    runs: { findOne: async () => run(periods) },
    events: { find: (filter: Record<string, unknown>) => ({ toArray: async () => filter.runId === "run-a" ? [staged("run-a", august)] : filter.runId === "ayo-sync:rolling" ? [staged("ayo-sync:rolling", august), staged("ayo-sync:rolling", extra)] : [] }) },
  };
  const result = await readActiveStagedPaymentEvents("2026-08-01", "2026-08-05", context);
  assert.equal(result?.events.length, 2);
  assert.equal(result?.events.reduce((sum, value) => sum + value.amount, 0), 300);
});

test("release guard hanya membuka aktivasi setelah pointer lama resmi null", () => {
  assert.doesNotThrow(() => assertPaymentEventActivationAllowed(null));
  assert.throws(() => assertPaymentEventActivationAllowed("legacy-run"), /officially rolled back/);
  assert.throws(() => assertPaymentEventActivationAllowed(undefined), /officially rolled back/);
});

test("dashboard memakai staging aktif hanya untuk metrik, bukan mengganti widget booking", async () => {
  const source = await readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8");
  assert.match(source, /readActiveStagedPaymentEvents/);
  assert.match(source, /isPaymentEventsReadEnabled\(\) && canUsePaymentEvents/);
  assert.doesNotMatch(source, /ayoPaymentEvents|ayoPaymentPeriods|readValidatedPaymentEvents/);
  assert.match(source, /const analyzedFiltered = filteredBookings\.map\(analyzeBooking\)/);
  assert.match(source, /const paymentMetrics = buildDashboardPaymentMetrics/);
  assert.doesNotMatch(source, /paymentEventAsBooking/);
  assert.match(source, /totalTransactions: paymentMetrics\.totalTransactions/);
  assert.match(source, /revenueMonth: toIdrFull\(paymentMetrics\.revenueMonth\)/);
  assert.doesNotMatch(source, /dashboardRows/);
});

test("flag dashboard fail-safe: pointer aktif tidak dibaca tanpa opt-in; opt-in hanya untuk metrik", async () => {
  const source = await readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8");
  assert.match(source, /const validatedPaymentEvents = isPaymentEventsReadEnabled\(\) && canUsePaymentEvents/);
  assert.match(source, /const analyzedFiltered = filteredBookings\.map\(analyzeBooking\)/);
  assert.match(source, /bookingTotal: paymentMetrics\.bookingTotal/);
  assert.match(source, /paymentEvents: validatedPaymentEvents\?\.events \?\? null/);
});

test("aktivasi memakai satu pointer atomik, rollback tidak menghapus, dan Olsera tidak memakai staging", async () => {
  const [route, courtSource, ledger] = await Promise.all([
    readFile(new URL("../app/api/supervisor/ayo-payment-events/backfill/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./reconciliation-court-revenue-source.ts", import.meta.url), "utf8"),
    readFile(new URL("./reconciliation-omzet-ledger.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /findOneAndUpdate\(\{ _id: "ayo-payment-events-active" \}/);
  assert.match(route, /assertPaymentEventActivationAllowed/);
  assert.match(route, /status: 423/);
  assert.match(route, /if \(action === "rollback"\)/);
  assert.match(route, /activeRunId: rollbackToRunId/);
  assert.doesNotMatch(route, /deleteMany|deleteOne|drop\(|createIndex/);
  assert.match(courtSource, /readActiveStagedPaymentEvents/);
  assert.match(ledger, /readActiveStagedPaymentEvents/);
});

// ---------------------------------------------------------------------------
// 21 Agustus: root cause export harian/range/bulanan salah nominal (0002994
// menampilkan Rp50.000 alih-alih Rp200.000) bukan payment-events yang hilang
// atau flag mati — ketiga route SELALU mengirim akhir bulan KALENDER
// (mis. "2026-08-31") ke readActiveStagedPaymentEvents() untuk bulan
// BERJALAN, padahal resolveStagingRange() menolak endDate > hari ini
// ("tanggal masa depan tidak diizinkan"). Untuk hari ini 2026-08-21, itu
// membuat SELURUH rentang Agustus ditolak (bukan cuma booking 0002994) —
// readActiveStagedPaymentEvents() return null, export fallback ke
// bookings.total_price mentah untuk SEMUA booking bulan berjalan.
// ---------------------------------------------------------------------------

// Fix (2 September): resolveStagingRange() sendiri sekarang memotong endDate
// masa depan ke hari ini (sama seperti workaround manual di ketiga route
// export di bawah), bukan menolak seluruh rentang. Ini menutup celah yang
// sama untuk pemanggil yang BELUM meng-cap sendiri, mis. app/api/dashboard/
// route.ts — sebelum fix ini, dashboard bulan berjalan selalu fallback.
test("REGRESSION 21 Agustus (ditutup di sumber): endDate akhir bulan kalender untuk bulan BERJALAN dipotong ke hari ini, bukan ditolak", () => {
  const today = new Date("2026-08-21T12:00:00Z");
  const accepted = resolveStagingRange({ startDate: "2026-08-01", endDate: "2026-08-31" }, today);
  assert.deepEqual(accepted, { range: { period: "2026-08", start: "2026-08-01", end: "2026-08-21" } });
});

test("startDate itu sendiri di masa depan tetap ditolak (tidak ada yang bisa dipotong)", () => {
  const today = new Date("2026-08-21T12:00:00Z");
  const rejected = resolveStagingRange({ startDate: "2026-09-01", endDate: "2026-09-30" }, today);
  assert.deepEqual(rejected, { error: "tanggal masa depan tidak diizinkan" });
});

test("REGRESSION 21 Agustus: fix (cap endDate ke hari ini untuk bulan berjalan) membuat rentang diterima", () => {
  const today = new Date("2026-08-21T12:00:00Z");
  // Formula fix yang dipakai ketiga route export: min(akhir bulan kalender, hari ini).
  const monthCalendarEnd = "2026-08-31";
  const cappedEnd = monthCalendarEnd < "2026-08-21" ? monthCalendarEnd : "2026-08-21";
  assert.equal(cappedEnd, "2026-08-21");
  const accepted = resolveStagingRange({ startDate: "2026-08-01", endDate: cappedEnd }, today);
  // endDate == hari ini -> rangePeriod() mengenali ini sebagai bulan berjalan penuh ("2026-08"),
  // bukan rentang custom "start:end" — lihat rangePeriod() di lib/ayo-payment-event-staging.ts.
  assert.deepEqual(accepted, { range: { period: "2026-08", start: "2026-08-01", end: "2026-08-21" } });
});

test("REGRESSION 21 Agustus: bulan yang SUDAH LEWAT SEPENUHNYA tidak terpengaruh fix (cap = no-op, perilaku sama seperti sebelumnya)", () => {
  const today = new Date("2026-09-15T12:00:00Z");
  const monthCalendarEnd = "2026-08-31";
  // Bulan Agustus sudah lewat total per hari ini (September) — cap tidak mengubah apa pun.
  const cappedEnd = monthCalendarEnd < "2026-09-15" ? monthCalendarEnd : "2026-09-15";
  assert.equal(cappedEnd, monthCalendarEnd, "endDate untuk bulan yang sudah lewat tidak boleh berubah oleh fix ini");
  const result = resolveStagingRange({ startDate: "2026-08-01", endDate: cappedEnd }, today);
  assert.deepEqual(result, { range: { period: "2026-08", start: "2026-08-01", end: "2026-08-31" } });
});

test("REGRESSION 21 Agustus: ketiga route export harian/range/bulanan meng-cap endDate payment-events ke hari ini, tidak pernah kirim tanggal masa depan", async () => {
  const [harian, range, bulanan] = await Promise.all([
    readFile(new URL("../app/api/transactions/export/harian/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/transactions/export/range/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/transactions/export/bulanan/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(harian, /monthCalendarEnd < todayJakarta\(\) \? monthCalendarEnd : todayJakarta\(\)/);
  assert.match(harian, /readActiveStagedPaymentEvents\(monthStart, monthEnd,/);
  assert.match(range, /end < todayJakarta\(\) \? end : todayJakarta\(\)/);
  assert.match(range, /readActiveStagedPaymentEvents\(start, paymentEventsEnd,/);
  assert.match(bulanan, /end < todayJakarta\(\) \? end : todayJakarta\(\)/);
  assert.match(bulanan, /readActiveStagedPaymentEvents\(start, paymentEventsEnd,/);
});
