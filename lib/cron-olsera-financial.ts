// Logika murni endpoint cron Laporan Keuangan Olsera
// (app/api/cron/olsera/financial/route.ts). Memakai mekanisme start/step
// bertahap yang SAMA dengan tombol manual (lib/olsera-financial-sync.ts,
// lib/olsera-financial-store.ts) — checkpoint tersimpan di MongoDB per
// periode (financialSyncRunId), sehingga panggilan cron berikutnya
// melanjutkan, bukan mengulang dari awal.
//
// Satu request cron menjalankan BEBERAPA step secara berurutan (sequential,
// tidak paralel) supaya sync selesai lebih cepat tanpa perlu cron dipanggil
// berkali-kali dalam sehari — tapi tetap dibatasi (MAX_STEPS_PER_REQUEST +
// TIME_BUDGET_MS) supaya tidak menjadi loop tanpa batas atau melebihi
// timeout Vercel. Bila belum selesai, checkpoint tersimpan di MongoDB
// (phase/accountCursor — lib/olsera-financial-sync.ts) dan panggilan cron
// berikutnya melanjutkan (bukan mengulang dari awal).
import { todayJakarta } from "@/lib/olsera-sync";
import { validatePeriod } from "@/lib/olsera-financial-core";
import { FinancialClientError } from "@/lib/olsera-financial-client";
import { startFinancialSync, stepFinancialSync } from "@/lib/olsera-financial-sync";
import { getFinancialSyncLogForPeriod } from "@/lib/olsera-financial-store";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";
import { acquireOlseraSyncLock, releaseOlseraSyncLock } from "@/lib/olsera-cron-lock";
import { isDatabaseTimeoutError, withDatabaseRetry } from "@/lib/mongodb-errors";

// Lock dipegang selama seluruh batch step (bukan hanya satu step) — lease
// harus lebih longgar dari TIME_BUDGET_MS supaya tidak kedaluwarsa di
// tengah proses sendiri.
const LEASE_MS = 6 * 60 * 1000;
// Maksimal step yang dijalankan SEQUENTIAL dalam satu request cron — batas
// eksplisit supaya tidak loop tanpa batas walau periode punya ratusan akun.
const MAX_STEPS_PER_REQUEST = 8;
// Batas waktu internal, lebih pendek dari maxDuration route (300 detik) dan
// dari LEASE_MS — begitu terlampaui, loop berhenti di step yang sedang
// berjalan (tidak memotong step yang sudah dimulai), checkpoint tersimpan,
// dan request berikutnya melanjutkan.
const TIME_BUDGET_MS = 240_000;

export type CronOlseraFinancialResponse = {
  status: number;
  body: Record<string, unknown>;
};

