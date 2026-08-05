import { readFile } from "node:fs/promises";
import { getDb } from "../lib/mongodb.ts";
import { fetchAyoPaymentEvents, paymentEventRevenue, validatePaymentPeriod, type AyoPaymentEvent, type AyoPaymentPeriodMetadata } from "../lib/ayo-payment-events.ts";
import { assertBackfillWriteAllowed, BACKFILL_CONFIRM, planBackfill } from "../lib/ayo-payment-events-backfill.ts";

type Args = { from: string; to: string; dryRun: boolean; write: boolean; confirm?: string; month?: string; resume: boolean };
const TARGETS: Record<string, { rows: number; total: number }> = { "2026-02": { rows: 375, total: 107593500 }, "2026-03": { rows: 745, total: 197855000 }, "2026-04": { rows: 1160, total: 242129999 }, "2026-05": { rows: 1515, total: 277457500 }, "2026-06": { rows: 1421, total: 242895499 }, "2026-07": { rows: 1359, total: 237491000 } };

function parseArgs(argv: string[]): Args {
  const values = new Map(argv.filter((arg) => arg.startsWith("--")).map((arg) => { const [key, ...rest] = arg.slice(2).split("="); return [key, rest.join("=") || "true"]; }));
  const from = values.get("from") ?? "2026-02-01";
  const to = values.get("to") ?? "2026-07-31";
  const dryRun = values.get("dry-run") === "true" || !values.has("write");
  const write = values.get("write") === "true";
  if (dryRun === write) throw new Error("Pilih tepat satu mode: --dry-run atau --write.");
  if (values.has("confirm") && values.get("confirm") !== BACKFILL_CONFIRM) throw new Error(`--confirm harus ${BACKFILL_CONFIRM}.`);
  if (values.has("month") && !/^2026-(0[2-7])$/.test(values.get("month")!)) throw new Error("--month harus salah satu 2026-02 sampai 2026-07.");
  return { from, to, dryRun, write, confirm: values.get("confirm"), month: values.get("month"), resume: values.get("resume") === "true" };
}

async function loadEnv() {
  const text = await readFile(".env.local", "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(AYO_MOBILE_TOKEN|MONGODB_URI)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  if (!process.env.AYO_MOBILE_TOKEN || !process.env.MONGODB_URI) throw new Error("AYO_MOBILE_TOKEN dan MONGODB_URI wajib tersedia.");
}

function months(args: Args) {
  const selected = args.month ? [args.month] : Object.keys(TARGETS);
  return selected.filter((period) => `${period}-01` >= args.from && `${period}-31` <= args.to);
}

function range(period: string) { const [year, month] = period.split("-").map(Number); return { start: `${period}-01`, end: `${period}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}` }; }
function runId() { return `backfill-ayo-payment-events:${new Date().toISOString()}`; }

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Backfill AYO gagal.";
  return message.replace(/(mobile_token|AYO_MOBILE_TOKEN|MONGODB_URI)\s*[=:]\s*[^\s&]+/gi, "$1=[redacted]").replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "mongodb://[redacted]");
}

async function main() {
  await loadEnv();
  const args = parseArgs(process.argv.slice(2));
  assertBackfillWriteAllowed(args);
  const selected = months(args);
  if (!selected.length) throw new Error("Scope kosong; gunakan Februari–Juli 2026.");
  const run = runId();
  const db = await getDb();
  const eventsCollection = db.collection<AyoPaymentEvent>("ayo_payment_events");
  const periodsCollection = db.collection<AyoPaymentPeriodMetadata>("ayo_payment_periods");
  const auditCollection = db.collection("ayo_payment_event_backfill_audit_logs");
  const plans: Array<{ period: string; plan: ReturnType<typeof planBackfill>; expected: { rows: number; total: number }; apiTotal: number; validationStatus: string }> = [];

for (const period of selected) {
  const { start, end } = range(period);
  const api = await fetchAyoPaymentEvents(start, end);
  const existing = await eventsCollection.find({ date: { $gte: start, $lte: end } }).toArray();
  const plan = planBackfill(api.events, existing);
  const target = TARGETS[period];
  const validation = validatePaymentPeriod({ startDate: start, endDate: end, events: plan.finalProjectedEvents, expectedTotalTransaction: api.expectedTotalTransaction, expectedTotal: api.expectedTotal, conflictCount: plan.conflict });
  const targetOk = api.expectedTotalTransaction === target.rows && api.expectedTotal === target.total;
  const validationStatus = validation.status === "validated" && targetOk ? "validated" : "invalid";
  plans.push({ period, plan, expected: target, apiTotal: api.expectedTotal, validationStatus });
  console.log(JSON.stringify({ runId: run, period, apiRows: api.events.length, apiTotal: api.expectedTotal, existingEvents: existing.length, wouldInsert: plan.wouldInsert, wouldUpdate: plan.wouldUpdate, unchanged: plan.unchanged, duplicate: plan.duplicate, conflict: plan.conflict, finalProjectedRows: plan.finalProjectedRows, finalProjectedTotal: plan.finalProjectedEvents.reduce((sum, event) => sum + paymentEventRevenue(event), 0), validationStatus }));
}

  if (plans.some((item) => item.validationStatus !== "validated")) {
    process.exitCode = 1;
  } else if (args.write) {
    for (const item of plans) {
      const now = new Date();
      if (item.plan.finalProjectedEvents.length) await eventsCollection.bulkWrite(item.plan.finalProjectedEvents.map((event) => ({ updateOne: { filter: { _id: event._id }, update: { $set: event }, upsert: true } })));
      const { start, end } = range(item.period);
      await periodsCollection.updateOne({ _id: `${start}:${end}` }, { $set: { _id: `${start}:${end}`, startDate: start, endDate: end, fetchedRows: item.plan.finalProjectedRows, expectedTotalTransaction: item.expected.rows, calculatedTotal: item.plan.finalProjectedEvents.reduce((sum, event) => sum + paymentEventRevenue(event), 0), expectedTotal: item.expected.total, validationStatus: "validated", lastSuccessfulSyncAt: now, errorCode: null, errorMessage: null, conflictCount: 0, updatedAt: now } }, { upsert: true });
      await auditCollection.insertOne({ runId: run, period: item.period, from: range(item.period).start, to: range(item.period).end, inserted: item.plan.wouldInsert, updated: item.plan.wouldUpdate, unchanged: item.plan.unchanged, duplicate: item.plan.duplicate, conflict: item.plan.conflict, status: "success", createdAt: now });
    }
  }
}

main().catch((error) => {
  console.error(sanitizeError(error));
  process.exitCode = 1;
});
