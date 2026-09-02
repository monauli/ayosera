// Logika murni endpoint cron Laporan Keuangan Olsera
// (app/api/cron/olsera/financial/route.ts). Memakai mekanisme start/step
// bertahap yang SAMA dengan tombol manual (lib/olsera-financial-sync.ts,
// lib/olsera-financial-store.ts) — checkpoint tersimpan di MongoDB per
// periode (financialSyncRunId), sehingga panggilan cron berikutnya
// melanjutkan, bukan mengulang dari awal.
//
// Satu request cron BOLEH menjalankan beberapa step secara berurutan
// (sequential, tidak paralel) — tapi dalam praktiknya deadline internal
// (TIME_BUDGET_MS, Phase 3C.5) jauh lebih ketat daripada MAX_STEPS_PER_REQUEST:
// cron-job.org hanya menunggu response ~30 detik, jadi biasanya HANYA satu
// step (bahkan sebagian dari satu step) yang sempat jalan per invocation.
// Bila belum selesai, checkpoint tersimpan di MongoDB (phase/accountCursor —
// lib/olsera-financial-sync.ts) dan panggilan cron berikutnya melanjutkan
// (bukan mengulang dari awal) — ini NORMAL, bukan error.
//
// Phase 3B/3B.1 — jendela pemeliharaan otomatis "bulan berjalan + bulan
// sebelumnya" (docs: audit Phase 3A). Root cause lama: begitu suatu periode
// mencapai status "success", cron auto-mode (tanpa {year,month} eksplisit)
// SELALU no-op untuk periode itu selamanya — kalau Olsera kemudian menerima
// jurnal terlambat bertanggal periode yang sudah "success" itu, AYOSERA
// tidak pernah menangkapnya otomatis (hanya lewat tombol Sync manual).
// Sekarang: mode auto (tanpa {year,month}) memelihara DUA periode setiap
// invocation — bulan berjalan DAN bulan sebelumnya. Bulan berjalan boleh
// di-refresh ulang otomatis setelah CURRENT_MONTH_REFRESH_INTERVAL_MS walau
// sudah "success" — bulan berjalan TIDAK BOLEH berhenti permanen setelah
// "success" (diperbaiki di Phase 3B.1: Phase 3B awal salah mengasumsikan
// "perilaku current tidak berubah" padahal current month masih terus
// menerima transaksi baru sepanjang bulan berjalan, sama rentannya dengan
// kasus Juli). Bulan SEBELUMNYA yang sudah "success" TIDAK LAGI di-refresh
// ulang secara periodik oleh cron ini — cabang itu (previous-refresh-due,
// PREVIOUS_MONTH_REFRESH_INTERVAL_MS lama) dimatikan permanen karena
// restart penuh 85 akun tiap hari terlalu mahal; jurnal susulan akun revenue
// sekarang ditangkap lib/cron-olsera-revenue-recheck.ts (lihat file itu).
// Mode manual (dipanggil dengan {year,month} eksplisit dari tombol Sync UI)
// TIDAK berubah sama sekali — selalu satu periode persis yang diminta,
// seperti sebelumnya.
//
// PENTING — batas waktu Vercel/cron-job.org: satu invocation TETAP hanya
// mengerjakan SATU periode (dipilih lewat selectFinancialCronTarget, bukan
// dua periode sekaligus). Prioritas (lihat dokumentasi lengkap di
// selectFinancialCronTarget): periode yang benar-benar belum selesai SELALU
// didahulukan dari periode yang "hanya" perlu refresh ulang — supaya previous
// yang sedang berjalan tidak pernah kelaparan hanya karena current kebetulan
// sudah waktunya di-refresh ulang. Di antara sesama "belum selesai",
// previous yang SUDAH punya progres nyata dan akan di-resume menyalip current
// (financialPreviousResumeShouldPreemptCurrent) supaya periode setengah jalan
// tidak terjebak permanen di belakang current yang tidak pernah tuntas;
// selebihnya current tetap lebih dulu.
import { todayJakarta } from "@/lib/olsera-sync";
import { FINANCIAL_BASELINE_PERIOD, previousFinancialPeriod, validatePeriod } from "@/lib/olsera-financial-core";
import { FinancialClientError } from "@/lib/olsera-financial-client";
import { startFinancialSync, stepFinancialSync, FINANCIAL_INVOCATION_TIME_BUDGET_MS, FINANCIAL_MIN_REMAINING_MS_TO_START_WORK } from "@/lib/olsera-financial-sync";
import { getFinancialSyncLogForPeriod, type FinancialSyncRun } from "@/lib/olsera-financial-store";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";
import { acquireOlseraSyncLock, releaseOlseraSyncLock } from "@/lib/olsera-cron-lock";
import { isDatabaseTimeoutError, withDatabaseRetry } from "@/lib/mongodb-errors";
import { collections, withMongo } from "@/lib/mongodb";

