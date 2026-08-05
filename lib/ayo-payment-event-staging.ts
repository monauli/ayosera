import "server-only";
import { paymentEventRevenue, type AyoPaymentEvent } from "./ayo-payment-events.ts";

export const AYO_STAGING_PERIODS = {
  "2026-06": { rows: 1421, total: 242895499 },
  "2026-07": { rows: 1359, total: 237491000 },
} as const;
export type AyoStagingPeriod = keyof typeof AYO_STAGING_PERIODS;

export type StagingPeriodStatus = { rows: number; total: number; duplicate: number; conflict: number; validationStatus: "validated" | "invalid" };
export type AyoPaymentEventStagingRun = { _id: string; periods: Partial<Record<AyoStagingPeriod, StagingPeriodStatus>>; status: "staging" | "validated" | "active" | "invalid"; createdAt: Date; updatedAt: Date; createdBy: string };
export type AyoPaymentEventStagingEvent = AyoPaymentEvent & { runId: string; period: AyoStagingPeriod; eventIdentity: string; payload: AyoPaymentEvent; fetchedAt: Date };
export type AyoPaymentEventActivation = { _id: "ayo-payment-events-active"; activeRunId: string | null; activatedAt: Date; activatedBy: string };

export type StagingReadContext = {
  runs: { findOne(filter: Record<string, unknown>): Promise<AyoPaymentEventStagingRun | null> };
  events: { find(filter: Record<string, unknown>): { toArray(): Promise<AyoPaymentEventStagingEvent[]> } };
  activation: { findOne(filter: Record<string, unknown>): Promise<AyoPaymentEventActivation | null> };
};

export function periodDates(period: AyoStagingPeriod) {
  const [year, month] = period.split("-").map(Number);
  return { start: `${period}-01`, end: `${period}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}` };
}

export function isAyoStagingPeriod(startDate: string, endDate: string): startDate is `${AyoStagingPeriod}-01` {
  return (Object.keys(AYO_STAGING_PERIODS) as AyoStagingPeriod[]).some((period) => {
    const range = periodDates(period);
    return range.start === startDate && range.end === endDate;
  });
}

export function validateStagingPeriod(period: AyoStagingPeriod, events: readonly AyoPaymentEvent[], duplicate: number, conflict: number): StagingPeriodStatus {
  const target = AYO_STAGING_PERIODS[period];
  const total = events.reduce((sum, event) => sum + paymentEventRevenue(event), 0);
  const validationStatus = events.length === target.rows && total === target.total && duplicate === 0 && conflict === 0 ? "validated" : "invalid";
  return { rows: events.length, total, duplicate, conflict, validationStatus };
}

export function isActivatableRun(run: AyoPaymentEventStagingRun | null): run is AyoPaymentEventStagingRun {
  return Boolean(run && (Object.keys(AYO_STAGING_PERIODS) as AyoStagingPeriod[]).every((period) => run.periods[period]?.validationStatus === "validated"));
}

export async function readActiveStagedPaymentEvents(startDate: string, endDate: string, context?: StagingReadContext) {
  if (!isAyoStagingPeriod(startDate, endDate)) return null;
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
    const period = startDate.slice(0, 7) as AyoStagingPeriod;
    const events = await source.events.find({ runId: run._id, period }).toArray();
    const status = validateStagingPeriod(period, events, 0, 0);
    return status.validationStatus === "validated" ? { run, events } : null;
  } catch {
    return null;
  }
}
