// AYO bookings and Olsera orders keep changing after their date (late manual
// payments, price revisions, cancellations, voided orders), but the scheduled
// syncs only cover today and yesterday. Each cron run therefore also revisits
// older dates in the backlog window, from the 1st of the previous month up to
// two days ago, so such edits land within a few runs instead of never.

export const AYO_BACKLOG_DAYS_PER_RUN = 6;

function shiftDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function previousMonthStart(date: string) {
  const value = new Date(`${date.slice(0, 7)}-01T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() - 1);
  return value.toISOString().slice(0, 10);
}

/** Dates of the backlog slice for this run (`runIndex` rotates through the window). */
export function ayoBacklogDates(today: string, runIndex: number, perRun = AYO_BACKLOG_DAYS_PER_RUN): string[] {
  const dates: string[] = [];
  for (let date = previousMonthStart(today), last = shiftDays(today, -2); date <= last; date = shiftDays(date, 1)) dates.push(date);
  if (!dates.length) return [];
  const offset = (Math.abs(Math.trunc(runIndex)) % Math.ceil(dates.length / perRun)) * perRun;
  return dates.slice(offset, offset + perRun);
}

/** Date after `last` in the backlog window, wrapping to the window start. */
export function nextBacklogDate(today: string, last: string | null | undefined): string | null {
  const first = previousMonthStart(today);
  const end = shiftDays(today, -2);
  if (first > end) return null;
  const next = last ? shiftDays(last, 1) : first;
  return next < first || next > end ? first : next;
}
