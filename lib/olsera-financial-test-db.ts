// @ts-nocheck
import "server-only";
import { MongoClient } from "mongodb";
import { dbName as productionDbName } from "./mongodb";
export type FinancialTestCollections = { db: any; reports: any; accounts: any; ledger: any; logs: any; client: MongoClient };
export function validateFinancialTestDatabase(uri: string | undefined, testDb: string | undefined, productionDb = productionDbName) {
  if (!uri || !testDb) return { ok: false, reason: "MongoDB test belum dikonfigurasi." };
  const name = testDb.trim().toLowerCase(); const production = productionDb.trim().toLowerCase();
  if (name === production || !/(test|sandbox|staging)/.test(name) || /^(ayosera|production|prod|main|primary)$/.test(name)) return { ok: false, reason: "Database test tidak aman digunakan." };
  try { new URL(uri); } catch { return { ok: false, reason: "Database test tidak aman digunakan." }; }
  return { ok: true, dbName: testDb.trim() };
}
export async function connectFinancialTestDatabase(uri: string, testDb: string): Promise<FinancialTestCollections> { const client = new MongoClient(uri); await client.connect(); const db = client.db(testDb); return { db, client, reports: db.collection("olsera_financial_monthly_reports"), accounts: db.collection("olsera_financial_accounts"), ledger: db.collection("olsera_financial_ledger_entries"), logs: db.collection("olsera_financial_sync_logs") }; }
