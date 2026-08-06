// Presentation-only filtering for the financial-source diagnostic panel.
// The snapshot diagnostic payload remains intact; this only controls rows
// shown to users.
export type FinancialSourceDiagnostic = {
  accountCode: string;
  accountName: string | null;
  status: string;
  summaryDebit: number;
  summaryCredit: number;
  detailDebit: number;
  detailCredit: number;
};

const NON_WARNING_STATUSES = new Set(["Data Lengkap", "Tidak Ada Transaksi"]);

export function hasNonZeroDiagnosticAmount(row: FinancialSourceDiagnostic): boolean {
  return row.summaryDebit !== 0 || row.summaryCredit !== 0 || row.detailDebit !== 0 || row.detailCredit !== 0;
}

export function visibleFinancialSourceDiagnostics(rows: readonly FinancialSourceDiagnostic[]): FinancialSourceDiagnostic[] {
  return rows.filter((row) => !NON_WARNING_STATUSES.has(row.status) && hasNonZeroDiagnosticAmount(row));
}
