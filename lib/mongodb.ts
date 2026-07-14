import "./mongodb-dns.ts";
import { MongoClient, type Db } from "mongodb";

declare global {
  var __mongoClient: MongoClient | undefined;
  var __mongoClientPromise: Promise<MongoClient> | undefined;
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
  /** Jenis perubahan terakhir yang terdeteksi saat sinkronisasi. */
  changeType?: "new" | "updated" | "rescheduled" | null;
  /** Kapan perubahan terakhir terdeteksi. */
  changedAt?: Date;
  /** Jadwal sebelumnya, hanya diisi saat terjadi reschedule. */
  previousSchedule?: { date: string; start_time: string; end_time: string };
  /** Rincian field non-jadwal yang berubah saat changeType "updated" (nilai sudah human-readable). */
  fieldChanges?: { field: string; from: string; to: string }[];
};

export type SyncLogDocument = {
  type: "manual" | "scheduled" | "webhook" | "fields";
  status: "success" | "partial" | "failed";
  recordsProcessed: number;
  message?: string;
  errorMessage?: string;
  startedAt: Date;
  finishedAt: Date;
  inserted?: number;
  updated?: number;
  duplicate?: number;
  error?: number;
  totalReceived?: number;
  totalDaysSynced?: number;
  warningDays?: number;
};

export type WebhookLogDocument = {
  receivedAt: Date;
  method: string;
  ok: boolean;
  status: "received" | "invalid" | "error";
  ids: Record<string, string[]>;
  itemCount: number;
  message?: string;
  bodyPreview: string;
  // Membedakan asal webhook. Opsional agar dokumen produksi lama (tanpa field ini) tetap valid.
  source?: "production" | "sandbox";
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

export type OlseraSalesByCategoryDocument = {
  /** Tanggal order (YYYY-MM-DD, WIB). */
  date: string;
  /** Nama klasifikasi Olsera yang sudah dinormalisasi. */
  category: string;
  qty: number;
  totalAmount: number;
  /** Jumlah cost_amount (modal) seluruh item kategori ini pada tanggal ini. 0 untuk kategori jasa/sewa. */
  costAmount: number;
  syncedAt: Date;
};

export type OlseraSyncLogDocument = {
  startDate: string;
  endDate: string;
  status: "success" | "partial" | "failed";
  /** Jumlah order dari Close+Open List (setelah dedup). */
  expectedOrderCount: number;
  /** Jumlah order yang detail-nya berhasil ditarik. */
  processedOrderCount: number;
  errorMessage: string | null;
  /** Order yang tetap gagal setelah putaran retry akhir (order_id + alasan) — untuk investigasi tanpa membongkar Vercel logs. */
  failedOrders?: { date: string; orderId: number; reason: string }[];
  startedAt: Date;
  finishedAt: Date | null;
};

export type OlseraSyncedDayDocument = {
  /** Tanggal (YYYY-MM-DD, WIB) yang sudah tuntas disync penuh. */
  _id: string;
  /** Jumlah order (Close+Open dedup) saat hari ini dituntaskan. */
  expectedOrderCount: number;
  syncedAt: Date;
  /** Total penjualan dari Order List Olsera saat audit terakhir (null bila list tidak memuat nominal). */
  expectedTotal?: number | null;
  /** Waktu audit terakhir yang memastikan tanggal ini masih cocok dengan API Olsera. */
  verifiedAt?: Date;
};

export type OlseraProductCacheDocument = {
  /** ID produk Olsera (string, sesuai product_id di order items). */
  productId: string;
  /** Nama klasifikasi produk (sudah apa adanya dari API, dinormalisasi saat dipakai). */
  klasifikasi: string;
  cachedAt: Date;
};

export type OlseraSyncStateDocument = {
  _id: "olsera";
  /** Tanggal terakhir yang sync-nya tuntas penuh (expected = processed). */
  lastFullySyncedDate: string | null;
  updatedAt: Date;
};

export type OlseraOrderItemDocument = {
  /** id baris item Olsera (data.orderitems[i].id) — unik per baris, dipakai sebagai _id agar upsert re-sync tidak duplikat. */
  _id: number;
  /** Tanggal order (YYYY-MM-DD, WIB). */
  date: string;
  orderNo: string;
  orderDate: string;
  customerId: string | null;
  customerName: string | null;
  tableNo: string | null;
  salesByName: string | null;
  itemName: string;
  qty: number;
  amount: number;
  costAmount: number;
  discount: number;
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
    webhookLogs: db.collection<WebhookLogDocument>("webhook_logs"),
    olseraSalesByCategory: db.collection<OlseraSalesByCategoryDocument>("olsera_sales_by_category"),
    olseraSyncLog: db.collection<OlseraSyncLogDocument>("olsera_sync_log"),
    olseraSyncState: db.collection<OlseraSyncStateDocument>("olsera_sync_state"),
    olseraSyncedDays: db.collection<OlseraSyncedDayDocument>("olsera_synced_days"),
    olseraProductCache: db.collection<OlseraProductCacheDocument>("olsera_product_cache"),
    olseraOrderItems: db.collection<OlseraOrderItemDocument>("olsera_order_items"),
  };
}

// Index cukup dipastikan sekali per proses. Sebelumnya ensureIndexes() dipanggil
// pada SETIAP operasi DB (lewat withMongo) sehingga menambah banyak round-trip
// createIndex yang tidak perlu di tiap request.
let indexesEnsured: Promise<void> | null = null;

export async function ensureIndexes() {
  if (!indexesEnsured) {
    indexesEnsured = createIndexes().catch((error) => {
      // Jangan cache kegagalan; biarkan percobaan berikutnya mencoba lagi.
      indexesEnsured = null;
      throw error;
    });
  }
  return indexesEnsured;
}

async function createIndexes() {
  const {
    users,
    bookings,
    syncLogs,
    fields,
    webhookLogs,
    olseraSalesByCategory,
    olseraSyncLog,
    olseraSyncedDays,
    olseraProductCache,
    olseraOrderItems,
  } = await collections();
  await Promise.all([
    webhookLogs.createIndex({ receivedAt: -1 }),
    users.createIndex({ email: 1 }, { unique: true }),
    bookings.createIndex({ booking_id: 1 }, { unique: true }),
    bookings.createIndex({ date: -1, start_time: -1 }),
    bookings.createIndex({ status: 1 }),
    bookings.createIndex({ branch_name: 1 }),
    bookings.createIndex({ field_name: 1 }),
    bookings.createIndex({ booker_name: 1 }),
    bookings.createIndex({ booker_phone: 1 }),
    bookings.createIndex({ updatedAt: -1 }),
    bookings.createIndex({ syncedAt: -1 }),
    syncLogs.createIndex({ startedAt: -1 }),
    fields.createIndex({ id: 1 }, { unique: true }),
    olseraSalesByCategory.createIndex({ date: 1, category: 1 }, { unique: true }),
    olseraSyncLog.createIndex({ startedAt: -1 }),
    olseraSyncedDays.createIndex({ syncedAt: -1 }),
    olseraProductCache.createIndex({ productId: 1 }, { unique: true }),
    olseraOrderItems.createIndex({ date: 1 }),
    olseraOrderItems.createIndex({ orderNo: 1 }),
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
