// @ts-nocheck
import { loadEnvConfig } from "@next/env";

const financialNames = [
  "olsera_financial_monthly_reports",
  "olsera_financial_accounts",
  "olsera_financial_ledger_entries",
  "olsera_financial_sync_logs",
];

function pass(label: string, detail = "") {
  console.log(`[PASS] ${label}${detail ? `: ${detail}` : ""}`);
}

function fail(label: string, detail = "") {
  console.error(`[FAIL] ${label}${detail ? `: ${detail}` : ""}`);
}

async function main() {
  loadEnvConfig(process.cwd());
  if (!process.env.MONGODB_URI) {
    fail("Production MongoDB configuration", "MONGODB_URI tidak tersedia");
    process.exitCode = 2;
    return;
  }
  if (!process.env.MONGODB_DB) {
    fail("Production MongoDB configuration", "MONGODB_DB tidak tersedia");
    process.exitCode = 2;
    return;
  }

  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB);
    await db.command({ ping: 1 });
    pass("Production MongoDB connected");
    pass("Production database selected");

    const existing = await db.listCollections({ name: "bookings" }, { nameOnly: true }).hasNext();
    if (!existing) {
      fail("Existing AYOSERA collection readable", "collection bookings tidak ditemukan");
      process.exitCode = 1;
      return;
    }
    await db.collection("bookings").findOne({}, { projection: { _id: 1 }, maxTimeMS: 8000 });
    pass("Existing AYOSERA collection readable");

    const collectionStates = await Promise.all(
      financialNames.map(async (name) => {
        const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
        const count = exists ? await db.collection(name).countDocuments({}, { maxTimeMS: 8000 }) : 0;
        const may = exists ? await db.collection(name).countDocuments({ period: "2026-05" }, { maxTimeMS: 8000 }) : 0;
        return { name, exists, count, may };
      }),
    );
    const financialReadable = collectionStates.every((item) => item.exists);
    if (financialReadable) pass("Financial collections inspection");
    else fail("Financial collections inspection", "satu atau lebih collection belum ada");

    const storeId = Number(process.env.OLSERA_INTERNAL_STORE_ID);
    const sync = await db.collection("olsera_financial_sync_logs").findOne(
      { _id: `financial:${storeId}:2026-05` },
      { projection: { status: 1, phase: 1, errorMessage: 1 }, maxTimeMS: 8000 },
    );
    const ledgerMay = await db.collection("olsera_financial_ledger_entries").countDocuments(
      { storeId, period: "2026-05", accountCode: "11105" },
      { maxTimeMS: 8000 },
    );
    const reportsMay = await db.collection("olsera_financial_monthly_reports").countDocuments(
      { storeId, period: "2026-05" },
      { maxTimeMS: 8000 },
    );

    const { getMonthlyReportsForPeriod, getFinancialSyncLogForPeriod, listFinancialAccounts, listFinancialLedgerEntriesPage } =
      await import("../lib/olsera-financial-store.ts");
    const context = {
      monthlyReports: db.collection("olsera_financial_monthly_reports"),
      accounts: db.collection("olsera_financial_accounts"),
      ledgerEntries: db.collection("olsera_financial_ledger_entries"),
      syncLogs: db.collection("olsera_financial_sync_logs"),
    };
    const [reports, accounts, log, ledger] = await Promise.all([
      getMonthlyReportsForPeriod("2026-05", context),
      listFinancialAccounts(context),
      getFinancialSyncLogForPeriod("2026-05", context),
      listFinancialLedgerEntriesPage("2026-05", "11105", 1, 50, context),
    ]);
    if (Object.keys(reports).length === 4 && accounts.length === 85 && ledger.total === 91) pass("Financial store read path");
    else fail("Financial store read path", "hasil read tidak lengkap");

    console.log("\nProduction database: configured");
    console.log("Existing collection: readable");
    console.log("\nFinancial data:");
    for (const item of collectionStates) console.log(`- ${item.name}: exists=${item.exists}, documents=${item.count}, period 2026-05=${item.may}`);
    console.log(`- period 2026-05: ${reportsMay === 4 && Object.keys(reports).length === 4 ? "available" : "missing"}`);
    console.log(`- sync 2026-05: ${sync?.status ?? log?.status ?? "missing"}/${sync?.phase ?? log?.phase ?? "missing"}`);
    console.log(`- ledger 11105: ${ledgerMay === 91 && ledger.total === 91 ? "available" : "missing"}`);
    console.log("\nDiagnosis:");
    console.log(financialReadable && reportsMay > 0 ? "- connection-ok-data-exists" : financialReadable ? "- connection-ok-financial-data-missing" : "- financial-read-path-error");
  } catch (error) {
    const name = error?.name ?? "UnknownError";
    const code = error?.code == null ? "UNKNOWN" : String(error.code);
    const diagnosis = /Timeout|ServerSelection|ECONN|ENOTFOUND/i.test(`${name} ${code}`) ? "production-connection-timeout" : "financial-read-path-error";
    fail("Production diagnosis", `${diagnosis} (${name}/${code})`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch(() => {
  fail("Production diagnosis", "read-only check failed");
  process.exitCode = 1;
});
