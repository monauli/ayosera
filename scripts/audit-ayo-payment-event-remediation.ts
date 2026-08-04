import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
}

const { sumAyoPaymentEvents, toAyoPaymentEvent } = await import("../lib/ayo-payment-events.ts");
const { normalizeBooking } = await import("../lib/booking-mapper.ts");

const expected: Record<string, { count: number; revenue: number }> = {
  "2026-06": { count: 1421, revenue: 242895499 },
  "2026-07": { count: 1359, revenue: 237491000 },
};

async function readMongo(period: string) {
  if (process.argv.includes("--samples-only")) return { events: [], bookingRows: [], error: "MongoDB read skipped (--samples-only)" };
  try {
    const { collections } = await import("../lib/mongodb.ts");
    const { bookings, ayoPaymentEvents } = await Promise.race([
      collections(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("MongoDB read timeout")), 7000)),
    ]);
    const [events, bookingRows] = await Promise.all([
      ayoPaymentEvents.find({ date: { $gte: `${period}-01`, $lte: `${period}-31` } }).toArray(),
      bookings.find({ date: { $gte: `${period}-01`, $lte: `${period}-31` } }).toArray(),
    ]);
    return { events, bookingRows, error: null };
  } catch (error) {
    return { events: [], bookingRows: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function sampleEvents(period: string) {
  const dir = path.join(process.cwd(), "samples", "production", "list-bookings");
  const seen = new Map<string, ReturnType<typeof toAyoPaymentEvent>>();
  for (const file of readdirSync(dir).filter((name) => name.startsWith(`${period}-`))) {
    const payload = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    const rows = Array.isArray(payload?.response?.data) ? payload.response.data : Array.isArray(payload?.data) ? payload.data : [];
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const event = toAyoPaymentEvent(normalizeBooking(raw));
      seen.set(event._id, event);
    }
  }
  return [...seen.values()];
}

for (const period of ["2026-06", "2026-07"]) {
  const mongo = await readMongo(period);
  const { events, bookingRows } = mongo;
  const candidates = sampleEvents(period);
  const existingIds = new Set(events.map((event) => event._id));
  const newEvents = candidates.filter((event) => !existingIds.has(event._id));
  const duplicates = candidates.length - newEvents.length;
  const conflicts = candidates.filter((candidate) => {
    const existing = events.find((event) => event._id === candidate._id);
    return existing && JSON.stringify(existing.raw) !== JSON.stringify(candidate.raw);
  });
  const before = sumAyoPaymentEvents(events);
  const after = sumAyoPaymentEvents([...events, ...newEvents]);
  const target = expected[period];
  console.log(JSON.stringify({ period, mode: "DRY-RUN", mongoReadError: mongo.error, eventDocuments: events.length, bookingDocuments: bookingRows.length, candidateEvents: candidates.length, newEvents: newEvents.length, duplicates, conflicts: conflicts.length, before, after, target, targetMatches: after.count === target.count && after.revenue === target.revenue }, null, 2));
}

console.log("No writes performed.");
process.exit(0);
