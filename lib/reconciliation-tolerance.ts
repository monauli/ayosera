export const RECONCILIATION_TOLERANCE_RUPIAH = 1;

export function isWithinReconciliationTolerance(residual: number): boolean {
  return Math.abs(residual) <= RECONCILIATION_TOLERANCE_RUPIAH;
}

export function absoluteAmountResidual(systemDifference: number, baAmount: number): number {
  return Math.abs(Math.abs(systemDifference) - Math.abs(baAmount));
}

export function amountsMatchWithinReconciliationTolerance(systemDifference: number, baAmount: number): boolean {
  return isWithinReconciliationTolerance(absoluteAmountResidual(systemDifference, baAmount));
}
