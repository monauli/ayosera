// Test unit Export Laporan Keuangan (Tahap 4C) — murni, tanpa MongoDB/Olsera.
// Memakai fixture angka nyata laporan resmi Olsera Mei 2026 (doc export/*.pdf).
// Jalankan: npm run test:olsera-financial-export
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { inflateSync } from "node:zlib";
import {
  buildBalanceSheetLines,
  buildCashFlowLines,
  buildLedgerAccountDetail,
  buildLedgerDetailGroups,
  buildLedgerSummaryRows,
  computeRunningLedgerBalances,
  type RunningLedgerRow,
  buildProfitLossLines,
  decodeFinancialHtmlEntities,
  draftReportNotice,
  filterZeroLedgerSummaryRows,
  filterZeroStatementLines,
  financialExportFileName,
  financialLedgerAccountExportFileName,
  formatAccountingID,
  formatJakartaDateTime,
  formatPeriodDateRangeEN,
  formatPeriodLabelID,
  isFinancialReportKind,
  ledgerMovementForDisplay,
  sanitizeForFileName,
  splitPeriod,
  type BalanceSheetPayload,
  type CashFlowPayload,
  type LedgerEntryInput,
  type LedgerSummaryRow,
  type ProfitLossPayload,
  type StatementLine,
} from "./olsera-financial-export-core.ts";
import { buildFinancialWorkbook, buildLedgerAccountWorkbook } from "./olsera-financial-excel.ts";
import {
  renderArusKasPdf,
  renderBukuBesarDetailPdf,
  renderLabaRugiPdf,
  renderLedgerAccountDetailPdf,
  renderNeracaPdf,
  renderRingkasanBukuBesarPdf,
  PDF_REPORT_LAYOUT,
  normalizePdfText,
  wrapPdfText,
} from "./olsera-financial-pdf.ts";

