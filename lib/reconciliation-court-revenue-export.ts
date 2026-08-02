// Export Excel — Rekonsiliasi AYO vs Olsera (Milestone 3, Bagian I). 6 sheet
// minimal sesuai instruksi: Ringkasan, Per Hari, Per Court, Mismatch, Manual
// Review, Root Cause. Reuse pola sanitasi formula-injection & format angka
// dari lib/olsera-category-export.ts (exceljs sudah dipakai luas di repo ini
// — bukan dependency baru).
import ExcelJS from "exceljs";
import { sanitizeExcelCellValue, sanitizeExcelText } from "./excel-sanitization.ts";
import type { CourtRevenueFindingWithRootCause, DailyRollup, MonthlyRollup, RootCauseSummaryRow } from "./reconciliation-court-revenue-aggregate.ts";
import type { ManualReviewItem } from "./reconciliation-manual-review.ts";
import { statusLabel, type ReconciliationStatus } from "./reconciliation-types.ts";

const MONEY_FMT = '"IDR" #,##0';
const HEADER_GRAY = "FFA6A6A6";
const BLACK = "FF000000";
const FONT = "Aptos Narrow";

function fill(argb: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return sanitizeExcelText(String(value));
}

function writeHeaderRow(ws: ExcelJS.Worksheet, headers: string[]) {
  headers.forEach((label, index) => {
    const cell = ws.getCell(1, index + 1);
    cell.value = label;
    cell.fill = fill(HEADER_GRAY);
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: BLACK } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  ws.getRow(1).height = 24;
}

function writeDataRow(ws: ExcelJS.Worksheet, rowNumber: number, values: ExcelJS.CellValue[], moneyColumns: number[]) {
  values.forEach((value, index) => {
    const column = index + 1;
    const cell = ws.getCell(rowNumber, column);
    cell.value = sanitizeExcelCellValue(value);
    cell.font = { name: FONT, size: 10, color: { argb: BLACK } };
    if (moneyColumns.includes(column)) {
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: "right", vertical: "middle" };
    } else {
      cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    }
  });
}

function autoWidth(ws: ExcelJS.Worksheet, widths: number[]) {
  widths.forEach((width, index) => {
    ws.getColumn(index + 1).width = width;
  });
}

export type CourtRevenueAuditWorkbookInput = {
  period: string; // YYYY-MM
  monthly: MonthlyRollup;
  daily: DailyRollup[];
  courtFindings: CourtRevenueFindingWithRootCause[];
  manualReview: ManualReviewItem[];
  rootCauses: RootCauseSummaryRow[];
  auditedAt: Date;
};

const NON_MATCH_STATUSES: ReconciliationStatus[] = ["MISMATCH", "MISSING_IN_AYO", "MISSING_IN_OLSERA", "AMBIGUOUS", "BUTUH_ADJUST_MANUAL"];

