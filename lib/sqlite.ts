import { mkdirSync } from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { normalizeBooking } from "./booking-mapper.ts";

export type SqliteBookingImportResult = {
  inserted: number;
  updated: number;
  duplicate: number;
  error: number;
};

export type SqliteSyncLogOptions = {
  type: "manual" | "scheduled";
  status: "success" | "partial" | "failed";
  message?: string;
  errorMessage?: string;
  startedAt: Date;
  finishedAt?: Date;
  total_received: number;
  inserted: number;
  updated: number;
  duplicate: number;
  error: number;
  total_days_synced: number;
  warning_days: number;
};

type SqliteBookingRow = {
  raw_json?: string;
};

export function getSqliteDatabasePath() {
  const configured = process.env.SQLITE_DB_PATH || process.env.AYO_SQLITE_DB_PATH || "data/ayo_bridge.sqlite";
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

export function syncSqliteBookingItems(items: Record<string, unknown>[]): SqliteBookingImportResult {
  const db = openSqliteDatabase();
  const result: SqliteBookingImportResult = { inserted: 0, updated: 0, duplicate: 0, error: 0 };

  try {
    const existing = db.prepare("SELECT raw_json FROM bookings WHERE booking_id = ?");
    const insert = db.prepare(`
      INSERT INTO bookings (
        booking_id,
        order_detail_id,
        field_id,
        field_name,
        date,
        start_time,
        end_time,
        total_price,
        status,
        booker_name,
        booker_phone,
        booker_email,
        booking_source,
        branch_name,
        created_at,
        note,
        raw_json,
        synced_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = db.prepare(`
      UPDATE bookings
      SET
        order_detail_id = ?,
        field_id = ?,
        field_name = ?,
        date = ?,
        start_time = ?,
        end_time = ?,
        total_price = ?,
        status = ?,
        booker_name = ?,
        booker_phone = ?,
        booker_email = ?,
        booking_source = ?,
        branch_name = ?,
        created_at = ?,
        note = ?,
        raw_json = ?,
        synced_at = ?,
        updated_at = ?
      WHERE booking_id = ?
    `);

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items) {
        try {
          const booking = normalizeBooking(item);
          if (!booking.booking_id) {
            result.error += 1;
            continue;
          }

          const rawJson = stableJson(booking.raw);
          const row = existing.get(booking.booking_id) as SqliteBookingRow | undefined;

          if (!row) {
            insert.run(...insertBookingValues(booking, rawJson));
            result.inserted += 1;
            continue;
          }

          if (row.raw_json === rawJson) {
            result.duplicate += 1;
            continue;
          }

          update.run(...updateBookingValues(booking, rawJson));
          result.updated += 1;
        } catch {
          result.error += 1;
        }
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }

  return result;
}

export function writeSqliteSyncLog(options: SqliteSyncLogOptions) {
  const db = openSqliteDatabase();
  try {
    db.prepare(`
      INSERT INTO sync_logs (
        type,
        status,
        records_processed,
        message,
        error_message,
        started_at,
        finished_at,
        total_received,
        inserted,
        updated,
        duplicate,
        error,
        total_days_synced,
        warning_days
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      options.type,
      options.status,
      options.inserted + options.updated + options.duplicate,
      options.message || null,
      options.errorMessage || null,
      options.startedAt.toISOString(),
      (options.finishedAt || new Date()).toISOString(),
      options.total_received,
      options.inserted,
      options.updated,
      options.duplicate,
      options.error,
      options.total_days_synced,
      options.warning_days,
    );
  } finally {
    db.close();
  }
}

function openSqliteDatabase() {
  const dbPath = getSqliteDatabasePath();
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS bookings (
      booking_id TEXT PRIMARY KEY NOT NULL,
      order_detail_id INTEGER,
      field_id INTEGER,
      field_name TEXT,
      date TEXT,
      start_time TEXT,
      end_time TEXT,
      total_price REAL,
      status TEXT,
      booker_name TEXT,
      booker_phone TEXT,
      booker_email TEXT,
      booking_source TEXT,
      branch_name TEXT,
      created_at TEXT,
      note TEXT,
      raw_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_date_time ON bookings(date DESC, start_time DESC);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_field_name ON bookings(field_name);

    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      records_processed INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      total_received INTEGER NOT NULL DEFAULT 0,
      inserted INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      duplicate INTEGER NOT NULL DEFAULT 0,
      error INTEGER NOT NULL DEFAULT 0,
      total_days_synced INTEGER NOT NULL DEFAULT 0,
      warning_days INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sync_logs_started_at ON sync_logs(started_at DESC);
  `);

  return db;
}

function insertBookingValues(booking: ReturnType<typeof normalizeBooking>, rawJson: string) {
  return [
    booking.booking_id,
    booking.order_detail_id || null,
    booking.field_id || null,
    booking.field_name || null,
    booking.date || null,
    booking.start_time || null,
    booking.end_time || null,
    booking.total_price || 0,
    booking.status || null,
    booking.booker_name || null,
    booking.booker_phone || null,
    booking.booker_email || null,
    booking.booking_source || null,
    booking.branch_name || null,
    booking.created_at || null,
    booking.note || null,
    rawJson,
    booking.syncedAt.toISOString(),
    booking.updatedAt.toISOString(),
  ];
}

function updateBookingValues(booking: ReturnType<typeof normalizeBooking>, rawJson: string) {
  return [
    booking.order_detail_id || null,
    booking.field_id || null,
    booking.field_name || null,
    booking.date || null,
    booking.start_time || null,
    booking.end_time || null,
    booking.total_price || 0,
    booking.status || null,
    booking.booker_name || null,
    booking.booker_phone || null,
    booking.booker_email || null,
    booking.booking_source || null,
    booking.branch_name || null,
    booking.created_at || null,
    booking.note || null,
    rawJson,
    booking.syncedAt.toISOString(),
    booking.updatedAt.toISOString(),
    booking.booking_id,
  ];
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
