// @ts-nocheck
/**
 * Validator Financial Sync Tahap 4A — HARUS berjalan seluruhnya terhadap
 * MongoDB TEST (MONGODB_TEST_URI/MONGODB_TEST_DB), tidak pernah menyentuh
 * koneksi atau database production.
 *
 * Urutan wajib (lihat laporan akhir untuk audit penyebab):
 *  1. loadEnvConfig()            — env siap sebelum modul lain dievaluasi.
 *  2. baca & validasi env TEST   — safety guard.
 *  3. buka koneksi MongoDB TEST  — MongoClient terpisah, bukan singleton
 *     production (lib/mongodb.ts tidak pernah diimpor di sini).
 *  4. baru import modul financial sync/store/client yang dibutuhkan.
 *  5. jalankan sync end-to-end via dependency injection (context TEST).
 */
import { loadEnvConfig } from "@next/env";

class ValidationMismatchError extends Error {}

function safeErrorInfo(error: unknown) {
  const e = error as { name?: string; code?: unknown } | undefined;
  return { name: e?.name ?? "UnknownError", code: e?.code !== undefined && e?.code !== null ? String(e.code) : "UNKNOWN" };
}

function approxEqual(actual: unknown, expected: number, tolerance = 0.01) {
  return Math.abs(Number(actual) - expected) <= tolerance;
}

function assertMatch(condition: boolean, message: string) {
  if (!condition) throw new ValidationMismatchError(message);
}

