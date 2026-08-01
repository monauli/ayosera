// Glue server-side export Laporan Keuangan (Tahap 4C): baca snapshot MongoDB
// yang SUDAH tersimpan (lib/olsera-financial-store.ts) lalu rakit berkas Excel/PDF.
//
// TIDAK PERNAH memanggil Olsera live — hanya store baca-only (bandingkan
// app/api/olsera/financial/snapshot). Angka diambil dari normalizedPayload yang
// sama dengan yang dipakai UI, sehingga export konsisten dengan tampilan.
//
// Error database (timeout/koneksi) SENGAJA dibiarkan naik ke pemanggil (route)
// supaya dipetakan menjadi HTTP 504 terstruktur oleh mongodb-errors; hanya
// kegagalan pembuatan berkas yang ditangkap di sini menjadi "generation-failed".
import "server-only";
import {
  getFinancialSyncLogForPeriod,
  getMonthlyReportsForPeriod,
  listAllFinancialLedgerEntriesForAccount,
  listAllFinancialLedgerEntriesForPeriod,
  listFinancialAccounts,
  type FinancialCollections,
} from "./olsera-financial-store.ts";
import { collectSubtotalDiagnostics, validatePeriod } from "./olsera-financial-core.ts";
import {
  buildLedgerAccountDetail,
  DEFAULT_COMPANY_NAME,
  financialExportFileName,
  financialLedgerAccountExportFileName,
  isFinancialReportKind,
  type ExportFailureReason,
  type FinancialReportKind,
  type LedgerAccountDetailReport,
  type LedgerEntryInput,
} from "./olsera-financial-export-core.ts";
import { buildFinancialWorkbook, buildLedgerAccountWorkbook } from "./olsera-financial-excel.ts";
import {
  renderArusKasPdf,
  renderBukuBesarDetailPdf,
  renderLabaRugiPdf,
  renderLedgerAccountDetailPdf,
  renderNeracaPdf,
  renderRingkasanBukuBesarPdf,
} from "./olsera-financial-pdf.ts";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_CONTENT_TYPE = "application/pdf";

export type FinancialExportResult =
  | { ok: true; filename: string; contentType: string; body: Uint8Array | Buffer }
  | { ok: false; reason: ExportFailureReason };

function companyName(): string {
  const configured = process.env.OLSERA_COMPANY_NAME;
  return configured && configured.trim() ? configured.trim() : DEFAULT_COMPANY_NAME;
}

/** "2026-05" → periode tervalidasi, atau null bila tidak valid. */
function safePeriod(period: string): string | null {
  const [year, month] = (period ?? "").split("-");
  try {
    return validatePeriod(year, month);
  } catch {
    return null;
  }
}

/** Kode akun tervalidasi (angka, sama seperti aturan di route ledger snapshot), atau null bila tidak valid. */
function safeAccountCode(value: string): string | null {
  const trimmed = (value ?? "").trim();
  return /^\d{1,20}$/.test(trimmed) ? trimmed : null;
}

function accountNameMap(accounts: Array<{ accountCode?: string | null; accountName?: string | null }>, preferredEntries: Array<{ accountCode?: string | null; accountName?: string | null }> = [], preferredSummary: Array<{ accountCode?: string | null; accountName?: string | null }> = []): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of [...preferredEntries, ...preferredSummary, ...accounts]) {
    const code = (row.accountCode ?? "").toString().trim();
    if (code && !map.has(code)) map.set(code, (row.accountName ?? "").toString().trim());
  }
  return map;
}

