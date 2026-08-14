export const RECONCILIATION_TOLERANCE_RUPIAH = 1;

export function isWithinReconciliationTolerance(residual: number): boolean {
  return Math.abs(residual) <= RECONCILIATION_TOLERANCE_RUPIAH;
}