// Lock dipegang selama seluruh batch step (bukan hanya satu step) — lease
// harus lebih longgar dari TIME_BUDGET_MS supaya tidak kedaluwarsa di
// tengah proses sendiri.
const LEASE_MS = 6 * 60 * 1000;
// Maksimal step yang dijalankan SEQUENTIAL dalam satu request cron — batas
// pengaman tambahan (defense-in-depth) di ATAS deadline waktu di bawah; dalam
// praktiknya deadline 21 detik hampir selalu tercapai lebih dulu daripada
// batas 8 step ini.
const MAX_STEPS_PER_REQUEST = 8;
// Deadline internal SATU invocation — konsep TUNGGAL dibagi dengan
// stepFinancialSync (lib/olsera-financial-sync.ts, FINANCIAL_INVOCATION_TIME_BUDGET_MS)
// supaya tidak ada dua timer yang saling bertentangan (Phase 3C.5). Jauh
// lebih pendek dari maxDuration route (300 detik) dan LEASE_MS (6 menit) —
// cron-job.org hanya menunggu response ~30 detik. Dicek di antara step DI
// SINI, dan di antara akun DI DALAM stepFinancialSync (fase ledger-details) —
// begitu terlampaui, proses berhenti tanpa memotong akun yang sudah mulai
// diproses, checkpoint tersimpan, dan request berikutnya melanjutkan.
const TIME_BUDGET_MS = FINANCIAL_INVOCATION_TIME_BUDGET_MS;
// Phase 3C.5.1 — HARDENING: "belum lewat TIME_BUDGET_MS" saja tidak cukup
// untuk memutuskan boleh memanggil step BARU — step itu sendiri bisa
// memicu request Olsera baru (monthly-reports/ledger-details) yang butuh
// waktu sampai FINANCIAL_REQUEST_TIMEOUT_MS lagi. Dipakai rumus SAMA persis
// dengan stepFinancialSync (lib/olsera-financial-sync.ts) supaya route dan
// step sepakat pada satu definisi "aman untuk mulai kerja baru".
const MIN_REMAINING_MS_TO_START_WORK = FINANCIAL_MIN_REMAINING_MS_TO_START_WORK;
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
// PREVIOUS_MONTH_REFRESH_INTERVAL_MS (dulu 24 jam) DIHAPUS — cabang
// previous-refresh-due yang memakainya dimatikan permanen (lihat komentar
// besar di selectFinancialCronTargetWithHistory, blok scope "auto"): efeknya
// me-restart penuh 85 akun dari accountCursor 0 untuk periode yang sudah
// "success", terlalu mahal untuk sekadar refresh berkala. Kebutuhan aslinya
// (jurnal susulan akun revenue) sekarang dilayani
// lib/cron-olsera-revenue-recheck.ts.
// Ambang "running" dianggap macet (stale) — MURNI untuk observability/log,
// TIDAK memicu reset/hapus data apa pun: run yang stale tetap di-resume
// lewat step seperti run yang masih segar (checkpoint sudah aman di MongoDB,
// lihat lib/olsera-financial-sync.ts). Dipilih longgar (beberapa jam) karena
// ledger-details ~85-90 akun @ LEDGER_BATCH_SIZE=4/step butuh puluhan step,
// dan sekarang current+previous bergantian berbagi kuota cron yang sama.
export const RUNNING_STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;

