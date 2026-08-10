import "server-only";
import { MongoClient } from "mongodb";
import type { FinancialCollections } from "./olsera-financial-store";

/**
 * Modul ini HANYA untuk MongoDB TEST (validator). Sengaja TIDAK mengimpor
 * apa pun dari "./mongodb" — tidak ada singleton production, tidak ada
 * fallback localhost, tidak ada ensureIndexes() global yang bisa menyentuh
 * collection non-financial.
 */
export type FinancialTestCollections = FinancialCollections & { client: MongoClient; dbName: string };

export type FinancialTestDbGuardReasonCode =
  | "missing-test-uri"
  | "missing-test-db"
  | "same-as-production"
  | "forbidden-name"
  | "missing-test-marker"
  | "invalid-uri";
export type FinancialTestDbGuardResult =
  | { ok: true; dbName: string }
  | { ok: false; reason: string; reasonCode: FinancialTestDbGuardReasonCode };

export function validateFinancialTestDatabase(uri: string | undefined, testDb: string | undefined, productionDb: string): FinancialTestDbGuardResult {
  if (!uri) return { ok: false, reason: "MongoDB test belum dikonfigurasi.", reasonCode: "missing-test-uri" };
  const name = (testDb ?? "").trim().toLowerCase();
  if (!name) return { ok: false, reason: "MongoDB test belum dikonfigurasi.", reasonCode: "missing-test-db" };
  const production = productionDb.trim().toLowerCase();
  if (name === production) return { ok: false, reason: "Database test tidak aman digunakan.", reasonCode: "same-as-production" };
  if (/^(ayosera|production|prod|main|primary)$/.test(name)) return { ok: false, reason: "Database test tidak aman digunakan.", reasonCode: "forbidden-name" };
  if (!/(test|sandbox|staging)/.test(name)) return { ok: false, reason: "Database test tidak aman digunakan.", reasonCode: "missing-test-marker" };
  // Koneksi MongoDB standar mendukung multi-host ("host1,host2,host3") yang
  // tidak valid untuk WHATWG URL parser meski valid untuk MongoClient — jadi
  // validasi skema saja, jangan pakai `new URL()` yang menolak URI aman ini.
  if (!/^mongodb(\+srv)?:\/\/.+/.test(uri)) return { ok: false, reason: "MongoDB test belum dikonfigurasi.", reasonCode: "invalid-uri" };
  return { ok: true, dbName: testDb!.trim() };
}

/**
 * Index financial di database TEST — SENGAJA daftar yang sama persis dengan
 * bagian financial di createIndexes() production (lib/mongodb.ts), disalin
 * (bukan dipanggil bersama) supaya TEST tidak pernah memicu ensureIndexes()
 * global yang bisa menyentuh collection non-financial (inventori, booking,
 * dll).
 */
export async function ensureFinancialTestIndexes(fc: FinancialCollections): Promise<void> {
  await Promise.all([
    fc.monthlyReports.createIndex({ storeId: 1, period: 1, reportType: 1 }, { unique: true }),
    fc.monthlyReports.createIndex({ period: -1 }),
    fc.monthlyReports.createIndex({ syncedAt: -1 }),
    fc.accounts.createIndex({ storeId: 1, accountCode: 1 }),
    fc.accounts.createIndex({ storeId: 1, accountId: 1 }),
    fc.accounts.createIndex({ accountName: 1 }),
    fc.ledgerEntries.createIndex({ storeId: 1, period: 1, accountCode: 1 }),
    fc.ledgerEntries.createIndex({ storeId: 1, transactionNo: 1 }),
    fc.ledgerEntries.createIndex({ transactionDate: 1 }),
    fc.ledgerEntries.createIndex({ period: 1, accountCode: 1, transactionDate: 1 }),
    fc.syncLogs.createIndex({ startedAt: -1 }),
    fc.syncLogs.createIndex({ storeId: 1, period: 1 }),
    fc.syncLogs.createIndex({ status: 1, updatedAt: -1 }),
  ]);
}

export async function connectFinancialTestDatabase(uri: string, testDb: string): Promise<FinancialTestCollections> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(testDb);
  const fc: FinancialTestCollections = {
    client,
    dbName: testDb,
    monthlyReports: db.collection("olsera_financial_monthly_reports"),
    accounts: db.collection("olsera_financial_accounts"),
    ledgerEntries: db.collection("olsera_financial_ledger_entries"),
    syncLogs: db.collection("olsera_financial_sync_logs"),
  };
  await ensureFinancialTestIndexes(fc);
  return fc;
}
