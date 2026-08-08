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
//
// Phase 3B/3B.1 — jendela pemeliharaan otomatis "bulan berjalan + bulan
// sebelumnya" (docs: audit Phase 3A). Root cause lama: begitu suatu periode
// mencapai status "success", cron auto-mode (tanpa {year,month} eksplisit)
// SELALU no-op untuk periode itu selamanya — kalau Olsera kemudian menerima
// jurnal terlambat bertanggal periode yang sudah "success" itu, AYOSERA
// tidak pernah menangkapnya otomatis (hanya lewat tombol Sync manual).
// Sekarang: mode auto (tanpa {year,month}) memelihara DUA periode setiap
// invocation — bulan berjalan DAN bulan sebelumnya, KEDUANYA boleh
// di-refresh ulang otomatis setelah masing-masing jendela waktu
// (CURRENT_MONTH_REFRESH_INTERVAL_MS / PREVIOUS_MONTH_REFRESH_INTERVAL_MS)
// walau sudah "success" — bulan berjalan TIDAK BOLEH berhenti permanen
// setelah "success" (diperbaiki di Phase 3B.1: Phase 3B awal salah
// mengasumsikan "perilaku current tidak berubah" padahal current month
// masih terus menerima transaksi baru sepanjang bulan berjalan, sama
// rentannya dengan kasus Juli). Mode manual (dipanggil dengan {year,month}
// eksplisit dari tombol Sync UI) TIDAK berubah sama sekali — selalu satu
// periode persis yang diminta, seperti sebelumnya.
//
// PENTING — batas waktu Vercel/cron-job.org: satu invocation TETAP hanya
// mengerjakan SATU periode (dipilih lewat selectFinancialCronTarget, bukan
// dua periode sekaligus) — jumlah step/batas waktu per request TIDAK
// berubah dari sebelumnya. Prioritas (lihat dokumentasi lengkap di
// selectFinancialCronTarget): periode yang benar-benar belum selesai
// (current dulu, baru previous) SELALU didahulukan dari periode yang
// "hanya" perlu refresh ulang — supaya previous yang sedang berjalan tidak
// pernah kelaparan hanya karena current kebetulan sudah waktunya
// di-refresh ulang.
import { todayJakarta } from "@/lib/olsera-sync";
import { previousFinancialPeriod, validatePeriod } from "@/lib/olsera-financial-core";
import { FinancialClientError } from "@/lib/olsera-financial-client";
import { startFinancialSync, stepFinancialSync } from "@/lib/olsera-financial-sync";
import { getFinancialSyncLogForPeriod, type FinancialSyncRun } from "@/lib/olsera-financial-store";
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
// Jeda minimum sebelum cron memulai ulang run yang sudah final sebagai
// "partial" — mencegah restart beruntun setiap invocation.
const PARTIAL_RESTART_COOLDOWN_MS = 30 * 60 * 1000;
// Jeda minimum sebelum bulan BERJALAN yang sudah "success" boleh di-refresh
// ulang otomatis lagi (Phase 3B.1 — perbaikan atas Phase 3B: bulan berjalan
// TIDAK PERNAH boleh berhenti permanen setelah "success", karena transaksi
// baru terus masuk sepanjang bulan itu berjalan). Dipilih ~1x/6 jam (~4x
// sehari) — lebih sering dari previous month karena current month masih
// aktif menerima transaksi setiap hari, tapi tetap tidak setiap invocation
// cron supaya tidak membebani Olsera/MongoDB tanpa perlu. Titik awal yang
// direkomendasikan; boleh diperlonggar lagi kalau nanti terbukti API Olsera
// terbebani, tapi tidak ada indikasi itu sekarang.
const CURRENT_MONTH_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Jeda minimum sebelum bulan SEBELUMNYA yang sudah "success" boleh
// di-refresh ulang otomatis lagi — dipilih ~1x/hari (BUKAN setiap
// invocation cron, yang dijadwalkan lebih sering seperti modul lain di
// cron-job.org) berdasarkan pola insiden nyata Juli 2026: jurnal terlambat
// baru diketahui 3-5 hari setelah bulan berakhir, bukan berkali-kali dalam
// sehari — jendela harian sudah cukup menutup pola itu tanpa membebani
// Olsera/MongoDB dengan refresh berulang yang tidak perlu.
const PREVIOUS_MONTH_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Ambang "running" dianggap macet (stale) — MURNI untuk observability/log,
// TIDAK memicu reset/hapus data apa pun: run yang stale tetap di-resume
// lewat step seperti run yang masih segar (checkpoint sudah aman di MongoDB,
// lihat lib/olsera-financial-sync.ts). Dipilih longgar (beberapa jam) karena
// ledger-details ~85-90 akun @ LEDGER_BATCH_SIZE=4/step butuh puluhan step,
// dan sekarang current+previous bergantian berbagi kuota cron yang sama.
const RUNNING_STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;

