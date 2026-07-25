// Logika murni endpoint cron baru khusus modul Kategori/Penjualan Olsera
// (app/api/cron/olsera/sales/route.ts). Terpisah dari lib/cron-olsera-sync.ts
// (endpoint cron LAMA app/api/cron/olsera-sync — TIDAK diubah/dihapus supaya
// jadwal cron-job.org existing yang mungkin masih mengarah ke sana tidak
// rusak). Endpoint baru ini menambahkan distributed lock (lib/olsera-cron-lock.ts)
// yang endpoint lama tidak punya.
import { syncOlseraSalesByCategory, todayJakarta } from "@/lib/olsera-sync";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";
import { acquireOlseraSyncLock, releaseOlseraSyncLock } from "@/lib/olsera-cron-lock";
import { isDatabaseTimeoutError, withDatabaseRetry } from "@/lib/mongodb-errors";

const LEASE_MS = 5 * 60 * 1000; // 5 menit — sync hanya menyasar hari ini.

export type CronOlseraSalesResponse = {
  status: number;
  body: Record<string, unknown>;
};

function classifySalesError(message: string): "connection-expired" | "upstream-error" {
  return /\b(401|403)\b|unauthorized|token/i.test(message) ? "connection-expired" : "upstream-error";
}

export async function runOlseraSalesCron(authHeader: string | null): Promise<CronOlseraSalesResponse> {
  const auth = verifyCronSecret(authHeader);
  if (!auth.ok) {
    if (auth.status === 500) console.error("[cron:olsera:sales] CRON_SECRET is not configured");
    return { status: auth.status, body: { success: false, mode: "cron", module: "sales", message: auth.message } };
  }

  let lock;
  try {
    lock = await withDatabaseRetry(() => acquireOlseraSyncLock("sales", "cron", LEASE_MS));
  } catch (error) {
    if (isDatabaseTimeoutError(error)) {
      return { status: 504, body: { status: "timeout", module: "sales", safeErrorCode: "mongodb-timeout" } };
    }
    throw error;
  }
  if (!lock.ok) {
    return { status: 409, body: { status: "sync-in-progress", activeModule: lock.activeModule, runId: lock.runId } };
  }

  const { runId } = lock;
  const startedAt = new Date();
  console.log(`[cron:olsera:sales] runId=${runId} startedAt=${startedAt.toISOString()}`);
  try {
    const start_date = todayJakarta();
    const end_date = start_date;
    const result = await syncOlseraSalesByCategory(start_date, end_date, { force: true });

    const safeErrorCode = result.status === "failed" && result.errorMessage ? classifySalesError(result.errorMessage) : null;
    console.log(
      `[cron:olsera:sales] runId=${runId} finishedAt=${new Date().toISOString()} status=${result.status} processedCount=${result.processedOrderCount}`,
    );
    return {
      status: 200,
      body: {
        success: result.status !== "failed",
        mode: "cron",
        module: "sales",
        runId,
        status: result.status,
        period: { start_date, end_date },
        processedCount: result.processedOrderCount,
        ...(safeErrorCode ? { safeErrorCode } : {}),
      },
    };
  } catch (error) {
    if (isDatabaseTimeoutError(error)) {
      console.error(`[cron:olsera:sales] runId=${runId} safeErrorCode=mongodb-timeout`);
      return { status: 504, body: { status: "timeout", module: "sales", runId, safeErrorCode: "mongodb-timeout" } };
    }
    const message = error instanceof Error ? error.message : "Scheduled Olsera sales sync failed";
    const safeErrorCode = classifySalesError(message);
    console.error(`[cron:olsera:sales] runId=${runId} safeErrorCode=${safeErrorCode}`);
    return {
      status: 200,
      body: {
        success: false,
        mode: "cron",
        module: "sales",
        runId,
        status: safeErrorCode,
        message: safeErrorCode === "connection-expired" ? "Koneksi Olsera kedaluwarsa." : "Sync penjualan Olsera gagal.",
      },
    };
  } finally {
    try {
      await withDatabaseRetry(() => releaseOlseraSyncLock(runId));
    } catch (error) {
      console.error(`[cron:olsera:sales] runId=${runId} gagal release lock`, isDatabaseTimeoutError(error) ? "timeout" : "error");
    }
  }
}
