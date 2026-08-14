// Logika murni endpoint cron Inventori Olsera (app/api/cron/olsera/inventory/route.ts).
// Menggunakan fungsi start/step yang SAMA dengan tombol manual
// (lib/olsera-inventory.ts) — hanya menambahkan distributed lock supaya cron
// dan manual tidak bisa berjalan bersamaan, dan supaya cron ini tidak
// bertabrakan dengan cron Kategori/Penjualan atau Keuangan.
//
// Loop step (fix 2026-07-30, lihat audit tmp/ai-handoff.md): scheduler
// eksternal (cron-job.org) memanggil endpoint ini setiap 60 menit, sementara
// desain lama hanya menjalankan SATU step per invocation lalu berhenti — fase
// "movements" tidak pernah sempat mulai sebelum run dianggap basi
// (INVENTORY_SYNC_STALE_MS=30 menit) oleh invocation berikutnya, sehingga
// checkpoint tidak pernah maju secara otomatis. Perbaikan: SATU invocation
// sekarang memanggil stepInventorySync() berulang (loop di process yang sama,
// bukan menunggu invocation cron berikutnya) sampai run selesai (success/
// partial/failed) ATAU mendekati batas waktu eksekusi (deadline dengan safety
// buffer) ATAU mencapai batas iterasi pengaman — mengulang persis pola tombol
// manual (frontend memanggil step berulang dalam loop cepat), hanya saja
// loop-nya sekarang di server, bukan di browser.
import { startInventorySync, stepInventorySync, type InventorySyncStatus } from "@/lib/olsera-inventory";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";
import { acquireOlseraSyncLock, releaseOlseraSyncLock } from "@/lib/olsera-cron-lock";
import { isDatabaseTimeoutError, withDatabaseRetry } from "@/lib/mongodb-errors";
import { shouldStopCronLoop, type CronLoopStopReason } from "@/lib/olsera-inventory-core";
import { runFebruaryHistoricalMigration } from "@/lib/february-historical-migration";

// HARUS <= maxDuration route (app/api/cron/olsera/inventory/route.ts) — loop
// berhenti memulai step BARU jauh sebelum Vercel mematikan function, supaya
// selalu sempat menulis response akhir + release lock. Diekspor (bukan hanya
// konstanta privat) supaya ada regression test eksplisit yang mengunci
// kecocokan angka ini dengan `maxDuration` di route.ts — lihat
// "konsistensi ROUTE_MAX_DURATION_MS vs maxDuration route" di
// lib/cron-olsera-inventory.test.ts.
export const ROUTE_MAX_DURATION_MS = 300_000;
const LOOP_SAFETY_BUFFER_MS = 45_000;
export const LOOP_BUDGET_MS = ROUTE_MAX_DURATION_MS - LOOP_SAFETY_BUFFER_MS;

// Perlindungan tambahan di luar deadline waktu (mis. jam sistem bermasalah) —
// rentang terpanjang yang realistis adalah backfill baseline penuh
// (INVENTORY_BASELINE_DATE s/d hari ini, puluhan-ratusan hari) + 1 step fase
// produk; 400 memberi ruang jauh di atas itu tanpa membiarkan loop tak
// terbatas.
export const MAX_STEP_ITERATIONS = 400;

// Lease lock lebih panjang dari LOOP_BUDGET_MS supaya lock tidak pernah
// dianggap kedaluwarsa SAAT loop masih berjalan aktif di invocation ini
// (release tetap selalu terjadi di finally — lease hanya jaring pengaman bila
// seluruh proses mati sebelum sempat melepas lock).
const LEASE_MS = ROUTE_MAX_DURATION_MS + 60_000;

export type CronOlseraInventoryResponse = {
  status: number;
  body: Record<string, unknown>;
};

type RunSnapshot = NonNullable<InventorySyncStatus["run"]>;

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
  const deadlineMs = Date.now() + LOOP_BUDGET_MS;
  console.log(`[cron:olsera:inventory] runId=${runId} startedAt=${startedAt.toISOString()} deadline=${new Date(deadlineMs).toISOString()}`);

  try {
    const historical = await runFebruaryHistoricalMigration();
    // startInventorySync melanjutkan run "running" yang belum selesai
    // (checkpoint tersimpan), bukan membuat run baru — aman dipanggil ulang.
    // Dipanggil TEPAT SEKALI per invocation; loop di bawah HANYA memanggil
    // stepInventorySync (tidak pernah membuat run baru per iterasi).
    let latestRun: RunSnapshot = await startInventorySync();
    let iterations = 0;
    let stopReason: CronLoopStopReason | null = null;
    let stepError: string | null = null;

    while (true) {
      stopReason = shouldStopCronLoop({
        iterations,
        maxIterations: MAX_STEP_ITERATIONS,
        nowMs: Date.now(),
        deadlineMs,
      });
      if (stopReason) break;

      iterations++;
      const stepResult = await stepInventorySync();
      if ("error" in stepResult) {
        stepError = stepResult.error;
        break;
      }
      latestRun = stepResult.run;
      if (stepResult.done) break;
    }

    console.log(
      `[cron:olsera:inventory] runId=${runId} finishedAt=${new Date().toISOString()} iterations=${iterations} status=${latestRun.status} phase=${latestRun.phase} processedDays=${latestRun.processedDays} stopReason=${stopReason ?? (stepError ? "step-error" : "completed")}`,
    );

    if (stepError) {
      console.error(`[cron:olsera:inventory] runId=${runId} step gagal setelah ${iterations} iterasi: ${stepError}`);
      return {
        status: 200,
        body: {
          success: false,
          mode: "cron",
          module: "inventory",
          runId,
          status: "failed",
          currentStep: latestRun.phase,
          iterations,
          done: false,
          continuation: "none",
          historical,
          safeErrorCode: "step-failed",
        },
      };
    }

    // done hanya true bila stepInventorySync sendiri melaporkan phase "done"
    // (run benar-benar tuntas: success/partial/failed) — checkpoint
    // (lastSuccessfulSyncAt/lastSyncedDate) hanya maju bila status di sini
    // "success", logika itu TIDAK disentuh sama sekali di file ini (tetap di
    // lib/olsera-inventory.ts stepInventorySync).
    const finished = latestRun.phase === "done";
    const continuation: "none" | CronLoopStopReason = finished ? "none" : (stopReason ?? "deadline");

    return {
      status: 200,
      body: {
        success: latestRun.status !== "failed",
        mode: "cron",
        module: "inventory",
        runId,
        status: latestRun.status,
        currentStep: latestRun.phase,
        done: finished,
        iterations,
        processedDays: latestRun.processedDays,
        totalDays: latestRun.totalDays,
        nextCheckpoint: finished ? null : latestRun.currentDate,
        // "none" saat run benar-benar tuntas; "deadline"/"max-iterations" saat
        // run SENGAJA dibiarkan status "running" untuk dilanjutkan invocation
        // cron berikutnya — bukan kegagalan.
        continuation,
        historical,
        message: finished
          ? `Sync selesai dalam ${iterations} langkah pada invocation ini.`
          : continuation === "max-iterations"
            ? `Batas ${MAX_STEP_ITERATIONS} langkah per invocation tercapai setelah ${iterations} langkah — run tetap berstatus "running", akan dilanjutkan invocation cron berikutnya.`
            : `Mendekati batas waktu eksekusi setelah ${iterations} langkah — run tetap berstatus "running", akan dilanjutkan invocation cron berikutnya.`,
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