function pdfContainsText(bytes: Uint8Array, value: string): boolean {
  const source = Buffer.from(bytes);
  const wanted = Buffer.from(value, "latin1").toString("hex").toUpperCase();
  let offset = 0;
  while (true) {
    const streamStart = source.indexOf(Buffer.from("stream\n"), offset);
    if (streamStart < 0) return false;
    const streamEnd = source.indexOf(Buffer.from("\nendstream"), streamStart);
    if (streamEnd < 0) return false;
    try {
      const decoded = inflateSync(source.subarray(streamStart + 7, streamEnd)).toString("latin1").toUpperCase();
      if (decoded.includes(wanted)) return true;
    } catch {
      // Non-content streams are ignored.
    }
    offset = streamEnd + 10;
  }
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// ---- Fixture Mei 2026 (subset akun, total sesuai laporan resmi) ------------

const BALANCE_SHEET: BalanceSheetPayload = {
  assets: {
    amount: 2519025675.61,
    children: [
      {
        name: "Aset Lancar",
        amount: 2489469165.61,
        children: [
          { name: "Kas", accountCode: "11101", amount: 0 },
          { name: "BANK BCA 7195-332266", accountCode: "11105", amount: 571554462.38 },
          { name: "Persediaan barang dagang", accountCode: "11400", amount: 91408341.32 },
        ],
      },
      {
        name: "Aset Tidak Lancar",
        amount: 29556510,
        children: [
          { name: "Aset Tetap", accountCode: "12000", amount: 30613364 },
          { name: "Akumulasi penyusutan aset tetap", accountCode: "14000", amount: -1056854 },
        ],
      },
    ],
  },
  liabilityCapital: {
    amount: 2519025675.61,
    children: [
      {
        name: "Kewajiban",
        amount: 215143780,
        children: [{ name: "Hutang dagang", accountCode: "21000", amount: 12944548 }],
      },
      {
        name: "Modal",
        amount: 2303881895.61,
        children: [
          { name: "Modal", accountCode: "31000", amount: 2000000000 },
          { name: "Pendapatan periode ini", accountCode: null, amount: 0 },
        ],
      },
    ],
  },
  totals: { totalAssets: 2519025675.61, totalLiabilityCapital: 2519025675.61, balanced: true, difference: 0 },
};

const PROFIT_LOSS: ProfitLossPayload = {
  revenue: { amount: 351707500, children: [{ name: "Penjualan", accountCode: "40000", amount: 33230000 }] },
  costOfGoodsSold: { amount: 42162139.51, children: [{ name: "Harga pokok penjualan", accountCode: "51000", amount: 17685139.51 }] },
  grossProfit: { amount: 309545360.49, children: [] },
  operatingExpenses: { amount: 178852843, children: [{ name: "Biaya Sewa", accountCode: "60002", amount: 45000000 }] },
  nonOperatingIncome: { amount: 77522.77, children: [{ name: "Pendapatan lain lain", accountCode: "70000", amount: 77522.77 }] },
  nonOperatingExpenses: { amount: 1322013.02, children: [{ name: "Biaya Administrasi Bank", accountCode: "80001", amount: 1322013.02 }] },
  netProfit: { amount: 129448027.24, children: [] },
  totals: {
    revenue: 351707500,
    costOfGoodsSold: 42162139.51,
    grossProfit: 309545360.49,
    operatingExpenses: 178852843,
    nonOperatingIncome: 77522.77,
    nonOperatingExpenses: 1322013.02,
    netProfit: 129448027.24,
  },
};

const CASH_FLOW: CashFlowPayload = {
  operational: { amount: 252572176.75, children: [{ name: "Penerimaan dari pelanggan", amount: 371942500 }] },
  investing: { amount: -5350000, children: [{ name: "Pendapatan/pembelian aset tetap", amount: -5350000 }] },
  funding: { amount: 0, children: [{ name: "Pembayaran/penerimaan pinjaman", amount: 0 }] },
  cashIncrease: { amount: 247222176.75, children: [] },
  openingCash: { amount: 346987623.54, children: [] },
  endingCash: { amount: 594209800.29, children: [] },
  totals: {
    operational: 252572176.75,
    investing: -5350000,
    funding: 0,
    cashIncrease: 247222176.75,
    openingCash: 346987623.54,
    endingCash: 594209800.29,
  },
};

const LEDGER_SUMMARY = [
  { accountCode: "11101", accountName: "Kas", classification: "Kas & Bank", debit: 0, credit: 0, balance: 0 },
  { accountCode: "11105", accountName: "BANK BCA 7195-332266", classification: "Kas & Bank", debit: 370361513.75, credit: 120030000, balance: 250331513.75 },
  { accountCode: "33000", accountName: "Laba rugi ditahan", classification: "Ekuitas", debit: -222336996, credit: 351785023, balance: 129448027.24 },
];

function makeLedgerEntries(): LedgerEntryInput[] {
  const entries: LedgerEntryInput[] = [];
  for (const [code, name] of [["11105", "BANK BCA 7195-332266"], ["40001", "Pendapatan Court Fees"], ["51000", "Harga pokok penjualan"]] as const) {
    entries.push({ accountCode: code, accountName: name, isOpeningBalance: true, description: "Saldo awal", debit: 0, credit: 0, balance: 1000000 });
    for (let i = 0; i < 150; i++) {
      entries.push({
        accountCode: code,
        accountName: name,
        transactionDate: `2026-05-${String((i % 31) + 1).padStart(2, "0")}`,
        formattedTransactionDate: `${String((i % 31) + 1).padStart(2, "0")} May 2026`,
        transactionNo: `JU2605${code}${String(i).padStart(4, "0")}`,
        description: "Transaksi harian penjualan lapangan padel",
        debit: i % 2 === 0 ? 500000 : 0,
        credit: i % 2 === 0 ? 0 : 300000,
        // famount = pergerakan BERTANDA baris itu, seperti yang benar-benar
        // dikirim Olsera (dulu fixture ini memakai angka karangan
        // 1000000 + i*1000 untuk membuktikan famount diabaikan). Ketiga akun
        // di fixture ini dimodelkan debit-normal; cakupan tanda kredit-normal
        // ada di test regresi data nyata Feb 2026 di bawah.
        balance: i % 2 === 0 ? 500000 : -300000,
        isOpeningBalance: false,
      });
    }
  }
  return entries;
}

function lastTotal(lines: StatementLine[], label: string): StatementLine {
  const found = [...lines].reverse().find((l) => l.label === label);
  assert.ok(found, `baris "${label}" harus ada`);
  return found!;
}

// ---- Format & nama file ----------------------------------------------------

test("formatAccountingID: ribuan titik, desimal koma, negatif dalam kurung", () => {
  assert.equal(formatAccountingID(2519025675.61), "2.519.025.675,61");
  assert.equal(formatAccountingID(-1056854), "(1.056.854,00)");
  assert.equal(formatAccountingID(0), "0,00");
  assert.equal(formatAccountingID(null), "");
  assert.equal(formatAccountingID(370361513.75, 0), "370.361.514");
});

test("label periode Indonesia & rentang tanggal arus kas", () => {
  assert.equal(formatPeriodLabelID("2026-05"), "Mei 2026");
  assert.equal(formatPeriodDateRangeEN("2026-05"), "01 May 2026 - 31 May 2026");
  assert.equal(formatPeriodDateRangeEN("2026-02"), "01 Feb 2026 - 28 Feb 2026");
});

test("validasi periode & nama file", () => {
  assert.throws(() => splitPeriod("2026-13"));
  assert.throws(() => splitPeriod("bukan-periode"));
  assert.deepEqual(splitPeriod("2026-05"), { year: 2026, month: 5 });
  assert.equal(financialExportFileName("excel", "2026-05"), "laporan-keuangan-2026-05.xlsx");
  assert.equal(financialExportFileName("neraca", "2026-05"), "neraca-2026-05.pdf");
  assert.equal(financialExportFileName("buku-besar-detail", "2026-05"), "buku-besar-detail-2026-05.pdf");
  assert.equal(isFinancialReportKind("neraca"), true);
  assert.equal(isFinancialReportKind("tidak-ada"), false);
});

// ---- Status "bulan berjalan / belum final" ---------------------------------

test("draftReportNotice: bulan berjalan menampilkan DRAFT + tanggal sinkron, bulan sebelumnya tidak", () => {
  const now = new Date("2026-05-15T04:00:00Z"); // 11:00 WIB, periode berjalan = 2026-05
  const current = draftReportNotice("2026-05", "2026-05-14T20:00:00Z", now);
  assert.equal(current.isDraft, true);
  assert.equal(current.label, "DRAFT / BELUM FINAL");
  assert.ok(current.detail.includes("Data sementara sampai tanggal sinkron terakhir"));

  const previous = draftReportNotice("2026-04", "2026-04-30T20:00:00Z", now);
  assert.equal(previous.isDraft, false);
  assert.equal(previous.label, "");
  assert.equal(previous.detail, "");
});

test("draftReportNotice: pergantian tahun Desember -> Januari dihitung dari Asia/Jakarta", () => {
  const rolloverNow = new Date("2025-12-31T17:05:00Z"); // 00:05 WIB 1 Jan 2026
  assert.equal(draftReportNotice("2026-01", null, rolloverNow).isDraft, true);
  assert.equal(draftReportNotice("2025-12", null, rolloverNow).isDraft, false);
});

test("draftReportNotice: tanpa sinkron menampilkan keterangan aman, bukan crash", () => {
  const now = new Date("2026-05-15T04:00:00Z");
  const notice = draftReportNotice("2026-05", null, now);
  assert.ok(notice.detail.includes("belum pernah sinkron"));
  assert.equal(formatJakartaDateTime(null), "belum pernah sinkron");
  assert.equal(formatJakartaDateTime("not-a-date"), "belum pernah sinkron");
});

test("PDF & Excel bulan berjalan menampilkan label DRAFT, bulan lama (Mei 2026) tidak berubah", async () => {
  const now = new Date("2026-05-15T04:00:00Z");
  const currentPeriod = "2026-05";
  const lastSynced = "2026-05-14T20:00:00Z";

  // Laporan "lama" (tanpa lastSyncedAt eksplisit dan bukan bulan berjalan pada
  // waktu nyata pengujian) TIDAK boleh membawa label DRAFT — angka/tampilan lama tetap.
  const oldPdf = await renderNeracaPdf("BC PADEL CLUB", "2026-05", BALANCE_SHEET);
  assert.equal(pdfContainsText(oldPdf, "DRAFT / BELUM FINAL"), false);

  const oldWorkbook = buildFinancialWorkbook({
    period: "2026-05",
    companyName: "BC PADEL CLUB",
    balanceSheet: BALANCE_SHEET,
    profitLoss: PROFIT_LOSS,
    cashFlow: CASH_FLOW,
    ledgerSummary: LEDGER_SUMMARY,
    ledgerEntries: [],
  });
  let oldHasDraftCell = false;
  oldWorkbook.getWorksheet("Neraca")!.eachRow((row) => {
    if (String(row.getCell(1).value ?? "").includes("DRAFT")) oldHasDraftCell = true;
  });
  assert.equal(oldHasDraftCell, false);

  assert.equal(draftReportNotice(currentPeriod, lastSynced, now).isDraft, true);
});

test("PDF & Excel menampilkan label DRAFT saat periode = bulan berjalan sungguhan", async () => {
  const { jakartaCurrentPeriod } = await import("./olsera-financial-core.ts");
  const currentPeriod = jakartaCurrentPeriod();

  const draftPdf = await renderNeracaPdf("BC PADEL CLUB", currentPeriod, BALANCE_SHEET, new Date().toISOString());
  assert.equal(pdfContainsText(draftPdf, "DRAFT / BELUM FINAL"), true);

  const draftWorkbook = buildFinancialWorkbook({
    period: currentPeriod,
    companyName: "BC PADEL CLUB",
    balanceSheet: BALANCE_SHEET,
    profitLoss: PROFIT_LOSS,
    cashFlow: CASH_FLOW,
    ledgerSummary: LEDGER_SUMMARY,
    ledgerEntries: [],
    lastSyncedAt: new Date().toISOString(),
  });
  let hasDraftCell = false;
  draftWorkbook.getWorksheet("Neraca")!.eachRow((row) => {
    if (String(row.getCell(1).value ?? "").includes("DRAFT")) hasDraftCell = true;
  });
  assert.equal(hasDraftCell, true);
});

// ---- Angka total utama sesuai snapshot Mei 2026 ----------------------------

test("Neraca: Total Aset = Total Kewajiban dan Modal (seimbang)", () => {
  const lines = buildBalanceSheetLines(BALANCE_SHEET);
  const totalAset = lastTotal(lines, "Total Aset");
  const totalKM = lastTotal(lines, "Total Kewajiban dan Modal");
  assert.equal(totalAset.amount, 2519025675.61);
  assert.equal(totalKM.amount, 2519025675.61);
  assert.equal(totalAset.amount, totalKM.amount);
  // Grup + akun ikut terangkat (mis. Aset Lancar dengan subtotalnya).
  assert.ok(lines.some((l) => l.kind === "group" && l.label === "Aset Lancar"));
  assert.ok(lines.some((l) => l.kind === "account" && l.code === "11105"));
  assert.ok(lines.some((l) => l.kind === "subtotal" && l.label === "Total Aset Lancar" && l.amount === 2489469165.61));
});

test("Laba Rugi: Laba bersih sesuai snapshot", () => {
  const lines = buildProfitLossLines(PROFIT_LOSS);
  assert.equal(lastTotal(lines, "Laba bersih").amount, 129448027.24);
  assert.equal(lastTotal(lines, "Laba kotor").amount, 309545360.49);
  assert.equal(lastTotal(lines, "Total Pendapatan").amount, 351707500);
});

test("Arus Kas: Saldo kas akhir sesuai snapshot", () => {
  const lines = buildCashFlowLines(CASH_FLOW);
  assert.equal(lastTotal(lines, "Saldo kas akhir").amount, 594209800.29);
  assert.equal(lastTotal(lines, "Total Aktivitas operasional").amount, 252572176.75);
  assert.equal(lastTotal(lines, "Total Aktivitas Investasi").amount, -5350000);
});

test("Ringkasan Buku Besar: baris & pergerakan terjaga", () => {
  const rows = buildLedgerSummaryRows(LEDGER_SUMMARY);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].hasMovement, false); // 11101 semua nol
  assert.equal(rows[1].balance, 250331513.75);
  assert.equal(rows[1].debit, 370361513.75);
  assert.equal(rows[1].credit, 120030000);
  assert.equal(formatAccountingID(rows[1].debit), "370.361.513,75");
  assert.equal(formatAccountingID(rows[1].credit), "120.030.000,00");
  assert.equal(rows[2].balance, 129448027.24);
});

