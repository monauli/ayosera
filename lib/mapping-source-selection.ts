import type { MappingSourceDocument } from "./mongodb.ts";
import { repairCachedPdfReports, type FinancialSheetKind, type MappingParseResult } from "./mapping-parser.ts";

export function getCachedPdfReports<T extends { parsedReports?: unknown; parsedWithVersion?: string }>(source: T, _parserVersion: string): T["parsedReports"] | null {
  // Cached OCR is still usable after a parser upgrade. Re-OCR only when no
  // saved result exists; users should not wait again for an already-saved PDF.
  if (!source.parsedReports) return null;
  return repairCachedPdfReports(source.parsedReports as Record<FinancialSheetKind, MappingParseResult>);
}

export function shouldAttemptPdfRestore(lastAttemptKey: string | null, period: string, sourceKey: string): boolean {
  return lastAttemptKey !== `${period}|${sourceKey}`;
}

const MONTHS = new Map([
  ["januari", 1], ["februari", 2], ["maret", 3], ["april", 4], ["mei", 5], ["juni", 6],
  ["juli", 7], ["agustus", 8], ["september", 9], ["oktober", 10], ["november", 11], ["desember", 12],
  ["january", 1], ["february", 2], ["march", 3], ["may", 5], ["june", 6], ["july", 7],
  ["august", 8], ["october", 10], ["december", 12],
]);

function formatPeriod(month: string, year: string): string {
  const fullYear = year.length === 2 ? `20${year}` : year;
  return `${fullYear}-${month.padStart(2, "0")}`;
}

/** Mengambil periode dari pola nama file umum agar arsip lama tidak perlu di-OCR semua. */
export function inferMappingSourcePeriod(fileName: string): string | null {
  const normalized = fileName.toLowerCase();
  const named = normalized.match(/\b(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|january|february|march|may|june|july|august|october|december)\D+(20\d{2}|\d{2})\b/);
  if (named) return formatPeriod(String(MONTHS.get(named[1])!), named[2]);
  const compact = normalized.match(/(?:^|[^\d])(0[1-9]|1[0-2])(?:[-_ ]?)(20\d{2}|\d{2})(?:[^\d]|$)/);
  return compact ? formatPeriod(compact[1], compact[2]) : null;
}

/** Satu Excel terbaru, tetapi satu PDF terbaru untuk SETIAP periode. */
export function selectMappingSources(rows: readonly MappingSourceDocument[]): MappingSourceDocument[] {
  const sorted = [...rows].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  const excel = sorted.find((row) => row.kind === "excel");
  const pdfByPeriod = new Map<string, MappingSourceDocument>();
  const legacyPdf: MappingSourceDocument[] = [];
  for (const row of sorted) {
    if (row.kind !== "pdf") continue;
    const period = row.period ?? inferMappingSourcePeriod(row.fileName);
    if (!period) {
      legacyPdf.push(row);
      continue;
    }
    const candidate = row.period === period ? row : { ...row, period };
    const current = pdfByPeriod.get(period);
    // Upload ulang yang belum selesai OCR tidak boleh menutupi PDF lama yang
    // sudah punya cache. Pilih file terbaru bila keduanya sama-sama tersimpan;
    // bila tidak, gunakan hasil baca tersimpan agar periode tidak OCR ulang.
    if (!current || (!current.parsedReports && candidate.parsedReports)) pdfByPeriod.set(period, candidate);
  }
  return [
    ...(excel ? [excel] : []),
    ...[...pdfByPeriod.values(), ...legacyPdf].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime()),
  ];
}

export function selectPdfForPeriod<T extends { period?: string }>(rows: readonly T[], period: string): T | null {
  return rows.find((row) => row.period === period) ?? null;
}
