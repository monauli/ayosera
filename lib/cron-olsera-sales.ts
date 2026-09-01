// Logika murni endpoint cron baru khusus modul Kategori/Penjualan Olsera
// (app/api/cron/olsera/sales/route.ts). Terpisah dari lib/cron-olsera-sync.ts
// (endpoint cron LAMA app/api/cron/olsera-sync — TIDAK diubah/dihapus supaya
// jadwal cron-job.org existing yang mungkin masih mengarah ke sana tidak
// rusak). Endpoint baru ini menambahkan distributed lock (lib/olsera-cron-lock.ts)
// yang endpoint lama tidak punya.
import { auditAndSyncOlseraDay, todayJakarta } from "@/lib/olsera-sync";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";
import { acquireOlseraSyncLock, releaseOlseraSyncLock } from "@/lib/olsera-cron-lock";
import { isDatabaseTimeoutError, withDatabaseRetry } from "@/lib/mongodb-errors";
import { collections, withMongo } from "@/lib/mongodb";

function previousJakartaDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

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
    // auditAndSyncOlseraDay, BUKAN syncOlseraSalesByCategory({force:true}):
    // ia membandingkan jumlah order + total dari Order List Olsera (2 request,
    // TANPA order detail) dengan olsera_synced_days lebih dulu, lalu HANYA
    // menarik ulang penuh bila memang berbeda. Verifikasi lapangan 2026-08-28:
    // baris Order List memuat `total_amount` ("42000.00"), extractOrderTotal
    // membacanya 51/51 baris, jadi perbandingan total benar-benar aktif —
    // bukan sekadar perbandingan jumlah order.
    //
    // Skip tetap di level HARI lewat perbandingan count+total ke sumber, BUKAN
    // lewat keberadaan dokumen olsera_synced_days (itulah yang `force: true`
    // dulu matikan, dan memang harus tetap mati): order sore yang masuk
    // mengubah count/total, sehingga tetap memicu tarik ulang penuh.
    const result = await auditAndSyncOlseraDay(start_date);
    const yesterday = previousJakartaDate(start_date);
    const shouldAuditYesterday = await withMongo(async () => {
      const { olseraSyncState } = await collections();
      const state = await olseraSyncState.findOne({ _id: "olsera" });
      return state?.lastDailyAuditDate !== yesterday;
    });
    let yesterdayResult: Awaited<ReturnType<typeof auditAndSyncOlseraDay>> | null = null;
    if (shouldAuditYesterday) {
      try {
        yesterdayResult = await auditAndSyncOlseraDay(yesterday);
        if (yesterdayResult.action !== "failed") {
          await withMongo(async () => {
            const { olseraSyncState } = await collections();
            await olseraSyncState.updateOne(
              { _id: "olsera" },
              { $set: { lastDailyAuditDate: yesterday, updatedAt: new Date() } },
              { upsert: true },
            );
          });
        } else {
          console.warn(`[cron:olsera:sales] audit H-1 gagal date=${yesterday} — sync hari ini tetap sukses`, yesterdayResult.errorMessage ?? "unknown error");
        }
      } catch (error) {
        console.warn(`[cron:olsera:sales] audit H-1 error date=${yesterday} — sync hari ini tetap sukses`, error);
      }
    }

    const failed = result.action === "failed";
    const safeErrorCode = failed && result.errorMessage ? classifySalesError(result.errorMessage) : null;
    console.log(
      `[cron:olsera:sales] runId=${runId} finishedAt=${new Date().toISOString()} action=${result.action} expected=${result.expectedOrderCount} processedCount=${result.processedOrderCount} reason=${result.reason ?? "-"}`,
    );
    return {
      status: 200,
      body: {
        success: !failed,
        mode: "cron",
        module: "sales",
        runId,
        status: failed ? "failed" : "success",
        action: result.action,
        period: { start_date, end_date },
        expectedCount: result.expectedOrderCount,
        processedCount: result.processedOrderCount,
        reason: result.reason,
        yesterdayAction: yesterdayResult?.action ?? "skipped",
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
