import { test } from "node:test";
import assert from "node:assert/strict";
import { getCachedPdfReports, inferMappingSourcePeriod, selectMappingSources, selectPdfForPeriod, shouldAttemptPdfRestore } from "./mapping-source-selection.ts";
import type { MappingSourceDocument } from "./mongodb.ts";

const source = (kind: "excel" | "pdf", uploadedAt: string, period?: string): MappingSourceDocument => ({
  storeId: 1,
  kind,
  url: `${kind}-${uploadedAt}`,
  fileName: `${kind}-${uploadedAt}.pdf`,
  mimeType: kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: 1,
  period,
  uploadedAt: new Date(uploadedAt),
  uploadedBy: "test@example.com",
});

test("sumber mapping mempertahankan PDF per periode dan hanya memilih Excel terbaru", () => {
  const selected = selectMappingSources([
    source("pdf", "2026-03-02T00:00:00.000Z", "2026-03"),
    source("pdf", "2026-02-02T00:00:00.000Z", "2026-02"),
    source("pdf", "2026-03-01T00:00:00.000Z", "2026-03"),
    source("excel", "2026-02-01T00:00:00.000Z"),
    source("excel", "2026-03-01T00:00:00.000Z"),
  ]);

  assert.equal(selected.filter((item) => item.kind === "excel").length, 1);
  assert.equal(selected.find((item) => item.kind === "excel")?.uploadedAt.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.deepEqual(
    selected.filter((item) => item.kind === "pdf").map((item) => item.period),
    ["2026-03", "2026-02"],
  );
  assert.equal(selected.find((item) => item.period === "2026-03")?.uploadedAt.toISOString(), "2026-03-02T00:00:00.000Z");
  assert.equal(selectPdfForPeriod(selected, "2026-02")?.url, "pdf-2026-02-02T00:00:00.000Z");
  assert.equal(selectPdfForPeriod(selected, "2026-04"), null);
});

test("periode PDF lama dapat dikenali dari nama file tanpa OCR", () => {
  assert.equal(inferMappingSourcePeriod("Laporan Keuangan 0226_compressed.pdf"), "2026-02");
  assert.equal(inferMappingSourcePeriod("Laporan Keuangan Maret 2026.pdf"), "2026-03");
  assert.equal(inferMappingSourcePeriod("dokumen-tanpa-periode.pdf"), null);
  const [selected] = selectMappingSources([source("pdf", "2026-02-01T00:00:00.000Z")].map((item) => ({ ...item, fileName: "Laporan Keuangan 0226_compressed.pdf" })));
  assert.equal(selected.period, "2026-02");
  assert.equal(selectPdfForPeriod([selected], "2026-02")?.fileName, "Laporan Keuangan 0226_compressed.pdf");
});

test("hasil PDF tersimpan dipakai hanya bila versinya masih sesuai", () => {
  const reports = { "profit-loss": { status: "ok" } };
  const cached = { parsedReports: reports, parsedWithVersion: "1" };
  assert.deepEqual(getCachedPdfReports(cached, "1"), reports);
  assert.deepEqual(getCachedPdfReports(cached, "2"), reports);
  assert.equal(getCachedPdfReports({ parsedReports: reports }, "1"), null);
});

test("pemulihan PDF yang gagal tidak mengulang percobaan identik", () => {
  assert.equal(shouldAttemptPdfRestore("2026-03|march.pdf", "2026-03", "march.pdf"), false);
  assert.equal(shouldAttemptPdfRestore("2026-03|march.pdf", "2026-04", "march.pdf"), true);
  assert.equal(shouldAttemptPdfRestore(null, "2026-03", "march.pdf"), true);
});
