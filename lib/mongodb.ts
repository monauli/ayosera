import "./mongodb-dns.ts";
import { MongoClient, type Db } from "mongodb";
import type { ReconciliationConfidence, ReconciliationDomain, ReconciliationImpact, ReconciliationStatus, ReconciliationType } from "./reconciliation-types.ts";
import type { AyoPaymentEvent, AyoPaymentPeriodMetadata } from "./ayo-payment-events.ts";

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

export type AyoPaymentEventDocument = AyoPaymentEvent;
export type AyoPaymentPeriodDocument = AyoPaymentPeriodMetadata;

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

// Rate limiting (Task 4: security hardening) — satu dokumen per (key, window
// waktu tetap). TTL index expiresAt membersihkan bucket lama otomatis. Dipilih
// MongoDB (bukan in-memory) karena serverless: instance function bisa banyak
// dan tidak berbagi memori, sedangkan MongoDB sudah jadi satu-satunya sumber
// kebenaran bersama yang dipakai app ini (sama seperti distributed lock
// olsera_sync_locks) — bukan layanan berbayar baru.
export type RateLimitDocument = {
  _id: string; // `${key}:${windowBucket}`
  count: number;
  expiresAt: Date;
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
export type OlseraFinancialMonthlyReportDocument = { _id: string; storeId: number; period: string; year: number; month: number; reportType: "balance-sheet" | "profit-loss" | "cash-flow" | "ledger-summary"; normalizedPayload: Record<string, unknown>; rawPayload: Record<string, unknown>; sourceEndpoint: string; currency: "IDR"; validated: boolean; validationNote: string | null; syncedAt: Date; createdAt: Date; updatedAt: Date };
export type OlseraFinancialAccountDocument = { _id: string; storeId: number; accountId: string | number | null; accountCode: string | null; accountName: string | null; classification: string | null; parentId: string | number | null; isActive: boolean; rawPayload: Record<string, unknown>; syncedAt: Date; createdAt: Date; updatedAt: Date };
export type OlseraFinancialLedgerEntryDocument = { _id: string; storeId: number; period: string; accountCode: string; accountName: string | null; transactionDate: string | null; formattedTransactionDate: string | null; transactionNo: string | null; description: string | null; debit: number; credit: number; balance: number | null; isOpeningBalance: boolean; rawPayload: Record<string, unknown>; syncedAt: Date; createdAt: Date; updatedAt: Date };
export type OlseraFinancialSyncLogDocument = { _id: string; storeId: number; period: string; status: "running" | "success" | "partial" | "failed"; phase: "accounts" | "monthly-reports" | "ledger-details" | "reconcile" | "completed"; accountCursor: number; accountCodes: string[]; reportsCompleted: string[]; recordsProcessed: number; accountsProcessed: number; errorMessage: string | null; failedAccountCodes?: string[]; recoveredAccountCodes?: string[]; accountAttempts?: Array<{ code: string; attempts: number }>; finalized?: boolean; startedAt: Date; updatedAt: Date; completedAt: Date | null };
export type FinancialEmptyLedgerObservation = { runId: string; invocationId: string; observedAt: Date; rowCount: number; sourceStatus: "success-empty" };
export type FinancialEmptyLedgerConfirmationDocument = { _id: string; storeId: number; period: string; accountCode: string; status: "candidate" | "confirmed" | "cancelled"; observations: FinancialEmptyLedgerObservation[]; confirmedAt: Date | null; lastNonEmptyAt: Date | null; updatedAt: Date; createdAt: Date };
export type FinancialStaleCleanupAuditDocument = { _id: string; storeId: number; period: string; accountCode: string; runId: string; reason: string; firstCheck: FinancialEmptyLedgerObservation; secondCheck: FinancialEmptyLedgerObservation; deletedCount: number; succeeded: boolean; createdAt: Date };
/**
 * Jejak audit reversibel Milestone 4 Bagian C (Safe Backfill) — SATU dokumen
 * per baris olsera_order_items yang berhasil dibackfill (HIGH CONFIDENCE
 * "Exact Match" saja). `before` menyimpan state productId/variantId/sku
 * SEBELUM backfill (persis seperti tersimpan di Mongo — bisa "absent" via
 * penanda null di sini karena Mongo tidak menyimpan konsep "absent" sbg
 * value) sehingga operasi ini bisa dibatalkan manual (unset field) bila
 * pernah diperlukan. `_id` = `orderItemId` — idempoten, satu jejak final per baris.
 */
export type HistoricalBackfillAuditLogDocument = {
  _id: number;
  storeId: number;
  orderItemId: number;
  classification: "Exact Match";
  before: { productId: number | null; variantId: number | null; sku: string | null };
  after: { productId: number; variantId: number | null; sku: string | null };
  triggeredBy: string;
  runId: string;
  createdAt: Date;
};

/**
 * Bukti jurnal nyata yang menjelaskan selisih Rekonsiliasi Omzet AYOSERA pada
 * SATU periode — SATU-SATUNYA jalur status "Selisih Terjelaskan" (lihat
 * lib/reconciliation-omzet-ledger.ts classifyStatus). TIDAK PERNAH dibuat
 * otomatis; `explainedAmount` harus sama persis dengan differenceRevenue yang
 * dihitung engine saat catatan ini dipakai, kalau tidak status kembali ke
 * "Perlu Dicek". Satu dokumen per periode (menimpa catatan lama bila diperbarui
 * — bukan riwayat berlapis, lihat lib/reconciliation-omzet-explanation-store.ts).
 */
export type OlseraOmzetReconciliationNoteDocument = {
  _id: string; // `${storeId}:${period}`
  storeId: number;
  period: string;
  evidenceType: "shifted-period" | "wrong-amount" | "duplicate" | "reversal" | "correction" | "wrong-account";
  description: string;
  explainedAmount: number;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
};

/**
 * Skema BARU (Fitur Lock+Berita Acara, lihat "Desain Skema Lock+Berita Acara"
 * di tmp/ai-handoff.md) — menggantikan `OlseraOmzetReconciliationNoteDocument`
 * di atas, mengikuti pola APPEND-ONLY dari `ReconciliationManualResolutionDocument`
 * (baris ~603 di bawah) alih-alih overwrite satu-dokumen-per-periode. Setiap
 * submit/revisi penjelasan adalah DOKUMEN BARU; dokumen lama ditandai
 * `isCurrent:false`+`supersededBy`, tidak pernah dihapus/ditimpa.
 *
 * LANGKAH 1 (implementasi ini): kedua type sengaja dibiarkan BERDAMPINGAN —
 * `OlseraOmzetReconciliationNoteDocument` (lama) TIDAK diubah/dihapus supaya
 * `lib/reconciliation-omzet-explanation-store.ts` dan
 * `lib/reconciliation-omzet-ledger.ts` (classifyStatus/computeOmzetOlseraLedger)
 * yang masih memakainya tetap kompatibel — migrasi jalur baca engine ke skema
 * baru ini adalah langkah TERPISAH berikutnya (lihat catatan di dokumen
 * desain, section 3c). Dua bentuk dokumen ini bisa hidup berdampingan di
 * collection fisik yang sama (`olsera_omzet_reconciliation_notes`) karena
 * format `_id` berbeda (lama: `${storeId}:${period}`, baru: `note:v1:${hash}`)
 * — lihat rencana migrasi (Opsi A, script backfill) di dokumen desain.
 */
export type OlseraOmzetReconciliationNoteV2Document = {
  /**
   * Deterministik, mirip pola `resolution:v1:${hash}` di
   * lib/reconciliation-manual-resolution.ts. Formula:
   *   `note:v1:${sha256(JSON.stringify({ storeId, period, actor, idempotencyKey })).slice(0, 32)}`
   * — lihat `generateNoteId` di lib/reconciliation-omzet-note-store.ts.
   * `idempotencyKey` disuplai caller (mis. UI generate sekali per klik submit)
   * sehingga retry jaringan dengan key yang sama dianggap request yang sama
   * (idempotent), bukan revisi baru.
   */
  _id: string;
  storeId: number;
  period: string; // format YYYY-MM
  /**
   * "matched-no-explanation" = penanda KHUSUS (lihat
   * OMZET_LOCK_WITHOUT_EXPLANATION_MARKER di lib/reconciliation-omzet-ledger.ts)
   * untuk note yang dikunci LANGSUNG dari status Cocok (selisih Rp0) TANPA
   * penjelasan manual — bukan kategori bukti jurnal nyata sungguhan.
   */
  evidenceType: "shifted-period" | "wrong-amount" | "duplicate" | "reversal" | "correction" | "wrong-account" | "matched-no-explanation";
  description: string;
  /** HARUS sama persis dengan differenceRevenue yang dihitung engine saat submit/lock — divalidasi di lib/reconciliation-omzet-note-store.ts, bukan hanya di classifyStatus. */
  explainedAmount: number;

  /** URL file lampiran Berita Acara (mis. hasil upload ke Vercel Blob) — null bila belum ada lampiran. Infrastruktur upload BELUM dibangun (lihat dokumen desain section 3); field ini siap dipakai begitu tersedia. */
  attachmentUrl: string | null;
  /** Nama file asli saat diunggah — null bila attachmentUrl null. */
  attachmentFileName: string | null;

  /** true HANYA pada dokumen aktif untuk (storeId, period) ini; di-$set jadi false pada dokumen lama saat digantikan. */
  isCurrent: boolean;
  /** _id dokumen PENGGANTI — null bila masih berlaku. */
  supersededBy: string | null;
  /** Timestamp saat digantikan — null bila masih berlaku. */
  supersededAt: Date | null;
  /** Pointer MUNDUR ke dokumen yang digantikan dokumen ini — null bila ini submit pertama untuk (storeId, period). */
  previousNoteId: string | null;

  /** true bila periode ini sudah dikunci lewat Berita Acara. TIDAK ADA jalur unlock (lihat lockOmzetPeriod di lib/reconciliation-omzet-note-store.ts — pembukaan kunci ditunda untuk role developer di masa depan). */
  locked: boolean;
  /** userId yang mengunci — null bila locked:false. */
  lockedBy: string | null;
  /** Timestamp saat dikunci — null bila locked:false. */
  lockedAt: Date | null;

  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
};

export type OlseraOmzetReconciliationAuditAction = "SUBMIT_EXPLANATION" | "SUPERSEDE_EXPLANATION" | "LOCK";

/**
 * Jejak audit APPEND-ONLY untuk fitur Lock+Berita Acara — collection
 * TERPISAH dari `olsera_omzet_reconciliation_notes`, HANYA `insertOne`
 * (lihat `writeOmzetAuditLog` di lib/reconciliation-omzet-note-store.ts),
 * tidak pernah diubah/dihapus. Beda dari `ReconciliationAuditLogDocument`
 * (baris ~632 di bawah) yang untuk modul Rekonsiliasi Findings — collection
 * ini khusus fitur Lock+Berita Acara Rekonsiliasi Omzet.
 */
export type OlseraOmzetReconciliationAuditLogDocument = {
  /** `omzet-audit:v1:${randomUUID()}`. */
  _id: string;
  storeId: number;
  period: string;
  action: OlseraOmzetReconciliationAuditAction;
  /** userId pelaku. */
  actor: string;
  timestamp: Date;
  /** _id dokumen note yang terlibat — dokumen baru untuk SUBMIT_EXPLANATION/SUPERSEDE_EXPLANATION, dokumen current untuk LOCK. */
  noteId: string;
  /** _id dokumen note yang digantikan — hanya diisi untuk SUPERSEDE_EXPLANATION, null selainnya. */
  previousNoteId: string | null;
  /** Snapshot ringkas untuk audit trail manusiawi — TIDAK berisi credential. */
  detail: {
    evidenceType?: "shifted-period" | "wrong-amount" | "duplicate" | "reversal" | "correction" | "wrong-account" | "matched-no-explanation";
    explainedAmount?: number;
    hasAttachment?: boolean;
  };
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
  /**
   * Add-on price (per unit) dari payload Olsera — INFORMASI SAJA. `amount`
   * SUDAH termasuk add-on ((basic price + addon) × qty − discount, terbukti
   * dari data nyata) — jangan pernah dijumlahkan lagi ke amount/total manapun.
   * Optional: dokumen yang disync sebelum fitur ini menunggu backfill.
   */
  addonPrice?: number;
  syncedAt: Date;

  // --- Identitas produk historis (Feature: canonical category mapping) ---
  // Disimpan saat sync agar perubahan product_id di katalog Olsera tidak
  // menghilangkan jejak identitas transaksi lama. Optional: dokumen lama
  // (sebelum fitur ini) belum memilikinya sampai dibackfill.
  /** product_id asli dari payload transaksi. */
  productId?: number | null;
  /** product_variant_id asli dari payload transaksi. */
  variantId?: number | null;
  /** product_variant_sku ?? product_sku dari payload transaksi. */
  sku?: string | null;
  barcode?: string | null;
  /** itemName ternormalisasi (uppercase, spasi rapi) untuk lookup exact. */
  normalizedItemName?: string;
  /** Kategori asli dari payload transaksi bila Olsera menyediakannya (saat ini tidak). */
  originalCategoryId?: string | null;
  originalCategoryName?: string | null;
  /** Hasil resolusi canonical resolver. */
  resolvedProductId?: number | null;
  resolvedCategoryId?: string | null;
  resolvedCategoryName?: string | null;
  categoryResolutionMethod?: string;
  categoryResolutionStatus?: "resolved" | "unresolved";
  categoryResolutionReason?: string | null;
  /** Payload item mentah dari API (tanpa field photo) — pola sama dengan bookings.raw. */
  raw?: Record<string, unknown>;
  /** Waktu resolusi kategori terakhir diterapkan (diisi terutama untuk manual_override). */
  resolvedAt?: Date | null;
};

/**
 * Override kategori manual untuk SATU item transaksi spesifik (bukan aturan
 * global per nama/product_id) — mis. konfirmasi langsung dari kasir untuk
 * item yang tidak bisa dipetakan otomatis. `_id` = orderItemId (unique key
 * olsera_order_items) — identitas paling spesifik yang tersedia, sehingga
 * override TIDAK PERNAH memengaruhi item lain meski nama/product_id sama.
 */
export type OlseraCategoryOverrideDocument = {
  /** orderItemId — sama dengan olsera_order_items._id (unique key item, bukan nama/product_id). */
  _id: number;
  orderNo: string;
  date: string;
  itemName: string;
  productId: number | null;
  category: string;
  reason: string;
  createdAt: Date;
};

export type OlseraProductAliasDocument = {
  /** `${oldProductId}:${oldVariantId ?? 0}` — unique key stabil per identitas lama. */
  _id: string;
  oldProductId: number;
  /** product_id pengganti di katalog aktif; null bila hanya alias kategori historis. */
  newProductId: number | null;
  oldVariantId: number | null;
  newVariantId: number | null;
  sku: string | null;
  /** Nama produk lama ternormalisasi (uppercase) — dipakai lookup by-name. */
  normalizedName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  /** Asal alias, mis. "manual-verified", "catalog-match". */
  source: string;
  confidence: "verified" | "high" | "low";
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// ---- Inventori Olsera (modul terpisah dari penjualan; read-only terhadap API) ----

export type OlseraInventoryProductDocument = {
  /** `${storeId}:${productId}:${variantId ?? 0}` — unik & stabil per outlet+produk+variant. */
  _id: string;
  productId: number;
  variantId: number | null;
  sku: string | null;
  barcode: string | null;
  name: string;
  variantName: string | null;
  /** Klasifikasi Olsera (dipakai sebagai kategori utama, konsisten dengan modul penjualan). */
  category: string;
  /** category_name Olsera (subkategori). */
  subCategory: string | null;
  uom: string | null;
  storeId: number | null;
  storeName: string | null;
  active: boolean;
  trackInventory: boolean;
  sellPrice: number;
  buyPrice: number;
  lastBuyPrice: number;
  stockQty: number;
  holdQty: number;
  /** low_stock_alert Olsera; null bila 0/tidak diset (threshold default dipakai). */
  lowStockAlert: number | null;
  isOutStock: boolean;
  modifiedTime: string | null;
  stockSyncTime: string | null;
  syncedAt: Date;
};

export type OlseraInventorySnapshotDocument = {
  /** `${storeId}:${productId}:${variantId ?? 0}:${date}` */
  _id: string;
  date: string;
  productId: number;
  variantId: number | null;
  sku: string | null;
  name: string;
  storeId: number | null;
  stockQty: number;
  holdQty: number;
  buyPrice: number;
  syncedAt: Date;
};

export type OlseraInventoryMovementDocument = {
  /** Deterministic source key, mis. `sale:${orderItemId}` — upsert aman diulang. */
  _id: string;
  source: "sale";
  /** Jenis mutasi (saat ini "penjualan" — satu-satunya histori yang tersedia dari data Olsera). */
  type: string;
  date: string;
  movementAt: string;
  productId: number | null;
  variantId: number | null;
  sku: string | null;
  productName: string;
  qtyBefore: number | null;
  qtyChange: number;
  qtyAfter: number | null;
  costPrice: number | null;
  value: number | null;
  storeId: number | null;
  reference: string | null;
  note: string | null;
  syncedAt: Date;
};

export type OlseraInventorySyncRunDocument = {
  /** `run-${startedAt ISO}` */
  _id: string;
  status: "running" | "success" | "partial" | "failed";
  phase: "products" | "movements" | "done";
  baselineDate: string;
  startDate: string;
  endDate: string;
  /** Tanggal yang belum diproses (antrian; tanggal gagal run sebelumnya di depan). */
  pendingDates: string[];
  currentDate: string | null;
  processedDays: number;
  totalDays: number;
  totalProducts: number;
  totalMovements: number;
  createdRecords: number;
  updatedRecords: number;
  failedDates: string[];
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
};

/**
 * Ledger stok BULANAN per produk (bukan snapshot harian — lihat
 * OlseraInventorySnapshotDocument untuk itu). Satu dokumen = satu produk pada
 * satu bulan, dengan opening/closing + rincian arus (incoming/return/sales/
 * outgoing) — sumber Stok Awal/Stock Akhir Export Stock Opname Bulanan
 * OTOMATIS, MENGGANTIKAN fallback stockQty katalog hari ini (lihat
 * lib/olsera-inventory-monthly-snapshot-core.ts & lib/olsera-inventory-monthly-snapshot-store.ts).
 * closing bulan N = opening bulan N+1 (rantai berkelanjutan Februari 2026 s/d
 * bulan berjalan, lihat OLSERA_INVENTORY_BASELINE_DATE).
 */
export type OlseraInventoryMonthlySnapshotDocument = {
  /** `${storeId}:${year}:${String(month).padStart(2,"0")}:${productId}:${variantId ?? 0}` */
  _id: string;
  storeId: number;
  year: number;
  month: number;
  /** Tanggal akhir bulan (YYYY-MM-DD) — tanggal yang direpresentasikan closingQty. */
  snapshotDate: string;
  productId: number;
  variantId: number | null;
  /** productId setelah resolusi olsera_product_aliases; null bila sama dengan productId (tidak pernah berubah). */
  canonicalProductId: number | null;
  productName: string;
  productSku: string | null;
  groupName: string;
  openingQty: number | null;
  incomingQty: number | null;
  returnQty: number | null;
  salesQty: number | null;
  outgoingQty: number | null;
  closingQty: number | null;
  source: "baseline-file" | "stockmovement-backward" | "stockmovement-forward" | "carry-forward";
  status: "complete" | "boundary-only" | "incomplete";
  diagnostics: string[];
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Fitur "Rekonsiliasi Inventori dengan Berita Acara" — data pembanding stok
 * fisik (hasil stock opname manual) per produk per bulan. Koleksi TERPISAH
 * dari `olsera_inventory_monthly_snapshots` — TIDAK PERNAH menulis/mengubah
 * snapshot, katalog produk, order item, atau data transaksi Olsera manapun.
 * `_id` deterministik dengan pola SAMA seperti
 * OlseraInventoryMonthlySnapshotDocument (storeId+year+month+productId+variantId)
 * — upsert idempoten by construction, tidak pernah duplikat.
 * Bila physicalQty dihapus user, dokumen ini DIHAPUS (bukan disimpan null) —
 * status "Belum Diisi" direpresentasikan lewat KETIADAAN dokumen.
 */
export type InventoryStockOpnameDocument = {
  /** `${storeId}:${year}:${String(month).padStart(2,"0")}:${productId}:${variantId ?? 0}` */
  _id: string;
  storeId: number;
  year: number;
  month: number;
  productId: number;
  variantId: number | null;
  physicalQty: number;
  /** Stok akhir sistem (snapshot) SAAT diverifikasi/disimpan — dicatat sebagai bukti; snapshot sumber tidak pernah ditulis ulang. */
  systemClosingQty: number | null;
  differenceQty: number | null;
  /** "Belum Diisi" tidak pernah tersimpan — direpresentasikan lewat ketiadaan dokumen. */
  status: "COCOK" | "PERLU_DICEK" | "BUTUH_ADJUST_MANUAL";
  note: string | null;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type OlseraInventoryStateDocument = {
  _id: "olsera-inventory";
  /** Diperbarui hanya saat run selesai sukses penuh. */
  lastSuccessfulSyncAt: Date | null;
  /** Tanggal terakhir yang mutasinya tuntas — start incremental berikutnya = tanggal ini - 1 hari. */
  lastSyncedDate: string | null;
  firstSyncAt: Date | null;
  /** Tanggal data paling awal yang benar-benar tersedia (min tanggal mutasi/snapshot). */
  earliestAvailableDate: string | null;
  /** API Olsera tidak menyediakan histori mutasi/adjustment — hanya stok saat ini + penjualan. */
  historyCoverage: "snapshot-only";
  updatedAt: Date;
};

/**
 * Distributed lock/lease untuk mencegah sync Olsera (kategori/penjualan,
 * inventori, keuangan) berjalan bersamaan lintas instance Vercel — dipakai
 * baik oleh cron server-side (app/api/cron/olsera/*) maupun tombol manual
 * (Sync Semua Olsera / sync per modul). Satu dokumen singleton (_id tetap),
 * diambil alih secara atomik bila lockedUntil sudah lewat (proses lama
 * dianggap mati) — lihat lib/olsera-cron-lock.ts.
 */
export type OlseraSyncLockDocument = {
  _id: "olsera-sync";
  runId: string;
  module: "sales" | "inventory" | "financial";
  source: "cron" | "manual";
  lockedAt: Date;
  lockedUntil: Date;
};

// ---------------------------------------------------------------------------
// Modul Rekonsiliasi (Phase 5A) — lihat docs/reconciliation-design.md dan
// lib/reconciliation-types.ts (status/jenis/domain), lib/reconciliation-rules.ts
// (rule engine murni), lib/reconciliation-store.ts (service read-only).
// Koleksi BARU, tidak menyentuh koleksi lama.
// ---------------------------------------------------------------------------

/**
 * Satu dokumen run rekonsiliasi. Phase 5A menulis `_id` unik per eksekusi;
 * Phase 5B (lib/reconciliation-runner.ts, background job internal) memakai
 * `_id` DETERMINISTIK berdasarkan cakupan (`${reconciliationType}:${storeId}:${scope}:${period}:${domain-set}:v${runVersion}`,
 * TANPA timestamp) supaya rerun pada cakupan yang sama meng-upsert dokumen
 * YANG SAMA (idempotent) alih-alih membuat histori baru — `startedAt` tetap
 * dari eksekusi pertama, `updatedAt`/`completedAt` mengikuti eksekusi terakhir.
 */
export type ReconciliationRunDocument = {
  /** Lihat catatan di atas — deterministik (Phase 5B) atau unik-per-eksekusi (Phase 5A manual). */
  _id: string;
  reconciliationType: ReconciliationType;
  storeId: number;
  /** "daily" (per tanggal, dipakai CROSS_SYSTEM_COURT_REVENUE) atau "monthly" (per periode, dipakai INTERNAL_OLSERA snapshot/ledger). */
  scope: "daily" | "monthly";
  /** Nilai cakupan: tanggal YYYY-MM-DD (daily) atau periode YYYY-MM (monthly). */
  period: string;
  /** Sumber data yang dibaca run ini, mis. ["ayo","olsera"] atau ["olsera"] — TIDAK PERNAH mencampur AYO ke dalam run INTERNAL_OLSERA. */
  sourceSystems: string[];
  status: "running" | "success" | "partial" | "failed";
  summary: {
    totalFindings: number;
    byStatus: Partial<Record<ReconciliationStatus, number>>;
    byDomain: Partial<Record<ReconciliationDomain, Partial<Record<ReconciliationStatus, number>>>>;
    requiresManualAdjustmentCount: number;
    matchLikeCount: number;
    notCheckedCount: number;
    finalCount: number;
    nonFinalCount: number;
    /** true bila `period` = bulan berjalan (Asia/Jakarta) — hasil non-final, bisa berubah sampai bulan ditutup (lihat lib/olsera-financial-core.ts isCurrentJakartaPeriod). */
    isDraftPeriod: boolean;
    /** Ringkasan impact seluruh finding di run ini (lihat lib/reconciliation-aggregate.ts summaryImpact) — dasar Dashboard/Priority. */
    impactSummary: Partial<Record<ReconciliationImpact, number>>;
    /** Impact tertinggi di run ini (CRITICAL > ERROR > WARNING > INFO). */
    highestImpact: ReconciliationImpact;
    /** Ringkasan confidence seluruh finding di run ini (lihat summaryConfidence). */
    confidenceSummary: Partial<Record<ReconciliationConfidence, number>>;
    /** Confidence keseluruhan run ini (paling lemah menang — lihat overallConfidence). */
    overallConfidence: ReconciliationConfidence;
  };
  /** Checkpoint proses bertahap (pola sama cron finansial/inventori) — null bila run selesai dalam satu langkah. */
  checkpoint: { cursor: string | null; stage: string | null; completedDomains: ReconciliationDomain[] } | null;
  /** Versi rule engine yang menghasilkan run ini — naikkan bila logika rule berubah signifikan. */
  version: number;
  errorMessage: string | null;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

/** Satu dokumen per TEMUAN (satu entitas yang dibandingkan) — upsert idempoten via `_id` deterministik. */
export type ReconciliationFindingDocument = {
  /** `${reconciliationType}:${storeId}:${scope}:${scopeKey}:${domain}:${entityKey}` — deterministik, upsert aman diulang. */
  _id: string;
  reconciliationType: ReconciliationType;
  domain: ReconciliationDomain;
  ruleId: string;
  /** _id run TERAKHIR yang menghasilkan status ini (lihat ReconciliationRunDocument). */
  runId: string;
  storeId: number;
  scope: "daily" | "monthly";
  period: string;
  status: ReconciliationStatus;
  /** Dampak finding ini bila dibiarkan — WAJIB diisi (lihat lib/reconciliation-types.ts STATUS_IMPACT & rule engine untuk override per sub-case). */
  impact: ReconciliationImpact;
  /** Seberapa yakin hasil matching/rule ini (HIGH=deterministik, MEDIUM=historical/alias/fallback, LOW=ambigu/butuh tinjauan). */
  confidence: ReconciliationConfidence;
  /** Referensi id/collection dari tiap sisi (mis. {bookingId, orderNo}) — BUKAN payload mentah/credential. */
  sourceRefs: Record<string, unknown>;
  entityKey: string;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  difference: Record<string, unknown> | null;
  diagnostics: Record<string, unknown>;
  candidates: Array<{ label: string; value: unknown; note?: string }>;
  knownCaseRef: string | null;
  requiresManualAdjustment: boolean;
  /** _id resolusi manual terakhir (ReconciliationManualResolutionDocument) — null bila belum pernah diputuskan manusia. */
  manualResolutionId: string | null;
  firstDetectedAt: Date;
  lastCheckedAt: Date;
  /** Berapa kali finding ini terlihat lagi pada run berikutnya (naik tiap kali di-upsert ulang, TIDAK PERNAH direset) — Phase 5B. */
  occurrenceCount: number;
  /** Waktu finding ini berhenti muncul pada rerun (TIDAK dihapus, hanya ditandai) — null bila masih aktif/terlihat pada run terakhir. Phase 5B (lib/reconciliation-runner.ts). */
  supersededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Keputusan manusia atas satu finding — APPEND-ONLY (tidak diedit/dihapus,
 * hanya "superseded" oleh entri baru). Kunci = findingId, BUKAN aturan global
 * by-name (pola sama olsera_category_overrides): satu keputusan HANYA berlaku
 * untuk satu finding spesifik. Skema disiapkan Phase 5A; BELUM ada jalur
 * tulis (API/service) yang membuat dokumen ini — lihat docs/reconciliation-design.md.
 */
export type ReconciliationManualResolutionDocument = {
  _id: string;
  /** Sama dengan `_id`; eksplisit untuk kontrak audit/API Phase 5C. */
  resolutionId?: string;
  findingId: string;
  runId?: string;
  domain?: ReconciliationDomain;
  storeId?: number;
  period?: string;
  entityKey?: string;
  decision: ReconciliationManualDecision | "confirmed-match" | "confirmed-mismatch" | "chosen-candidate" | "acknowledged-known-case" | "needs-source-fix";
  reasonCode?: ReconciliationResolutionReasonCode;
  note?: string | null;
  evidence?: string[];
  previousResolutionId?: string | null;
  isCurrent?: boolean;
  createdBy?: string;
  supersededAt?: Date | null;
  metadata?: Record<string, unknown>;
  schemaVersion?: number;
  chosenCandidateEntityKey?: string | null;
  reason?: string;
  userId?: string;
  createdAt: Date;
  /** _id resolusi berikutnya bila keputusan ini sudah digantikan — null bila masih berlaku. */
  supersededBy?: string | null;
};

/** Audit trail APPEND-ONLY atas seluruh perubahan status finding (sistem maupun manusia). Skema disiapkan Phase 5A; belum ada penulis otomatis. */
export type ReconciliationAuditLogDocument = {
  _id: string;
  /** Sama dengan `_id`; eksplisit untuk kontrak audit/API Phase 5C. */
  auditId?: string;
  findingId: string;
  action?: ReconciliationResolutionAuditAction;
  actor?: string;
  storeId?: number;
  runId?: string;
  resolutionId?: string | null;
  previousResolutionId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
  schemaVersion?: number;
  previousStatus?: ReconciliationStatus | null;
  newStatus?: ReconciliationStatus;
  changedBy?: string;
  reason?: string | null;
  createdAt: Date;
};

export const RECONCILIATION_MANUAL_DECISIONS = ["CONFIRMED_FINDING", "FALSE_POSITIVE", "REQUIRES_MANUAL_ADJUSTMENT", "DEFERRED", "RESOLVED", "REVOKED"] as const;
export type ReconciliationManualDecision = (typeof RECONCILIATION_MANUAL_DECISIONS)[number];

export const RECONCILIATION_RESOLUTION_REASON_CODES = [
  "SOURCE_DATA_INCOMPLETE", "PRODUCT_ID_CHANGED", "PRODUCT_IDENTITY_AMBIGUOUS", "LEGACY_STORE_ID_NULL", "STALE_SNAPSHOT",
  "EXPECTED_NON_STOCK_ITEM", "CURRENT_MONTH_BOUNDARY", "VERIFIED_FALSE_POSITIVE", "VERIFIED_CORRECT",
  "MANUAL_INVENTORY_ADJUSTMENT_REQUIRED", "OTHER",
] as const;
export type ReconciliationResolutionReasonCode = (typeof RECONCILIATION_RESOLUTION_REASON_CODES)[number];

export const RECONCILIATION_RESOLUTION_AUDIT_ACTIONS = ["CREATE_RESOLUTION", "SUPERSEDE_RESOLUTION", "REVOKE_RESOLUTION", "RESOLUTION_CONFLICT", "UNAUTHORIZED_RESOLUTION_ATTEMPT", "INVALID_RESOLUTION_TRANSITION"] as const;
export type ReconciliationResolutionAuditAction = (typeof RECONCILIATION_RESOLUTION_AUDIT_ACTIONS)[number];

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
    ayoPaymentEvents: db.collection<AyoPaymentEventDocument>("ayo_payment_events"),
    ayoPaymentPeriods: db.collection<AyoPaymentPeriodDocument>("ayo_payment_periods"),
    syncLogs: db.collection<SyncLogDocument>("sync_logs"),
    fields: db.collection<FieldDocument>("fields"),
    webhookLogs: db.collection<WebhookLogDocument>("webhook_logs"),
    olseraSalesByCategory: db.collection<OlseraSalesByCategoryDocument>("olsera_sales_by_category"),
    olseraSyncLog: db.collection<OlseraSyncLogDocument>("olsera_sync_log"),
    olseraSyncState: db.collection<OlseraSyncStateDocument>("olsera_sync_state"),
    olseraSyncedDays: db.collection<OlseraSyncedDayDocument>("olsera_synced_days"),
    olseraProductCache: db.collection<OlseraProductCacheDocument>("olsera_product_cache"),
    olseraOrderItems: db.collection<OlseraOrderItemDocument>("olsera_order_items"),
    olseraProductAliases: db.collection<OlseraProductAliasDocument>("olsera_product_aliases"),
    olseraCategoryOverrides: db.collection<OlseraCategoryOverrideDocument>("olsera_category_overrides"),
    olseraInventoryProducts: db.collection<OlseraInventoryProductDocument>("olsera_inventory_products"),
    olseraInventorySnapshots: db.collection<OlseraInventorySnapshotDocument>("olsera_inventory_snapshots"),
    olseraInventoryMonthlySnapshots: db.collection<OlseraInventoryMonthlySnapshotDocument>("olsera_inventory_monthly_snapshots"),
    olseraInventoryMovements: db.collection<OlseraInventoryMovementDocument>("olsera_inventory_movements"),
    olseraInventorySyncRuns: db.collection<OlseraInventorySyncRunDocument>("olsera_inventory_sync_runs"),
    olseraInventoryState: db.collection<OlseraInventoryStateDocument>("olsera_inventory_state"),
    olseraFinancialMonthlyReports: db.collection<OlseraFinancialMonthlyReportDocument>("olsera_financial_monthly_reports"),
    olseraFinancialAccounts: db.collection<OlseraFinancialAccountDocument>("olsera_financial_accounts"),
    olseraFinancialLedgerEntries: db.collection<OlseraFinancialLedgerEntryDocument>("olsera_financial_ledger_entries"),
    olseraFinancialSyncLogs: db.collection<OlseraFinancialSyncLogDocument>("olsera_financial_sync_logs"),
    olseraFinancialEmptyLedgerConfirmations: db.collection<FinancialEmptyLedgerConfirmationDocument>("olsera_financial_empty_ledger_confirmations"),
    olseraFinancialStaleCleanupAudits: db.collection<FinancialStaleCleanupAuditDocument>("olsera_financial_stale_cleanup_audits"),
    olseraSyncLocks: db.collection<OlseraSyncLockDocument>("olsera_sync_locks"),
    reconciliationRuns: db.collection<ReconciliationRunDocument>("reconciliation_runs"),
    reconciliationFindings: db.collection<ReconciliationFindingDocument>("reconciliation_findings"),
    reconciliationManualResolutions: db.collection<ReconciliationManualResolutionDocument>("reconciliation_manual_resolutions"),
    reconciliationAuditLog: db.collection<ReconciliationAuditLogDocument>("reconciliation_audit_log"),
    inventoryStockOpnameReconciliations: db.collection<InventoryStockOpnameDocument>("inventory_stock_opname_reconciliations"),
    olseraOmzetReconciliationNotes: db.collection<OlseraOmzetReconciliationNoteDocument>("olsera_omzet_reconciliation_notes"),
    olseraOmzetReconciliationAuditLog: db.collection<OlseraOmzetReconciliationAuditLogDocument>("olsera_omzet_reconciliation_audit_log"),
    rateLimits: db.collection<RateLimitDocument>("rate_limits"),
    historicalBackfillAuditLog: db.collection<HistoricalBackfillAuditLogDocument>("historical_backfill_audit_log"),
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
    ayoPaymentEvents,
    ayoPaymentPeriods,
    syncLogs,
    fields,
    webhookLogs,
    olseraSalesByCategory,
    olseraSyncLog,
    olseraSyncedDays,
    olseraProductCache,
    olseraOrderItems,
    olseraProductAliases,
    olseraInventoryProducts,
    olseraInventorySnapshots,
    olseraInventoryMonthlySnapshots,
    olseraInventoryMovements,
    olseraFinancialEmptyLedgerConfirmations,
    olseraFinancialStaleCleanupAudits,
    olseraInventorySyncRuns,
    olseraFinancialMonthlyReports,
    olseraFinancialAccounts,
    olseraFinancialLedgerEntries,
    olseraFinancialSyncLogs,
    olseraSyncLocks,
    reconciliationRuns,
    reconciliationFindings,
    reconciliationManualResolutions,
    reconciliationAuditLog,
    inventoryStockOpnameReconciliations,
    olseraOmzetReconciliationNotes,
    olseraOmzetReconciliationAuditLog,
    rateLimits,
    historicalBackfillAuditLog,
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
    ayoPaymentEvents.createIndex({ bookingId: 1, date: 1 }),
    syncLogs.createIndex({ startedAt: -1 }),
    fields.createIndex({ id: 1 }, { unique: true }),
    olseraSalesByCategory.createIndex({ date: 1, category: 1 }, { unique: true }),
    olseraSyncLog.createIndex({ startedAt: -1 }),
    olseraSyncedDays.createIndex({ syncedAt: -1 }),
    olseraProductCache.createIndex({ productId: 1 }, { unique: true }),
    olseraOrderItems.createIndex({ date: 1 }),
    olseraOrderItems.createIndex({ orderNo: 1 }),
    olseraOrderItems.createIndex({ categoryResolutionStatus: 1 }),
    olseraProductAliases.createIndex({ normalizedName: 1 }),
    olseraProductAliases.createIndex({ sku: 1 }),
    olseraInventoryProducts.createIndex({ productId: 1, variantId: 1 }),
    olseraInventoryProducts.createIndex({ sku: 1 }),
    olseraInventoryProducts.createIndex({ category: 1 }),
    olseraInventoryProducts.createIndex({ storeId: 1 }),
    olseraInventorySnapshots.createIndex({ date: 1 }),
    olseraInventorySnapshots.createIndex({ productId: 1, variantId: 1, date: 1 }),
    // Unique: satu dokumen per toko+bulan+produk+variant — upsert bootstrap/backfill aman diulang (idempotent).
    olseraInventoryMonthlySnapshots.createIndex(
      { storeId: 1, year: 1, month: 1, productId: 1, variantId: 1 },
      { unique: true },
    ),
    olseraInventoryMonthlySnapshots.createIndex({ updatedAt: -1 }),
    olseraInventoryMovements.createIndex({ date: 1 }),
    olseraInventoryMovements.createIndex({ productId: 1, variantId: 1, date: 1 }),
    olseraInventoryMovements.createIndex({ sku: 1 }),
    olseraInventoryMovements.createIndex({ type: 1 }),
    olseraInventorySyncRuns.createIndex({ startedAt: -1 }),
    // Paling banyak satu dokumen "running" pada satu waktu — mencegah dua
    // request start() paralel sama-sama membuat run baru (lihat
    // lib/olsera-inventory.ts startInventorySync, stale-lock protection).
    olseraInventorySyncRuns.createIndex(
      { status: 1 },
      { unique: true, partialFilterExpression: { status: "running" } },
    ),
    olseraFinancialMonthlyReports.createIndex({ storeId: 1, period: 1, reportType: 1 }, { unique: true }),
    olseraFinancialMonthlyReports.createIndex({ period: -1 }),
    olseraFinancialMonthlyReports.createIndex({ syncedAt: -1 }),
    olseraFinancialAccounts.createIndex({ storeId: 1, accountCode: 1 }),
    olseraFinancialAccounts.createIndex({ storeId: 1, accountId: 1 }),
    olseraFinancialAccounts.createIndex({ accountName: 1 }),
    olseraFinancialLedgerEntries.createIndex({ storeId: 1, period: 1, accountCode: 1 }),
    olseraFinancialLedgerEntries.createIndex({ storeId: 1, transactionNo: 1 }),
    olseraFinancialLedgerEntries.createIndex({ transactionDate: 1 }),
    olseraFinancialLedgerEntries.createIndex({ period: 1, accountCode: 1, transactionDate: 1 }),
    olseraFinancialSyncLogs.createIndex({ startedAt: -1 }),
    olseraFinancialSyncLogs.createIndex({ storeId: 1, period: 1 }),
    olseraFinancialSyncLogs.createIndex({ status: 1, updatedAt: -1 }),
    olseraFinancialEmptyLedgerConfirmations.createIndex({ storeId: 1, period: 1, accountCode: 1 }, { unique: true }),
    olseraFinancialStaleCleanupAudits.createIndex({ storeId: 1, period: 1, accountCode: 1, createdAt: -1 }),
    // TTL jaga-jaga: dokumen lock singleton dibersihkan otomatis lama setelah
    // lease kedaluwarsa (release/acquire tetap bekerja tanpa TTL — ini hanya
    // housekeeping, bukan mekanisme utama lock).
    olseraSyncLocks.createIndex({ lockedUntil: 1 }),
    // Modul Rekonsiliasi (Phase 5A) — collection BARU, index BARU saja (tidak
    // menyentuh index koleksi lama manapun). `_id` sudah unik secara native
    // (runId/findingId/resolutionId/auditId deterministik, lihat lib/mongodb.ts
    // dokumentasi tipe di atas) — index tambahan di bawah untuk pola query.
    reconciliationRuns.createIndex({ storeId: 1, period: 1, reconciliationType: 1 }),
    reconciliationRuns.createIndex({ startedAt: -1 }),
    reconciliationRuns.createIndex({ updatedAt: -1 }),
    reconciliationFindings.createIndex({ storeId: 1, period: 1, reconciliationType: 1 }),
    reconciliationFindings.createIndex({ storeId: 1, period: 1, impact: 1, confidence: 1, updatedAt: -1 }),
    reconciliationFindings.createIndex({ storeId: 1, entityKey: 1 }),
    reconciliationFindings.createIndex({ runId: 1, domain: 1, status: 1 }),
    reconciliationFindings.createIndex({ runId: 1 }),
    reconciliationFindings.createIndex({ createdAt: -1 }),
    reconciliationManualResolutions.createIndex({ findingId: 1, createdAt: -1 }),
    reconciliationManualResolutions.createIndex({ findingId: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } }),
    reconciliationManualResolutions.createIndex({ storeId: 1, period: 1, decision: 1 }),
    reconciliationManualResolutions.createIndex({ runId: 1 }),
    reconciliationManualResolutions.createIndex({ createdAt: -1 }),
    reconciliationAuditLog.createIndex({ findingId: 1, createdAt: -1 }),
    reconciliationAuditLog.createIndex({ createdAt: -1 }),
    // Rekonsiliasi Inventori dengan Berita Acara — collection BARU, TERPISAH
    // dari snapshot/katalog/order/transaksi. `_id` sudah unik secara native
    // (deterministik storeId+year+month+productId+variantId) — index di bawah
    // hanya untuk pola query "seluruh produk satu bulan".
    inventoryStockOpnameReconciliations.createIndex({ storeId: 1, year: 1, month: 1 }),
    inventoryStockOpnameReconciliations.createIndex({ updatedAt: -1 }),
    // Rekonsiliasi Omzet AYOSERA (engine ledger 40001/40004) — `_id` sudah
    // unik secara native (`${storeId}:${period}`), index tambahan untuk
    // query "seluruh catatan satu toko".
    olseraOmzetReconciliationNotes.createIndex({ storeId: 1, updatedAt: -1 }),
    // Fitur Lock+Berita Acara (skema baru append-only, lihat
    // OlseraOmzetReconciliationNoteV2Document) — index BARU, TIDAK mengganti
    // index lama di atas (dua bentuk dokumen berdampingan di collection yang
    // sama, lihat dokumen desain "Desain Skema Lock+Berita Acara" di
    // tmp/ai-handoff.md, section 5). Unique partial index menegakkan
    // invarian "maksimal satu isCurrent:true per (storeId, period)" di level
    // database, lapisan pertahanan kedua di luar conditional update aplikasi.
    olseraOmzetReconciliationNotes.createIndex(
      { storeId: 1, period: 1, isCurrent: 1 },
      { unique: true, partialFilterExpression: { isCurrent: true } },
    ),
    olseraOmzetReconciliationNotes.createIndex({ storeId: 1, period: 1, createdAt: -1 }),
    olseraOmzetReconciliationNotes.createIndex({ locked: 1, storeId: 1 }),
    olseraOmzetReconciliationAuditLog.createIndex({ storeId: 1, period: 1, timestamp: -1 }),
    olseraOmzetReconciliationAuditLog.createIndex({ noteId: 1 }),
    // Rate limiting (Task 4) — TTL: bucket kedaluwarsa dihapus otomatis, tidak
    // menumpuk dokumen selamanya.
    rateLimits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Milestone 4 Bagian C — jejak audit backfill reversibel, satu per orderItemId.
    historicalBackfillAuditLog.createIndex({ storeId: 1, createdAt: -1 }),
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