/** Excel gabungan 5-sheet untuk periode. */
export async function generateFinancialExcelExport(rawPeriod: string, context?: FinancialCollections): Promise<FinancialExportResult> {
  const period = safePeriod(rawPeriod);
  if (!period) return { ok: false, reason: "invalid-period" };

  const [reports, accounts, ledgerEntries, syncLog] = await Promise.all([
    getMonthlyReportsForPeriod(period, context),
    listFinancialAccounts(context),
    listAllFinancialLedgerEntriesForPeriod(period, context),
    getFinancialSyncLogForPeriod(period, context),
  ]);

  if (!reports || Object.keys(reports).length === 0) return { ok: false, reason: "snapshot-missing" };
  const sourceWarningLines = collectSubtotalDiagnostics([
    reports["balance-sheet"]?.normalizedPayload,
    reports["profit-loss"]?.normalizedPayload,
    reports["cash-flow"]?.normalizedPayload,
  ]).map((line) => `PERINGATAN SUMBER: ${line}`);

  try {
    const workbook = buildFinancialWorkbook({
      period,
      companyName: companyName(),
      balanceSheet: (reports["balance-sheet"]?.normalizedPayload as never) ?? null,
      profitLoss: (reports["profit-loss"]?.normalizedPayload as never) ?? null,
      cashFlow: (reports["cash-flow"]?.normalizedPayload as never) ?? null,
      ledgerSummary: (reports["ledger-summary"]?.normalizedPayload as never) ?? null,
      ledgerEntries: ledgerEntries as unknown as LedgerEntryInput[],
      accountNameByCode: accountNameMap(accounts, ledgerEntries, (reports["ledger-summary"]?.normalizedPayload as unknown as any[]) ?? []),
      sourceWarningLines,
      lastSyncedAt: syncLog?.completedAt ?? null,
    });
    const body = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    return { ok: true, filename: financialExportFileName("excel", period), contentType: XLSX_CONTENT_TYPE, body };
  } catch {
    return { ok: false, reason: "generation-failed" };
  }
}

/** PDF satu jenis laporan untuk periode. */
export async function generateFinancialPdfExport(
  rawPeriod: string,
  rawKind: string,
  context?: FinancialCollections,
): Promise<FinancialExportResult> {
  const period = safePeriod(rawPeriod);
  if (!period) return { ok: false, reason: "invalid-period" };
  if (!isFinancialReportKind(rawKind)) return { ok: false, reason: "invalid-period" };
  const kind: FinancialReportKind = rawKind;
  const company = companyName();

  const syncLog = await getFinancialSyncLogForPeriod(period, context);
  const lastSyncedAt = syncLog?.completedAt ?? null;

  if (kind === "buku-besar-detail") {
    const [ledgerEntries, accounts] = await Promise.all([
      listAllFinancialLedgerEntriesForPeriod(period, context),
      listFinancialAccounts(context),
    ]);
    if (!ledgerEntries.length) return { ok: false, reason: "ledger-empty" };
    try {
      const body = await renderBukuBesarDetailPdf(company, period, ledgerEntries as unknown as LedgerEntryInput[], accountNameMap(accounts, ledgerEntries), lastSyncedAt);
      return { ok: true, filename: financialExportFileName(kind, period), contentType: PDF_CONTENT_TYPE, body };
    } catch {
      return { ok: false, reason: "generation-failed" };
    }
  }

  const reports = await getMonthlyReportsForPeriod(period, context);
  if (!reports || Object.keys(reports).length === 0) return { ok: false, reason: "snapshot-missing" };

  const reportTypeByKind: Record<Exclude<FinancialReportKind, "buku-besar-detail">, string> = {
    neraca: "balance-sheet",
    "laba-rugi": "profit-loss",
    "arus-kas": "cash-flow",
    "ringkasan-buku-besar": "ledger-summary",
  };
  const payload =
    (reports as Record<string, { normalizedPayload?: unknown } | undefined>)[reportTypeByKind[kind]]?.normalizedPayload ?? null;
  if (!payload) return { ok: false, reason: "invalid-payload" };
  const sourceWarningLines = collectSubtotalDiagnostics(payload).map((line) => `PERINGATAN SUMBER: ${line}`);

  try {
    let body: Uint8Array;
    switch (kind) {
      case "neraca":
        body = await renderNeracaPdf(company, period, payload as never, lastSyncedAt, sourceWarningLines);
        break;
      case "laba-rugi":
        body = await renderLabaRugiPdf(company, period, payload as never, lastSyncedAt, sourceWarningLines);
        break;
      case "arus-kas":
        body = await renderArusKasPdf(company, period, payload as never, lastSyncedAt, sourceWarningLines);
        break;
      case "ringkasan-buku-besar":
        body = await renderRingkasanBukuBesarPdf(company, period, payload as never, lastSyncedAt, sourceWarningLines);
        break;
    }
    return { ok: true, filename: financialExportFileName(kind, period), contentType: PDF_CONTENT_TYPE, body };
  } catch {
    return { ok: false, reason: "generation-failed" };
  }
}

