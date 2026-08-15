import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateFinancialAccounts, FINANCIAL_BASELINE_PERIOD, isCurrentJakartaPeriod, jakartaCurrentPeriod, mapFinancialError, normalizeBalanceSheetPayload, normalizeCashFlowPayload, normalizeLedgerDetailPayload, normalizeLedgerSummaryPayload, normalizeProfitLossPayload, parseFinancialAmount, previousFinancialPeriod, reconcileLedgerSummaryWithDetails, validatePeriod } from "./olsera-financial-core.ts";

test("financial parser handles Indonesian formats and nullish values", () => {
  assert.equal(parseFinancialAmount("IDR 15.000"), 15000);
  assert.equal(parseFinancialAmount("1.150.000,50"), 1150000.5);
  assert.equal(parseFinancialAmount("(1.322.013,02)"), -1322013.02);
  assert.equal(parseFinancialAmount("0,00"), 0);
  assert.equal(parseFinancialAmount(null), 0);
  assert.equal(parseFinancialAmount(undefined), 0);
  assert.equal(parseFinancialAmount(""), 0);
});

test("period validator accepts only digit strings", () => {
  assert.throws(() => validatePeriod("2026", "1"));
  assert.equal(validatePeriod("2026", "02"), "2026-02");
  assert.throws(() => validatePeriod("2026", "5.5"));
  assert.throws(() => validatePeriod("2026", "05abc"));
  assert.throws(() => validatePeriod("2026", "0"));
  assert.throws(() => validatePeriod("2026", "13"));
  assert.throws(() => validatePeriod("2026.0", "5"));
});

test("jakartaCurrentPeriod uses Asia/Jakarta, not server UTC", () => {
  // 17:00 UTC 31 Des = 00:00 WIB 1 Jan — sisi UTC belum ganti bulan, WIB sudah.
  assert.equal(jakartaCurrentPeriod(new Date("2025-12-31T16:59:00Z")), "2025-12");
  assert.equal(jakartaCurrentPeriod(new Date("2025-12-31T17:00:00Z")), "2026-01");
  assert.equal(jakartaCurrentPeriod(new Date("2026-01-01T10:00:00Z")), "2026-01");
});

// -----------------------------------------------------------------------
// Bug produksi cross-browser: input type="month" menampilkan value "07/2026"
// (ditolak browser, wajib "yyyy-MM") karena jakartaCurrentPeriod() dulu
// memformat langsung ke string lewat Intl.DateTimeFormat("en-CA", ...) dan
// mengandalkan URUTAN karakter hasilnya. Urutan "yyyy-MM" utk skeleton
// year+month (tanpa day) BUKAN jaminan CLDR pada locale "en-CA" — itu cuma
// kebetulan berlaku di satu versi ICU. Di ICU/browser lain skeleton yang
// sama merender "MM/yyyy". Tes di bawah membuktikan fungsi produksi SELALU
// "yyyy-MM" walau string mentah Intl utk skeleton yang sama terbukti salah
// urutan di lingkungan ICU ini — karena fungsi memilih part lewat `type`,
// bukan lewat posisi/urutan string.
// -----------------------------------------------------------------------
test("jakartaCurrentPeriod: Juli 2026 -> 'yyyy-MM' persis '2026-07', TIDAK PERNAH 'MM/YYYY' seperti '07/2026'", () => {
  const now = new Date("2026-07-15T03:00:00Z"); // pagi WIB pertengahan Juli, jauh dari batas hari
  const result = jakartaCurrentPeriod(now);
  assert.equal(result, "2026-07");
  assert.notEqual(result, "07/2026");
  assert.match(result, /^\d{4}-\d{2}$/);
});

