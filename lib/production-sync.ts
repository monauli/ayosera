import { mkdir, writeFile } from "fs/promises";
import path from "path";
import {
  DEFAULT_LIST_BOOKINGS_LIMIT,
  fetchAyoBookings,
  type AyoBookingPayload,
} from "./ayo.ts";
import {
  syncSqliteBookingItems,
  writeSqliteSyncLog,
  type SqliteBookingImportResult,
} from "./sqlite.ts";

const INCOMPLETE_DAY_WARNING = "Possible incomplete day because received count reached limit.";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ProductionSyncDayResult = {
  date: string;
  received: number;
  inserted: number;
  updated: number;
  duplicate: number;
  error: number;
  warning?: string;
  error_message?: string;
};

export type ProductionSyncResult = {
  message: string;
  total_received: number;
  inserted: number;
  updated: number;
  duplicate: number;
  error: number;
  total_days_synced: number;
  warning_days: number;
  recordsProcessed: number;
  days: ProductionSyncDayResult[];
};

export type ProductionListBookingsSyncOptions = Omit<AyoBookingPayload, "token" | "signature"> & {
  startedAt?: Date;
  type?: "manual" | "scheduled";
  mirrorToMongo?: boolean;
  saveSamples?: boolean;
  logProgress?: boolean;
};

export async function syncProductionListBookings(options: ProductionListBookingsSyncOptions = {}) {
  const startedAt = options.startedAt || new Date();
  const limit = normalizeLimit(options.limit);
  const dates = resolveSyncDates(options);
  const baseFilters = toDailyListBookingFilters(options, limit);
  const allItems: Record<string, unknown>[] = [];
  const days: ProductionSyncDayResult[] = [];
  const totals = {
    total_received: 0,
    inserted: 0,
    updated: 0,
    duplicate: 0,
    error: 0,
    total_days_synced: 0,
    warning_days: 0,
  };

  for (const date of dates) {
    const day: ProductionSyncDayResult = {
      date,
      received: 0,
      inserted: 0,
      updated: 0,
      duplicate: 0,
      error: 0,
    };

    try {
      const response = await fetchAyoBookings({ ...baseFilters, date, limit });
      const items = extractBookingItems(response.data);
      day.received = items.length;
      totals.total_received += day.received;
      totals.total_days_synced += 1;

      if (day.received === limit) {
        day.warning = INCOMPLETE_DAY_WARNING;
        totals.warning_days += 1;
      }

      if (options.saveSamples !== false) {
        await saveProductionListBookingsSample(date, response, {
          received: day.received,
          warning: day.warning,
        });
      }

      const importResult = syncSqliteBookingItems(items);
      applyImportResult(day, totals, importResult);
      allItems.push(...items);
    } catch (error) {
      day.error += 1;
      totals.error += 1;
      day.error_message = error instanceof Error ? error.message : "Unknown daily sync error";
    }

    days.push(day);
    if (options.logProgress !== false) logDailyProgress(day);
  }

  const result: ProductionSyncResult = {
    ...totals,
    message: buildSyncMessage(totals),
    recordsProcessed: totals.total_received,
    days,
  };

  writeSqliteSyncLog({
    type: options.type || "manual",
    status: totals.error ? "partial" : "success",
    message: result.message,
    startedAt,
    total_received: result.total_received,
    inserted: result.inserted,
    updated: result.updated,
    duplicate: result.duplicate,
    error: result.error,
    total_days_synced: result.total_days_synced,
    warning_days: result.warning_days,
  });

  if (options.mirrorToMongo) {
    await mirrorBookingsToMongo(allItems, options.type || "manual", result.message, startedAt);
  }

  return result;
}

function resolveSyncDates(options: ProductionListBookingsSyncOptions) {
  if (options.date) return [validateDate(options.date, "date")];

  const shouldUseDefaultRange = !options.start_date && !options.end_date && !options.booking_id;
  const startDate = shouldUseDefaultRange ? monthStartJakarta() : options.start_date || options.end_date;
  const endDate = shouldUseDefaultRange ? todayJakarta() : options.end_date || options.start_date;

  if (!startDate || !endDate) {
    throw new Error("start_date and end_date are required for range sync.");
  }

  return listDateRange(validateDate(startDate, "start_date"), validateDate(endDate, "end_date"));
}

