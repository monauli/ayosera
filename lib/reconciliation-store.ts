// Service READ-ONLY Modul Rekonsiliasi (Phase 5A) — lib/reconciliation-store.ts
// membaca `reconciliation_runs`/`reconciliation_findings` (koleksi baru, lihat
// lib/mongodb.ts). TIDAK ADA operasi tulis di file ini (belum ada manual
// resolution/audit-log writer — sesuai batasan tugas Phase 5A).
//
// Dependency injection: parameter `context` opsional (pola sama
// lib/olsera-financial-store.ts) supaya bisa diuji dengan koleksi palsu tanpa
// MongoDB sungguhan (lihat lib/reconciliation-store.test.ts).
import "server-only";
import {
  isReconciliationConfidence,
  isReconciliationDomain,
  isReconciliationImpact,
  isReconciliationStatus,
  isReconciliationType,
  type ReconciliationConfidence,
  type ReconciliationDomain,
  type ReconciliationImpact,
  type ReconciliationStatus,
  type ReconciliationType,
} from "./reconciliation-types.ts";
import type { ReconciliationFindingDocument, ReconciliationRunDocument } from "./mongodb.ts";

export class ReconciliationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationValidationError";
  }
}

// ---------------------------------------------------------------------------
// Bentuk koleksi minimal yang dibutuhkan (subset method Mongo Collection asli
// yang benar-benar dipakai) — Collection<T> produksi structurally compatible,
// dan test bisa memasok tiruan sederhana tanpa MongoDB sungguhan.
// ---------------------------------------------------------------------------

export type MinimalFindCursor<T> = {
  sort(spec: Record<string, 1 | -1>): MinimalFindCursor<T>;
  skip(n: number): MinimalFindCursor<T>;
  limit(n: number): MinimalFindCursor<T>;
  toArray(): Promise<T[]>;
};

export type MinimalCollection<T> = {
  find(filter: Record<string, unknown>): MinimalFindCursor<T>;
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  countDocuments(filter: Record<string, unknown>): Promise<number>;
};

export type ReconciliationStoreContext = {
  runs: MinimalCollection<ReconciliationRunDocument>;
  findings: MinimalCollection<ReconciliationFindingDocument>;
};

async function resolveContext(context?: ReconciliationStoreContext): Promise<ReconciliationStoreContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { reconciliationRuns, reconciliationFindings } = await collections();
  return { runs: reconciliationRuns, findings: reconciliationFindings };
}

// ---------------------------------------------------------------------------
// Validasi input — SATU-SATUNYA jalur nilai boleh masuk ke query Mongo.
// Tidak ada field yang diteruskan mentah dari caller ke filter: setiap field
// divalidasi tipe+isi primitifnya (bukan object/operator Mongo apa pun bisa
// menembus ke sini, karena tiap nilai dicek `typeof`/enum sebelum dipakai).
// ---------------------------------------------------------------------------

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
/** Format cakupan diterima: YYYY-MM (bulanan) atau YYYY-MM-DD (harian). */
const PERIOD_PATTERN = /^\d{4}-\d{2}(-\d{2})?$/;

export function validateStoreId(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ReconciliationValidationError("storeId wajib diisi (integer positif).");
  return n;
}

/**
 * storeId SELALU berasal dari konfigurasi server (OLSERA_INTERNAL_STORE_ID),
 * TIDAK PERNAH dari input klien — mencegah IDOR lintas toko (lihat SEC-07,
 * temuan audit sebelumnya, tentang bahaya storeId dari input klien). Dipakai
 * oleh route API; fungsi list-/get- di atas tetap menerima storeId sebagai
 * parameter eksplisit supaya mudah diuji dengan storeId palsu di unit test.
 */
export function currentStoreId(): number {
  return validateStoreId(process.env.OLSERA_INTERNAL_STORE_ID);
}

