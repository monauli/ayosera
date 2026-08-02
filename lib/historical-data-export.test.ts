import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildHistoricalDataAuditWorkbook } from "./historical-data-export.ts";
import type { HistoricalDataSummary } from "./historical-data-aggregate.ts";

function sampleSummary(overrides: Partial<HistoricalDataSummary> = {}): HistoricalDataSummary {
  return {
    generatedAt: "2026-08-02T00:00:00.000Z",
    totalIssues: 2, autoFixable: 1, manual: 1, selesai: 1, pending: 2,
    categories: [
      { category: "PRODUCT_MAPPING", categoryLabel: "Historical Product Mapping", periode: "seluruh waktu (live)", jumlahData: 6271, penyebab: "Sync historis lama", dampak: "Aman untuk omzet", canAutoFix: true, confidence: "HIGH" },
    ],
    issues: [
      { id: "product-mapping:exact-match", category: "PRODUCT_MAPPING", categoryLabel: "Historical Product Mapping", period: "seluruh waktu (live)", issue: "5991 baris exact match", penyebab: "Sync historis lama", confidence: "HIGH", canAutoFix: true, tindakan: "Backfill otomatis", status: "pending", jumlahData: 5991 },
      { id: "product-mapping:ambiguous", category: "PRODUCT_MAPPING", categoryLabel: "Historical Product Mapping", period: "seluruh waktu (live)", issue: "276 baris ambigu", penyebab: "Kandidat >1", confidence: "LOW", canAutoFix: false, tindakan: "Butuh Adjust Manual", status: "manual", jumlahData: 276 },
    ],
    ...overrides,
  };
}

test("buildHistoricalDataAuditWorkbook: menghasilkan 3 sheet (Ringkasan, Per Kategori, Issue Detail)", async () => {
  const buffer = await buildHistoricalDataAuditWorkbook(sampleSummary());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  assert.deepEqual(wb.worksheets.map((ws) => ws.name), ["Ringkasan", "Per Kategori", "Issue Detail"]);
});

test("buildHistoricalDataAuditWorkbook: sheet Issue Detail memuat kolom issue/penyebab/confidence/tindakan/status", async () => {
  const buffer = await buildHistoricalDataAuditWorkbook(sampleSummary());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet("Issue Detail")!;
  const headers = ws.getRow(1).values as unknown[];
  for (const col of ["Issue", "Penyebab", "Confidence", "Tindakan", "Status"]) {
    assert.ok(headers.includes(col), `header ${col} harus ada`);
  }
  assert.equal(ws.rowCount, 3); // header + 2 issues
});

test("buildHistoricalDataAuditWorkbook: sheet Ringkasan mencerminkan bucket auto fixable/manual/selesai/pending", async () => {
  const buffer = await buildHistoricalDataAuditWorkbook(sampleSummary());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet("Ringkasan")!;
  const values = ws.getColumn(2).values.slice(1);
  assert.ok(values.includes(1), "autoFixable=1 harus muncul");
  assert.ok(values.includes(2), "totalIssues/pending=2 harus muncul");
});

test("buildHistoricalDataAuditWorkbook: nama issue yang diawali '=' diberi apostrof (anti formula injection)", async () => {
  const summary = sampleSummary({
    issues: [{ id: "x", category: "PRODUCT_MAPPING", categoryLabel: "Historical Product Mapping", period: "test", issue: "=CMD|'/c calc'!A1", penyebab: "-", confidence: "LOW", canAutoFix: false, tindakan: "-", status: "manual", jumlahData: 1 }],
  });
  const buffer = await buildHistoricalDataAuditWorkbook(summary);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet("Issue Detail")!;
  const value = ws.getRow(2).getCell(3).value; // kolom "Issue"
  assert.equal(typeof value, "string");
  assert.ok(String(value).startsWith("'="));
});

test("buildHistoricalDataAuditWorkbook: tidak ada payload mentah/token", async () => {
  const buffer = await buildHistoricalDataAuditWorkbook(sampleSummary());
  const text = Buffer.from(buffer).toString("latin1");
  assert.ok(!text.includes("AYO_API_TOKEN"));
  assert.ok(!text.includes("OLSERA_SECRET_KEY"));
  assert.ok(!text.includes("MONGODB_URI"));
});
