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
  buildLedgerDetailGroups,
  buildLedgerSummaryRows,
  buildProfitLossLines,
  decodeFinancialHtmlEntities,
  financialExportFileName,
  formatAccountingID,
  formatPeriodDateRangeEN,
  formatPeriodLabelID,
  isFinancialReportKind,
  splitPeriod,
  type BalanceSheetPayload,
  type CashFlowPayload,
  type LedgerEntryInput,
  type LedgerSummaryRow,
  type ProfitLossPayload,
  type StatementLine,
} from "./olsera-financial-export-core.ts";
import { buildFinancialWorkbook } from "./olsera-financial-excel.ts";
import {
  renderArusKasPdf,
  renderBukuBesarDetailPdf,
  renderLabaRugiPdf,
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
        balance: 1000000 + i * 1000,
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

test("Excel ledger mempertahankan dua desimal, pengaturan cetak, dan Total Pergerakan kosong", () => {
  const workbook = buildFinancialWorkbook({ period: "2026-05", companyName: "BC PADEL CLUB", balanceSheet: BALANCE_SHEET, profitLoss: PROFIT_LOSS, cashFlow: CASH_FLOW, ledgerSummary: LEDGER_SUMMARY, ledgerEntries: makeLedgerEntries() });
  const summary = workbook.getWorksheet("Ringkasan Buku Besar")!;
  const account11105 = summary.getRow(7);
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
  assert.equal(detail.getRow(5).getCell(6).value, null);
  assert.equal(detail.getRow(7).getCell(3).alignment?.wrapText, true);
  assert.equal(detail.pageSetup.printTitlesRow, "5:5");
});

test("PDF dan Excel mempertahankan Debit 11105 dengan dua desimal", async () => {
  const pdf = await renderRingkasanBukuBesarPdf("BC PADEL CLUB", "2026-05", LEDGER_SUMMARY);
  assert.equal(pdfContainsText(pdf, "370.361.513,75"), true);
  const workbook = buildFinancialWorkbook({ period: "2026-05", companyName: "BC PADEL CLUB", balanceSheet: BALANCE_SHEET, profitLoss: PROFIT_LOSS, cashFlow: CASH_FLOW, ledgerSummary: LEDGER_SUMMARY, ledgerEntries: [] });
  const row = workbook.getWorksheet("Ringkasan Buku Besar")!.getRow(7);
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

test("route export baca snapshot (guard auth) & petakan timeout ke 504", () => {
  for (const file of ["../app/api/olsera/financial/export/excel/route.ts", "../app/api/olsera/financial/export/pdf/route.ts"]) {
    const source = readFileSync(here(file), "utf8");
    assert.ok(/guard\(\)/.test(source), `${file} harus memanggil guard() (auth)`);
    assert.ok(/isDatabaseTimeoutError/.test(source) && /504/.test(source), `${file} harus memetakan timeout DB ke 504`);
    assert.ok(!/olsera-financial-client/.test(source), `${file} tidak boleh menyentuh Olsera live`);
  }
});