function clampPage(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function clampLimit(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function validatePeriod(value: unknown): string {
  if (typeof value !== "string" || !PERIOD_PATTERN.test(value)) {
    throw new ReconciliationValidationError("period tidak valid (format YYYY-MM atau YYYY-MM-DD).");
  }
  return value;
}

function validateReconciliationType(value: unknown): ReconciliationType {
  if (!isReconciliationType(value)) throw new ReconciliationValidationError("reconciliationType tidak valid.");
  return value;
}

function validateDomain(value: unknown): ReconciliationDomain {
  if (!isReconciliationDomain(value)) throw new ReconciliationValidationError("domain tidak valid.");
  return value;
}

function validateStatus(value: unknown): ReconciliationStatus {
  if (!isReconciliationStatus(value)) throw new ReconciliationValidationError("status tidak valid.");
  return value;
}

function validateImpact(value: unknown): ReconciliationImpact {
  if (!isReconciliationImpact(value)) throw new ReconciliationValidationError("impact tidak valid.");
  return value;
}

function validateConfidence(value: unknown): ReconciliationConfidence {
  if (!isReconciliationConfidence(value)) throw new ReconciliationValidationError("confidence tidak valid.");
  return value;
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ReconciliationValidationError(`${field} harus boolean.`);
  return value;
}

function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ReconciliationValidationError(`${field} wajib diisi.`);
  return value;
}

const RUN_SORT_FIELDS = ["startedAt", "period"] as const;
type RunSortField = (typeof RUN_SORT_FIELDS)[number];
function validateRunSort(value: unknown): RunSortField {
  if (value === undefined) return "startedAt";
  if (typeof value === "string" && (RUN_SORT_FIELDS as readonly string[]).includes(value)) return value as RunSortField;
  throw new ReconciliationValidationError(`Field sort run tidak didukung: ${String(value)}`);
}

const FINDING_SORT_FIELDS = ["createdAt", "lastCheckedAt", "status", "domain"] as const;
type FindingSortField = (typeof FINDING_SORT_FIELDS)[number];
function validateFindingSort(value: unknown): FindingSortField {
  if (value === undefined) return "createdAt";
  if (typeof value === "string" && (FINDING_SORT_FIELDS as readonly string[]).includes(value)) return value as FindingSortField;
  throw new ReconciliationValidationError(`Field sort finding tidak didukung: ${String(value)}`);
}

function validateSortDir(value: unknown): 1 | -1 {
  if (value === undefined || value === "desc") return -1;
  if (value === "asc") return 1;
  throw new ReconciliationValidationError('sortDir hanya boleh "asc" atau "desc".');
}

// ---------------------------------------------------------------------------
// listRuns
// ---------------------------------------------------------------------------

export type ListRunsFilter = {
  storeId: number;
  reconciliationType?: unknown;
  period?: unknown;
  page?: unknown;
  limit?: unknown;
  sort?: unknown;
  sortDir?: unknown;
};

export type ListRunsResult = { items: ReconciliationRunDocument[]; total: number; page: number; limit: number };

/** Daftar run — storeId WAJIB (isolasi lintas toko), paginasi dibatasi keras, sort divalidasi dari allow-list. */
export async function listRuns(filter: ListRunsFilter, context?: ReconciliationStoreContext): Promise<ListRunsResult> {
  const storeId = validateStoreId(filter.storeId);
  const page = clampPage(filter.page);
  const limit = clampLimit(filter.limit);
  const sortField = validateRunSort(filter.sort);
  const sortDir = validateSortDir(filter.sortDir);

  const query: Record<string, unknown> = { storeId };
  if (filter.reconciliationType !== undefined) query.reconciliationType = validateReconciliationType(filter.reconciliationType);
  if (filter.period !== undefined) query.period = validatePeriod(filter.period);

  const { runs } = await resolveContext(context);
  const [items, total] = await Promise.all([
    runs
      .find(query)
      .sort({ [sortField]: sortDir })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    runs.countDocuments(query),
  ]);
  return { items, total, page, limit };
}

// ---------------------------------------------------------------------------
// getRunDetail
// ---------------------------------------------------------------------------

export type GetRunDetailParams = { runId: unknown; storeId: number };

/**
 * Detail satu run — storeId WAJIB dan HARUS cocok dengan run yang tersimpan.
 * Run milik toko lain diperlakukan SAMA seperti "tidak ada" (null) — tidak
 * membedakan "ada tapi bukan milik Anda" vs "tidak ada" (mencegah IDOR/
 * enumerasi keberadaan run lintas toko).
 */
export async function getRunDetail(params: GetRunDetailParams, context?: ReconciliationStoreContext): Promise<ReconciliationRunDocument | null> {
  const storeId = validateStoreId(params.storeId);
  const runId = validateNonEmptyString(params.runId, "runId");
  const { runs } = await resolveContext(context);
  return runs.findOne({ _id: runId, storeId });
}

// ---------------------------------------------------------------------------
// listFindings
// ---------------------------------------------------------------------------

export type ListFindingsFilter = {
  storeId: number;
  reconciliationType?: unknown;
  domain?: unknown;
  status?: unknown;
  impact?: unknown;
  confidence?: unknown;
  requiresManualAdjustment?: unknown;
  period?: unknown;
  runId?: unknown;
  page?: unknown;
  limit?: unknown;
  sort?: unknown;
  sortDir?: unknown;
};

export type ListFindingsResult = { items: ReconciliationFindingDocument[]; total: number; page: number; limit: number };

/** Daftar finding — storeId WAJIB, filter lain divalidasi terhadap enum/format tetap (tidak ada operator Mongo dari client). */
export async function listFindings(filter: ListFindingsFilter, context?: ReconciliationStoreContext): Promise<ListFindingsResult> {
  const storeId = validateStoreId(filter.storeId);
  const page = clampPage(filter.page);
  const limit = clampLimit(filter.limit);
  const sortField = validateFindingSort(filter.sort);
  const sortDir = validateSortDir(filter.sortDir);

  const query: Record<string, unknown> = { storeId };
  if (filter.reconciliationType !== undefined) query.reconciliationType = validateReconciliationType(filter.reconciliationType);
  if (filter.domain !== undefined) query.domain = validateDomain(filter.domain);
  if (filter.status !== undefined) query.status = validateStatus(filter.status);
  if (filter.impact !== undefined) query.impact = validateImpact(filter.impact);
  if (filter.confidence !== undefined) query.confidence = validateConfidence(filter.confidence);
  if (filter.requiresManualAdjustment !== undefined) query.requiresManualAdjustment = validateBoolean(filter.requiresManualAdjustment, "requiresManualAdjustment");
  if (filter.period !== undefined) query.period = validatePeriod(filter.period);
  if (filter.runId !== undefined) query.runId = validateNonEmptyString(filter.runId, "runId");

  const { findings } = await resolveContext(context);
  const [items, total] = await Promise.all([
    findings
      .find(query)
      .sort({ [sortField]: sortDir })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    findings.countDocuments(query),
  ]);
  return { items, total, page, limit };
}