async function main() {
  // 1) Env siap SEBELUM modul lain diimpor/dijalankan.
  loadEnvConfig(process.cwd());

  // 2) Baca + validasi env TEST (safety guard) sebelum apa pun lain terjadi.
  const { validateFinancialTestDatabase } = await import("../lib/olsera-financial-test-db.ts");
  const guard = validateFinancialTestDatabase(
    process.env.MONGODB_TEST_URI,
    process.env.MONGODB_TEST_DB,
    process.env.MONGODB_DB || "ayo_middleware",
  );
  if (!guard.ok) {
    console.error(`[FAIL] ${guard.reason === "MongoDB test belum dikonfigurasi." ? "Configuration" : "Safety guard"}`);
    console.error(guard.reason);
    console.error(`(reason code: ${guard.reasonCode})`);
    process.exitCode = 2;
    return;
  }
  console.log("[PASS] Test database safety");

  // 3) Buka koneksi MongoDB TEST — client terpisah, bukan singleton production.
  const { connectFinancialTestDatabase } = await import("../lib/olsera-financial-test-db.ts");
  let testDb: Awaited<ReturnType<typeof connectFinancialTestDatabase>> | undefined;
  try {
    testDb = await connectFinancialTestDatabase(process.env.MONGODB_TEST_URI!, guard.dbName);
  } catch (error) {
    const info = safeErrorInfo(error);
    console.error("[FAIL] MongoDB TEST connection");
    console.error(`Error: ${info.name}`);
    console.error(`Code: ${info.code}`);
    process.exitCode = 2;
    return;
  }
  console.log("[PASS] MongoDB TEST connected");

  const period = (process.argv.find((v) => v.startsWith("--period=")) || "--period=2026-05").slice(9);
  const storeId = Number(process.env.OLSERA_INTERNAL_STORE_ID);

  try {
    // 4) Baru import modul financial sync yang dibutuhkan (setelah koneksi TEST siap).
    const { startFinancialSync, stepFinancialSync } = await import("../lib/olsera-financial-sync.ts");

    // 5) Bersihkan HANYA data TEST milik storeId + period ini — tidak pernah
    // menghapus seluruh database atau menyentuh collection non-financial.
    await testDb.monthlyReports.deleteMany({ storeId, period });
    await testDb.accounts.deleteMany({ storeId });
    await testDb.ledgerEntries.deleteMany({ storeId, period });
    await testDb.syncLogs.deleteMany({ storeId, period });

    const [year, month] = period.split("-").map(Number);

    async function runSyncToCompletion() {
      let run = await startFinancialSync(year, month, testDb!);
      while (run.status === "running") run = await stepFinancialSync(run._id, testDb!);
      return run;
    }

    const firstRun = await runSyncToCompletion();
    assertMatch(firstRun.status === "success", `Sync pertama berstatus ${firstRun.status}, diharapkan success.`);
    console.log("[PASS] Financial sync completed");

    const reportsCount = await testDb.monthlyReports.countDocuments({ storeId, period });
    assertMatch(reportsCount === 4, `Monthly reports ${reportsCount}, diharapkan 4.`);
    console.log(`[PASS] Monthly reports: ${reportsCount}`);

    const accountCount = await testDb.accounts.countDocuments({ storeId });
    assertMatch(accountCount === 85, `Accounts ${accountCount}, diharapkan 85.`);
    console.log(`[PASS] Accounts: ${accountCount}`);

    const ledgerCount = await testDb.ledgerEntries.countDocuments({ storeId, period, accountCode: "11105" });
    assertMatch(ledgerCount === 91, `Ledger 11105 ${ledgerCount}, diharapkan 91.`);
    console.log(`[PASS] Ledger 11105: ${ledgerCount}`);

    const ledgerRows = await testDb.ledgerEntries.find({ storeId, period, accountCode: "11105" }).toArray();
    const openingRows = ledgerRows.filter((r: any) => r.isOpeningBalance).length;
    const transactionRows = ledgerRows.filter((r: any) => !r.isOpeningBalance).length;
    const debitSum = ledgerRows.reduce((sum: number, r: any) => sum + (Number(r.debit) || 0), 0);
    const creditSum = ledgerRows.reduce((sum: number, r: any) => sum + (Number(r.credit) || 0), 0);
    assertMatch(openingRows === 1, `Opening rows ${openingRows}, diharapkan 1.`);
    assertMatch(transactionRows === 90, `Transaction rows ${transactionRows}, diharapkan 90.`);
    assertMatch(approxEqual(debitSum, 370361513.75), `Debit ${debitSum}, diharapkan 370361513.75.`);
    assertMatch(approxEqual(creditSum, 120030000), `Credit ${creditSum}, diharapkan 120030000.`);
    assertMatch(approxEqual(debitSum - creditSum, 250331513.75), `Period movement ${debitSum - creditSum}, diharapkan 250331513.75.`);

    const bsDoc = await testDb.monthlyReports.findOne({ storeId, period, reportType: "balance-sheet" });
    const bsTotals = bsDoc?.normalizedPayload?.totals ?? {};
    assertMatch(
      approxEqual(bsTotals.totalAssets, 2519025675.61) &&
        approxEqual(bsTotals.totalLiabilityCapital, 2519025675.61) &&
        bsTotals.balanced === true,
      "Balance Sheet snapshot tidak sesuai target.",
    );
    console.log("[PASS] Balance Sheet snapshot");

    const plDoc = await testDb.monthlyReports.findOne({ storeId, period, reportType: "profit-loss" });
    const plTotals = plDoc?.normalizedPayload?.totals ?? {};
    assertMatch(
      approxEqual(plTotals.revenue, 351707500) &&
        approxEqual(plTotals.costOfGoodsSold, 42162139.51) &&
        approxEqual(plTotals.grossProfit, 309545360.49) &&
        approxEqual(plTotals.operatingExpenses, 178852843) &&
        approxEqual(plTotals.nonOperatingIncome, 77522.77) &&
        approxEqual(plTotals.nonOperatingExpenses, 1322013.02) &&
        approxEqual(plTotals.netProfit, 129448027.24),
      "Profit Loss snapshot tidak sesuai target.",
    );
    console.log("[PASS] Profit Loss snapshot");

    const cfDoc = await testDb.monthlyReports.findOne({ storeId, period, reportType: "cash-flow" });
    const cfTotals = cfDoc?.normalizedPayload?.totals ?? {};
    assertMatch(
      approxEqual(cfTotals.cashIncrease, 247222176.75) &&
        approxEqual(cfTotals.openingCash, 346987623.54) &&
        approxEqual(cfTotals.endingCash, 594209800.29),
      "Cash Flow snapshot tidak sesuai target.",
    );
    console.log("[PASS] Cash Flow snapshot");

    const lsDoc = await testDb.monthlyReports.findOne({ storeId, period, reportType: "ledger-summary" });
    assertMatch(Boolean(lsDoc), "Ledger Summary snapshot tidak ditemukan.");
    console.log("[PASS] Ledger Summary snapshot");

    const logDoc = await testDb.syncLogs.findOne({ _id: firstRun._id });
    assertMatch(
      Boolean(logDoc) && logDoc.status === "success" && logDoc.phase === "completed" && logDoc.errorMessage === null,
      "Sync log tidak sesuai target (status/phase/errorMessage).",
    );
    console.log("[PASS] Sync log completed");

    // Snapshot sebelum sync kedua, untuk verifikasi idempotensi.
    const monthlyReportsBefore = await testDb.monthlyReports.find({ storeId, period }).toArray();
    const accountsBefore = await testDb.accounts.find({ storeId }).toArray();
    const ledgerBefore = await testDb.ledgerEntries.find({ storeId, period }).toArray();

    // Sync kedua pada periode yang sama — createFinancialSyncRun meng-upsert _id
    // deterministik yang sama, jadi tidak perlu membersihkan apa pun sebelumnya.
    const secondRun = await runSyncToCompletion();
    assertMatch(secondRun.status === "success", `Sync kedua berstatus ${secondRun.status}, diharapkan success.`);

    const monthlyReportsAfter = await testDb.monthlyReports.find({ storeId, period }).toArray();
    const accountsAfter = await testDb.accounts.find({ storeId }).toArray();
    const ledgerAfter = await testDb.ledgerEntries.find({ storeId, period }).toArray();

    assertMatch(monthlyReportsAfter.length === 4, `Idempotensi: monthly reports jadi ${monthlyReportsAfter.length}, diharapkan tetap 4.`);
    assertMatch(accountsAfter.length === 85, `Idempotensi: accounts jadi ${accountsAfter.length}, diharapkan tetap 85.`);
    assertMatch(
      ledgerAfter.length === ledgerBefore.length,
      `Idempotensi: ledger entries jadi ${ledgerAfter.length}, sebelumnya ${ledgerBefore.length}, seharusnya tidak bertambah.`,
    );

    const idsBefore = new Set(monthlyReportsBefore.map((d: any) => d._id));
    const idsAfter = new Set(monthlyReportsAfter.map((d: any) => d._id));
    assertMatch(
      idsBefore.size === idsAfter.size && [...idsBefore].every((id) => idsAfter.has(id)),
      "Idempotensi: _id monthly reports berubah antar-run.",
    );
    assertMatch(idsAfter.size === monthlyReportsAfter.length, "Idempotensi: ditemukan _id duplikat pada monthly reports.");
    for (const before of monthlyReportsBefore) {
      const after = monthlyReportsAfter.find((d: any) => d._id === before._id);
      assertMatch(
        Boolean(after) && new Date(after.createdAt).getTime() === new Date(before.createdAt).getTime(),
        `Idempotensi: createdAt berubah untuk laporan ${before._id}.`,
      );
    }

    const accountIdsBefore = new Set(accountsBefore.map((d: any) => d._id));
    const accountIdsAfter = new Set(accountsAfter.map((d: any) => d._id));
    assertMatch(accountIdsAfter.size === accountsAfter.length, "Idempotensi: ditemukan _id duplikat pada accounts.");
    assertMatch(
      accountIdsBefore.size === accountIdsAfter.size && [...accountIdsBefore].every((id) => accountIdsAfter.has(id)),
      "Idempotensi: _id accounts berubah antar-run.",
    );

    console.log("[PASS] Idempotent second run");
    console.log("");
    console.log("Financial sync validation: PASSED");
  } catch (error) {
    console.error("[FAIL] Financial sync validation");
    if (error instanceof ValidationMismatchError) {
      console.error(error.message);
    } else {
      const info = safeErrorInfo(error);
      console.error(`Error: ${info.name}`);
      console.error(`Code: ${info.code}`);
    }
    process.exitCode = 1;
  } finally {
    if (testDb) await testDb.client.close();
  }
}

main().catch((error) => {
  const info = safeErrorInfo(error);
  console.error("[FAIL] Unexpected validator error");
  console.error(`Error: ${info.name}`);
  console.error(`Code: ${info.code}`);
  process.exitCode = 2;
});
