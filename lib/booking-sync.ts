import { normalizeBooking } from "./booking-mapper.ts";
import { collections, withMongo, type SyncLogDocument } from "./mongodb.ts";

type SyncBookingOptions = {
  type: SyncLogDocument["type"];
  message: string;
  startedAt?: Date;
};

export type BookingImportResult = {
  inserted: number;
  updated: number;
  duplicate: number;
  error: number;
};

type ExistingBookingProjection = {
  booking_id: string;
  raw: Record<string, unknown>;
  date?: string;
  start_time?: string;
  end_time?: string;
  total_price?: number;
  status?: string;
  booker_name?: string;
  booker_phone?: string;
  booker_email?: string;
  note?: string;
};

// Field non-jadwal yang dilacak rinciannya saat booking berubah (changeType "updated").
const TRACKED_FIELDS: { key: keyof TrackedFieldValues; label: string }[] = [
  { key: "total_price", label: "Harga" },
  { key: "status", label: "Status" },
  { key: "booker_name", label: "Nama Pemesan" },
  { key: "booker_phone", label: "Telepon" },
  { key: "booker_email", label: "Email" },
  { key: "note", label: "Catatan" },
];

type TrackedFieldValues = Pick<
  ExistingBookingProjection,
  "total_price" | "status" | "booker_name" | "booker_phone" | "booker_email" | "note"
>;

function formatTrackedValue(key: keyof TrackedFieldValues, value: string | number | undefined) {
  if (key === "total_price") {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(Number(value || 0));
  }
  const text = value === undefined || value === null ? "" : String(value);
  return text.trim() ? text : "-";
}

function diffTrackedFields(prev: TrackedFieldValues, next: TrackedFieldValues) {
  const changes: { field: string; from: string; to: string }[] = [];
  for (const { key, label } of TRACKED_FIELDS) {
    const before = formatTrackedValue(key, prev[key]);
    const after = formatTrackedValue(key, next[key]);
    if (before !== after) changes.push({ field: label, from: before, to: after });
  }
  return changes;
}

export function extractBookingItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }

  if (!isRecord(payload)) {
    return [];
  }

  const candidates = [
    payload.data,
    payload.booking,
    payload.bookings,
    payload.order,
    payload.orders,
    payload.transaction,
    payload.transactions,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }

    if (isRecord(candidate)) {
      return [candidate];
    }
  }

  return [payload];
}

/**
 * Upsert booking ke MongoDB dengan dedup berbasis isi (raw payload).
 *
 * `booking_id` dipakai sebagai unique key (lihat index unik di lib/mongodb.ts):
 * - belum ada di DB  -> insert
 * - sudah ada & isi identik -> duplicate (di-skip, tidak menulis ulang)
 * - sudah ada & isi berbeda -> update
 *
 * Tidak pernah membuat row ganda untuk booking yang sama.
 */
export async function upsertBookingItems(items: Record<string, unknown>[]): Promise<BookingImportResult> {
  const result: BookingImportResult = { inserted: 0, updated: 0, duplicate: 0, error: 0 };
  const normalized: ReturnType<typeof normalizeBooking>[] = [];

  for (const item of items) {
    const booking = normalizeBooking(item);
    if (!booking.booking_id) {
      result.error += 1;
      continue;
    }
    normalized.push(booking);
  }

  if (!normalized.length) return result;

  await withMongo(async () => {
    const { bookings } = await collections();
    const ids = normalized.map((booking) => booking.booking_id);
    const existing = await bookings
      .find({ booking_id: { $in: ids } })
      .project<ExistingBookingProjection>({
        booking_id: 1,
        raw: 1,
        date: 1,
        start_time: 1,
        end_time: 1,
        total_price: 1,
        status: 1,
        booker_name: 1,
        booker_phone: 1,
        booker_email: 1,
        note: 1,
      })
      .toArray();
    const existingMap = new Map(existing.map((doc) => [doc.booking_id, doc]));

    const operations = [];
    for (const booking of normalized) {
      const nextHash = stableJson(booking.raw);
      const prev = existingMap.get(booking.booking_id);
      const prevHash = prev ? stableJson(prev.raw) : undefined;

      if (prevHash === undefined) {
        booking.changeType = "new";
        booking.changedAt = booking.syncedAt;
        operations.push({
          updateOne: {
            filter: { booking_id: booking.booking_id },
            update: { $set: booking },
            upsert: true,
          },
        });
        result.inserted += 1;
      } else if (prevHash === nextHash) {
        result.duplicate += 1;
      } else {
        const rescheduled =
          prev!.date !== booking.date ||
          prev!.start_time !== booking.start_time ||
          prev!.end_time !== booking.end_time;
        booking.changeType = rescheduled ? "rescheduled" : "updated";
        booking.changedAt = booking.syncedAt;
        if (rescheduled) {
          booking.previousSchedule = {
            date: prev!.date ?? "",
            start_time: prev!.start_time ?? "",
            end_time: prev!.end_time ?? "",
          };
        } else {
          booking.fieldChanges = diffTrackedFields(prev!, booking);
        }
        operations.push({
          updateOne: {
            filter: { booking_id: booking.booking_id },
            update: { $set: booking },
          },
        });
        result.updated += 1;
      }
    }

    if (operations.length) {
      await bookings.bulkWrite(operations, { ordered: false });
    }
  });

  return result;
}

export async function syncBookingItems(items: Record<string, unknown>[], options: SyncBookingOptions) {
  const startedAt = options.startedAt ?? new Date();
  const counts = await upsertBookingItems(items);
  const recordsProcessed = counts.inserted + counts.updated + counts.duplicate;

  await writeMongoSyncLog({
    type: options.type,
    status: "success",
    message: options.message,
    recordsProcessed,
    startedAt,
    inserted: counts.inserted,
    updated: counts.updated,
    duplicate: counts.duplicate,
    error: counts.error,
    totalReceived: recordsProcessed + counts.error,
    totalDaysSynced: 1,
    warningDays: 0,
  });

  return { recordsProcessed, ...counts };
}

export async function writeMongoSyncLog(options: {
  type: SyncLogDocument["type"];
  status: SyncLogDocument["status"];
  message?: string;
  recordsProcessed: number;
  startedAt: Date;
  finishedAt?: Date;
  inserted?: number;
  updated?: number;
  duplicate?: number;
  error?: number;
  totalReceived?: number;
  totalDaysSynced?: number;
  warningDays?: number;
}) {
  await withMongo(async () => {
    const { syncLogs } = await collections();
    await syncLogs.insertOne({
      type: options.type,
      status: options.status,
      recordsProcessed: options.recordsProcessed,
      message: options.message,
      startedAt: options.startedAt,
      finishedAt: options.finishedAt ?? new Date(),
      inserted: options.inserted,
      updated: options.updated,
      duplicate: options.duplicate,
      error: options.error,
      totalReceived: options.totalReceived,
      totalDaysSynced: options.totalDaysSynced,
      warningDays: options.warningDays,
    });
  });
}

export async function logSyncFailure(options: {
  type: SyncLogDocument["type"];
  startedAt: Date;
  error: unknown;
}) {
  await withMongo(async () => {
    const { syncLogs } = await collections();
    await syncLogs.insertOne({
      type: options.type,
      status: "failed",
      recordsProcessed: 0,
      errorMessage: options.error instanceof Error ? options.error.message : "Unknown error",
      startedAt: options.startedAt,
      finishedAt: new Date(),
    });
  }).catch(() => undefined);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