test("jakartaCurrentPeriod: tidak bergantung pada urutan/locale Intl — string mentah format() utk skeleton year+month TERBUKTI 'MM/YYYY' pada ICU ini, tapi fungsi produksi tetap benar", () => {
  const now = new Date("2026-07-15T03:00:00Z");
  // Sanity check: ini justru MEMBUKTIKAN kenapa memformat langsung ke string
  // (mis. .format(now) atau toLocaleDateString) berbahaya sebagai value input
  // month — skeleton year+month (tanpa day) pada locale umum (en-US/id-ID,
  // dan pada ICU/browser lain juga en-CA) merender "MM/yyyy", bukan ISO.
  const rawEnUs = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" }).format(now);
  assert.equal(rawEnUs, "07/2026", "string mentah Intl (tanpa formatToParts) memang salah urutan di lingkungan ICU ini — inilah akar bug cross-browser");
  assert.equal(jakartaCurrentPeriod(now), "2026-07", "fungsi produksi memilih part lewat `type`, bukan posisi string, jadi tetap benar");
});

test("jakartaCurrentPeriod: seluruh transisi Feb->Mar->Apr->Mei->Jun->Jul 2026 selalu 'yyyy-MM', tidak pernah mengandung '/'", () => {
  const sequence: Array<[string, number, number]> = [
    ["2026-02", 2026, 2],
    ["2026-03", 2026, 3],
    ["2026-04", 2026, 4],
    ["2026-05", 2026, 5],
    ["2026-06", 2026, 6],
    ["2026-07", 2026, 7],
  ];
  for (const [expected, year, month] of sequence) {
    const now = new Date(Date.UTC(year, month - 1, 15, 3, 0, 0)); // tengah bulan, pagi WIB
    const result = jakartaCurrentPeriod(now);
    assert.equal(result, expected);
    assert.doesNotMatch(result, /\//, `periode ${result} tidak boleh berformat MM/YYYY (mengandung '/')`);
  }
});

test("isCurrentJakartaPeriod: bulan berjalan vs bulan sebelumnya, termasuk pergantian tahun Desember->Januari", () => {
  const rolloverNow = new Date("2025-12-31T17:05:00Z"); // 00:05 WIB 1 Jan 2026
  assert.equal(isCurrentJakartaPeriod("2026-01", rolloverNow), true);
  assert.equal(isCurrentJakartaPeriod("2025-12", rolloverNow), false);

  const midMonthNow = new Date("2026-05-15T04:00:00Z"); // 11:00 WIB
  assert.equal(isCurrentJakartaPeriod("2026-05", midMonthNow), true);
  assert.equal(isCurrentJakartaPeriod("2026-04", midMonthNow), false);
  assert.equal(isCurrentJakartaPeriod("2026-06", midMonthNow), false);
});

test("account deduplication preserves distinct accounts and empty objects", () => {
  const result = deduplicateFinancialAccounts(
    [{ account_id: "1", account_name: "Kas" }, {}, { account_no: "1102", account_name: "Kas" }],
    [{ account_id: "1", account_name: "Kas" }, {}, { account_no: "1103", account_name: "Kas" }],
  );
  assert.equal(result.length, 4);
  assert.deepEqual(result[0], { account_id: "1", account_name: "Kas" });
  assert.deepEqual(result[1], {});
  assert.deepEqual(result[2], { account_no: "1102", account_name: "Kas" });
  assert.deepEqual(result[3], { account_no: "1103", account_name: "Kas" });
});

test("balance sheet production normalizer validates May 2026 fixture", () => {
  const normalized = normalizeBalanceSheetPayload({ assets: { famount: "2.519.025.675,61", children: [{ name: "Kas", account_code: "1101", famount: "15.000" }] }, liability_capital: { famount: "2.519.025.675,61", children: [{ name: "Modal", account_code: "3001", famount: "2.519.010.675,61" }] }, ignored: { int_amount: 1 } });
  assert.equal(normalized.totals.totalAssets, 2519025675.61);
  assert.equal(normalized.totals.totalLiabilityCapital, 2519025675.61);
  assert.equal(normalized.totals.balanced, true);
  assert.equal(normalized.totals.difference, 0);
  assert.equal(normalized.assets.children[0].amount, 15000);
});

test("profit loss production normalizer validates May 2026 fixture", () => {
  const normalized = normalizeProfitLossPayload({ operasional: { pendapatan: { famount: "351.707.500,00" }, hpp: { famount: "42.162.139,51" }, laba_kotor: { famount: "309.545.360,49" }, biaya_operasional: { famount: "178.852.843,00" } }, pendapatan_non_operasional: { famount: "77.522,77" }, biaya_non_operasional: { famount: "1.322.013,02" }, laba_bersih: { famount: "129.448.027,24" } });
  assert.equal(normalized.totals.revenue, 351707500);
  assert.equal(normalized.totals.costOfGoodsSold, 42162139.51);
  assert.equal(normalized.totals.grossProfit, 309545360.49);
  assert.equal(normalized.totals.operatingExpenses, 178852843);
  assert.equal(normalized.totals.nonOperatingIncome, 77522.77);
  assert.equal(normalized.totals.nonOperatingExpenses, 1322013.02);
  assert.equal(normalized.totals.netProfit, 129448027.24);
  assert.equal(normalized.totals.grossProfitValid, true);
  assert.equal(normalized.totals.netProfitValid, true);
});

test("upstream errors map to safe statuses", () => { assert.equal(mapFinancialError(401).status, "connection-expired"); assert.equal(mapFinancialError(403).status, "connection-expired"); assert.equal(mapFinancialError(404).status, "no-data"); assert.equal(mapFinancialError(408).status, "upstream-error"); assert.equal(mapFinancialError(429).status, "upstream-error"); assert.equal(mapFinancialError(500).status, "upstream-error"); });

test("cash flow production normalizer validates May 2026 fixture", () => {
  const normalized = normalizeCashFlowPayload({ operational: { famount: "252.572.176,75", children: [{ group: "Kas Operasional", famount: "252.572.176,75" }] }, investasi: { famount: "(5.350.000,00)" }, funding: { famount: "0,00" }, cash_increase: { famount: "247.222.176,75" }, first_cash: { famount: "346.987.623,54" }, end_cash: { famount: "594.209.800,29" } });
  assert.equal(normalized.totals.operational, 252572176.75); assert.equal(normalized.totals.investing, -5350000); assert.equal(normalized.totals.funding, 0); assert.equal(normalized.totals.cashIncrease, 247222176.75); assert.equal(normalized.totals.openingCash, 346987623.54); assert.equal(normalized.totals.endingCash, 594209800.29); assert.equal(normalized.totals.activityTotalValid, true); assert.equal(normalized.totals.endingCashValid, true); assert.equal(normalized.operational.children[0].amount, 252572176.75);
});

test("ledger normalizer handles numeric object keys, preserves zero rows and precision", () => {
  const rows = normalizeLedgerSummaryPayload({ "0": { account_id: 11105, account_code: "11105", account_name: "BANK BCA 7195-332266", fdebit: "370.361.513,75", fcredit: "120.030.000,00", famount: "250.331.513,75", int_amount: 1 }, "1": { account_code: "20001", account_name: "Zero", fdebit: "0,00", fcredit: "0,00", famount: "0,00" }, meta: { total: 85 } });
  assert.equal(rows.length, 2); assert.equal(rows[0].accountCode, "11105"); assert.equal(rows[0].debit, 370361513.75); assert.equal(rows[0].credit, 120030000); assert.equal(rows[0].balance, 250331513.75); assert.equal(rows[1].balance, 0); assert.equal((rows[0] as { int_amount?: unknown }).int_amount, undefined);
});

test("ledger summary reconciliation keeps 11105 decimals from detail and does not round", () => {
  const summary = normalizeLedgerSummaryPayload({
    "0": { account_code: "11105", account_name: "BANK BCA 7195-332266", fdebit: "370.361.514", fcredit: "120.030.000", famount: "250.331.513,75" },
  });
  const reconciled = reconcileLedgerSummaryWithDetails(summary, [
    { accountCode: "11105", debit: 370361513.75, credit: 120030000, isOpeningBalance: false },
  ]);
  assert.equal(reconciled[0].debit, 370361513.75);
  assert.equal(reconciled[0].credit, 120030000);
  assert.equal(reconciled[0].balance, 250331513.75);
  assert.equal(reconciled[0].formattedDebit, "370361513.75");
});

test("ledger summary reconciliation derives closing balance from detail for accounts without opening balance", () => {
  const summary = normalizeLedgerSummaryPayload({
    "0": { account_code: "50000", account_name: "Pembelian", fdebit: "0", fcredit: "21.890.500", famount: "(21.890.500)" },
    "1": { account_code: "51000", account_name: "Harga pokok penjualan", fdebit: "20.614.924", fcredit: "1.275.576", famount: "21.890.500" },
  });
  const reconciled = reconcileLedgerSummaryWithDetails(summary, [
    { accountCode: "50000", debit: 21890500, credit: 21890500, balance: -21890500, isOpeningBalance: false },
    { accountCode: "51000", debit: 20614923.86, credit: 20614923.86, balance: 1275576.14, isOpeningBalance: false },
  ]);
  assert.deepEqual(reconciled.map((row) => [row.debit, row.credit, row.balance]), [[21890500, 21890500, 0], [20614923.86, 20614923.86, 0]]);
});

test("ledger summary reconciliation preserves opening balance and applies net movement", () => {
  const summary = normalizeLedgerSummaryPayload({ "0": { account_code: "11105", fdebit: "0", fcredit: "0", famount: "1.000" } });
  const reconciled = reconcileLedgerSummaryWithDetails(summary, [
    { accountCode: "11105", debit: 0, credit: 0, balance: 1000, isOpeningBalance: true },
    { accountCode: "11105", debit: 200, credit: 50, balance: 1150, isOpeningBalance: false },
  ]);
  assert.equal(reconciled[0].balance, 1150);
});

test("ledger detail normalizer detects opening balance and excludes it from movement totals", () => {
  const transactions = Array.from({ length: 90 }, (_, index) => ({ transaction_date: `2026-05-${String(Math.min(index + 1, 31)).padStart(2, "0")}`, transaction_no: `JU2605${String(index).padStart(8, "0")}`, transaction_description: "Transaksi", fdebit: index === 0 ? "370.361.513,75" : "0,00", fcredit: index === 0 ? "120.030.000,00" : "0,00", famount: index === 89 ? "250.331.513,75" : "1.000,00" }));
  const normalized = normalizeLedgerDetailPayload({ data: [{ transaction_description: "Saldo awal", fdebit: "999,00", fcredit: "999,00", famount: "0,00" }, ...transactions] }, "11105");
  assert.equal(normalized.totalRecords, 91); assert.equal(normalized.entries.filter((entry) => entry.isOpeningBalance).length, 1); assert.equal(normalized.totalDebit, 370361513.75); assert.equal(normalized.totalCredit, 120030000); assert.equal(normalized.entries[1].transactionNo?.startsWith("JU"), true); assert.equal(normalized.entries[1].description, "Transaksi");
});

test("ledger detail normalizer preserves negative credit sign (reversal entries)", () => {
  const normalized = normalizeLedgerDetailPayload({ data: [
    { transaction_date: "2026-05-10", transaction_no: "PB260500001", transaction_description: "Pembelian PT LIM SIANG HUAT", fdebit: "0,00", fcredit: "162.000,00", famount: "162.000,00" },
    { transaction_date: "2026-05-31", transaction_no: "CL26062100001341", transaction_description: "Transaksi tutup buku", fdebit: "0,00", fcredit: "-162.000,00", famount: "0,00" },
  ] }, "50500");
  assert.equal(normalized.entries[0].credit, 162000);
  assert.equal(normalized.entries[1].credit, -162000);
  assert.equal(normalized.totalCredit, 0);
  assert.equal(normalized.totalDebit, 0);
  assert.equal(normalized.calculatedClosingBalance, 0);
});

test("ledger detail normalizer preserves negative debit sign", () => {
  const normalized = normalizeLedgerDetailPayload({ data: [
    { transaction_date: "2026-05-05", transaction_no: "JU2605000001", transaction_description: "Transaksi", fdebit: "100.000,00", fcredit: "0,00", famount: "100.000,00" },
    { transaction_date: "2026-05-06", transaction_no: "JU2605000002", transaction_description: "Koreksi", fdebit: "-100.000,00", fcredit: "0,00", famount: "0,00" },
  ] }, "50500");
  assert.equal(normalized.entries[0].debit, 100000);
  assert.equal(normalized.entries[1].debit, -100000);
  assert.equal(normalized.totalDebit, 0);
});

test("ledger detail normalizer: reversal entry does not double an account with no other movement", () => {
  const normalized = normalizeLedgerDetailPayload({ data: [
    { transaction_date: "2026-05-31", transaction_no: "CL26062100001341", transaction_description: "Transaksi tutup buku", fdebit: "0,00", fcredit: "-500.000,00", famount: "0,00" },
  ] }, "50500");
  assert.equal(normalized.totalCredit, -500000);
  assert.notEqual(Math.abs(normalized.totalCredit), 1000000);
});

test("ledger detail normalizer: normal account without reversal is unchanged by the fix", () => {
  const transactions = Array.from({ length: 90 }, (_, index) => ({ transaction_date: `2026-05-${String(Math.min(index + 1, 31)).padStart(2, "0")}`, transaction_no: `JU2605${String(index).padStart(8, "0")}`, transaction_description: "Transaksi", fdebit: index === 0 ? "370.361.513,75" : "0,00", fcredit: index === 0 ? "120.030.000,00" : "0,00", famount: index === 89 ? "250.331.513,75" : "1.000,00" }));
  const normalized = normalizeLedgerDetailPayload({ data: transactions }, "11105");
  assert.equal(normalized.totalDebit, 370361513.75);
  assert.equal(normalized.totalCredit, 120030000);
  assert.equal(normalized.calculatedClosingBalance, 250331513.75);
});

// ---- Phase 3B: previousFinancialPeriod (jendela cron current+previous) ----

test("previousFinancialPeriod: bulan biasa mundur satu bulan", () => {
  assert.equal(previousFinancialPeriod("2026-08"), "2026-07");
  assert.equal(previousFinancialPeriod("2026-03"), "2026-02");
});

test("previousFinancialPeriod: lintas tahun (Januari -> Desember tahun sebelumnya)", () => {
  assert.equal(previousFinancialPeriod("2027-01"), "2026-12");
});

test("previousFinancialPeriod: pada/​sebelum FINANCIAL_BASELINE_PERIOD -> null (tidak ada bulan valid sebelumnya)", () => {
  assert.equal(previousFinancialPeriod(FINANCIAL_BASELINE_PERIOD), null);
  assert.equal(previousFinancialPeriod("2026-02"), null);
});

// ---- Phase 3B: response kosong/tidak lengkap HARUS gagal (bukan disimpan sebagai laporan 0) ----

test("normalizeProfitLossPayload: raw payload null/undefined/{}/[] -> throw (bukan laporan kosong senyap)", () => {
  assert.throws(() => normalizeProfitLossPayload(null));
  assert.throws(() => normalizeProfitLossPayload(undefined));
  assert.throws(() => normalizeProfitLossPayload({}));
  assert.throws(() => normalizeProfitLossPayload([]));
});

test("normalizeCashFlowPayload: raw payload kosong -> throw", () => {
  assert.throws(() => normalizeCashFlowPayload(null));
  assert.throws(() => normalizeCashFlowPayload({}));
});

test("normalizeLedgerSummaryPayload: raw payload kosong -> throw", () => {
  assert.throws(() => normalizeLedgerSummaryPayload(null));
  assert.throws(() => normalizeLedgerSummaryPayload({}));
});

test("normalizeBalanceSheetPayload: raw payload kosong -> tetap throw (perilaku existing, sudah benar sebelum Phase 3B)", () => {
  assert.throws(() => normalizeBalanceSheetPayload({}));
  assert.throws(() => normalizeBalanceSheetPayload(null));
});

test("normalizeProfitLossPayload: response LENGKAP tapi gagal validasi bisnis (laba kotor tidak cocok) TETAP dinormalisasi, TIDAK throw — beda dari struktur kosong", () => {
  const normalized = normalizeProfitLossPayload({
    operasional: { pendapatan: { famount: "100.000" }, hpp: { famount: "20.000" }, laba_kotor: { famount: "999.000" }, biaya_operasional: { famount: "0" } },
    laba_bersih: { famount: "0" },
  });
  assert.equal(normalized.totals.grossProfitValid, false); // gagal validasi bisnis, BUKAN struktur kosong
  assert.equal(normalized.totals.revenue, 100000); // tetap dinormalisasi, angka source apa adanya
});
