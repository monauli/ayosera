import "server-only";
import { withTimeout } from "./with-timeout";
import { isCurrentJakartaPeriod } from "./olsera-financial-core";
import { getFinancialSummaryDiagnostics } from "./olsera-financial-store";
import type { SystemAuditCheck, SystemAuditResult, SystemAuditSummary, AuditCheckStatus } from "./system-audit-types";

type AuditCollections = ReturnType<typeof import("./mongodb").collections> extends Promise<infer T> ? T : never;

const AUDIT_CHECK_TIMEOUT_MS = 12_000;

function storeIdFromEnv(): number {
  const value = Number(process.env.OLSERA_INTERNAL_STORE_ID);
  if (!Number.isInteger(value) || value <= 0) throw new Error("Store audit tidak valid.");
  return value;
}

function statusSummary(checks: SystemAuditCheck[]): SystemAuditSummary {
  return checks.reduce<SystemAuditSummary>((summary, check) => { summary[check.status] += 1; return summary; }, { pass: 0, warning: 0, manual: 0, failed: 0, unavailable: 0 });
}

type AuditCheckFields = Omit<SystemAuditCheck, "id" | "module" | "period" | "status" | "checkedAt">;
function checkStatus(status: AuditCheckStatus, input: AuditCheckFields): AuditCheckFields & { status: AuditCheckStatus; checkedAt: string } {
  return { ...input, status, checkedAt: new Date().toISOString() };
}

async function safeCheck(id: string, module: string, period: string | null, fn: () => Promise<Omit<SystemAuditCheck, "id" | "module" | "period" | "checkedAt">>): Promise<SystemAuditCheck> {
  try {
    const result = await withTimeout(fn(), AUDIT_CHECK_TIMEOUT_MS, `audit ${id} timeout`);
    return { ...result, id, module, period, checkedAt: new Date().toISOString() };
  } catch (error) {
    return { ...checkStatus("unavailable", { subject: null, difference: null, impact: "medium", recommendation: error instanceof Error && error.message.includes("timeout") ? "Ulangi pemeriksaan; sumber belum merespons dalam batas aman." : "Periksa koneksi atau log modul; detail sensitif disembunyikan." }), id, module, period };
  }
}

function safePeriodList(logs: any[], requested?: string): string[] {
  const values = requested ? [requested] : logs.map((row) => String(row.period ?? "")).filter((value) => /^\d{4}-\d{2}$/.test(value));
  return [...new Set(values)].sort();
}

