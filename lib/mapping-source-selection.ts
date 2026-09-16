import type { MappingSourceDocument } from "./mongodb.ts";

/** Satu Excel terbaru, tetapi satu PDF terbaru untuk SETIAP periode. */
export function selectMappingSources(rows: readonly MappingSourceDocument[]): MappingSourceDocument[] {
  const sorted = [...rows].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  const excel = sorted.find((row) => row.kind === "excel");
  const pdfByPeriod = new Map<string, MappingSourceDocument>();
  const legacyPdf: MappingSourceDocument[] = [];
  for (const row of sorted) {
    if (row.kind !== "pdf") continue;
    if (!row.period) {
      legacyPdf.push(row);
      continue;
    }
    if (!pdfByPeriod.has(row.period)) pdfByPeriod.set(row.period, row);
  }
  return [
    ...(excel ? [excel] : []),
    ...[...pdfByPeriod.values(), ...legacyPdf].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime()),
  ];
}

export function selectPdfForPeriod<T extends { period?: string }>(rows: readonly T[], period: string): T | null {
  return rows.find((row) => row.period === period) ?? null;
}
