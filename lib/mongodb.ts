import "@/lib/mongodb-dns";
import type { Db, MongoClient as MongoClientType } from "mongodb";

const { MongoClient } = require("mongodb") as typeof import("mongodb");

declare global {
  var __mongoClient: MongoClientType | undefined;
  var __mongoClientPromise: Promise<MongoClientType> | undefined;
}

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const mongoUri = getMongoUri();
export const dbName = process.env.MONGODB_DB || "ayo_middleware";

export type UserDocument = {
  email: string;
  name: string;
  passwordHash: string;
  role: "admin" | "viewer";
  createdAt: Date;
  updatedAt: Date;
};

export type BookingDocument = {
  order_detail_id: number;
  booking_id: string;
  field_id: number;
  field_name: string;
  date: string;
  start_time: string;
  end_time: string;
  total_price: number;
  status: string;
  booker_name: string;
  booker_phone: string;
  booker_email: string;
  booking_source: string;
  branch_name: string;
  created_at: string;
  note?: string;
  raw: Record<string, unknown>;
  syncedAt: Date;
  updatedAt: Date;
};

export type SyncLogDocument = {
  type: "manual" | "scheduled" | "webhook" | "fields";
  status: "success" | "failed";
  recordsProcessed: number;
  message?: string;
  errorMessage?: string;
  startedAt: Date;
  finishedAt: Date;
};

export type FieldDocument = {
  id: number;
  name: string;
  status: string;
  is_active: number;
  is_permanent_active: number;
  sport_name: string;
  raw: Record<string, unknown>;
  syncedAt: Date;
};

function parseDirectHosts(value: string | undefined) {
  return (
    value
      ?.split(",")
      .map((host) => host.trim())
      .filter(Boolean)
      .map((host) => (host.includes(":") ? host : `${host}:27017`)) ?? []
  );
}

function getMongoUri() {
  const directHosts = parseDirectHosts(process.env.MONGODB_DIRECT_HOSTS);
  if (!uri.startsWith("mongodb+srv://") || !directHosts.length) return uri;

  const url = new URL(uri);
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";

  if (!url.searchParams.has("tls") && !url.searchParams.has("ssl")) {
    url.searchParams.set("tls", "true");
  }

  const query = url.searchParams.toString();
  return `mongodb://${auth}${directHosts.join(",")}${url.pathname}${query ? `?${query}` : ""}`;
}

function createMongoClient() {
  return new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 5000,
  });
}

export const mongoClient = global.__mongoClient ?? createMongoClient();

if (process.env.NODE_ENV !== "production") {
  global.__mongoClient = mongoClient;
}

export function getMongoDb(): Db {
  return mongoClient.db(dbName);
}

export async function getClient() {
  if (!global.__mongoClientPromise) {
    global.__mongoClientPromise = mongoClient.connect();
  }

  return global.__mongoClientPromise;
}

export async function getDb(): Promise<Db> {
  await getClient();
  return getMongoDb();
}

export async function collections() {
  const db = await getDb();
  return {
    users: db.collection<UserDocument>("users"),
    bookings: db.collection<BookingDocument>("bookings"),
    syncLogs: db.collection<SyncLogDocument>("sync_logs"),
    fields: db.collection<FieldDocument>("fields"),
  };
}

export async function ensureIndexes() {
  const { users, bookings, syncLogs, fields } = await collections();
  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    bookings.createIndex({ booking_id: 1 }, { unique: true }),
    bookings.createIndex({ date: -1, start_time: -1 }),
    bookings.createIndex({ status: 1 }),
    bookings.createIndex({ branch_name: 1 }),
    bookings.createIndex({ field_name: 1 }),
    syncLogs.createIndex({ startedAt: -1 }),
    fields.createIndex({ id: 1 }, { unique: true }),
  ]);
}

export async function withMongo<T>(handler: () => Promise<T>): Promise<T> {
  try {
    await ensureIndexes();
    return await handler();
  } catch (error) {
    console.error("MongoDB operation failed", error);
    throw error;
  }
}