test("entity HTML didecode sekali untuk PDF dan Excel tanpa recursive decode", () => {
  assert.equal(decodeFinancialHtmlEntities("April&#039;26 &amp; Mei&#039;26"), "April'26 & Mei'26");
  assert.equal(decodeFinancialHtmlEntities("&amp;#039;"), "&#039;");
  const groups = buildLedgerDetailGroups([{ accountCode: "11105", formattedTransactionDate: "April&#039;26", description: "Kas &amp; Bank &quot;BCA&quot;", debit: 1, credit: 0 }]);
  assert.equal(groups[0].entries[0].date, "April'26");
  assert.equal(groups[0].entries[0].description, 'Kas & Bank "BCA"');
});

// ---- Buku Besar Detail: TIDAK terpotong pagination -------------------------

test("Buku Besar Detail: seluruh baris dikelompokkan per akun, tidak ada yang hilang", () => {
  const entries = makeLedgerEntries();
  const groups = buildLedgerDetailGroups(entries);
  assert.equal(groups.length, 3);
  const totalRows = groups.reduce((sum, g) => sum + g.entries.length, 0);
  assert.equal(totalRows, entries.length); // 3 * (1 opening + 150) = 453
  for (const group of groups) {
    // Saldo awal tidak ikut total pergerakan.
    const movementRows = group.entries.filter((e) => !e.isOpeningBalance);
    const expectedDebit = movementRows.reduce((s, e) => s + e.debit, 0);
    assert.equal(group.totalDebit, expectedDebit);
    assert.equal(group.entries[0].isOpeningBalance, true);
  }
});

// ---- Phase 5B P0 regresi: kolom Saldo HARUS running balance, bukan famount --
// mentah per baris. Bukti produksi: akun BANK BCA 7195-332266, periode
// 2026-07, Saldo Awal Rp556.986.758,71, transaksi pertama Debit
// Rp2.011.818,00 — UI menampilkan Saldo Rp2.011.818,00 (movement baris itu
// sendiri), padahal seharusnya Rp558.998.576,71 (running balance). Fixture di
// bawah memakai contoh produksi HANYA untuk regresi test — logika produksi
// (computeRunningLedgerBalances/buildLedgerDetailGroups/buildLedgerAccountDetail)
// TIDAK mengandung rule khusus akun apa pun (diverifikasi juga oleh test kode
// akun generik lain di file ini).

// Test "Phase 5B P0 fix" di bawah ini DIPERBARUI (bukan dihapus): akumulasi
// pindah dari Σ(debit-kredit) ke Σ famount. Alasannya, famount memang BUKAN
// saldo kumulatif — kesimpulan Phase 5B itu benar — tapi MENJUMLAHKANNYA benar,
// dan hanya itu yang memberi tanda sama dengan Olsera untuk akun kredit-normal.
// Σ(debit-kredit) membalik tanda akun 2xxxx/3xxxx/4xxxx/7xxxx, dan bila akun
// tsb punya saldo awal hasilnya rusak (seed konvensi Olsera + akumulasi
// konvensi debit-normal). Terverifikasi 77.449 baris tersimpan: famount tiap
// baris = debit-kredit (debit-normal) atau kredit-debit (kredit-normal), nol
// pengecualian — sehingga akun debit-normal tetap menghasilkan angka IDENTIK.

test("computeRunningLedgerBalances: saldo awal menjadi seed, famount diakumulasi (akun debit-normal identik dengan formula lama debit - kredit)", () => {
  // famount diisi sesuai konvensi Olsera untuk akun debit-normal: debit - kredit.
  const rows = computeRunningLedgerBalances<RunningLedgerRow>([
    { isOpeningBalance: true, debit: 0, credit: 0, balance: 556986758.71 },
    { isOpeningBalance: false, debit: 2011818.0, credit: 0, balance: 2011818.0 },
    { isOpeningBalance: false, debit: 0, credit: 500000, balance: -500000 },
    { isOpeningBalance: false, debit: 1000, credit: 0, balance: 1000 },
  ]);
  assert.equal(rows[0].balance, 556986758.71); // Saldo Awal tidak berubah
  assert.equal(rows[1].balance, 558998576.71); // angka regresi PRD persis — TIDAK berubah oleh perubahan ini
  assert.equal(rows[2].balance, 558498576.71); // famount negatif MENGURANGI saldo
  assert.equal(rows[3].balance, 558499576.71); // tetap kumulatif dari baris sebelumnya
});

test("computeRunningLedgerBalances: akun kredit-normal memakai tanda Olsera (famount kredit POSITIF) — inilah yang dulu terbalik", () => {
  // Akun 2xxxx: kredit menaikkan saldo hutang. Formula LAMA Σ(debit-kredit)
  // menghasilkan -900000 untuk baris terakhir; Olsera menampilkan +900000.
  const rows = computeRunningLedgerBalances<RunningLedgerRow>([
    { isOpeningBalance: false, debit: 0, credit: 1000000, balance: 1000000 },
    { isOpeningBalance: false, debit: 100000, credit: 0, balance: -100000 },
  ]);
  assert.equal(rows[0].balance, 1000000);
  assert.equal(rows[1].balance, 900000);
});

test("computeRunningLedgerBalances: tanpa baris saldo awal, seed dimulai dari 0 (tidak menebak opening)", () => {
  const rows = computeRunningLedgerBalances<RunningLedgerRow>([
    { isOpeningBalance: false, debit: 100, credit: 0, balance: 100 },
    { isOpeningBalance: false, debit: 0, credit: 40, balance: -40 },
  ]);
  assert.equal(rows[0].balance, 100);
  assert.equal(rows[1].balance, 60);
});

