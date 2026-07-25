// Logika murni endpoint cron Inventori Olsera (app/api/cron/olsera/inventory/route.ts).
// Menggunakan fungsi start/step yang SAMA dengan tombol manual
// (lib/olsera-inventory.ts) — hanya menambahkan distributed lock supaya cron
// dan manual tidak bisa berjalan bersamaan, dan supaya cron ini tidak
// bertabrakan dengan cron Kategori/Penjualan atau Keuangan.
import { startInventorySync, stepInventorySync } from "@/lib/olsera-inventory";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";
import { acquireOlseraSyncLock, releaseOlseraSyncLock } from "@/lib/olsera-cron-lock";
import { isDatabaseTimeoutError, withDatabaseRetry } from "@/lib/mongodb-errors";

// Satu step = katalog produk penuh ATAU satu tanggal mutasi (lihat
// lib/olsera-inventory.ts) — jauh di bawah maxDuration=300 route ini.
const LEASE_MS = 6 * 60 * 1000;

export type CronOlseraInventoryResponse = {
  status: number;
  body: Record<string, unknown>;
};

export async function runOlseraInventoryCron(authHeader: string | null): Promise<CronOlseraInventoryResponse> {
  const auth = verifyCronSecret(authHeader);
  if (!auth.ok) {
    if (auth.status === 500) console.error("[cron:olsera:inventory] CRON_SECRET is not configured");
    return { status: auth.status, body: { success: false, mode: "cron", module: "inventory", message: auth.message } };
  }

  let lock;
  try {
    lock = await withDatabaseRetry(() => acquireOlseraSyncLock("inventory", "cron", LEASE_MS));
  } catch (error) {
    if (isDatabaseTimeoutError(error)) {
      return { status: 504, body: { status: "timeout", module: "inventory", safeErrorCode: "mongodb-timeout" } };
    }
    throw error;
  }
  if (!lock.ok) {
    return { status: 409, body: { status: "sync-in-progress", activeModule: lock.activeModule, runId: lock.runId } };
  }

  const { runId } = lock;
  const startedAt = new Date();
  console.log(`[cron:olsera:inventory] runId=${runId} startedAt=${startedAt.toISOString()}`);
  try {
    // startInventorySync melanjutkan run "running" yang belum selesai
    // (checkpoint tersimpan), bukan membuat run baru — aman dipanggil ulang.
    const run = await startInventorySync();
    const stepResult = await stepInventorySync();

    if ("error" in stepResult) {
      console.error(`[cron:olsera:inventory] runId=${runId} step gagal: ${stepResult.error}`);
      return {
        status: 200,
        body: { success: false, mode: "cron", module: "inventory", runId, status: "failed", currentStep: run.phase, safeErrorCode: "step-failed" },
      };
    }

    console.log(
      `[cron:olsera:inventory] runId=${runId} finishedAt=${new Date().toISOString()} status=${stepResult.run.status} phase=${stepResult.run.phase} processedCount=${stepResult.run.processedDays}`,
    );
    return {
      status: 200,
      body: {
        success: stepResult.run.status !== "failed",
        mode: "cron",
        module: "inventory",
        runId,
        status: stepResult.run.status,
        currentStep: stepResult.run.phase,
        done: stepResult.done,
        processedDays: stepResult.run.processedDays,
        totalDays: stepResult.run.totalDays,
        nextCheckpoint: stepResult.done ? null : stepResult.run.currentDate,
      },
    };
  } catch (error) {
    if (isDatabaseTimeoutError(error)) {
      console.error(`[cron:olsera:inventory] runId=${runId} safeErrorCode=mongodb-timeout`);
      return { status: 504, body: { status: "timeout", module: "inventory", runId, safeErrorCode: "mongodb-timeout" } };
    }
    console.error(`[cron:olsera:inventory] runId=${runId} gagal`, error instanceof Error ? error.message : error);
    return {
      status: 200,
      body: { success: false, mode: "cron", module: "inventory", runId, status: "failed", safeErrorCode: "upstream-error" },
    };
  } finally {
    try {
      await withDatabaseRetry(() => releaseOlseraSyncLock(runId));
    } catch (error) {
      console.error(`[cron:olsera:inventory] runId=${runId} gagal release lock`, isDatabaseTimeoutError(error) ? "timeout" : "error");
    }
  }
}