export type CronOlseraFinancialResponse = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * Bentuk minimal sync log yang dibutuhkan logic pemilihan periode — subset
 * FinancialSyncRun, supaya mudah diuji tanpa objek run penuh. `accountCursor`
 * OPSIONAL: jalur production selalu mengoper dokumen run penuh (punya field
 * ini), sementara fixture test lama yang tidak menyebutnya tetap valid dan
 * dibaca sebagai "belum ada progres" (0) — lihat financialPreviousResumeShouldPreemptCurrent.
 */
export type FinancialSyncLogLite =
  | (Pick<FinancialSyncRun, "status" | "finalized" | "updatedAt" | "completedAt"> & Partial<Pick<FinancialSyncRun, "accountCursor">>)
  | null;

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
  if ((log as { status?: string }).status === "missing") return true;
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

/**
 * true bila periode SEBELUMNYA harus MENDAHULUI periode berjalan pada
 * invocation ini.
 *
 * Root cause yang diperbaiki: sebelumnya "current belum selesai" SELALU
 * menang mutlak, tanpa syarat. Akibatnya periode previous yang sudah setengah
 * jalan (mis. Agustus di akun 50/85) bisa terjebak permanen selama current
 * tidak pernah berhasil tuntas — tiap invocation dihabiskan untuk current,
 * dan checkpoint previous tidak pernah disentuh lagi.
 *
 * Syaratnya SEMPIT dan sengaja begitu — previous hanya boleh menyalip bila
 * benar-benar ada kerja setengah jadi yang akan HILANG gilirannya:
 *  1. previous belum "success" (isFinancialPeriodUnfinished), DAN
 *  2. previous punya progres nyata: accountCursor > 0, DAN
 *  3. previous akan DI-RESUME, bukan di-restart (!financialPeriodNeedsFreshStart).
 *
 * Syarat 3 penting: run "partial" yang sudah final dan lewat cooldown akan
 * di-start ULANG dari accountCursor 0 — progres lamanya memang dibuang, jadi
 * tidak ada yang perlu dilindungi dan menyalip current di situ hanya menukar
 * satu starvation dengan starvation lain (previous restart dari nol terus,
 * current tidak pernah jalan).
 *
 * Bila previous belum punya progres sama sekali (accountCursor 0 / belum ada
 * log), current tetap didahulukan seperti perilaku lama — tidak ada yang
 * ditunda, dan previous tetap kebagian lewat cabang previous-unfinished /
 * historical-unfinished di bawahnya.
 */
export function financialPreviousResumeShouldPreemptCurrent(previousLog: FinancialSyncLogLite, now: Date): boolean {
  if (!previousLog) return false;
  if (!isFinancialPeriodUnfinished(previousLog, now)) return false;
  if (financialPeriodNeedsFreshStart(previousLog, now)) return false;
  return (previousLog.accountCursor ?? 0) > 0;
}

export type FinancialCronTarget = {
  period: string;
  /** true = panggil startFinancialSync (run baru/di-restart); false = lanjutkan run existing via stepFinancialSync. */
  startFresh: boolean;
  reason: "current-unfinished" | "previous-unfinished" | "historical-unfinished" | "current-refresh-due" | "previous-refresh-due";
};

export type HistoricalFinancialLog = FinancialSyncLogLite & Partial<FinancialSyncRun> & { period: string };
export type FinancialCronScope = "auto" | "current" | "historical";