export async function runSystemAudit(input: { period?: string } = {}, suppliedCollections?: AuditCollections): Promise<SystemAuditResult> {
  const started = new Date();
  const storeId = storeIdFromEnv();
  const { collections } = suppliedCollections ? { collections: async () => suppliedCollections } : await import("./mongodb");
  const c = await collections();
  const financialContext = {
    monthlyReports: c.olseraFinancialMonthlyReports,
    accounts: c.olseraFinancialAccounts,
    ledgerEntries: c.olseraFinancialLedgerEntries,
    syncLogs: c.olseraFinancialSyncLogs,
    emptyLedgerConfirmations: c.olseraFinancialEmptyLedgerConfirmations,
    staleCleanupAudits: c.olseraFinancialStaleCleanupAudits,
  };
  try {
    const financialLogs = await c.olseraFinancialSyncLogs.find({ storeId }).sort({ period: 1 }).toArray();
    const periods = safePeriodList(financialLogs, input.period);
    const checks: SystemAuditCheck[] = [];
    const add = async (check: Promise<SystemAuditCheck>) => checks.push(await check);

    await add(safeCheck("ayo-sync-status", "AYO", null, async () => {
      const row = await c.syncLogs.find({}).sort({ finishedAt: -1 }).limit(1).toArray();
      const latest = row[0];
      return latest?.status === "success" ? checkStatus("pass", { subject: "sync terakhir", difference: null, impact: "low", recommendation: "Tidak ada tindakan." }) : checkStatus(latest ? "warning" : "unavailable", { subject: "sync terakhir", difference: latest ? { status: latest.status } : null, impact: "medium", recommendation: latest ? "Periksa sync AYO terakhir." : "Jalankan sync AYO terjadwal/manual." });
    }));
    await add(safeCheck("olsera-sales-sync-status", "Olsera Sales", null, async () => {
      const row = await c.olseraSyncLog.find({}).sort({ startedAt: -1 }).limit(1).toArray(); const latest = row[0];
      return latest?.status === "success" ? checkStatus("pass", { subject: "sync penjualan terakhir", difference: null, impact: "low", recommendation: "Tidak ada tindakan." }) : checkStatus(latest ? "warning" : "unavailable", { subject: "sync penjualan terakhir", difference: latest ? { status: latest.status } : null, impact: "medium", recommendation: "Periksa sync penjualan terakhir." });
    }));
    await add(safeCheck("inventory-sync-status", "Inventori", null, async () => {
      const row = await c.olseraInventorySyncRuns.find({}).sort({ startedAt: -1 }).limit(1).toArray(); const latest = row[0];
      return latest?.status === "success" ? checkStatus("pass", { subject: "sync inventori terakhir", difference: null, impact: "low", recommendation: "Tidak ada tindakan." }) : checkStatus(latest ? "warning" : "unavailable", { subject: "sync inventori terakhir", difference: latest ? { status: latest.status } : null, impact: "medium", recommendation: "Periksa sync inventori terakhir." });
    }));

    for (const period of periods) {
      const log = financialLogs.find((row) => row.period === period);
      await add(safeCheck(`financial-sync-${period}`, "Financial", period, async () => log?.status === "success" && log?.phase === "completed"
        ? checkStatus("pass", { subject: "sync financial", difference: null, impact: "low", recommendation: "Tidak ada tindakan." })
        : checkStatus(log?.failedAccountCodes?.length ? "failed" : log ? "warning" : "unavailable", { subject: "sync financial", difference: log ? { status: log.status, phase: log.phase, failedAccountCodes: Array.isArray(log.failedAccountCodes) ? log.failedAccountCodes : [] } : null, impact: "high", recommendation: log?.failedAccountCodes?.length ? "Retry akun gagal setelah memeriksa diagnostic." : "Jalankan atau lanjutkan sync financial." })));
      await add(safeCheck(`financial-duplicates-${period}`, "Financial", period, async () => {
        const rows = await c.olseraFinancialLedgerEntries.find({ storeId, period }, { projection: { accountCode: 1, "rawPayload.id": 1, isOpeningBalance: 1 } }).toArray();
        const seen = new Map<string, number>(); for (const row of rows) { if (row.isOpeningBalance) continue; const id = row.rawPayload?.id; if (id == null) continue; const key = `${row.accountCode}:${id}`; seen.set(key, (seen.get(key) ?? 0) + 1); }
        const duplicateGroups = [...seen.values()].filter((count) => count > 1).length;
        return duplicateGroups === 0 ? checkStatus("pass", { subject: "duplicate ledger", difference: { duplicateGroups: 0 }, impact: "critical", recommendation: "Tidak ada tindakan." }) : checkStatus("failed", { subject: "duplicate ledger", difference: { duplicateGroups }, impact: "critical", recommendation: "Hentikan export final dan lakukan investigasi scoped." });
      }));
      await add(safeCheck(`financial-stale-orphan-${period}`, "Financial", period, async () => {
        const [rows, accounts, periodLog] = await Promise.all([c.olseraFinancialLedgerEntries.find({ storeId, period }, { projection: { accountCode: 1, syncedAt: 1 } }).toArray(), c.olseraFinancialAccounts.find({ storeId }, { projection: { accountCode: 1 } }).toArray(), Promise.resolve(log)]);
        const accountCodes = new Set(accounts.map((row) => String(row.accountCode))); const orphan = rows.filter((row) => !accountCodes.has(String(row.accountCode))).length; const stale = periodLog?.startedAt ? rows.filter((row) => new Date(row.syncedAt).getTime() < new Date(periodLog.startedAt).getTime()).length : 0;
        const candidate = await c.olseraFinancialEmptyLedgerConfirmations.find({ storeId, period, status: "candidate" }).toArray();
        return orphan === 0 && stale === 0 && candidate.length === 0 ? checkStatus("pass", { subject: "stale/orphan ledger", difference: { orphan, stale, emptyCandidates: 0 }, impact: "critical", recommendation: "Tidak ada tindakan." }) : checkStatus("warning", { subject: "stale/orphan ledger", difference: { orphan, stale, emptyCandidates: candidate.length }, impact: "critical", recommendation: "Periksa kandidat stale; cleanup hanya setelah dua konfirmasi sukses." });
      }));
      await add(safeCheck(`financial-summary-detail-${period}`, "Financial", period, async () => {
        const diagnostics = await getFinancialSummaryDiagnostics(period, financialContext);
        const problematic = diagnostics.filter((row: any) => !["Data Lengkap", "Tidak Ada Transaksi"].includes(String(row.status)));
        return problematic.length === 0 ? checkStatus("pass", { subject: "summary vs detail", difference: { mismatch: 0 }, impact: "critical", recommendation: "Tidak ada tindakan." }) : checkStatus("warning", { subject: "summary vs detail", difference: { problematicAccounts: problematic.map((row: any) => ({ accountCode: row.accountCode, status: row.status })) }, impact: "critical", recommendation: "Periksa akun yang summary-nya tidak memiliki detail atau gagal sync." });
      }));
      await add(safeCheck(`financial-balance-${period}`, "Financial", period, async () => {
        const report = await c.olseraFinancialMonthlyReports.findOne({ storeId, period, reportType: "balance-sheet" }); const totals = report?.normalizedPayload?.totals as Record<string, unknown> | undefined; const balanced = totals?.balanced === true;
        return balanced ? checkStatus("pass", { subject: "neraca", difference: { balanced: true }, impact: "critical", recommendation: "Tidak ada tindakan." }) : checkStatus(report ? "failed" : "unavailable", { subject: "neraca", difference: report ? { balanced: false, difference: totals?.difference ?? null } : null, impact: "critical", recommendation: "Jangan nyatakan periode final sebelum Neraca balance." });
      }));
      await add(safeCheck(`financial-period-status-${period}`, "Financial", period, async () => {
        const reportRows = await c.olseraFinancialMonthlyReports.find({ storeId, period }, { projection: { reportType: 1, validated: 1 } }).toArray(); const current = isCurrentJakartaPeriod(period); const allValid = ["balance-sheet", "profit-loss", "cash-flow", "ledger-summary"].every((type) => reportRows.find((row) => row.reportType === type)?.validated === true); const label = current ? "Bulan Berjalan / Belum Final" : log?.status === "success" && allValid ? "Final" : "Menunggu Validasi";
        return label === "Final" ? checkStatus("pass", { subject: label, difference: null, impact: "medium", recommendation: "Tidak ada tindakan." }) : checkStatus("warning", { subject: label, difference: { current, allReportsValidated: allValid }, impact: "medium", recommendation: "Sinkronisasi selesai tidak otomatis berarti bulan sudah final." });
      }));
      await add(safeCheck(`financial-export-readiness-${period}`, "Financial", period, async () => {
        const reportCount = await c.olseraFinancialMonthlyReports.countDocuments({ storeId, period }); return reportCount === 4 ? checkStatus("pass", { subject: "export readiness", difference: { reports: reportCount }, impact: "low", recommendation: "Tidak ada tindakan." }) : checkStatus("warning", { subject: "export readiness", difference: { reports: reportCount }, impact: "medium", recommendation: "Lengkapi snapshot empat report sebelum export final." });
      }));
    }

    await add(safeCheck("inventory-snapshot", "Inventori", null, async () => { const row = await c.olseraInventoryMonthlySnapshots.find({}).sort({ updatedAt: -1 }).limit(1).toArray(); return row.length ? checkStatus("pass", { subject: "snapshot inventori terakhir", difference: { updatedAt: row[0].updatedAt }, impact: "medium", recommendation: "Tidak ada tindakan." }) : checkStatus("unavailable", { subject: "snapshot inventori terakhir", difference: null, impact: "medium", recommendation: "Periksa cakupan snapshot inventori." }); }));
    await add(safeCheck("inventory-manual-adjust", "Inventori", null, async () => { const rows = await c.olseraInventoryProducts.find({ $or: [{ needsManualAdjust: true }, { manualReview: true }, { active: false }] }, { projection: { productId: 1, variantId: 1 } }).limit(50).toArray(); return rows.length ? checkStatus("manual", { subject: "produk nonaktif/butuh adjust", difference: { count: rows.length }, impact: "high", recommendation: "Tinjau item secara manual sebelum perubahan stok." }) : checkStatus("pass", { subject: "produk nonaktif/butuh adjust", difference: { count: 0 }, impact: "high", recommendation: "Tidak ada tindakan." }); }));
    await add(safeCheck("court-reconciliation", "Rekonsiliasi", null, async () => { const row = await c.reconciliationRuns.find({ storeId }).sort({ updatedAt: -1 }).limit(1).toArray(); return row[0]?.status === "success" ? checkStatus("pass", { subject: "AYO vs Olsera court", difference: null, impact: "high", recommendation: "Tidak ada tindakan." }) : checkStatus(row.length ? "warning" : "unavailable", { subject: "AYO vs Olsera court", difference: row[0] ? { status: row[0].status } : null, impact: "high", recommendation: "Jalankan audit rekonsiliasi yang sesuai cakupan." }); }));
    await add(safeCheck("api-heartbeat-safe", "API/Heartbeat", null, async () => { const [lock, sales, financial] = await Promise.all([c.olseraSyncLocks.findOne({ _id: "olsera-sync" }, { projection: { module: 1, lockedUntil: 1, updatedAt: 1 } }), c.olseraSyncLog.find({}).sort({ startedAt: -1 }).limit(1).toArray(), c.olseraFinancialSyncLogs.find({ storeId }).sort({ updatedAt: -1 }).limit(1).toArray()]); return checkStatus("pass", { subject: "heartbeat dan status API", difference: { activeModule: lock?.module ?? null, salesStatus: sales[0]?.status ?? null, financialStatus: financial[0]?.status ?? null }, impact: "medium", recommendation: "Tidak ada tindakan." }); }));
    await add(safeCheck("data-last-updated", "System", null, async () => { const rows = await Promise.all([c.syncLogs.find({}).sort({ finishedAt: -1 }).limit(1).toArray(), c.olseraSyncLog.find({}).sort({ startedAt: -1 }).limit(1).toArray(), c.olseraFinancialSyncLogs.find({ storeId }).sort({ updatedAt: -1 }).limit(1).toArray()]); return checkStatus("pass", { subject: "data terakhir diperbarui", difference: { ayo: rows[0][0]?.finishedAt ?? null, sales: rows[1][0]?.startedAt ?? null, financial: rows[2][0]?.updatedAt ?? null }, impact: "low", recommendation: "Tidak ada tindakan." }); }));

    const completed = new Date(); const summary = statusSummary(checks); const result: SystemAuditResult = { runId: `system-audit:${storeId}:${completed.getTime()}`, storeId, scope: input.period ? `period:${input.period}` : "all", status: "completed", startedAt: started.toISOString(), completedAt: completed.toISOString(), checks, summary };
    if (c.systemAuditRuns?.insertOne) await c.systemAuditRuns.insertOne({ _id: result.runId, storeId, scope: result.scope, status: result.status, startedAt: started, completedAt: completed, checks, summary, createdAt: completed });
    return result;
  } finally {
    // Route/serverless lifecycle owns the shared Mongo client.
  }
}

export async function getLatestSystemAudit(suppliedCollections?: AuditCollections): Promise<SystemAuditResult | null> {
  const { collections } = suppliedCollections ? { collections: async () => suppliedCollections } : await import("./mongodb");
  const c = await collections();
    try { const row = await c.systemAuditRuns?.find({ storeId: storeIdFromEnv() }).sort({ createdAt: -1 }).limit(1).toArray(); return row?.[0] ? { runId: String(row[0]._id), ...row[0], startedAt: new Date(row[0].startedAt).toISOString(), completedAt: new Date(row[0].completedAt).toISOString() } as unknown as SystemAuditResult : null; } finally { /* shared client remains open for the request/runtime */ }
}