test("computeRunningLedgerBalances: baris tanpa famount valid (null/NaN) menyumbang 0, tidak meracuni akumulasi (bukan NaN, bukan fallback debit-kredit)", () => {
  const rows = computeRunningLedgerBalances<RunningLedgerRow>([
    { isOpeningBalance: true, debit: 0, credit: 0, balance: null },
    { isOpeningBalance: false, debit: 500, credit: 0, balance: 500 },
    // Tanpa famount: menyumbang 0. Fallback ke debit-kredit sengaja TIDAK
    // dilakukan — itu akan memasukkan kembali pencampuran konvensi yang jadi bug.
    { isOpeningBalance: false, debit: 999, credit: 0, balance: null },
  ]);
  assert.equal(rows[0].balance, 0);
  assert.equal(rows[1].balance, 500);
  assert.equal(rows[2].balance, 500);
});

test("buildLedgerDetailGroups: regresi produksi BANK BCA — Saldo per baris adalah running balance, urutan transaksi tidak berubah, TIDAK ada rule khusus akun (kode akun generik diuji sama)", () => {
  for (const accountCode of ["11105", "99999-generik"]) {
    const entries: LedgerEntryInput[] = [
      { accountCode, accountName: "Akun Uji", isOpeningBalance: true, description: "Saldo awal", debit: 0, credit: 0, balance: 556986758.71 },
      { accountCode, accountName: "Akun Uji", transactionDate: "2026-07-01", transactionNo: "JU-1", description: "Transaksi 1", debit: 2011818.0, credit: 0, balance: 2011818.0 },
      { accountCode, accountName: "Akun Uji", transactionDate: "2026-07-02", transactionNo: "JU-2", description: "Transaksi 2 (kredit)", debit: 0, credit: 500000, balance: -500000 },
    ];
    const [group] = buildLedgerDetailGroups(entries);
    assert.equal(group.entries.length, 3);
    assert.equal(group.entries[0].balance, 556986758.71); // Saldo Awal
    assert.equal(group.entries[1].balance, 558998576.71); // running (saldo awal + famount), BUKAN famount baris itu saja (2011818.00)
    assert.equal(group.entries[2].balance, 558498576.71); // famount negatif (akun debit-normal) mengurangi running sebelumnya
    // Urutan transaksi (transactionNo) tidak berubah oleh perbaikan saldo.
    assert.deepEqual(group.entries.map((e) => e.transactionNo), ["-", "JU-1", "JU-2"]);
  }
});

test("buildLedgerAccountDetail: regresi produksi BANK BCA — saldo per baris + saldo akhir konsisten dengan buildLedgerDetailGroups (satu formula)", () => {
  const entries: LedgerEntryInput[] = [
    { accountCode: "11105", accountName: "BANK BCA 7195-332266", isOpeningBalance: true, description: "Saldo awal", debit: 0, credit: 0, balance: 556986758.71 },
    { accountCode: "11105", accountName: "BANK BCA 7195-332266", transactionDate: "2026-07-01", transactionNo: "JU-1", description: "Transaksi 1", debit: 2011818.0, credit: 0, balance: 2011818.0 },
    { accountCode: "11105", accountName: "BANK BCA 7195-332266", transactionDate: "2026-07-02", transactionNo: "JU-2", description: "Transaksi 2 (kredit)", debit: 0, credit: 500000, balance: -500000 },
  ];
  const detail = buildLedgerAccountDetail(entries, "11105");
  assert.equal(detail.openingBalance, 556986758.71);
  assert.equal(detail.entries[0].balance, 558998576.71);
  assert.equal(detail.entries[1].balance, 558498576.71);
  assert.equal(detail.endingBalance, 558498576.71);
  // UI (buildLedgerDetailGroups) dan Excel/PDF "Download Akun Ini" (buildLedgerAccountDetail) harus sepakat persis.
  const [group] = buildLedgerDetailGroups(entries);
  assert.equal(detail.entries[0].balance, group.entries[1].balance);
  assert.equal(detail.entries[1].balance, group.entries[2].balance);
});

// ---- Regresi komplain: Total Kredit HARUS TIDAK ikut Total Debit -----------
// Kasus nyata: Debit total Rp20.614.923,86, Kredit transaksi Rp1.275.576,14 —
// Total Pergerakan Kredit sempat salah menampilkan Rp20.614.923,86 (= Debit).
// Total Debit dan Total Kredit harus SELALU dihitung independen per akun.

test("buildLedgerDetailGroups: Total Debit dan Total Kredit independen (regresi komplain user)", () => {
  const entries: LedgerEntryInput[] = [
    { accountCode: "51000", accountName: "Beban Operasional", isOpeningBalance: true, debit: 0, credit: 0, balance: 0 },
    { accountCode: "51000", accountName: "Beban Operasional", transactionDate: "2026-08-01", debit: 20614923.86, credit: 0, balance: 20614923.86 },
    // famount baris kedua adalah pergerakan baris itu (-1.275.576,14), BUKAN
    // saldo kumulatif 19.339.347,72 — saldo kumulatif itu yang dihitung
    // computeRunningLedgerBalances dari penjumlahan famount.
    { accountCode: "51000", accountName: "Beban Operasional", transactionDate: "2026-08-05", debit: 0, credit: 1275576.14, balance: -1275576.14 },
  ];
  const [group] = buildLedgerDetailGroups(entries);
  assert.equal(group.totalDebit, 20614923.86);
  assert.equal(group.totalCredit, 1275576.14);
  assert.notEqual(group.totalCredit, group.totalDebit);
});

test("buildLedgerAccountDetail: Total Debit dan Total Kredit independen (regresi komplain user)", () => {
  const entries: LedgerEntryInput[] = [
    { accountCode: "51000", accountName: "Beban Operasional", isOpeningBalance: true, debit: 0, credit: 0, balance: 0 },
    { accountCode: "51000", accountName: "Beban Operasional", transactionDate: "2026-08-01", debit: 20614923.86, credit: 0, balance: 20614923.86 },
    // famount baris kedua adalah pergerakan baris itu (-1.275.576,14), BUKAN
    // saldo kumulatif 19.339.347,72 — saldo kumulatif itu yang dihitung
    // computeRunningLedgerBalances dari penjumlahan famount.
    { accountCode: "51000", accountName: "Beban Operasional", transactionDate: "2026-08-05", debit: 0, credit: 1275576.14, balance: -1275576.14 },
  ];
  const detail = buildLedgerAccountDetail(entries, "51000");
  assert.equal(detail.totalDebit, 20614923.86);
  assert.equal(detail.totalCredit, 1275576.14);
  assert.notEqual(detail.totalCredit, detail.totalDebit);
  assert.equal(detail.movement, 20614923.86 - 1275576.14);
  assert.equal(detail.endingBalance, 19339347.72);
});

// ---- Excel: satu workbook, 5 sheet, urutan & total benar -------------------

test("Excel: workbook berisi tepat 5 sheet dengan nama yang benar", async () => {
  const workbook = buildFinancialWorkbook({
    period: "2026-05",
    companyName: "BC PADEL CLUB",
    balanceSheet: BALANCE_SHEET,
    profitLoss: PROFIT_LOSS,
    cashFlow: CASH_FLOW,
    ledgerSummary: LEDGER_SUMMARY,
    ledgerEntries: makeLedgerEntries(),
  });
  assert.equal(workbook.worksheets.length, 5);
  assert.deepEqual(
    workbook.worksheets.map((s) => s.name),
    ["Ringkasan Buku Besar", "Arus Kas", "Laba Rugi", "Neraca", "Buku Besar Detail"],
  );
  for (const sheet of workbook.worksheets) {
    assert.equal(sheet.pageSetup.orientation, "landscape");
    assert.equal(sheet.pageSetup.fitToWidth, 1);
    assert.equal(sheet.pageSetup.printTitlesRow, "5:5");
    assert.equal((sheet.views[0] as { ySplit?: number } | undefined)?.ySplit, 5);
  }
});