function historicalPeriodsBetween(startPeriod: string, endPeriod: string | null): string[] {
  if (!endPeriod || startPeriod >= endPeriod) return [];
  const periods: string[] = [];
  const cursor = new Date(`${startPeriod}-01T00:00:00Z`);
  const end = new Date(`${endPeriod}-01T00:00:00Z`);
  while (cursor < end) {
    periods.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return periods;
}

export function selectFinancialCronTargetWithHistory(input: {
  currentPeriod: string;
  previousPeriod: string | null;
  currentLog: FinancialSyncLogLite;
  previousLog: FinancialSyncLogLite;
  historicalLogs: HistoricalFinancialLog[];
  historicalPeriods?: string[];
  scope?: FinancialCronScope;
  now?: Date;
}): FinancialCronTarget | null {
  const now = input.now ?? new Date();
  const scope = input.scope ?? "auto";
  // Previous yang sudah setengah jalan menyalip current (lihat
  // financialPreviousResumeShouldPreemptCurrent). HANYA untuk scope "auto":
  // scope "current" memang tidak pernah menyentuh previous sama sekali, dan
  // scope "historical" tidak pernah menyentuh current — keduanya tidak punya
  // konflik prioritas yang perlu diputus di sini.
  if (scope === "auto" && input.previousPeriod && financialPreviousResumeShouldPreemptCurrent(input.previousLog, now)) {
    return { period: input.previousPeriod, startFresh: false, reason: "previous-unfinished" };
  }
  if (scope !== "historical" && isFinancialPeriodUnfinished(input.currentLog, now)) {
    return { period: input.currentPeriod, startFresh: financialPeriodNeedsFreshStart(input.currentLog, now), reason: "current-unfinished" };
  }
  if (scope === "current") {
    if (isFinancialPeriodRefreshDue(input.currentLog, now, CURRENT_MONTH_REFRESH_INTERVAL_MS)) {
      return { period: input.currentPeriod, startFresh: true, reason: "current-refresh-due" };
    }
    return null;
  }
  if (scope === "auto") {
    // Previous month BELUM selesai (progres NOL ATAU tidak ada log sama
    // sekali — kasus DENGAN progres sudah ditangani preemption di atas)
    // tetap harus kebagian giliran. Ini MENGGANTIKAN ketergantungan lama
    // pada blok historical-unfinished di bawah untuk kasus ini (satu-satunya
    // alasan blok itu bisa menjangkau previousPeriod sebelumnya) — logikanya
    // SAMA PERSIS dengan pengecekan yang sudah ada di selectFinancialCronTarget
    // (fungsi murni di bawah), dipindah ke sini supaya jalur PRODUCTION
    // (yang memanggil fungsi INI, bukan selectFinancialCronTarget) tidak
    // kehilangan jaminan Phase 3A/3B: bulan sebelumnya tidak boleh terjebak
    // permanen hanya karena sync-nya belum pernah dicoba / masih di cursor 0.
    if (input.previousPeriod && isFinancialPeriodUnfinished(input.previousLog, now)) {
      return { period: input.previousPeriod, startFresh: financialPeriodNeedsFreshStart(input.previousLog, now), reason: "previous-unfinished" };
    }
    if (isFinancialPeriodRefreshDue(input.currentLog, now, CURRENT_MONTH_REFRESH_INTERVAL_MS)) {
      return { period: input.currentPeriod, startFresh: true, reason: "current-refresh-due" };
    }
    // previous-refresh-due DAN backlog historis (2+ bulan ke belakang)
    // DIMATIKAN PERMANEN untuk scope "auto" — bukan sekadar interval yang
    // diperpanjang, cabangnya sengaja tidak pernah dievaluasi lagi di sini.
    //
    // previous-refresh-due dimatikan karena efeknya MEMBUANG progres:
    // startFresh:true me-restart createFinancialSyncRun() dari accountCursor
    // 0 untuk periode yang SUDAH "success" (mis. Agustus 85/85 dibuang lagi
    // jadi 0/85 tiap 24 jam), memakan puluhan invocation cron untuk sekadar
    // memeriksa ulang 85 akun yang mayoritas tidak berubah. Kebutuhan
    // aslinya (menangkap jurnal susulan di akun REVENUE setelah tutup buku)
    // sekarang dilayani jalur terpisah yang jauh lebih murah: cron
    // "revenue re-check mingguan" (lib/cron-olsera-revenue-recheck.ts) —
    // fetch ulang akun-akun run.accountCodes (sejak 2026-09-03 SEMUA akun,
    // bukan lagi 9 akun revenue) lewat getLedgerDetail() saja, beberapa akun
    // per invocation dari checkpoint sendiri (cursor) — TANPA startFresh/
    // createFinancialSyncRun/getAccounts sama sekali.
    //
    // backlog historis (periode 2+ bulan sebelum current, mis. Maret saat
    // current Agustus) dimatikan karena aturan final 16 Agustus 2026
    // (commit 65c427d, "aturan final melarang cron historical") — endpoint
    // /historical yang dulu sengaja dibuat untuk ini sudah dihapus lagi di
    // commit yang sama. Membuka scope "auto" (91097b1) TANPA mematikan blok
    // di bawah ini akan diam-diam menghidupkan kembali aturan yang sudah
    // dilarang itu begitu ada periode lama yang berubah non-success.
    return null;
  }
  // Hanya scope "historical" yang sampai di sini — dipertahankan UTUH untuk
  // kompatibilitas fungsi/test (TIDAK PERNAH dipanggil dari production sejak
  // endpoint /historical dihapus di 65c427d; route.ts sekarang selalu
  // memakai scope "auto", yang blok backlog historisnya sudah dimatikan
  // permanen di atas).
  const excluded = new Set([input.currentPeriod].filter(Boolean));
  const logsByPeriod = new Map(input.historicalLogs.map((log) => [log.period, log]));
  const historicalPeriods = input.historicalLogs.length === 0
    ? []
    : input.historicalPeriods ?? input.historicalLogs.map((log) => log.period);
  const historical = historicalPeriods
    .filter((period) => !excluded.has(period))
    .map((period, index) => ({ period, index, log: logsByPeriod.get(period) ?? ({ period, status: "missing" } as unknown as HistoricalFinancialLog) }))
    .filter(({ index, log }) => (log as { status?: string }).status === "missing"
      ? historicalPeriods.slice(0, index).every((period) => logsByPeriod.get(period)?.status === "success")
      : isFinancialPeriodUnfinished(log, now))
    .map(({ log }) => log)
    .sort((a, b) => a.period.localeCompare(b.period) || toTime(a.updatedAt) - toTime(b.updatedAt))[0];
  if (historical) {
    return { period: historical.period, startFresh: financialPeriodNeedsFreshStart(historical, now), reason: "historical-unfinished" };
  }
  return null;
}

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
 *   0. previous yang belum selesai TAPI sudah punya progres nyata dan akan
 *      di-resume (financialPreviousResumeShouldPreemptCurrent) — menyalip
 *      current supaya periode setengah jalan tidak terjebak permanen di
 *      belakang current yang tidak pernah tuntas.
 *   1. current yang belum selesai (resume/start) — didahulukan selama tidak
 *      ada previous setengah jalan di poin 0, supaya proses yang sudah
 *      dimulai bisa tuntas.
 *   2. previous yang belum selesai (termasuk yang belum punya progres sama
 *      sekali) — dicek SEBELUM current-refresh-due,
 *      supaya previous yang sedang "running"/"partial" TIDAK PERNAH
 *      kelaparan hanya karena current kebetulan sudah waktunya di-refresh
 *      ulang (current-refresh-due bukan "belum selesai", jadi prioritasnya
 *      di bawah previous yang benar-benar belum selesai).
 *   3. current yang sudah "success" TAPI jendela refresh sudah lewat — bulan
 *      berjalan TIDAK PERNAH berhenti permanen setelah "success" (bug Phase
 *      3B yang diperbaiki di sini): transaksi baru terus masuk sepanjang
 *      bulan itu masih berjalan.
 *   4. [DIMATIKAN PERMANEN] previous yang sudah "success" TAPI jendela
 *      refresh sudah lewat — cabang ini pernah menjadi perbaikan bug asli
 *      Juli 2026 (pemicu Phase 3A/3B), tapi efeknya (restart penuh 85 akun
 *      dari accountCursor 0 untuk periode yang sudah selesai) terlalu mahal
 *      untuk dijalankan tiap 24 jam. Kebutuhan aslinya sekarang dilayani
 *      cron "revenue re-check mingguan" yang jauh lebih murah (lihat
 *      selectFinancialCronTargetWithHistory, blok scope "auto").
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
  if (input.previousPeriod && financialPreviousResumeShouldPreemptCurrent(input.previousLog, now)) return { period: input.previousPeriod, startFresh: false, reason: "previous-unfinished" };
  if (isFinancialPeriodUnfinished(input.currentLog, now)) return { period: input.currentPeriod, startFresh: financialPeriodNeedsFreshStart(input.currentLog, now), reason: "current-unfinished" };
  if (input.previousPeriod && isFinancialPeriodUnfinished(input.previousLog, now)) return { period: input.previousPeriod, startFresh: financialPeriodNeedsFreshStart(input.previousLog, now), reason: "previous-unfinished" };
  return selectFinancialCronTargetWithHistory({ ...input, historicalLogs: [], scope: "auto" });
}