export async function runOlseraFinancialCron(
  authHeader: string | null,
  input?: { year?: unknown; month?: unknown },
): Promise<CronOlseraFinancialResponse> {
  const auth = verifyCronSecret(authHeader);
  if (!auth.ok) {
    if (auth.status === 500) console.error("[cron:olsera:financial] CRON_SECRET is not configured");
    return { status: auth.status, body: { success: false, mode: "cron", module: "financial", status: "unauthorized", message: auth.message } };
  }

  let period: string;
  try {
    const now = todayJakarta(); // "YYYY-MM-DD"
    const yearValue = input?.year != null ? String(input.year) : now.slice(0, 4);
    const monthValue = input?.month != null ? String(input.month) : now.slice(5, 7);
    period = validatePeriod(yearValue, monthValue);
  } catch {
    return { status: 200, body: { success: false, mode: "cron", module: "financial", status: "payload-invalid", message: "Periode tidak valid." } };
  }

  let lock;
  try {
    lock = await withDatabaseRetry(() => acquireOlseraSyncLock("financial", "cron", LEASE_MS));
  } catch (error) {
    if (isDatabaseTimeoutError(error)) {
      return { status: 504, body: { status: "database-timeout", module: "financial", safeErrorCode: "mongodb-timeout" } };
    }
    throw error;
  }
  if (!lock.ok) {
    return { status: 409, body: { status: "sync-in-progress", activeModule: lock.activeModule, runId: lock.runId } };
  }

  const { runId } = lock;
  const startedAt = Date.now();
  let stepsExecuted = 0;
  console.log(`[cron:olsera:financial] runId=${runId} period=${period} startedAt=${new Date(startedAt).toISOString()}`);
  try {
    const existing = await getFinancialSyncLogForPeriod(period);
    if (existing?.status === "success") {
      console.log(`[cron:olsera:financial] runId=${runId} period=${period} sudah selesai — no-op.`);
      return {
        status: 200,
        body: {
          success: true,
          mode: "cron",
          module: "financial",
          runId,
          period,
          status: "completed",
          stepsExecuted: 0,
          currentPhase: existing.phase,
          completed: true,
          nextCheckpoint: null,
        },
      };
    }

    // Jangan membuat run baru bila periode ini masih punya run aktif
    // (running/partial) — resume dari checkpoint yang sama.
    let run = existing ?? (await startFinancialSync(period.slice(0, 4), Number(period.slice(5))));

    // Sequential SATU per satu (tidak pernah paralel) — berhenti begitu salah
    // satu kondisi berikut terpenuhi: run selesai (phase != "running"), batas
    // step tercapai, atau sisa waktu serverless sudah tipis.
    while (stepsExecuted < MAX_STEPS_PER_REQUEST) {
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break;

      const stepped = await stepFinancialSync(run._id);
      if (!stepped) {
        console.error(`[cron:olsera:financial] runId=${runId} period=${period} run tidak ditemukan setelah step ${stepsExecuted + 1}.`);
        return {
          status: 200,
          body: {
            success: false,
            mode: "cron",
            module: "financial",
            runId,
            period,
            status: "step-failed",
            stepsExecuted,
            completed: false,
          },
        };
      }
      run = stepped;
      stepsExecuted++;
      if (run.status !== "running") break; // "success" atau "partial" -> fase sudah "completed", tidak perlu step lagi.
    }

    const completed = run.status !== "running";
    console.log(
      `[cron:olsera:financial] runId=${runId} finishedAt=${new Date().toISOString()} period=${period} stepsExecuted=${stepsExecuted} status=${run.status} phase=${run.phase}`,
    );
    return {
      status: 200,
      body: {
        success: true,
        mode: "cron",
        module: "financial",
        runId,
        period,
        status: completed ? "completed" : "partial-progress",
        stepsExecuted,
        currentPhase: run.phase,
        processedCount: run.accountsProcessed,
        nextCheckpoint: completed ? null : run.accountCursor,
        completed,
      },
    };
  } catch (error) {
    if (isDatabaseTimeoutError(error)) {
      console.error(`[cron:olsera:financial] runId=${runId} stepsExecuted=${stepsExecuted} safeErrorCode=mongodb-timeout`);
      return {
        status: 504,
        body: { status: "database-timeout", module: "financial", runId, period, stepsExecuted, safeErrorCode: "mongodb-timeout" },
      };
    }
    if (error instanceof FinancialClientError) {
      const status = error.safe.status === "connection-expired" ? "connection-expired" : "step-failed";
      console.error(`[cron:olsera:financial] runId=${runId} stepsExecuted=${stepsExecuted} safeErrorCode=${status}`);
      return {
        status: 200,
        body: { success: false, mode: "cron", module: "financial", runId, period, status, stepsExecuted, completed: false },
      };
    }
    console.error(`[cron:olsera:financial] runId=${runId} stepsExecuted=${stepsExecuted} gagal`, error instanceof Error ? error.message : error);
    return {
      status: 200,
      body: { success: false, mode: "cron", module: "financial", runId, period, status: "step-failed", stepsExecuted, completed: false },
    };
  } finally {
    try {
      await withDatabaseRetry(() => releaseOlseraSyncLock(runId));
    } catch (error) {
      console.error(`[cron:olsera:financial] runId=${runId} gagal release lock`, isDatabaseTimeoutError(error) ? "timeout" : "error");
    }
  }
}