test("Excel: sheet Neraca memuat nilai Total Aset persis snapshot", () => {
  const workbook = buildFinancialWorkbook({
    period: "2026-05",
    companyName: "BC PADEL CLUB",
    balanceSheet: BALANCE_SHEET,
    profitLoss: PROFIT_LOSS,
    cashFlow: CASH_FLOW,
    ledgerSummary: LEDGER_SUMMARY,
    ledgerEntries: [],
  });
  const neraca = workbook.getWorksheet("Neraca")!;
  let found: number | null = null;
  neraca.eachRow((row) => {
    if (String(row.getCell(1).value ?? "").startsWith("Total Aset") && row.getCell(1).value === "Total Aset") {
      found = Number(row.getCell(3).value);
    }
  });
  assert.equal(found, 2519025675.61);
});

test("Excel ledger mempertahankan dua desimal, pengaturan cetak, kolom Saldo terisi, dan Total Pergerakan tidak mengisi Saldo", () => {
  const workbook = buildFinancialWorkbook({ period: "2026-05", companyName: "BC PADEL CLUB", balanceSheet: BALANCE_SHEET, profitLoss: PROFIT_LOSS, cashFlow: CASH_FLOW, ledgerSummary: LEDGER_SUMMARY, ledgerEntries: makeLedgerEntries() });
  const summary = workbook.getWorksheet("Ringkasan Buku Besar")!;
  // Baris 6, bukan 7: akun 11101 (Kas, debit=kredit=saldo=0) disembunyikan Fitur 2.
  const account11105 = summary.getRow(6);
  assert.equal(account11105.getCell(4).value, 370361513.75);
  assert.equal(account11105.getCell(5).value, 120030000);
  assert.equal(account11105.getCell(4).numFmt, "#,##0.00;(#,##0.00)");
  assert.equal(summary.pageSetup.orientation, "landscape");
  assert.equal(summary.pageSetup.fitToWidth, 1);
  assert.equal(summary.pageSetup.printTitlesRow, "5:5");

  const detail = workbook.getWorksheet("Buku Besar Detail")!;
  let totalRow: import("exceljs").Row | undefined;
  detail.eachRow((row) => { if (row.getCell(3).value === "Total Pergerakan") totalRow = row; });
  assert.ok(totalRow);
  assert.equal(totalRow!.getCell(1).value, "");
  assert.equal(totalRow!.getCell(2).value, "");
  assert.equal(totalRow!.getCell(4).value, 37500000);
  assert.equal(totalRow!.getCell(5).value, 22500000);
  assert.equal(detail.getRow(5).getCell(6).value, "Saldo");
  // Total Pergerakan adalah total movement (SUM Debit/SUM Kredit) — kolom Saldo (6) sengaja tidak diisi di baris ini.
  assert.equal(totalRow!.getCell(6).value, null);
  // Baris 7 = Saldo Awal akun 11105 (famount sumber, dipakai sebagai seed saldo berjalan).
  assert.equal(detail.getRow(7).getCell(6).value, 1000000);
  assert.equal(detail.getRow(7).getCell(3).alignment?.wrapText, true);
  // Baris transaksi pertama = saldo berjalan DIHITUNG (opening + famount baris), bukan famount mentah begitu saja.
  assert.equal(detail.getRow(8).getCell(6).value, 1000000 + 500000);
  assert.equal(detail.pageSetup.printTitlesRow, "5:5");
});

test("PDF dan Excel mempertahankan Debit 11105 dengan dua desimal", async () => {
  const pdf = await renderRingkasanBukuBesarPdf("BC PADEL CLUB", "2026-05", LEDGER_SUMMARY);
  assert.equal(pdfContainsText(pdf, "370.361.513,75"), true);
  const workbook = buildFinancialWorkbook({ period: "2026-05", companyName: "BC PADEL CLUB", balanceSheet: BALANCE_SHEET, profitLoss: PROFIT_LOSS, cashFlow: CASH_FLOW, ledgerSummary: LEDGER_SUMMARY, ledgerEntries: [] });
  const row = workbook.getWorksheet("Ringkasan Buku Besar")!.getRow(6);
  assert.equal(row.getCell(4).value, 370361513.75);
  assert.equal(formatAccountingID(Number(row.getCell(4).value)), "370.361.513,75");
});

test("seluruh 52 baris Total Pergerakan Excel memiliki tanggal dan jurnal kosong", () => {
  const entries = Array.from({ length: 52 }, (_, index) => {
    const code = String(10000 + index);
    return [
      { accountCode: code, accountName: `Akun ${code}`, isOpeningBalance: true, description: "Saldo awal", debit: 0, credit: 0 },
      { accountCode: code, accountName: `Akun ${code}`, transactionDate: "2026-05-01", transactionNo: `JU-${index}`, description: "Transaksi normal", debit: index + 0.75, credit: 0 },
    ];
  }).flat() as LedgerEntryInput[];
  const workbook = buildFinancialWorkbook({ period: "2026-05", companyName: "BC PADEL CLUB", balanceSheet: BALANCE_SHEET, profitLoss: PROFIT_LOSS, cashFlow: CASH_FLOW, ledgerSummary: LEDGER_SUMMARY, ledgerEntries: entries });
  const detail = workbook.getWorksheet("Buku Besar Detail")!;
  const rows = (detail.getRows(1, detail.rowCount) ?? []).filter((row): row is import("exceljs").Row => Boolean(row));
  const totals = rows.filter((row) => row.getCell(3).value === "Total Pergerakan");
  assert.equal(totals.length, 52);
  for (const row of totals) {
    assert.equal(row.getCell(1).value, "");
    assert.equal(row.getCell(2).value, "");
    assert.equal(row.getCell(3).value, "Total Pergerakan");
    assert.equal(typeof row.getCell(4).value, "number");
    assert.equal(typeof row.getCell(5).value, "number");
    assert.notEqual(row.getCell(1).value, 407);
    assert.notEqual(row.getCell(2).value, 407);
  }
  const normal = rows.find((row) => row.getCell(3).value === "Transaksi normal");
  assert.ok(normal);
  assert.equal(normal!.getCell(1).value, "2026-05-01");
  assert.equal(normal!.getCell(2).value, "JU-0");
});

test("HTML entity pada nama/deskripsi menjadi karakter normal", () => {
  assert.equal(decodeFinancialHtmlEntities("Kas &#039;Utama&#039; &amp; Bank &quot;BCA&quot;"), "Kas 'Utama' & Bank \"BCA\"");
  const groups = buildLedgerDetailGroups([
    { accountCode: "11105", accountName: "Bank &amp; Kas", transactionDate: "2026-05-01", transactionNo: "JU-1", description: "Kartu &#039;BCA&#039; &amp; debit", debit: 1, credit: 0 },
  ]);
  assert.equal(groups[0].name, "Bank & Kas");
  assert.equal(groups[0].entries[0].description, "Kartu 'BCA' & debit");
});

// ---- PDF: setiap jenis bisa dibuat & valid ---------------------------------

test("normalisasi teks PDF: Unicode berisiko aman untuk Helvetica tanpa mengubah angka", () => {
  const input = "Kas – Utama • 1.234,56\u00a0→ ✓";
  assert.equal(normalizePdfText(input), "Kas - Utama - 1.234,56 -> ");
});