export type CronOlseraFinancialResponse = {
  status: number;
  body: Record<string, unknown>;
};

/** Bentuk minimal sync log yang dibutuhkan logic pemilihan periode — subset FinancialSyncRun, supaya mudah diuji tanpa objek run penuh. */
export type FinancialSyncLogLite = Pick<FinancialSyncRun, "status" | "finalized" | "updatedAt" | "completedAt"> | null;

function toTime(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** true bila log ini masih "belum selesai" — perlu step (resume) atau start baru. success TIDAK PERNAH "belum selesai" di sini (lihat needsRefresh untuk kasus previous-month refresh-ulang). */
export function isFinancialPeriodUnfinished(log: FinancialSyncLogLite, now: Date): boolean {
  if (!log) return true;
  if (log.status === "success") return false;
  if (log.status === "running") return true; // resume — termasuk yang stale, TIDAK direset (lihat RUNNING_STALE_THRESHOLD_MS)
  if (log.status === "partial") {
    if (log.finalized !== true) return true; // masih ada slot retry akun dalam run yang sama
    return now.getTime() - toTime(log.updatedAt) >= PARTIAL_RESTART_COOLDOWN_MS; // partial final -> restart hanya setelah cooldown
  }
  return true; // "failed" atau status tak dikenal -> perlu kerja, bukan diam-diam diabaikan
}

/** true bila periode ini perlu startFinancialSync (run baru) alih-alih resume step dari run existing. */
export function financialPeriodNeedsFreshStart(log: FinancialSyncLogLite, now: Date): boolean {
  if (!log) return true;
  if (log.status === "partial" && log.finalized === true) {
    return now.getTime() - toTime(log.updatedAt) >= PARTIAL_RESTART_COOLDOWN_MS;
  }
  return false; // running / partial-belum-final -> resume via step, BUKAN start ulang (tidak menghapus progres)
}

/** true bila log "running" ini sudah melewati ambang stale — MURNI label observability, tidak mengubah keputusan resume/tidak. */
export function isFinancialSyncRunStale(log: FinancialSyncLogLite, now: Date, thresholdMs = RUNNING_STALE_THRESHOLD_MS): boolean {
  if (!log) return false;
  if (log.status !== "running" && !(log.status === "partial" && log.finalized !== true)) return false;
  return now.getTime() - toTime(log.updatedAt) >= thresholdMs;
}

export type FinancialCronTarget = {
  period: string;
  /** true = panggil startFinancialSync (run baru/di-restart); false = lanjutkan run existing via stepFinancialSync. */
  startFresh: boolean;
  reason: "current-unfinished" | "previous-unfinished" | "current-refresh-due" | "previous-refresh-due";
};

/** true bila `log` "success" DAN sudah melewati `intervalMs` sejak selesai — boleh di-refresh ulang otomatis walau sudah pernah sukses. */
function isFinancialPeriodRefreshDue(log: FinancialSyncLogLite, now: Date, intervalMs: number): boolean {
  if (log?.status !== "success") return false;
  const lastRefreshedAt = toTime(log.completedAt) || toTime(log.updatedAt);
  const age = lastRefreshedAt ? now.getTime() - lastRefreshedAt : Number.POSITIVE_INFINITY;
  return age >= intervalMs;
}

/**
 * Pilih SATU periode yang perlu dikerjakan cron invocation ini (current atau
 * previous, tidak pernah dua sekaligus — lihat catatan batas waktu di atas
 * file). Return `null` bila current DAN previous sama-sama sudah up to date
 * (tidak ada kerja sama sekali -> no-op).
 *
 * Prioritas (Phase 3B.1 — perbaikan atas Phase 3B, lihat catatan
 * CURRENT_MONTH_REFRESH_INTERVAL_MS di atas file):
 *   1. current yang belum selesai (resume/start) — current SELALU didahulukan
 *      selama benar-benar belum selesai, supaya proses yang sudah dimulai
 *      bisa tuntas.
 *   2. previous yang belum selesai — dicek SEBELUM current-refresh-due,
 *      supaya previous yang sedang "running"/"partial" TIDAK PERNAH
 *      kelaparan hanya karena current kebetulan sudah waktunya di-refresh
 *      ulang (current-refresh-due bukan "belum selesai", jadi prioritasnya
 *      di bawah previous yang benar-benar belum selesai).
 *   3. current yang sudah "success" TAPI jendela refresh sudah lewat — bulan
 *      berjalan TIDAK PERNAH berhenti permanen setelah "success" (bug Phase
 *      3B yang diperbaiki di sini): transaksi baru terus masuk sepanjang
 *      bulan itu masih berjalan.
 *   4. previous yang sudah "success" TAPI jendela refresh sudah lewat (bug
 *      asli Juli 2026 yang jadi pemicu Phase 3A/3B).
 *   5. tidak ada kerja -> null (no-op).
 */
export function selectFinancialCronTarget(input: {
  currentPeriod: string;
  previousPeriod: string | null;
  currentLog: FinancialSyncLogLite;
  previousLog: FinancialSyncLogLite;
  now?: Date;
}): FinancialCronTarget | null {
  const now = input.now ?? new Date();

  if (isFinancialPeriodUnfinished(input.currentLog, now)) {
    return { period: input.currentPeriod, startFresh: financialPeriodNeedsFreshStart(input.currentLog, now), reason: "current-unfinished" };
  }

  if (input.previousPeriod && isFinancialPeriodUnfinished(input.previousLog, now)) {
    return { period: input.previousPeriod, startFresh: financialPeriodNeedsFreshStart(input.previousLog, now), reason: "previous-unfinished" };
  }

  if (isFinancialPeriodRefreshDue(input.currentLog, now, CURRENT_MONTH_REFRESH_INTERVAL_MS)) {
    return { period: input.currentPeriod, startFresh: true, reason: "current-refresh-due" };
  }

  if (input.previousPeriod && isFinancialPeriodRefreshDue(input.previousLog, now, PREVIOUS_MONTH_REFRESH_INTERVAL_MS)) {
    return { period: input.previousPeriod, startFresh: true, reason: "previous-refresh-due" };
  }

  return null;
}

export async function runOlseraFinancialCron(
  authHeader: string | null,
  input?: { year?: unknown; month?: unknown },
): Promise<CronOlseraFinancialResponse> {
  const auth = verifyCronSecret(authHeader);
  if (!auth.ok) {
    if (auth.status === 500) console.error("[cron:olsera:financial] CRON_SECRET is not configured");
    return { status: auth.status, body: { success: false, mode: "cron", module: "financial", status: "unauthorized", message: auth.message } };
  }

  // Mode manual (tombol Sync UI mengirim {year,month} eksplisit): SATU
  // periode persis yang diminta, TIDAK PERNAH menyentuh periode lain — logic
  // dan perilaku ini TIDAK berubah dari sebelum Phase 3B.
  const explicitRequest = input?.year != null || input?.month != null;

  let currentPeriod: string;
  try {
    const now = todayJakarta(); // "YYYY-MM-DD"
    const yearValue = input?.year != null ? String(input.year) : now.slice(0, 4);
    const monthValue = input?.month != null ? String(input.month) : now.slice(5, 7);
    currentPeriod = validatePeriod(yearValue, monthValue);
  } catch {
    return { status: 200, body: { success: false, mode: "cron", module: "financial", status: "payload-invalid", message: "Periode tidak valid." } };
  }
  const previousPeriod = explicitRequest ? null : previousFinancialPeriod(currentPeriod);

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
  console.log(`[cron:olsera:financial] runId=${runId} period=${currentPeriod} startedAt=${new Date(startedAt).toISOString()}`);
  try {
    let period: string;
    let existing: FinancialSyncRun | null;
    let startFresh: boolean;
    let staleRunningDetected = false;

    if (explicitRequest) {
      // Perilaku lama persis: satu periode, cek sekali, no-op bila sudah success.
      existing = await getFinancialSyncLogForPeriod(currentPeriod);
      if (existing?.status === "success") {
        console.log(`[cron:olsera:financial] runId=${runId} period=${currentPeriod} sudah selesai — no-op.`);
        return {
          status: 200,
          body: {
            success: true,
            mode: "cron",
            module: "financial",
            runId,
            period: currentPeriod,
            status: "completed",
            stepsExecuted: 0,
            currentPhase: existing.phase,
            completed: true,
            nextCheckpoint: null,
          },
        };
      }
      const stalePartial = existing?.finalized === true && Date.now() - new Date(existing.updatedAt ?? 0).getTime() >= PARTIAL_RESTART_COOLDOWN_MS;
      period = currentPeriod;
      startFresh = stalePartial || !existing;
    } else {
      // Mode auto (cron terjadwal): pelihara current + previous, pilih SATU
      // periode yang butuh kerja saat ini (lihat selectFinancialCronTarget).
      const [currentLog, previousLog] = await Promise.all([
        getFinancialSyncLogForPeriod(currentPeriod),
        previousPeriod ? getFinancialSyncLogForPeriod(previousPeriod) : Promise.resolve(null),
      ]);
      const now = new Date();
      const target = selectFinancialCronTarget({ currentPeriod, previousPeriod, currentLog, previousLog, now });
      if (!target) {
        console.log(`[cron:olsera:financial] runId=${runId} current=${currentPeriod} previous=${previousPeriod ?? "-"} semua up to date — no-op.`);
        return {
          status: 200,
          body: {
            success: true,
            mode: "cron",
            module: "financial",
            runId,
            period: currentPeriod,
            previousPeriod,
            status: "up-to-date",
            stepsExecuted: 0,
            completed: true,
            nextCheckpoint: null,
          },
        };
      }
      period = target.period;
      startFresh = target.startFresh;
      existing = target.period === currentPeriod ? currentLog : previousLog;
      staleRunningDetected = isFinancialSyncRunStale(existing, now);
      console.log(`[cron:olsera:financial] runId=${runId} target=${period} reason=${target.reason} startFresh=${startFresh} stale=${staleRunningDetected}`);
    }

    const { year: y, month: m } = { year: period.slice(0, 4), month: period.slice(5) };
    let run: FinancialSyncRun = startFresh || !existing ? await startFinancialSync(y, m) : existing;

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
      // "partial" BUKAN alasan berhenti selama run belum final: akun yang gagal
      // masih dijadwalkan retry pada step berikutnya (lib/olsera-financial-sync.ts).
      // Berhenti hanya bila run selesai atau sudah final (termasuk partial permanen).
      if (run.phase === "completed" || run.status === "success" || run.finalized === true) break;
    }

    const completed = run.phase === "completed" || run.status === "success";
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
        ...(explicitRequest ? {} : { staleRunningDetected }),
      },
    };
  } catch (error) {
    if (isDatabaseTimeoutError(error)) {
      console.error(`[cron:olsera:financial] runId=${runId} stepsExecuted=${stepsExecuted} safeErrorCode=mongodb-timeout`);
      return {
        status: 504,
        body: { status: "database-timeout", module: "financial", runId, period: currentPeriod, stepsExecuted, safeErrorCode: "mongodb-timeout" },
      };
    }
    if (error instanceof FinancialClientError) {
      const status = error.safe.status === "connection-expired" ? "connection-expired" : "step-failed";
      console.error(`[cron:olsera:financial] runId=${runId} stepsExecuted=${stepsExecuted} safeErrorCode=${status}`);
      return {
        status: 200,
        body: { success: false, mode: "cron", module: "financial", runId, period: currentPeriod, status, stepsExecuted, completed: false },
      };
    }
    console.error(`[cron:olsera:financial] runId=${runId} stepsExecuted=${stepsExecuted} gagal`, error instanceof Error ? error.message : error);
    return {
      status: 200,
      body: { success: false, mode: "cron", module: "financial", runId, period: currentPeriod, status: "step-failed", stepsExecuted, completed: false },
    };
  } finally {
    try {
      await withDatabaseRetry(() => releaseOlseraSyncLock(runId));
    } catch (error) {
      console.error(`[cron:olsera:financial] runId=${runId} gagal release lock`, isDatabaseTimeoutError(error) ? "timeout" : "error");
    }
  }
}