export async function buildCourtRevenueAuditWorkbook(input: CourtRevenueAuditWorkbookInput): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AYO Olsera — Rekonsiliasi AYO vs Olsera";
  wb.created = input.auditedAt;
  wb.modified = input.auditedAt;
  wb.calcProperties.fullCalcOnLoad = true;

  // 1. Ringkasan
  {
    const ws = wb.addWorksheet("Ringkasan");
    const rows: Array<[string, ExcelJS.CellValue]> = [
      ["Periode", input.period],
      ["Total Omzet AYO (IDR)", input.monthly.ayoRevenue],
      ["Total Omzet Olsera (IDR)", input.monthly.olseraRevenue],
      ["Selisih (IDR)", input.monthly.difference],
      ["Selisih (%)", input.monthly.differencePercent === null ? "-" : `${input.monthly.differencePercent.toFixed(2)}%`],
      ["Jumlah MATCH/MINOR_DIFFERENCE", input.monthly.matchCount],
      ["Jumlah MISMATCH", input.monthly.mismatchCount],
      ["Jumlah Butuh Tinjauan Manual", input.monthly.manualReviewCount],
      ["Status Keseluruhan", statusLabel(input.monthly.status)],
      ["Tanggal Audit", input.auditedAt.toISOString()],
    ];
    rows.forEach(([label, value], index) => {
      const rowNumber = index + 1;
      ws.getCell(rowNumber, 1).value = text(label);
      ws.getCell(rowNumber, 1).font = { name: FONT, size: 10, bold: true };
      const valueCell = ws.getCell(rowNumber, 2);
      valueCell.value = typeof value === "number" ? value : sanitizeExcelCellValue(value);
      valueCell.font = { name: FONT, size: 10 };
      if (typeof value === "number" && label.includes("IDR")) valueCell.numFmt = MONEY_FMT;
    });
    autoWidth(ws, [32, 28]);
  }

  // 2. Per Hari (Level 2)
  {
    const ws = wb.addWorksheet("Per Hari");
    writeHeaderRow(ws, ["Tanggal", "Omzet AYO (IDR)", "Omzet Olsera (IDR)", "Selisih (IDR)", "Status"]);
    input.daily.forEach((row, index) => {
      writeDataRow(ws, index + 2, [row.date, row.ayoRevenue, row.olseraRevenue, row.difference, statusLabel(row.status)], [2, 3, 4]);
    });
    autoWidth(ws, [14, 20, 20, 18, 24]);
  }

  // 3. Per Court (Level 3)
  {
    const ws = wb.addWorksheet("Per Court");
    writeHeaderRow(ws, ["Tanggal", "Court", "Omzet AYO (IDR)", "Omzet Olsera (IDR)", "Selisih (IDR)", "Status"]);
    input.courtFindings.forEach((row, index) => {
      writeDataRow(ws, index + 2, [row.date, text(row.courtKey), row.ayoRevenue, row.olseraRevenue, row.olseraRevenue - row.ayoRevenue, statusLabel(row.status)], [3, 4, 5]);
    });
    autoWidth(ws, [14, 26, 20, 20, 18, 24]);
  }

  // 4. Mismatch
  {
    const ws = wb.addWorksheet("Mismatch");
    writeHeaderRow(ws, ["Tanggal", "Court", "Omzet AYO (IDR)", "Omzet Olsera (IDR)", "Selisih (IDR)", "Status", "Root Cause", "Confidence"]);
    const mismatches = input.courtFindings.filter((f) => NON_MATCH_STATUSES.includes(f.status));
    mismatches.forEach((row, index) => {
      writeDataRow(
        ws,
        index + 2,
        [row.date, text(row.courtKey), row.ayoRevenue, row.olseraRevenue, row.olseraRevenue - row.ayoRevenue, statusLabel(row.status), text(row.rootCause?.label ?? "-"), text(row.rootCause?.confidence ?? "-")],
        [3, 4, 5],
      );
    });
    autoWidth(ws, [14, 26, 20, 20, 18, 22, 28, 14]);
  }

  // 5. Manual Review
  {
    const ws = wb.addWorksheet("Manual Review");
    writeHeaderRow(ws, ["Sumber", "Domain", "Periode", "Status", "Alasan", "Tindakan Direkomendasikan"]);
    input.manualReview.forEach((row, index) => {
      writeDataRow(ws, index + 2, [text(row.source), text(row.domainLabel), text(row.period), text(row.status), text(row.reason), text(row.recommendedAction)], []);
    });
    autoWidth(ws, [12, 20, 14, 22, 40, 40]);
  }

  // 6. Root Cause
  {
    const ws = wb.addWorksheet("Root Cause");
    writeHeaderRow(ws, ["Root Cause", "Confidence", "Jumlah Kasus", "Total Selisih Absolut (IDR)", "Periode"]);
    input.rootCauses.forEach((row, index) => {
      writeDataRow(ws, index + 2, [text(row.label), text(row.confidence), row.caseCount, row.totalAbsDifference, text(row.period)], [3, 4]);
    });
    autoWidth(ws, [28, 14, 14, 26, 12]);
  }

  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