test("PDF tetap dibuat untuk field null/undefined/NaN dan label bukan string", async () => {
  const malformed = {
    assets: {
      amount: Number.NaN,
      children: [
        null,
        { name: 123, accountCode: 11101, amount: Number.NaN },
        { name: "Kas • Utama →", accountCode: null, amount: undefined },
      ],
    },
    liabilityCapital: { amount: null, children: [] },
    totals: { totalAssets: Number.NaN, totalLiabilityCapital: undefined },
  } as unknown as BalanceSheetPayload;
  assert.ok((await pageCount(await renderNeracaPdf("BC PADEL CLUB", "2026-05", malformed))) >= 1);

  const workbook = buildFinancialWorkbook({
    period: "2026-05",
    companyName: "BC PADEL CLUB",
    balanceSheet: malformed,
    profitLoss: null,
    cashFlow: null,
    ledgerSummary: [null, { accountCode: 11101 as unknown as string, debit: Number.NaN } as never] as unknown as LedgerSummaryRow[],
    ledgerEntries: [null, { accountCode: 11101 as unknown as string, debit: Number.NaN, description: null } as never] as unknown as LedgerEntryInput[],
  });
  await workbook.xlsx.writeBuffer();
});

async function pageCount(bytes: Uint8Array): Promise<number> {
  assert.equal(bytes[0], 0x25); // '%' — header %PDF
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

test("PDF Neraca dapat dibuat & valid", async () => {
  assert.ok((await pageCount(await renderNeracaPdf("BC PADEL CLUB", "2026-05", BALANCE_SHEET))) >= 1);
});
test("PDF Laba Rugi dapat dibuat & valid", async () => {
  assert.ok((await pageCount(await renderLabaRugiPdf("BC PADEL CLUB", "2026-05", PROFIT_LOSS))) >= 1);
});
test("PDF Arus Kas dapat dibuat & valid", async () => {
  assert.ok((await pageCount(await renderArusKasPdf("BC PADEL CLUB", "2026-05", CASH_FLOW))) >= 1);
});
test("PDF Ringkasan Buku Besar dapat dibuat & valid", async () => {
  assert.ok((await pageCount(await renderRingkasanBukuBesarPdf("BC PADEL CLUB", "2026-05", LEDGER_SUMMARY))) >= 1);
});

test("PDF Buku Besar Detail multi-halaman (ledger besar tidak terpotong)", async () => {
  const pages = await pageCount(await renderBukuBesarDetailPdf("BC PADEL CLUB", "2026-05", makeLedgerEntries()));
  assert.ok(pages > 1, `ledger detail 453 baris harus > 1 halaman, dapat ${pages}`);
});

test("PDF ledger memakai ruang header aman, judul/periode jelas, dan tabel berulang", async () => {
  // Header tabel berada setelah blok judul + gap, sementara footer berada di luar area isi.
  assert.ok(PDF_REPORT_LAYOUT.headerBlockHeight >= 82);
  assert.ok(PDF_REPORT_LAYOUT.headerTableGap >= 18);
  assert.ok(PDF_REPORT_LAYOUT.rightNumberInset >= 8);
  assert.ok(PDF_REPORT_LAYOUT.margin + PDF_REPORT_LAYOUT.footerHeight < 100);
  assert.ok(PDF_REPORT_LAYOUT.tableTopOffset > PDF_REPORT_LAYOUT.titleBottomOffset, "header tabel harus berada di bawah blok judul");
  assert.ok(PDF_REPORT_LAYOUT.tableTopOffset - PDF_REPORT_LAYOUT.titleBottomOffset >= 10, "harus ada jarak kosong antar blok");
  const pages = await pageCount(await renderBukuBesarDetailPdf("BC PADEL CLUB", "2026-05", makeLedgerEntries()));
  assert.ok(pages > 1, "pagination memicu halaman baru yang selalu menggambar header tabel");
});

test("PDF deskripsi panjang di-wrap, bukan dipotong", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = wrapPdfText("Pembayaran pelanggan dengan deskripsi panjang yang harus turun ke baris berikutnya", 120, font, 8);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => font.widthOfTextAtSize(line, 8) <= 120));
});

test("PDF Buku Besar Detail kosong tetap valid (ledger-empty ditangani route)", async () => {
  assert.ok((await pageCount(await renderBukuBesarDetailPdf("BC PADEL CLUB", "2026-05", []))) >= 1);
});

// ---- Fitur 2: sembunyikan baris nominal nol --------------------------------

test("filterZeroStatementLines: baris nol dibuang, section/subtotal/total tetap, heading grup kosong ikut dibuang", () => {
  const lines: StatementLine[] = [
    { kind: "section", code: null, label: "Aset", amount: null },
    { kind: "group", code: null, label: "Aset Lancar", amount: null },
    { kind: "account", code: "11101", label: "Kas", amount: 0 },
    { kind: "account", code: "11105", label: "Bank", amount: 500000 },
    { kind: "subtotal", code: null, label: "Total Aset Lancar", amount: 500000 },
    { kind: "group", code: null, label: "Aset Tidak Lancar (kosong)", amount: null },
    { kind: "account", code: "12000", label: "Aset Tetap Nol", amount: 0 },
    { kind: "subtotal", code: null, label: "Total Aset Tidak Lancar", amount: 0 },
    { kind: "total", code: null, label: "Total Aset", amount: 500000 },
  ];
  const filtered = filterZeroStatementLines(lines);
  assert.equal(filtered.some((l) => l.label === "Kas"), false); // nol -> dibuang
  assert.equal(filtered.some((l) => l.label === "Bank"), true); // non-nol -> tetap
  assert.equal(filtered.some((l) => l.label === "Aset Tidak Lancar (kosong)"), false); // heading kosong dibuang
  assert.equal(filtered.some((l) => l.label === "Total Aset Tidak Lancar"), true); // subtotal tetap walau grup kosong
  assert.equal(filtered.some((l) => l.label === "Total Aset"), true); // total selalu tampil
  assert.equal(filtered.some((l) => l.label === "Aset"), true); // section (header wajib) selalu tampil
  assert.equal(filtered.some((l) => l.label === "Aset Lancar"), true); // grup dengan detail tetap tampil
});

test("filterZeroStatementLines: nilai negatif (bukan nol) tetap tampil, pemeriksaan numerik bukan string", () => {
  const filtered = filterZeroStatementLines(buildBalanceSheetLines(BALANCE_SHEET));
  assert.ok(filtered.some((l) => l.label === "Akumulasi penyusutan aset tetap" && l.amount === -1056854));
  assert.equal(filtered.some((l) => l.label === "Kas" && l.code === "11101"), false); // amount 0 -> dibuang
});

test("filterZeroLedgerSummaryRows: baris Ringkasan Buku Besar dengan debit=kredit=saldo=0 disembunyikan", () => {
  const rows = filterZeroLedgerSummaryRows(buildLedgerSummaryRows(LEDGER_SUMMARY));
  assert.equal(rows.length, 2);
  assert.equal(rows.some((r) => r.code === "11101"), false);
  assert.ok(rows.some((r) => r.code === "11105"));
});

function makeZeroFilterLedgerEntries(): LedgerEntryInput[] {
  return [
    { accountCode: "99001", accountName: "Akun Uji", isOpeningBalance: true, description: "Saldo awal", debit: 0, credit: 0, balance: 1000000 },
    { accountCode: "99001", accountName: "Akun Uji", transactionDate: "2026-05-02", transactionNo: "JU-1", description: "Debit saja", debit: 500000, credit: 0 },
    { accountCode: "99001", accountName: "Akun Uji", transactionDate: "2026-05-03", transactionNo: "JU-2", description: "Kredit saja", debit: 0, credit: 200000 },
    { accountCode: "99001", accountName: "Akun Uji", transactionDate: "2026-05-04", transactionNo: "JU-3", description: "Nol dibuang", debit: 0, credit: 0 },
  ];
}

