import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMappingSources, selectPdfForPeriod } from "./mapping-source-selection.ts";
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