type LedgerAccountLoadResult =
  | { ok: true; period: string; accountCode: string; detail: LedgerAccountDetailReport; lastSyncedAt: Date | string | null }
  | { ok: false; reason: ExportFailureReason };

/**
 * Validasi period+accountCode, ambil SELURUH ledger akun tsb dari Mongo (tanpa
 * pagination), dan bangun LedgerAccountDetailReport — dipakai bareng oleh
 * export PDF & Excel per akun ("Download Akun Ini") supaya query/validasi
 * tidak diduplikasi.
 */
async function loadLedgerAccountDetail(
  rawPeriod: string,
  rawAccountCode: string,
  context?: FinancialCollections,
): Promise<LedgerAccountLoadResult> {
  const period = safePeriod(rawPeriod);
  if (!period) return { ok: false, reason: "invalid-period" };
  const accountCode = safeAccountCode(rawAccountCode);
  if (!accountCode) return { ok: false, reason: "invalid-account" };

  const [rawEntries, accounts, syncLog] = await Promise.all([
    listAllFinancialLedgerEntriesForAccount(period, accountCode, context),
    listFinancialAccounts(context),
    getFinancialSyncLogForPeriod(period, context),
  ]);
  if (!rawEntries.length) return { ok: false, reason: "ledger-empty" };

  const detail = buildLedgerAccountDetail(rawEntries as unknown as LedgerEntryInput[], accountCode, accountNameMap(accounts, rawEntries));
  return { ok: true, period, accountCode, detail, lastSyncedAt: syncLog?.completedAt ?? null };
}

/**
 * Buku Besar Detail SATU akun ("Download Akun Ini") — PDF. Query Mongo
 * khusus akun (listAllFinancialLedgerEntriesForAccount), TANPA pagination,
 * supaya seluruh transaksi akun ikut. Tidak menyentuh/mengubah export Buku
 * Besar lengkap (generateFinancialPdfExport tetap seperti semula).
 */
export async function generateFinancialLedgerAccountPdfExport(
  rawPeriod: string,
  rawAccountCode: string,
  context?: FinancialCollections,
): Promise<FinancialExportResult> {
  const loaded = await loadLedgerAccountDetail(rawPeriod, rawAccountCode, context);
  if (!loaded.ok) return loaded;
  try {
    const body = await renderLedgerAccountDetailPdf(companyName(), loaded.period, loaded.detail, loaded.lastSyncedAt);
    return {
      ok: true,
      filename: financialLedgerAccountExportFileName("pdf", loaded.accountCode, loaded.detail.name, loaded.period),
      contentType: PDF_CONTENT_TYPE,
      body,
    };
  } catch {
    return { ok: false, reason: "generation-failed" };
  }
}

/** Buku Besar Detail SATU akun ("Download Akun Ini") — Excel (satu sheet). */
export async function generateFinancialLedgerAccountExcelExport(
  rawPeriod: string,
  rawAccountCode: string,
  context?: FinancialCollections,
): Promise<FinancialExportResult> {
  const loaded = await loadLedgerAccountDetail(rawPeriod, rawAccountCode, context);
  if (!loaded.ok) return loaded;
  try {
    const workbook = buildLedgerAccountWorkbook({ period: loaded.period, companyName: companyName(), detail: loaded.detail, lastSyncedAt: loaded.lastSyncedAt });
    const body = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    return {
      ok: true,
      filename: financialLedgerAccountExportFileName("excel", loaded.accountCode, loaded.detail.name, loaded.period),
      contentType: XLSX_CONTENT_TYPE,
      body,
    };
  } catch {
    return { ok: false, reason: "generation-failed" };
  }
}
