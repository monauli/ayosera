// Generator Excel Laporan Keuangan Olsera (Tahap 4C) — SATU workbook gabungan
// berisi 5 sheet untuk periode terpilih:
//   1. Ringkasan Buku Besar  2. Arus Kas  3. Laba Rugi  4. Neraca  5. Buku Besar Detail
//
// Murni: menerima data yang SUDAH diambil dari snapshot MongoDB (tidak menyentuh
// Mongo/Olsera di sini) + memakai flattener pure dari olsera-financial-export-core.
// Angka disimpan sebagai number dengan numFmt akuntansi Indonesia (negatif dalam
// kurung) supaya bisa dijumlah di Excel dan tetap tampil konsisten.
import ExcelJS from "exceljs";
import { sanitizeExcelCellValue } from "./excel-sanitization.ts";
import {
  buildBalanceSheetLines,
  buildCashFlowLines,
  buildLedgerDetailGroups,
  buildLedgerSummaryRows,
  buildProfitLossLines,
  draftReportNotice,
  filterZeroLedgerSummaryRows,
  filterZeroStatementLines,
  formatAccountingID,
  formatPeriodDateRangeEN,
  formatPeriodLabelID,
  type BalanceSheetPayload,
  type CashFlowPayload,
  type LedgerAccountDetailReport,
  type LedgerEntryInput,
  type LedgerSummaryRow,
  type ProfitLossPayload,
  type StatementLine,
} from "./olsera-financial-export-core.ts";

const FONT = "Calibri";
const MONEY_FMT = "#,##0.00;(#,##0.00)";
const SECTION_FILL = "FF1F2937"; // slate-800
const GROUP_FILL = "FFE5E7EB"; // gray-200
const TOTAL_FILL = "FFD1D5DB"; // gray-300
const HEADER_FILL = "FF374151"; // slate-700
const BLACK = "FF000000";
const DRAFT_RED = "FFB91C1C";

function fill(argb: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}
function topBorder(): Partial<ExcelJS.Borders> {
  return { top: { style: "thin", color: { argb: BLACK } } };
}

/** Label baris ringkasan (mis. "Total"/"Saldo Akhir") pada sheet Buku Besar per akun. */
function styleSummaryLabelCell(cell: ExcelJS.Cell) {
  cell.font = { name: FONT, bold: true, size: 9 };
  cell.alignment = { horizontal: "right" };
}
/** Nilai uang baris ringkasan pada sheet Buku Besar per akun (opsional garis atas untuk baris Total). */
function styleSummaryMoneyCell(cell: ExcelJS.Cell, value: number, withTopBorder = false) {
  cell.value = value;
  cell.numFmt = MONEY_FMT;
  cell.alignment = { horizontal: "right" };
  cell.font = { name: FONT, bold: true, size: 9 };
  if (withTopBorder) cell.border = topBorder();
}
function topBottomBorder(): Partial<ExcelJS.Borders> {
  return { top: { style: "thin", color: { argb: BLACK } }, bottom: { style: "double", color: { argb: BLACK } } };
}

function configurePrint(sheet: ExcelJS.Worksheet, lastColumn: string, headerRow = 5) {
  sheet.views = [{ state: "frozen", ySplit: headerRow }];
  sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  sheet.pageSetup.printArea = `A1:${lastColumn}${sheet.rowCount}`;
  sheet.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;
}

export interface FinancialExcelInput {
  period: string;
  companyName: string;
  balanceSheet: BalanceSheetPayload | null;
  profitLoss: ProfitLossPayload | null;
  cashFlow: CashFlowPayload | null;
  ledgerSummary: LedgerSummaryRow[] | null;
  ledgerEntries: LedgerEntryInput[];
  accountNameByCode?: Map<string, string>;
  /** Waktu sinkron terakhir (ISO/Date) — dipakai hanya untuk label bulan berjalan. */
  lastSyncedAt?: string | Date | null;
}