function toDailyListBookingFilters(options: ProductionListBookingsSyncOptions, limit: number): AyoBookingPayload {
  return {
    ...(options.booking_id ? { booking_id: options.booking_id } : {}),
    ...(options.field_name ? { field_name: options.field_name } : {}),
    ...(options.start_time ? { start_time: options.start_time } : {}),
    ...(options.end_time ? { end_time: options.end_time } : {}),
    ...(options.booking_source ? { booking_source: options.booking_source } : {}),
    ...(options.status ? { status: options.status } : {}),
    limit,
  };
}

function applyImportResult(
  day: ProductionSyncDayResult,
  totals: Omit<ProductionSyncResult, "message" | "recordsProcessed" | "days">,
  result: SqliteBookingImportResult,
) {
  day.inserted += result.inserted;
  day.updated += result.updated;
  day.duplicate += result.duplicate;
  day.error += result.error;
  totals.inserted += result.inserted;
  totals.updated += result.updated;
  totals.duplicate += result.duplicate;
  totals.error += result.error;
}

function extractBookingItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];

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
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
    if (isRecord(candidate)) return [candidate];
  }

  return [payload];
}

async function saveProductionListBookingsSample(
  date: string,
  response: unknown,
  metadata: { received: number; warning?: string },
) {
  const sampleDir = path.join(process.cwd(), "samples", "production", "list-bookings");
  await mkdir(sampleDir, { recursive: true });
  await writeFile(
    path.join(sampleDir, `${date}.json`),
    `${JSON.stringify(
      sanitizeSample({
        endpoint: "production/list-bookings",
        date,
        ...metadata,
        response,
      }),
      null,
      2,
    )}\n`,
  );
}

function sanitizeSample(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSample);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveKey(key))
      .map(([key, nestedValue]) => [key, sanitizeSample(nestedValue)]),
  );
}

function isSensitiveKey(key: string) {
  return ["token", "signature", "private_key", "privatekey", "api_key", "apikey", "authorization", "secret"].includes(
    key.toLowerCase(),
  );
}

function logDailyProgress(day: ProductionSyncDayResult) {
  const parts = [
    `[sync:prod] date=${day.date}`,
    `received=${day.received}`,
    `inserted=${day.inserted}`,
    `duplicate=${day.duplicate}`,
    `error=${day.error}`,
  ];

  if (day.warning) parts.push(`warning="${day.warning}"`);
  if (day.error_message) parts.push(`message="${day.error_message}"`);

  console.log(parts.join(" "));
}

function buildSyncMessage(totals: {
  total_received: number;
  inserted: number;
  duplicate: number;
  warning_days: number;
}) {
  return [
    "daily split sync completed",
    `total received ${totals.total_received}`,
    `inserted ${totals.inserted}`,
    `duplicate ${totals.duplicate}`,
    `warning days ${totals.warning_days}`,
  ].join("; ");
}

async function mirrorBookingsToMongo(
  items: Record<string, unknown>[],
  type: "manual" | "scheduled",
  message: string,
  startedAt: Date,
) {
  const { syncBookingItems } = await import("@/lib/booking-sync");
  await syncBookingItems(items, {
    type,
    message,
    startedAt,
  });
}

function listDateRange(startDate: string, endDate: string) {
  if (startDate > endDate) {
    throw new Error("start_date must be before or equal to end_date");
  }

  const dates: string[] = [];
  const cursor = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  const maxDays = Number(process.env.AYO_SYNC_MAX_DAYS || 62);

  while (cursor <= end) {
    if (dates.length >= maxDays) {
      throw new Error(`Date range is too large. Max ${maxDays} days per sync.`);
    }

    dates.push(formatDateOnly(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

function validateDate(value: string, name: string) {
  if (!DATE_PATTERN.test(value)) throw new Error(`${name} must use YYYY-MM-DD format.`);
  return value;
}

function parseDateOnly(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function todayJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function monthStartJakarta() {
  const today = todayJakarta();
  return `${today.slice(0, 7)}-01`;
}

function normalizeLimit(value: number | undefined) {
  if (!value) return DEFAULT_LIST_BOOKINGS_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIST_BOOKINGS_LIMIT;
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
