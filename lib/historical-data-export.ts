// Export Excel — Milestone 4 Bagian F (Historical Audit). Kolom minimal
// sesuai instruksi: issue, penyebab, confidence, tindakan, status — plus
// kategori/periode/jumlahData untuk konteks. Reuse pola sanitasi dan format
// yang sama dengan lib/reconciliation-court-revenue-export.ts (exceljs sudah
// dipakai luas di repo ini).
import ExcelJS from "exceljs";
import { sanitizeExcelCellValue, sanitizeExcelText } from "./excel-sanitization.ts";
import type { HistoricalCategoryReport, HistoricalDataSummary, HistoricalIssueItem } from "./historical-data-aggregate.ts";

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

function writeDataRow(ws: ExcelJS.Worksheet, rowNumber: number, values: ExcelJS.CellValue[]) {
  values.forEach((value, index) => {
    const cell = ws.getCell(rowNumber, index + 1);
    cell.value = sanitizeExcelCellValue(value);
    cell.font = { name: FONT, size: 10, color: { argb: BLACK } };
    cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  });
}

function autoWidth(ws: ExcelJS.Worksheet, widths: number[]) {
  widths.forEach((width, index) => ws.getColumn(index + 1).width = width);
}

function writeIssueSheet(ws: ExcelJS.Worksheet, issues: HistoricalIssueItem[]) {
  writeHeaderRow(ws, ["Kategori", "Periode", "Issue", "Penyebab", "Confidence", "Bisa Otomatis", "Tindakan", "Status", "Jumlah Data"]);
  issues.forEach((issue, i) => {
    writeDataRow(ws, i + 2, [
      text(issue.categoryLabel), text(issue.period), text(issue.issue), text(issue.penyebab),
      text(issue.confidence), issue.canAutoFix ? "YA" : "TIDAK", text(issue.tindakan), text(issue.status), issue.jumlahData,
    ]);
  });
  autoWidth(ws, [22, 16, 45, 45, 12, 12, 45, 10, 12]);
}

function writeCategorySheet(ws: ExcelJS.Worksheet, categories: HistoricalCategoryReport[]) {
  writeHeaderRow(ws, ["Kategori", "Periode", "Jumlah Data", "Penyebab", "Dampak", "Bisa Otomatis", "Confidence"]);
  categories.forEach((c, i) => {
    writeDataRow(ws, i + 2, [text(c.categoryLabel), text(c.periode), c.jumlahData, text(c.penyebab), text(c.dampak), c.canAutoFix ? "YA" : "TIDAK", text(c.confidence)]);
  });
  autoWidth(ws, [22, 16, 12, 45, 45, 12, 12]);
}

function writeSummarySheet(ws: ExcelJS.Worksheet, summary: HistoricalDataSummary, auditedAt: Date) {
  writeHeaderRow(ws, ["Metric", "Value"]);
  const rows: [string, unknown][] = [
    ["Dibuat pada", auditedAt.toISOString()],
    ["Total historical issue (belum selesai)", summary.totalIssues],
    ["Auto fixable (HIGH confidence, siap backfill)", summary.autoFixable],
    ["Manual (butuh keputusan manusia)", summary.manual],
    ["Selesai", summary.selesai],
    ["Pending (manual + auto-fixable belum dieksekusi)", summary.pending],
  ];
  rows.forEach(([metric, value], i) => writeDataRow(ws, i + 2, [text(metric), value as ExcelJS.CellValue]));
  autoWidth(ws, [45, 30]);
}

/** Bangun workbook "Historical Audit" — Ringkasan, Per Kategori, Issue Detail. */
export async function buildHistoricalDataAuditWorkbook(summary: HistoricalDataSummary, auditedAt: Date = new Date()): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AYO Real-Time Transaction Integration Platform";
  wb.created = auditedAt;

  writeSummarySheet(wb.addWorksheet("Ringkasan"), summary, auditedAt);
  writeCategorySheet(wb.addWorksheet("Per Kategori"), summary.categories);
  writeIssueSheet(wb.addWorksheet("Issue Detail"), summary.issues);

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
