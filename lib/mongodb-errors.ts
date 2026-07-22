import { MongoServerSelectionError, MongoNetworkError, MongoServerError } from "mongodb";

/** Koneksi/query MongoDB gagal atau melebihi batas waktu — dipakai rute snapshot (baca-only) untuk membedakan dari FinancialClientError (Olsera live). */
export const isDatabaseTimeoutError = (e: unknown) =>
  e instanceof MongoServerSelectionError ||
  e instanceof MongoNetworkError ||
  e instanceof MongoServerError ||
  (e instanceof Error && (e.message.includes("timed out") || e.message.includes("timeout")));
