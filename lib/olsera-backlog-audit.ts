// Olsera orders are also edited or voided after their day is over, but the
// sales cron only audits today and H-1. Each run additionally audits a few
// older dates from the backlog window (lib/backlog-sync.ts), resuming after
// the last audited date. A matching day costs two Order List requests; a
// mismatching day is re-pulled in full. Locked omzet periods are skipped and a
// failed date is retried on the next run.
import { auditAndSyncOlseraDay } from "@/lib/olsera-sync";
import { collections, withMongo } from "@/lib/mongodb";
import { currentStoreId } from "@/lib/olsera-store-id";
import { nextBacklogDate } from "@/lib/backlog-sync";

export const OLSERA_BACKLOG_DAYS_PER_RUN = 3;

export async function auditOlseraBacklog(today: string) {
  const audited: { date: string; action: string }[] = [];
  let last = await withMongo(async () => (await (await collections()).olseraSyncState.findOne({ _id: "olsera" }))?.backlogAuditDate ?? null);
  for (let i = 0; i < OLSERA_BACKLOG_DAYS_PER_RUN; i++) {
    const date = nextBacklogDate(today, last);
    if (!date) break;
    const locked = await withMongo(async () => (await (await collections()).reconciliationOmzetPeriodLocks.findOne({ _id: `${currentStoreId()}:${date.slice(0, 7)}` }))?.status === "locked");
    const action = locked ? "locked" : (await auditAndSyncOlseraDay(date)).action;
    audited.push({ date, action });
    if (action === "failed") break;
    last = date;
    await withMongo(async () => (await collections()).olseraSyncState.updateOne({ _id: "olsera" }, { $set: { backlogAuditDate: date, updatedAt: new Date() } }, { upsert: true }));
  }
  return audited;
}