test("buildLedgerDetailGroups (Buku Besar lengkap): baris debit=0 DAN kredit=0 dibuang, saldo awal & baris satu sisi tetap tampil", () => {
  const [group] = buildLedgerDetailGroups(makeZeroFilterLedgerEntries());
  assert.equal(group.entries.length, 3); // saldo awal + debit saja + kredit saja (baris nol dibuang)
  assert.equal(group.entries[0].isOpeningBalance, true);
  assert.ok(group.entries.some((e) => e.description === "Debit saja" && e.debit === 500000 && e.credit === 0));
  assert.ok(group.entries.some((e) => e.description === "Kredit saja" && e.credit === 200000 && e.debit === 0));
  assert.equal(group.entries.some((e) => e.description === "Nol dibuang"), false);
  assert.equal(group.totalDebit, 500000); // total tetap dihitung dari seluruh baris (baris nol tidak mengubah jumlah)
  assert.equal(group.totalCredit, 200000);
});

// ---- Fitur 1: Buku Besar per akun ("Download Akun Ini") -------------------

test("buildLedgerAccountDetail: hanya akun terpilih, seluruh transaksinya ikut, akun lain tidak ikut", () => {
  const detail = buildLedgerAccountDetail(makeLedgerEntries(), "11105");
  assert.equal(detail.code, "11105");
  assert.equal(detail.name, "BANK BCA 7195-332266");
  assert.equal(detail.openingBalance, 1000000);
  assert.equal(detail.entries.length, 150); // seluruh 150 transaksi non-opening akun 11105 ikut (tidak ada yang debit=kredit=0 di fixture ini)
  assert.equal(detail.totalDebit, 37500000); // = 75 * 500000, BUKAN gabungan 3 akun (yang akan 3x lipat)
  assert.equal(detail.totalCredit, 22500000);
  assert.equal(detail.movement, 15000000);
  // endingBalance = openingBalance + Σ famount. Bukan famount baris terakhir
  // begitu saja — famount adalah pergerakan per baris, bukan posisi kumulatif.
  assert.equal(detail.endingBalance, 1000000 + 15000000);
  // Saldo berjalan per baris juga harus akumulatif, bukan famount mentah: baris pertama (debit 500000) = opening + 500000.
  assert.equal(detail.entries[0].balance, 1000000 + 500000);
  assert.equal(detail.entries[1].balance, 1000000 + 500000 - 300000);
  assert.equal(detail.entries[detail.entries.length - 1].balance, detail.endingBalance);
});

test("buildLedgerAccountDetail: baris debit=0 kredit=0 dibuang, baris satu sisi & saldo awal tetap tampil", () => {
  const detail = buildLedgerAccountDetail(makeZeroFilterLedgerEntries(), "99001");
  assert.equal(detail.openingBalance, 1000000);
  assert.equal(detail.entries.length, 2);
  assert.ok(detail.entries.some((e) => e.description === "Debit saja" && e.debit === 500000));
  assert.ok(detail.entries.some((e) => e.description === "Kredit saja" && e.credit === 200000));
  assert.equal(detail.entries.some((e) => e.description === "Nol dibuang"), false);
  assert.equal(detail.totalDebit, 500000);
  assert.equal(detail.totalCredit, 200000);
});

test("financialLedgerAccountExportFileName & sanitizeForFileName: nama file aman/tersanitasi, isi laporan (nama akun) tidak berubah", () => {
  assert.equal(
    financialLedgerAccountExportFileName("pdf", "11105", "BANK BCA 7195-332266", "2026-07"),
    "Buku-Besar-11105-BANK-BCA-7195-332266-2026-07.pdf",
  );
  assert.equal(
    financialLedgerAccountExportFileName("excel", "11105", "BANK BCA 7195-332266", "2026-07"),
    "Buku-Besar-11105-BANK-BCA-7195-332266-2026-07.xlsx",
  );
  // Karakter berbahaya untuk nama file disaring; sanitizer HANYA dipakai untuk nama file, bukan isi laporan.
  assert.equal(sanitizeForFileName('Kas/Bank "Utama" <BCA> & Co.'), "Kas-Bank-Utama-BCA-Co");
  assert.equal(financialLedgerAccountExportFileName("pdf", "11105", "", "2026-07"), "Buku-Besar-11105-2026-07.pdf");
  assert.throws(() => financialLedgerAccountExportFileName("pdf", "11105", "Bank", "bukan-periode"));
});

test("Download Akun Ini PDF & Excel: hanya memuat akun terpilih, akun lain TIDAK ikut", async () => {
  const detail = buildLedgerAccountDetail(makeLedgerEntries(), "11105");
  const pdf = await renderLedgerAccountDetailPdf("BC PADEL CLUB", "2026-05", detail);
  assert.equal(pdfContainsText(pdf, "JU2605111050000"), true); // transaksi pertama akun 11105
  assert.equal(pdfContainsText(pdf, "JU2605400010000"), false); // transaksi akun 40001 TIDAK ikut
  assert.equal(pdfContainsText(pdf, "JU2605510000000"), false); // transaksi akun 51000 TIDAK ikut

  const workbook = buildLedgerAccountWorkbook({ period: "2026-05", companyName: "BC PADEL CLUB", detail });
  assert.equal(workbook.worksheets.length, 1);
  assert.equal(workbook.worksheets[0].name, "Buku Besar Detail");
  let found40001 = false;
  workbook.getWorksheet("Buku Besar Detail")!.eachRow((row) => {
    if (String(row.getCell(2).value ?? "").includes("40001")) found40001 = true;
  });
  assert.equal(found40001, false);
});

test("Download Akun Ini: saldo awal, total debit/kredit, pergerakan periode, dan saldo akhir selalu tampil (PDF & Excel)", async () => {
  const detail = buildLedgerAccountDetail(makeLedgerEntries(), "11105");
  const pdf = await renderLedgerAccountDetailPdf("BC PADEL CLUB", "2026-05", detail);
  assert.equal(pdfContainsText(pdf, "Saldo Awal"), true);
  assert.equal(pdfContainsText(pdf, "Pergerakan Periode"), true);
  assert.equal(pdfContainsText(pdf, "Saldo Akhir"), true);
  assert.equal(pdfContainsText(pdf, "Kode Akun"), true);
  assert.equal(pdfContainsText(pdf, "Nama Akun"), true);

  const workbook = buildLedgerAccountWorkbook({ period: "2026-05", companyName: "BC PADEL CLUB", detail });
  const sheet = workbook.getWorksheet("Buku Besar Detail")!;
  let hasTotal = false;
  let hasMovement = false;
  let hasEnding = false;
  sheet.eachRow((row) => {
    if (row.getCell(3).value === "Total") hasTotal = true;
    if (row.getCell(3).value === "Pergerakan Periode") hasMovement = true;
    if (row.getCell(3).value === "Saldo Akhir") hasEnding = true;
  });
  assert.ok(hasTotal && hasMovement && hasEnding);
});

test("Download Akun Ini: akun tanpa transaksi (hanya saldo awal) tetap menghasilkan PDF/Excel valid", async () => {
  const detail = buildLedgerAccountDetail(
    [{ accountCode: "99002", accountName: "Akun Kosong", isOpeningBalance: true, debit: 0, credit: 0, balance: 5000 }],
    "99002",
  );
  assert.equal(detail.entries.length, 0);
  assert.equal(detail.endingBalance, 5000); // fallback saldo awal + pergerakan (0) bila tidak ada transaksi
  assert.ok((await pageCount(await renderLedgerAccountDetailPdf("BC PADEL CLUB", "2026-05", detail))) >= 1);
  await buildLedgerAccountWorkbook({ period: "2026-05", companyName: "BC PADEL CLUB", detail }).xlsx.writeBuffer();
});

