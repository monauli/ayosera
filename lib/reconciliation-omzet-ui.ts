// Presentation-only status for the reconciliation screen. The canonical
// reconciliation engine still owns the calculation and its financial-report
// validation status; the UI labels a match when the computed difference is
// within the existing ±Rp1 tolerance.
export type ReconciliationOmzetUiStatus = "COCOK" | "SELISIH_TERJELASKAN" | "PERLU_DICEK" | "BULAN_BERJALAN";

const EXISTING_MATCH_TOLERANCE_IDR = 1;

export function reconciliationOmzetUiStatus(
  status: ReconciliationOmzetUiStatus,
  differenceRevenue: number,
): ReconciliationOmzetUiStatus {
  if (Math.abs(differenceRevenue) <= EXISTING_MATCH_TOLERANCE_IDR) return "COCOK";
  if (status === "BULAN_BERJALAN") return "BULAN_BERJALAN";
  if (status === "SELISIH_TERJELASKAN") return "SELISIH_TERJELASKAN";
  return "PERLU_DICEK";
}
