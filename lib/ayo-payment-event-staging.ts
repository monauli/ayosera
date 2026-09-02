import "server-only";
import { paymentEventRevenue, type AyoPaymentEvent } from "./ayo-payment-events.ts";

/** Official regression baselines only; all other valid ranges remain pending review. */
export const AYO_STAGING_PERIODS = {
  "2026-06": { rows: 1421, total: 242895499 },
  "2026-07": { rows: 1359, total: 237491000 },
} as const;
export type OfficialAyoStagingPeriod = keyof typeof AYO_STAGING_PERIODS;
export type AyoStagingPeriod = string;
export type StagingValidationStatus = "validated" | "pending-official-validation" | "invalid";
export type StagingPeriodStatus = { rows: number; total: number; duplicate: number; conflict: number; validationStatus: StagingValidationStatus };
export type AyoPaymentEventStagingRun = { _id: string; periods: Partial<Record<AyoStagingPeriod, StagingPeriodStatus>>; status: "staging" | "validated" | "active" | "invalid"; createdAt: Date; updatedAt: Date; createdBy: string };
export type AyoPaymentEventStagingEvent = AyoPaymentEvent & { runId: string; period: AyoStagingPeriod; eventIdentity: string; payload: AyoPaymentEvent; fetchedAt: Date };
export type AyoPaymentEventActivation = { _id: "ayo-payment-events-active"; activeRunId: string | null; activatedAt: Date; activatedBy: string };

export type StagingReadContext = {
  runs: { findOne(filter: Record<string, unknown>): Promise<AyoPaymentEventStagingRun | null> };
  events: { find(filter: Record<string, unknown>): { toArray(): Promise<AyoPaymentEventStagingEvent[]> } };
  activation: { findOne(filter: Record<string, unknown>): Promise<AyoPaymentEventActivation | null> };
};

type StagingRange = { period: AyoStagingPeriod; start: string; end: string };
type StagingRangeInput = { month?: unknown; startDate?: unknown; endDate?: unknown };
const MAX_STAGING_DAYS = 31;

function jakartaDate(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function daysInMonth(month: string) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function rangePeriod(start: string, end: string, today: string) {
  const month = start.slice(0, 7);
  const isMonth = start.endsWith("-01") && end.slice(0, 7) === month && (end === `${month}-${String(daysInMonth(month)).padStart(2, "0")}` || end === today);
  return isMonth ? month : `${start}:${end}`;
}

/** Resolves only a safe, non-future calendar range in Asia/Jakarta. */
export function resolveStagingRange(input: StagingRangeInput, now = new Date()): { range: StagingRange } | { error: string } {
  const today = jakartaDate(now);
  const month = typeof input.month === "string" ? input.month : undefined;
  const startDate = typeof input.startDate === "string" ? input.startDate : undefined;
  const endDate = typeof input.endDate === "string" ? input.endDate : undefined;
  if (month && (startDate || endDate)) return { error: "gunakan month atau startDate/endDate, bukan keduanya" };
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) return { error: "month harus format YYYY-MM yang valid" };
    if (month > today.slice(0, 7)) return { error: "bulan masa depan tidak diizinkan" };
    const start = `${month}-01`;
    const end = month === today.slice(0, 7) ? today : `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
    return { range: { period: month, start, end } };
  }
  if (!startDate || !endDate || !validDate(startDate) || !validDate(endDate)) return { error: "startDate dan endDate harus format YYYY-MM-DD yang valid" };
  if (endDate < startDate) return { error: "endDate tidak boleh sebelum startDate" };
  if (startDate > today) return { error: "tanggal masa depan tidak diizinkan" };
  // Rentang berjalan (mis. 1..akhir bulan ini) dipotong ke hari ini, sama seperti
  // shorthand `month` di atas — bukan ditolak, supaya bulan berjalan tetap bisa
  // memakai payment events tervalidasi sampai hari terakhir yang datanya ada.
  const end = endDate > today ? today : endDate;
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_STAGING_DAYS) return { error: `rentang maksimal ${MAX_STAGING_DAYS} hari` };
  return { range: { period: rangePeriod(startDate, end, today), start: startDate, end } };
}

export function validateStagingPeriod(period: AyoStagingPeriod, events: readonly AyoPaymentEvent[], duplicate: number, conflict: number): StagingPeriodStatus {
  const total = events.reduce((sum, event) => sum + paymentEventRevenue(event), 0);
  const target = AYO_STAGING_PERIODS[period as OfficialAyoStagingPeriod];
  if (!target) return { rows: events.length, total, duplicate, conflict, validationStatus: duplicate === 0 && conflict === 0 ? "pending-official-validation" : "invalid" };
  const validationStatus = events.length === target.rows && total === target.total && duplicate === 0 && conflict === 0 ? "validated" : "invalid";
  return { rows: events.length, total, duplicate, conflict, validationStatus };
}

export function isActivatableRun(run: AyoPaymentEventStagingRun | null): run is AyoPaymentEventStagingRun {
  return Boolean(run && (Object.keys(AYO_STAGING_PERIODS) as OfficialAyoStagingPeriod[]).every((period) => run.periods[period]?.validationStatus === "validated"));
}

export async function readActiveStagedPaymentEvents(startDate: string, endDate: string, context?: StagingReadContext) {
  const resolved = resolveStagingRange({ startDate, endDate });
  if ("error" in resolved || startDate < "2026-06-01") return null;
  try {
    const source = context ?? await (async () => {
      const { collections } = await import("./mongodb.ts");
      const c = await collections();
      return { runs: c.ayoPaymentEventStagingRuns, events: c.ayoPaymentEventStagingEvents, activation: c.ayoPaymentEventActivation };
    })();
    const activation = await source.activation.findOne({ _id: "ayo-payment-events-active" });
    if (!activation?.activeRunId) return null;
    const run = await source.runs.findOne({ _id: activation.activeRunId });
    if (!isActivatableRun(run)) return null;
    const official = resolved.range.period === "2026-06" || resolved.range.period === "2026-07";
    if (official && run.periods[resolved.range.period]?.validationStatus !== "validated") return null;
    const range = { $gte: new Date(`${resolved.range.start}T00:00:00.000Z`), $lte: new Date(`${resolved.range.end}T23:59:59.999Z`) };
    const historical = await source.events.find({ runId: run._id, eventDate: range }).toArray();
    if (official) {
      const status = validateStagingPeriod(resolved.range.period, historical, 0, 0);
      return status.validationStatus === "validated" ? { run, events: historical } : null;
    }
    // Rolling is intentionally combined only after a fully validated historical run is active.
    // Its eventIdentity is the deterministic business identity, so overlap rows never count twice.
    const rolling = await source.events.find({ runId: "ayo-sync:rolling", eventDate: range }).toArray();
    const byIdentity = new Map<string, AyoPaymentEvent>();
    for (const staged of [...historical, ...rolling]) byIdentity.set(staged.eventIdentity || staged.identity, staged);
    return { run, events: [...byIdentity.values()] };
  } catch {
    return null;
  }
}