export async function runOlseraFinancialCron(
  authHeader: string | null,
  input?: { year?: unknown; month?: unknown; scope?: FinancialCronScope },
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
  const scope = input?.scope ?? "auto";

  let currentPeriod: string;
  try {
    const now = todayJakarta(); // "YYYY-MM-DD"
    const yearValue = input?.year != null ? String(input.year) : now.slice(0, 4);
    const monthValue = input?.month != null ? String(input.month) : now.slice(5, 7);
    currentPeriod = validatePeriod(yearValue, monthValue);
  } catch {
    return { status: 200, body: { success: false, mode: "cron", module: "financial", status: "payload-invalid", message: "Periode tidak valid." } };
  }
  const previousPeriod = explicitRequest || scope === "historical" ? null : previousFinancialPeriod(currentPeriod);

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
  // SATU deadline dibagi dengan stepFinancialSync (lihat komentar TIME_BUDGET_MS
  // di atas) — dihitung sekali di sini, diteruskan apa adanya, tidak pernah
  // dihitung ulang secara terpisah supaya kedua sisi selalu sepakat.
  const deadlineAt = startedAt + TIME_BUDGET_MS;
  let stepsExecuted = 0;
  let telemetryPeriod: string | null = null;
  let telemetryRun: Partial<FinancialSyncRun> | null = null;
  let telemetrySafeErrorCode: "ERROR" | "TIMEOUT" | "DEADLINE" | "UNKNOWN" | null = null;
  const telemetryStartedAt = new Date(startedAt);
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
      telemetryPeriod = period;
      startFresh = stalePartial || !existing;
    } else {
      // Mode auto (cron terjadwal): pelihara current + previous, pilih SATU
      // periode yang butuh kerja saat ini (lihat selectFinancialCronTarget).
      // scope "current" TIDAK PERNAH membaca historicalLogs:
      // selectFinancialCronTargetWithHistory keluar lebih dulu di cabang
      // `if (scope === "current")`, dan target.period di sana selalu
      // currentPeriod sehingga pemilihan `existing` di bawah juga tidak
      // menyentuhnya. Query historis karena itu DILEWATI untuk scope ini —
      // ia men-scan seluruh olsera_financial_sync_logs sejak
      // FINANCIAL_BASELINE_PERIOD dan ikut jalan pada invocation no-op,
      // justru saat invocation seharusnya semurah mungkin.
      // Jalur historis DIPERTAHANKAN UTUH untuk scope "auto"/"historical".
      const skipHistoricalLogs = scope === "current";
      const [currentLog, previousLog, historicalLogs] = await Promise.all([
        getFinancialSyncLogForPeriod(currentPeriod),
        previousPeriod ? getFinancialSyncLogForPeriod(previousPeriod) : Promise.resolve(null),
        skipHistoricalLogs
          ? Promise.resolve([] as HistoricalFinancialLog[])
          : withMongo(async () => {
              const { olseraFinancialSyncLogs } = await collections();
              return olseraFinancialSyncLogs.find({ period: { $gte: FINANCIAL_BASELINE_PERIOD, $lt: currentPeriod } }).toArray() as Promise<HistoricalFinancialLog[]>;
            }),
      ]);
      const now = new Date();
      const target = selectFinancialCronTargetWithHistory({ currentPeriod, previousPeriod, currentLog, previousLog, historicalLogs, historicalPeriods: historicalPeriodsBetween(FINANCIAL_BASELINE_PERIOD, currentPeriod), scope, now });
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
      telemetryPeriod = period;
      startFresh = target.startFresh;
      existing = target.period === currentPeriod ? currentLog : target.period === previousPeriod ? previousLog : (historicalLogs.find((log) => log.period === target.period) as FinancialSyncRun | null);
      staleRunningDetected = isFinancialSyncRunStale(existing, now);
      console.log(`[cron:olsera:financial] runId=${runId} target=${period} reason=${target.reason} startFresh=${startFresh} stale=${staleRunningDetected}`);
    }

    const { year: y, month: m } = { year: period.slice(0, 4), month: period.slice(5) };
    const needsFreshRun = startFresh || !existing;
    // Phase 3C.5.2 — startFinancialSync() memanggil getAccounts() (2 request
    // Olsera) DI LUAR loop step, jadi satu-satunya kerja Olsera di invocation
    // ini yang TIDAK pernah tersentuh guard deadline: baik guard antar-step di
    // bawah maupun guard antar-akun di dalam stepFinancialSync baru berlaku
    // SESUDAH run dibuat. Akibatnya invocation yang memulai periode baru bisa
    // menghabiskan hampir seluruh budget di getAccounts lalu berhenti dengan
    // stepsExecuted 0 (terbukti di production: dua invocation 2026-09
    // berturut-turut, durMs 23.0 dan 23.7 detik, stepsExecuted 0).
    //
    // Ambang yang dipakai SAMA persis dengan guard step di bawah dan dengan
    // stepFinancialSync (MIN_REMAINING_MS_TO_START_WORK = worst-case satu
    // request Olsera + margin finalisasi) — getAccounts menembak 2 request
    // PARALEL, jadi worst-case wall-clock-nya tetap satu request timeout.
    //
    // Bila sisa waktu tidak cukup: JANGAN mulai. Ini no-op aman, bukan error —
    // tidak ada dokumen run yang dibuat atau di-reset, lock tetap dilepas di
    // finally, dan invocation BERIKUTNYA mencoba lagi dari awal dengan budget
    // penuh. Pola yang sama dengan "up-to-date" dan "stoppedForTimeBudget".
    if (needsFreshRun && deadlineAt - Date.now() <= MIN_REMAINING_MS_TO_START_WORK) {
      telemetrySafeErrorCode = "DEADLINE";
      console.log(`[cron:olsera:financial] runId=${runId} period=${period} sisa waktu invocation tipis sebelum startFinancialSync — start ditunda ke invocation berikutnya (tidak ada run yang dibuat).`);
      return {
        status: 200,
        body: {
          success: true,
          mode: "cron",
          module: "financial",
          runId,
          period,
          status: "start-deferred",
          stepsExecuted: 0,
          currentPhase: null,
          processedCount: 0,
          nextCheckpoint: null,
          completed: false,
          stoppedForTimeBudget: true,
          ...(explicitRequest ? {} : { staleRunningDetected }),
        },
      };
    }
    let run: FinancialSyncRun = needsFreshRun || !existing ? await startFinancialSync(y, m) : existing;
    telemetryRun = run;

    // Sequential SATU per satu (tidak pernah paralel) — berhenti begitu salah
    // satu kondisi berikut terpenuhi: run selesai (phase != "running"), batas
    // step tercapai, atau sisa waktu serverless sudah tipis.
    while (stepsExecuted < MAX_STEPS_PER_REQUEST) {
      // Start-safety guard (Phase 3C.5.1) — rumus SAMA dengan di dalam
      // stepFinancialSync: jangan mulai step baru kalau sisa waktu tidak
      // cukup untuk request Olsera terburuk + margin finalisasi.
      if (deadlineAt - Date.now() <= MIN_REMAINING_MS_TO_START_WORK) break;

      const stepped = await stepFinancialSync(run._id, undefined, deadlineAt);
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
      telemetryRun = run;
      stepsExecuted++;
      // "partial" BUKAN alasan berhenti selama run belum final: akun yang gagal
      // masih dijadwalkan retry pada step berikutnya (lib/olsera-financial-sync.ts).
      // Berhenti hanya bila run selesai atau sudah final (termasuk partial permanen).
      if (run.phase === "completed" || run.status === "success" || run.finalized === true) break;
    }

    const completed = run.phase === "completed" || run.status === "success";
    // Bukan error — berhenti karena deadline internal (Phase 3C.5/3C.5.1)
    // adalah perilaku NORMAL yang disengaja: checkpoint sudah tersimpan,
    // cron berikutnya melanjutkan. Rumus SAMA dengan guard di atas dan di
    // dalam stepFinancialSync — "berhenti karena time budget" berarti sisa
    // waktu sudah di bawah ambang aman untuk memulai kerja baru, BUKAN
    // hanya "sudah lewat deadlineAt mentah".
    const stoppedForTimeBudget = !completed && deadlineAt - Date.now() <= MIN_REMAINING_MS_TO_START_WORK;
    if (stoppedForTimeBudget) telemetrySafeErrorCode = "DEADLINE";
    console.log(
      `[cron:olsera:financial] runId=${runId} finishedAt=${new Date().toISOString()} period=${period} stepsExecuted=${stepsExecuted} status=${run.status} phase=${run.phase} stoppedForTimeBudget=${stoppedForTimeBudget}`,
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
        stoppedForTimeBudget,
        ...(explicitRequest ? {} : { staleRunningDetected }),
      },
    };
  } catch (error) {
    if (isDatabaseTimeoutError(error)) {
      telemetrySafeErrorCode = "TIMEOUT";
      console.error(`[cron:olsera:financial] runId=${runId} stepsExecuted=${stepsExecuted} safeErrorCode=mongodb-timeout`);
      return {
        status: 504,
        body: { status: "database-timeout", module: "financial", runId, period: currentPeriod, stepsExecuted, safeErrorCode: "mongodb-timeout" },
      };
    }
    if (error instanceof FinancialClientError) {
      telemetrySafeErrorCode = "ERROR";
      const status = error.safe.status === "connection-expired" ? "connection-expired" : "step-failed";
      console.error(`[cron:olsera:financial] runId=${runId} stepsExecuted=${stepsExecuted} safeErrorCode=${status}`);
      return {
        status: 200,
        body: { success: false, mode: "cron", module: "financial", runId, period: currentPeriod, status, stepsExecuted, completed: false },
      };
    }
    console.error(`[cron:olsera:financial] runId=${runId} stepsExecuted=${stepsExecuted} gagal`, error instanceof Error ? error.message : error);
    telemetrySafeErrorCode = "UNKNOWN";
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
    try {
      const finishedAt = new Date();
      await withMongo(async () => {
        const { olseraFinancialCronInvocations } = await collections();
        await olseraFinancialCronInvocations.insertOne({
          _id: `${runId}:${finishedAt.getTime()}`,
          cronRunId: runId,
          period: telemetryPeriod,
          status: telemetryRun?.status ?? "no-op",
          startedAt: telemetryStartedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt,
          stepsExecuted,
          checkpoint: telemetryRun?.accountCursor ?? null,
          safeErrorCode: telemetrySafeErrorCode,
          stopReason: telemetryRun?.status === "success" ? "completed" : stepsExecuted ? "checkpointed" : "no-op",
        });
      });
    } catch (error) {
      console.error("[cron:olsera:financial] telemetry write failed", isDatabaseTimeoutError(error) ? "timeout" : "error");
    }
  }
}
