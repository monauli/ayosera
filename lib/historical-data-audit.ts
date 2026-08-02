// Milestone 4 Bagian A — orchestrator TIPIS yang mengambil bukti read-only
// dari MongoDB (lewat modul-modul yang SUDAH ADA & teruji) dan
// menyerahkannya ke historical-data-aggregate.ts (pure) untuk digabungkan.
// Pola sama dengan app/api/supervisor/audit/court-revenue/_shared.ts
// (buildCourtRevenuePeriodData) — live compute, TIDAK bergantung pada
// koleksi persisted, supaya angka yang ditampilkan SELALU mencerminkan state
// MongoDB saat ini.
import "server-only";
import { loadHistoricalOrderItemIdentityAudit } from "./historical-order-item-source.ts";
import { summarizeClassifications } from "./historical-order-item-identity.ts";
import { getFinancialSummaryDiagnostics } from "./olsera-financial-store.ts";
import { buildManualReviewSummary } from "./reconciliation-manual-review.ts";
import {
  buildInventoryReport,
  buildLedgerAndAccountReports,
  buildProductMappingReport,
  buildReconciliationReport,
  buildSalesReport,
  buildSnapshotReport,
  buildTransactionReport,
  combineHistoricalDataSummary,
  type HistoricalDataSummary,
  type LedgerDiagnosticRow,
} from "./historical-data-aggregate.ts";

export type HistoricalDataAuditOptions = {
  /** Default: 7 bulan terakhir yang relevan (Feb-Aug 2026, lihat Bagian D). */
  ledgerPeriods?: string[];
};

const DEFAULT_LEDGER_PERIODS = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];

/** Bangun laporan Milestone 4 Historical Data lengkap (8 kategori) — read-only, live compute. */
export async function buildHistoricalDataAudit(storeId: number, options: HistoricalDataAuditOptions = {}): Promise<HistoricalDataSummary> {
  const ledgerPeriods = options.ledgerPeriods ?? DEFAULT_LEDGER_PERIODS;
  const periodeLabel = `${ledgerPeriods[0]}..${ledgerPeriods[ledgerPeriods.length - 1]}`;

  const { collections } = await import("./mongodb.ts");
  const { olseraInventoryMovements, olseraInventoryMonthlySnapshots, bookings, historicalBackfillAuditLog } = await collections();

  const [{ rows: classified }, ledgerRowsByPeriod, manualReview, resolvedCount, totalBookings, snapshotAgg] = await Promise.all([
    loadHistoricalOrderItemIdentityAudit(),
    Promise.all(ledgerPeriods.map(async (period) => (await getFinancialSummaryDiagnostics(period)).map((r) => ({ period, accountCode: String(r.accountCode), status: String(r.status) })))),
    buildManualReviewSummary(storeId),
    historicalBackfillAuditLog.countDocuments({ storeId }),
    bookings.countDocuments({}),
    olseraInventoryMonthlySnapshots
      .aggregate<{ _id: string; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray(),
  ]);

  const ledgerRows: LedgerDiagnosticRow[] = ledgerRowsByPeriod.flat();

  const movementIds = classified.map((r) => `sale:${r._id}`);
  const movements = movementIds.length ? await olseraInventoryMovements.find({ _id: { $in: movementIds } }).toArray() : [];
  const movementById = new Map(movements.map((m: any) => [m._id, m]));
  const movementUnmatchedCount = classified.filter((r) => movementById.has(`sale:${r._id}`) && movementById.get(`sale:${r._id}`).productId === null).length;
  const movementMissingDocCount = classified.filter((r) => !movementById.has(`sale:${r._id}`)).length;

  const snapshotByStatus = new Map(snapshotAgg.map((s) => [s._id, s.count]));

  const productMappingSummary = summarizeClassifications(classified);
  const productMapping = buildProductMappingReport({ periode: "seluruh waktu (live)", summary: productMappingSummary, resolvedCount });
  const { ledger, account } = buildLedgerAndAccountReports(ledgerPeriods, ledgerRows);
  const inventory = buildInventoryReport({ periode: periodeLabel, movementUnmatchedCount, movementMissingDocCount });
  const snapshot = buildSnapshotReport({ periode: periodeLabel, boundaryOnlyCount: snapshotByStatus.get("boundary-only") ?? 0, incompleteCount: snapshotByStatus.get("incomplete") ?? 0 });
  const sales = buildSalesReport("seluruh waktu (live)", productMappingSummary.totalGapped);
  const reconciliation = buildReconciliationReport(periodeLabel, manualReview);
  const transaction = buildTransactionReport("seluruh waktu (live)", totalBookings);

  return combineHistoricalDataSummary([productMapping, ledger, inventory, sales, reconciliation, account, transaction, snapshot]);
}