function titleBlock(
  sheet: ExcelJS.Worksheet,
  companyName: string,
  reportTitle: string,
  periodText: string,
  lastCol: number,
  draftLines?: string[],
  infoLines?: string[],
): number {
  const company = sheet.addRow([sanitizeExcelCellValue(companyName)]);
  company.font = { name: FONT, bold: true, size: 14 };
  company.alignment = { horizontal: "center" };
  sheet.mergeCells(company.number, 1, company.number, lastCol);

  const title = sheet.addRow([sanitizeExcelCellValue(reportTitle)]);
  title.font = { name: FONT, bold: true, size: 12 };
  title.alignment = { horizontal: "center" };
  sheet.mergeCells(title.number, 1, title.number, lastCol);

  const period = sheet.addRow([sanitizeExcelCellValue(periodText)]);
  period.font = { name: FONT, size: 11 };
  period.alignment = { horizontal: "center" };
  sheet.mergeCells(period.number, 1, period.number, lastCol);

  // Bulan berjalan / belum final — hanya digambar bila periode adalah bulan
  // berjalan (lihat draftReportNotice di olsera-financial-export-core.ts).
  // Baris laporan bulan lain/lama tidak bertambah dan tidak berubah.
  for (const line of draftLines ?? []) {
    const draftRow = sheet.addRow([sanitizeExcelCellValue(line)]);
    draftRow.font = { name: FONT, bold: true, size: 11, color: { argb: DRAFT_RED } };
    draftRow.alignment = { horizontal: "center" };
    sheet.mergeCells(draftRow.number, 1, draftRow.number, lastCol);
  }

  // Baris info tambahan (mis. Kode Akun/Nama Akun/Saldo Awal untuk Buku Besar
  // satu akun) — gaya normal, di bawah periode/draftLines.
  for (const line of infoLines ?? []) {
    const infoRow = sheet.addRow([sanitizeExcelCellValue(line)]);
    infoRow.font = { name: FONT, size: 10.5 };
    infoRow.alignment = { horizontal: "center" };
    sheet.mergeCells(infoRow.number, 1, infoRow.number, lastCol);
  }

  sheet.addRow([]);
  return sheet.rowCount + 1;
}

