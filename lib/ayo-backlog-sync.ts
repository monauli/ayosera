// AYO bookings keep changing after their play date (late manual payments,
// price revisions, cancellations), but the scheduled sync only pulls
// yesterday -> today. Each cron run therefore also re-pulls one rotating slice
// of older dates, from the 1st of the previous month up to two days ago, so
// such edits land within a few runs instead of never.

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
