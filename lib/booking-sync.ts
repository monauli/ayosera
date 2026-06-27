import { normalizeBooking } from "@/lib/booking-mapper";
import { collections, withMongo, type SyncLogDocument } from "@/lib/mongodb";

type SyncBookingOptions = {
  type: SyncLogDocument["type"];
  message: string;
  startedAt?: Date;
};

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

export async function syncBookingItems(items: Record<string, unknown>[], options: SyncBookingOptions) {
  const startedAt = options.startedAt ?? new Date();
  const records = items.map(normalizeBooking).filter((booking) => booking.booking_id);

  await withMongo(async () => {
    const { bookings, syncLogs } = await collections();

    if (records.length) {
      await bookings.bulkWrite(
        records.map((booking) => ({
          updateOne: {
            filter: { booking_id: booking.booking_id },
            update: { $set: booking },
            upsert: true,
          },
        })),
      );
    }

    await syncLogs.insertOne({
      type: options.type,
      status: "success",
      recordsProcessed: records.length,
      message: options.message,
      startedAt,
      finishedAt: new Date(),
    });
  });

  return { recordsProcessed: records.length };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
