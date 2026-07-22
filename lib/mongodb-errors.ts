import { MongoServerSelectionError, MongoNetworkError, MongoServerError } from "mongodb";

/** Koneksi/query MongoDB gagal atau melebihi batas waktu — dipakai rute snapshot (baca-only) untuk membedakan dari FinancialClientError (Olsera live). */
export const isDatabaseTimeoutError = (e: unknown) =>
  e instanceof MongoServerSelectionError ||
  e instanceof MongoNetworkError ||
  e instanceof MongoServerError ||
  (e instanceof Error && (e.message.includes("timed out") || e.message.includes("timeout")));

/**
 * Retry SEKALI (bukan loop) khusus untuk bacaan MongoDB yang gagal karena
 * koneksi/timeout sementara (cold start serverless) — bukan untuk auth,
 * validasi input, atau error lain (yang langsung dilempar ulang tanpa retry).
 */
export async function withDatabaseRetry<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (!isDatabaseTimeoutError(error)) throw error;
    const jitterMs = 500 + Math.floor(Math.random() * 500);
    await new Promise((resolve) => setTimeout(resolve, jitterMs));
    return task();
  }
}