// ---- Export TIDAK memanggil Olsera live (jaminan statis) --------------------

test("modul export tidak mengimpor client Olsera live", () => {
  for (const file of [
    "./olsera-financial-export.ts",
    "./olsera-financial-export-core.ts",
    "./olsera-financial-excel.ts",
    "./olsera-financial-pdf.ts",
  ]) {
    const source = readFileSync(here(file), "utf8");
    assert.ok(!/olsera-financial-client/.test(source), `${file} tidak boleh mengimpor olsera-financial-client (live)`);
  }
});

test("route export baca snapshot (guard auth: modul olsera saja) & petakan timeout ke 504", () => {
  for (const file of ["../app/api/olsera/financial/export/excel/route.ts", "../app/api/olsera/financial/export/pdf/route.ts"]) {
    const source = readFileSync(here(file), "utf8");
    assert.ok(/guard\(\)/.test(source), `${file} harus memanggil guard() (auth: modul olsera saja, tanpa syarat supervisor)`);
    assert.ok(/isDatabaseTimeoutError/.test(source) && /504/.test(source), `${file} harus memetakan timeout DB ke 504`);
    assert.ok(!/olsera-financial-client/.test(source), `${file} tidak boleh menyentuh Olsera live`);
  }
});

test("ledgerMovementForDisplay mengikuti konvensi tanda Olsera (kredit-normal 2xxxx/3xxxx/4xxxx/7xxxx positif)", () => {
  // Fixture Februari 2026 — nilai absolut sama, tanda mengikuti Olsera.
  assert.equal(ledgerMovementForDisplay("21000", 0, 17188500), 17188500);
  assert.equal(ledgerMovementForDisplay("23500", 0, 2000), 2000);
  assert.equal(ledgerMovementForDisplay("33000", 2670588.83, 0), -2670588.83);
  // Pendapatan 4xxxx juga kredit-normal di Olsera (fixture Mei 2026: kredit 500.000 -> Total +500.000).
  assert.equal(ledgerMovementForDisplay("40001", 0, 500000), 500000);
  assert.equal(ledgerMovementForDisplay("46100", 3750, 0), -3750);
  // 7xxxx (pendapatan lain-lain) juga kredit-normal: 59 baris Februari, nol pengecualian.
  assert.equal(ledgerMovementForDisplay("70000", 0, 77522.77), 77522.77);
  // Aset/HPP/beban tidak berubah: tetap debit - kredit (8xxxx biaya lain-lain ikut debit-normal).
  assert.equal(ledgerMovementForDisplay("11105", 20614923.86, 1275576.14), 20614923.86 - 1275576.14);
  assert.equal(ledgerMovementForDisplay("51000", 58472.73, 0), 58472.73);
  assert.equal(ledgerMovementForDisplay("60100", 22689000, 0), 22689000);
  assert.equal(ledgerMovementForDisplay("80000", 1322013.02, 0), 1322013.02);
  assert.equal(ledgerMovementForDisplay("", 1000, 400), 600);
});

// ---- Regresi data nyata: baris persis dari backup produksi Februari 2026 ----
// Sumber: tmp/financial-backup-2026-08-01.../olsera_financial_ledger_entries.json
// Angka target diverifikasi silang dengan export resmi Olsera Feb 2026
// (Ringkasan Buku Besar: 21000 = 17.188.500, 33000 = -2.670.588,83 pergerakan).

test("regresi data nyata Feb 2026: akun kredit-normal memakai tanda Olsera, akun debit-normal tidak berubah", () => {
  // 33000 Laba rugi ditahan — punya saldo awal, jadi kasus paling rusak di formula lama.
  const equity = computeRunningLedgerBalances<RunningLedgerRow>([
    { isOpeningBalance: true, debit: 0, credit: 0, balance: -621129.39 },
    { isOpeningBalance: false, debit: 155573542.31, credit: 0, balance: -155573542.31 },
    { isOpeningBalance: false, debit: 0, credit: 152902953.48, balance: 152902953.48 },
  ]);
  // Formula lama menghasilkan 2.049.459,44 — angka yang tidak ada di Olsera mana pun.
  assert.equal(equity[equity.length - 1].balance.toFixed(2), "-3291718.22");

  // 21000 Hutang dagang — tanpa saldo awal, 8 baris transaksi Februari.
  const liability = computeRunningLedgerBalances<RunningLedgerRow>([
    { isOpeningBalance: false, debit: 0, credit: 5764500, balance: 5764500 },
    { isOpeningBalance: false, debit: 0, credit: 1632000, balance: 1632000 },
    { isOpeningBalance: false, debit: 0, credit: 900000, balance: 900000 },
    { isOpeningBalance: false, debit: 0, credit: 4560000, balance: 4560000 },
    { isOpeningBalance: false, debit: 4560000, credit: 0, balance: -4560000 },
    { isOpeningBalance: false, debit: 0, credit: 1800000, balance: 1800000 },
    { isOpeningBalance: false, debit: 0, credit: 1692000, balance: 1692000 },
    { isOpeningBalance: false, debit: 0, credit: 5400000, balance: 5400000 },
  ]);
  // Formula lama: -17.188.500 (terbalik). Olsera: +17.188.500.
  assert.equal(liability[liability.length - 1].balance, 17188500);

  // 11105 BANK BCA — akun debit-normal, HARUS identik dengan formula lama.
  const assetRows: RunningLedgerRow[] = [
    { isOpeningBalance: true, debit: 0, credit: 0, balance: 410179573.61 },
    { isOpeningBalance: false, debit: 6.99, credit: 0, balance: 6.99 },
    { isOpeningBalance: false, debit: 0, credit: 210000000, balance: -210000000 },
    { isOpeningBalance: false, debit: 103272, credit: 0, balance: 103272 },
    { isOpeningBalance: false, debit: 6007650, credit: 0, balance: 6007650 },
  ];
  const asset = computeRunningLedgerBalances<RunningLedgerRow>(assetRows);
  // Dihitung ulang dengan formula LAMA (Σ debit-kredit) — harus sama persis.
  let legacy = 0;
  for (const row of assetRows) legacy = row.isOpeningBalance ? (row.balance ?? 0) : legacy + row.debit - row.credit;
  assert.equal(asset[asset.length - 1].balance.toFixed(2), legacy.toFixed(2));
  assert.equal(asset[asset.length - 1].balance.toFixed(2), "206290502.60");
});

test("buildLedgerAccountDetail: Saldo Akhir sama dengan saldo baris terakhir, dan memakai tanda Olsera untuk akun kredit-normal", () => {
  // 21000 Februari 2026 — subset baris nyata.
  const detail = buildLedgerAccountDetail(
    [
      { accountCode: "21000", accountName: "Hutang dagang", transaction_date: "2026-02-03", description: "purchase from PT LIM SIANG HUAT", debit: 0, credit: 5764500, balance: 5764500, isOpeningBalance: false },
      { accountCode: "21000", transaction_date: "2026-02-12", description: "pembayaran ke FAFA SPORT", debit: 4560000, credit: 0, balance: -4560000, isOpeningBalance: false },
    ] as unknown as LedgerEntryInput[],
    "21000",
  );
  assert.equal(detail.movement, 1204500); // 5.764.500 - 4.560.000, tanda Olsera
  assert.equal(detail.endingBalance, 1204500);
  // Invarian yang dijaga Phase 5B P0 tetap berlaku: baris terakhir == Saldo Akhir.
  assert.equal(detail.entries[detail.entries.length - 1].balance, detail.endingBalance);
});