/** Sheet laporan berstruktur (Neraca/Laba Rugi/Arus Kas) dari StatementLine[]. */
function renderStatementSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  reportTitle: string,
  periodText: string,
  companyName: string,
  lines: StatementLine[],
  layout: "code-name-amount" | "name-amount",
  draftLines?: string[],
) {
  const sheet = workbook.addWorksheet(sheetName);
  const amountCol = layout === "code-name-amount" ? 3 : 2;
  const headerRow = titleBlock(sheet, companyName, reportTitle, periodText, amountCol, draftLines);

  // Header kolom
  const header =
    layout === "code-name-amount" ? sheet.addRow(["Kode Akun", "Nama Akun", "Jumlah"]) : sheet.addRow(["Keterangan", "Jumlah"]);
  header.eachCell((cell, colNumber) => {
    cell.font = { name: FONT, bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(HEADER_FILL);
    cell.alignment = { horizontal: colNumber === amountCol ? "right" : "left" };
  });

  for (const line of lines) {
    const row = sheet.addRow([]);
    const amountCell = row.getCell(amountCol);
    if (line.amount !== null) {
      amountCell.value = line.amount;
      amountCell.numFmt = MONEY_FMT;
      amountCell.alignment = { horizontal: "right" };
    }
    switch (line.kind) {
      case "section": {
        const cell = row.getCell(1);
        cell.value = sanitizeExcelCellValue(line.label);
        cell.font = { name: FONT, bold: true, size: 11, color: { argb: "FFFFFFFF" } };
        sheet.mergeCells(row.number, 1, row.number, amountCol);
        row.eachCell((c) => (c.fill = fill(SECTION_FILL)));
        break;
      }
      case "group": {
        const cell = row.getCell(1);
        cell.value = sanitizeExcelCellValue(line.label);
        cell.font = { name: FONT, bold: true, size: 10 };
        sheet.mergeCells(row.number, 1, row.number, amountCol);
        row.eachCell((c) => (c.fill = fill(GROUP_FILL)));
        break;
      }
      case "account": {
        row.getCell(1).value = sanitizeExcelCellValue(line.code ?? "");
        row.getCell(1).font = { name: FONT, size: 10 };
        if (layout === "code-name-amount") {
          row.getCell(2).value = sanitizeExcelCellValue(line.label);
          row.getCell(2).font = { name: FONT, size: 10 };
        } else {
          row.getCell(1).value = sanitizeExcelCellValue(line.label);
        }
        row.getCell(layout === "code-name-amount" ? 2 : 1).alignment = { wrapText: true, vertical: "top" };
        amountCell.font = { name: FONT, size: 10 };
        break;
      }
      case "line": {
        // Baris nilai tanpa kode akun — nama pada kolom pertama non-amount.
        const labelCol = layout === "code-name-amount" ? 2 : 1;
        row.getCell(labelCol).value = sanitizeExcelCellValue(line.label);
        row.getCell(labelCol).font = { name: FONT, size: 10 };
        row.getCell(labelCol).alignment = { wrapText: true, vertical: "top" };
        amountCell.font = { name: FONT, size: 10 };
        break;
      }
      case "subtotal": {
        row.getCell(1).value = sanitizeExcelCellValue(line.label);
        row.getCell(1).font = { name: FONT, bold: true, size: 10 };
        sheet.mergeCells(row.number, 1, row.number, amountCol - 1);
        amountCell.font = { name: FONT, bold: true, size: 10 };
        amountCell.border = topBorder();
        break;
      }
      case "total": {
        row.getCell(1).value = sanitizeExcelCellValue(line.label);
        row.getCell(1).font = { name: FONT, bold: true, size: 11 };
        sheet.mergeCells(row.number, 1, row.number, amountCol - 1);
        amountCell.font = { name: FONT, bold: true, size: 11 };
        amountCell.border = topBottomBorder();
        row.eachCell((c) => (c.fill = fill(TOTAL_FILL)));
        break;
      }
    }
  }

  if (layout === "code-name-amount") {
    sheet.getColumn(1).width = 14;
    sheet.getColumn(2).width = 46;
    sheet.getColumn(3).width = 22;
  } else {
    sheet.getColumn(1).width = 52;
    sheet.getColumn(2).width = 22;
  }
  configurePrint(sheet, amountCol === 3 ? "C" : "B", headerRow);
  return sheet;
}

function renderLedgerSummarySheet(workbook: ExcelJS.Workbook, input: FinancialExcelInput, periodText: string, draftLines?: string[]) {
  const sheet = workbook.addWorksheet("Ringkasan Buku Besar");
  const headerRow = titleBlock(sheet, input.companyName, "Ringkasan Buku Besar", periodText, 6, draftLines);

  const header = sheet.addRow(["Nomor Akun", "Nama Akun", "Klasifikasi", "Debit", "Kredit", "Saldo"]);
  header.eachCell((cell, colNumber) => {
    cell.font = { name: FONT, bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(HEADER_FILL);
    cell.alignment = { horizontal: colNumber >= 4 ? "right" : "left" };
  });

  for (const row of filterZeroLedgerSummaryRows(buildLedgerSummaryRows(input.ledgerSummary))) {
    const r = sheet.addRow([row.code, row.name, row.classification].map(sanitizeExcelCellValue));
    r.font = { name: FONT, size: 10 };
    r.getCell(2).alignment = { wrapText: true, vertical: "top" };
    r.getCell(3).alignment = { wrapText: true, vertical: "top" };
    const debit = r.getCell(4);
    const credit = r.getCell(5);
    const saldo = r.getCell(6);
    debit.value = row.debit;
    credit.value = row.credit;
    saldo.value = row.balance;
    debit.numFmt = MONEY_FMT;
    credit.numFmt = MONEY_FMT;
    saldo.numFmt = MONEY_FMT;
    for (const cell of [debit, credit, saldo]) {
      cell.alignment = { horizontal: "right" };
      cell.font = { name: FONT, size: 10 };
    }
  }

  sheet.getColumn(1).width = 12;
  sheet.getColumn(2).width = 40;
  sheet.getColumn(3).width = 32;
  sheet.getColumn(4).width = 18;
  sheet.getColumn(5).width = 18;
  sheet.getColumn(6).width = 18;
  configurePrint(sheet, "F", headerRow);
}

function renderLedgerDetailSheet(workbook: ExcelJS.Workbook, input: FinancialExcelInput, periodText: string, draftLines?: string[]) {
  const sheet = workbook.addWorksheet("Buku Besar Detail");
  const headerRow = titleBlock(sheet, input.companyName, "Buku Besar Detail", periodText, 5, draftLines);

  const header = sheet.addRow(["Tanggal", "No. Jurnal", "Deskripsi", "Debit", "Kredit"]);
  header.eachCell((cell, colNumber) => {
    cell.font = { name: FONT, bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(HEADER_FILL);
    cell.alignment = { horizontal: colNumber >= 4 ? "right" : "left" };
  });

  const groups = buildLedgerDetailGroups(input.ledgerEntries, input.accountNameByCode);
  for (const group of groups) {
    const accountRow = sheet.addRow([sanitizeExcelCellValue(`${group.code} — ${group.name}`)]);
    accountRow.getCell(1).font = { name: FONT, bold: true, size: 10 };
    sheet.mergeCells(accountRow.number, 1, accountRow.number, 5);
    accountRow.eachCell((c) => (c.fill = fill(GROUP_FILL)));

    for (const entry of group.entries) {
      const r = sheet.addRow([entry.date, entry.transactionNo, entry.description].map(sanitizeExcelCellValue));
      r.font = { name: FONT, size: 9 };
      r.getCell(3).alignment = { wrapText: true, vertical: "top" };
      const debit = r.getCell(4);
      const credit = r.getCell(5);
      if (!entry.isOpeningBalance && entry.debit) debit.value = entry.debit;
      if (!entry.isOpeningBalance && entry.credit) credit.value = entry.credit;
      for (const cell of [debit, credit]) {
        cell.numFmt = MONEY_FMT;
        cell.alignment = { horizontal: "right" };
        cell.font = { name: FONT, size: 9 };
      }
    }

    const totalRow = sheet.addRow(["", "", "Total Pergerakan"]);
    totalRow.getCell(3).font = { name: FONT, bold: true, size: 9 };
    totalRow.getCell(3).alignment = { horizontal: "right" };
    totalRow.getCell(4).value = group.totalDebit;
    totalRow.getCell(5).value = group.totalCredit;
    for (const col of [4, 5]) {
      const cell = totalRow.getCell(col);
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: "right" };
      cell.font = { name: FONT, bold: true, size: 9 };
      cell.border = topBorder();
    }
  }

  if (!groups.length) {
    const empty = sheet.addRow(["Tidak ada data buku besar pada periode ini."]);
    empty.getCell(1).font = { name: FONT, italic: true, size: 10 };
    sheet.mergeCells(empty.number, 1, empty.number, 5);
  }

  sheet.getColumn(1).width = 20;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 56;
  sheet.getColumn(4).width = 18;
  sheet.getColumn(5).width = 18;
  configurePrint(sheet, "E", headerRow);
}

/** Susun workbook gabungan 5-sheet. Urutan sheet mengikuti spesifikasi Tahap 4C. */
export function buildFinancialWorkbook(input: FinancialExcelInput): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AYOSERA";
  const periodLabel = formatPeriodLabelID(input.period);
  const notice = draftReportNotice(input.period, input.lastSyncedAt);
  const draftLines = notice.isDraft ? [notice.label, notice.detail] : undefined;

  renderLedgerSummarySheet(workbook, input, periodLabel, draftLines);

  renderStatementSheet(
    workbook,
    "Arus Kas",
    "Laporan Arus Kas",
    formatPeriodDateRangeEN(input.period),
    input.companyName,
    input.cashFlow ? filterZeroStatementLines(buildCashFlowLines(input.cashFlow)) : [],
    "name-amount",
    draftLines,
  );

  renderStatementSheet(
    workbook,
    "Laba Rugi",
    "Laporan Laba Rugi",
    periodLabel,
    input.companyName,
    input.profitLoss ? filterZeroStatementLines(buildProfitLossLines(input.profitLoss)) : [],
    "code-name-amount",
    draftLines,
  );

  renderStatementSheet(
    workbook,
    "Neraca",
    "Laporan Neraca",
    periodLabel,
    input.companyName,
    input.balanceSheet ? filterZeroStatementLines(buildBalanceSheetLines(input.balanceSheet)) : [],
    "code-name-amount",
    draftLines,
  );

  renderLedgerDetailSheet(workbook, input, periodLabel, draftLines);

  return workbook;
}

// ---------------------------------------------------------------------------
// Buku Besar Detail — SATU akun ("Download Akun Ini", satu sheet)
// ---------------------------------------------------------------------------

export interface LedgerAccountExcelInput {
  period: string;
  companyName: string;
  detail: LedgerAccountDetailReport;
  lastSyncedAt?: string | Date | null;
}

/** Workbook satu sheet "Buku Besar Detail" berisi HANYA satu akun. */
export function buildLedgerAccountWorkbook(input: LedgerAccountExcelInput): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AYOSERA";
  const periodLabel = formatPeriodLabelID(input.period);
  const notice = draftReportNotice(input.period, input.lastSyncedAt);
  const draftLines = notice.isDraft ? [notice.label, notice.detail] : undefined;
  const { detail } = input;

  const sheet = workbook.addWorksheet("Buku Besar Detail");
  const headerRow = titleBlock(sheet, input.companyName, "Buku Besar Detail", periodLabel, 5, draftLines, [
    `Kode Akun: ${detail.code}`,
    `Nama Akun: ${detail.name}`,
    `Saldo Awal: ${formatAccountingID(detail.openingBalance)}`,
  ]);

  const header = sheet.addRow(["Tanggal", "No. Jurnal", "Deskripsi", "Debit", "Kredit"]);
  header.eachCell((cell, colNumber) => {
    cell.font = { name: FONT, bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(HEADER_FILL);
    cell.alignment = { horizontal: colNumber >= 4 ? "right" : "left" };
  });

  for (const entry of detail.entries) {
    const r = sheet.addRow([entry.date, entry.transactionNo, entry.description].map(sanitizeExcelCellValue));
    r.font = { name: FONT, size: 9 };
    r.getCell(3).alignment = { wrapText: true, vertical: "top" };
    const debit = r.getCell(4);
    const credit = r.getCell(5);
    if (entry.debit) debit.value = entry.debit;
    if (entry.credit) credit.value = entry.credit;
    for (const cell of [debit, credit]) {
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: "right" };
      cell.font = { name: FONT, size: 9 };
    }
  }

  if (!detail.entries.length) {
    const empty = sheet.addRow(["Tidak ada transaksi pada periode ini."]);
    empty.getCell(1).font = { name: FONT, italic: true, size: 10 };
    sheet.mergeCells(empty.number, 1, empty.number, 5);
  }

  // Total debit/kredit, pergerakan periode, saldo akhir — baris saldo/total, selalu tampil (tidak difilter Fitur 2).
  const totalRow = sheet.addRow(["", "", "Total"]);
  styleSummaryLabelCell(totalRow.getCell(3));
  styleSummaryMoneyCell(totalRow.getCell(4), detail.totalDebit, true);
  styleSummaryMoneyCell(totalRow.getCell(5), detail.totalCredit, true);

  const movementRow = sheet.addRow(["", "", "Pergerakan Periode"]);
  styleSummaryLabelCell(movementRow.getCell(3));
  styleSummaryMoneyCell(movementRow.getCell(5), detail.movement);

  const endingRow = sheet.addRow(["", "", "Saldo Akhir"]);
  styleSummaryLabelCell(endingRow.getCell(3));
  styleSummaryMoneyCell(endingRow.getCell(5), detail.endingBalance);

  sheet.getColumn(1).width = 20;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 56;
  sheet.getColumn(4).width = 18;
  sheet.getColumn(5).width = 18;
  configurePrint(sheet, "E", headerRow);
  return workbook;
}
