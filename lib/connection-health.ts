import "server-only";
import { collections, withMongo } from "@/lib/mongodb";
import { isFinancialSyncRunStale, RUNNING_STALE_THRESHOLD_MS } from "@/lib/cron-olsera-financial";

// Phase 3D.1 — Connection Health Monitoring. Baca ULANG log/checkpoint sync yang
// SUDAH ADA (sync_logs, olsera_sync_log, olsera_financial_sync_logs,
// ayo_payment_event_sync_state, olsera_inventory_sync_runs) — TIDAK memanggil
// AYO/Olsera hanya untuk mengecek koneksi, dan TIDAK mengubah formula/proses sync.

export type ConnectionStatus = "TERHUBUNG" | "BERMASALAH" | "BELUM_ADA_DATA";

export type ConnectionIssueKind =
  | "AKSES_API_BERMASALAH"
  | "TIMEOUT"
  | "TIDAK_BISA_TERHUBUNG"
  | "SERVER_SUMBER_BERMASALAH"
  | "DATA_TIDAK_VALID"
  | "SINKRONISASI_MACET";

export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  TERHUBUNG: "Terhubung",
  BERMASALAH: "Bermasalah",
  BELUM_ADA_DATA: "Belum Ada Data",
};

export const CONNECTION_ISSUE_LABEL: Record<ConnectionIssueKind, string> = {
  AKSES_API_BERMASALAH: "Akses API Bermasalah",
  TIMEOUT: "Timeout",
  TIDAK_BISA_TERHUBUNG: "Tidak Bisa Terhubung",
  SERVER_SUMBER_BERMASALAH: "Server Sumber Bermasalah",
  DATA_TIDAK_VALID: "Data Tidak Valid",
  SINKRONISASI_MACET: "Sinkronisasi Macet",
};

export type ModuleHealth = {
  module: "ayo-booking" | "ayo-payment-events" | "olsera-sales" | "olsera-inventory" | "olsera-financial";
  label: string;
  status: ConnectionStatus;
  issue: ConnectionIssueKind | null;
  lastSuccessfulSyncAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  checkedAt: string;
};

/**
 * Klasifikasi bermakna bukti (evidence-based), sama seperti classifyAyoMobileToken di
 * lib/private-integration-monitor.ts: tidak pernah menebak. Urutan pengecekan penting —
 * 401/403 diperiksa sebelum pola timeout/network agar pesan seperti "HTTP 401 ... timeout
 * saat retry" tetap diklasifikasikan sebagai akses, bukan jaringan.
 */
export function classifyConnectionIssue(errorMessage: string | null | undefined): ConnectionIssueKind | null {
  const text = errorMessage ?? "";
  if (!text.trim()) return null;
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid.?token/i.test(text)) return "AKSES_API_BERMASALAH";
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return "TIMEOUT";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed|gagal terhubung/i.test(text)) return "TIDAK_BISA_TERHUBUNG";
  if (/\b5\d{2}\b|server sumber|internal server error/i.test(text)) return "SERVER_SUMBER_BERMASALAH";
  return "DATA_TIDAK_VALID";
}

export function buildModuleHealth(
  module: ModuleHealth["module"],
  label: string,
  params: {
    lastSuccessfulSyncAt: Date | null;
    lastAttemptAt: Date | null;
    lastError: string | null;
    now: Date;
  },
): ModuleHealth {
  const { lastSuccessfulSyncAt, lastAttemptAt, lastError, now } = params;
  const hasAnyEvidence = Boolean(lastSuccessfulSyncAt || lastAttemptAt || lastError);
  if (!hasAnyEvidence) {
    return {
      module,
      label,
      status: "BELUM_ADA_DATA",
      issue: null,
      lastSuccessfulSyncAt: null,
      lastAttemptAt: null,
      lastError: null,
      checkedAt: now.toISOString(),
    };
  }

  // "Bermasalah" hanya jika percobaan TERAKHIR (bukan sekadar pernah ada error historis) gagal:
  // attempt terbaru lebih baru dari sukses terakhir (atau belum pernah sukses sama sekali).
  const lastAttemptIsFailure =
    Boolean(lastError) && (!lastSuccessfulSyncAt || !lastAttemptAt || lastAttemptAt.getTime() >= lastSuccessfulSyncAt.getTime());

  const issue = lastAttemptIsFailure ? classifyConnectionIssue(lastError) : null;
  const status: ConnectionStatus = lastAttemptIsFailure ? "BERMASALAH" : "TERHUBUNG";

  return {
    module,
    label,
    status,
    issue,
    lastSuccessfulSyncAt: lastSuccessfulSyncAt?.toISOString() ?? null,
    lastAttemptAt: lastAttemptAt?.toISOString() ?? null,
    lastError: lastAttemptIsFailure ? lastError : null,
    checkedAt: now.toISOString(),
  };
}

export async function getAyoBookingHealth(now = new Date()): Promise<ModuleHealth> {
  return withMongo(async () => {
    const { syncLogs } = await collections();
    const filter = { type: { $in: ["manual", "scheduled", "webhook"] as const } };
    const [lastLog, lastSuccess] = await Promise.all([
      syncLogs.find(filter).sort({ startedAt: -1 }).limit(1).next(),
      syncLogs.find({ ...filter, status: { $in: ["success", "partial"] } }).sort({ startedAt: -1 }).limit(1).next(),
    ]);
    return buildModuleHealth("ayo-booking", "AYO Booking", {
      lastSuccessfulSyncAt: lastSuccess?.startedAt ?? null,
      lastAttemptAt: lastLog?.startedAt ?? null,
      lastError: lastLog?.errorMessage ?? null,
      now,
    });
  });
}

export async function getAyoPaymentEventsHealth(now = new Date()): Promise<ModuleHealth> {
  return withMongo(async () => {
    const { ayoPaymentEventSyncState } = await collections();
    const state = await ayoPaymentEventSyncState.findOne({ _id: "ayo-payment-events-auto-sync" });
    return buildModuleHealth("ayo-payment-events", "AYO Payment Events", {
      lastSuccessfulSyncAt: state?.lastSuccessfulSyncAt ?? null,
      lastAttemptAt: state?.lastAttemptAt ?? null,
      lastError: state?.lastError ?? null,
      now,
    });
  });
}

export async function getOlseraSalesHealth(now = new Date()): Promise<ModuleHealth> {
  return withMongo(async () => {
    const { olseraSyncLog } = await collections();
    const [lastLog, lastSuccess] = await Promise.all([
      olseraSyncLog.find().sort({ startedAt: -1 }).limit(1).next(),
      olseraSyncLog.find({ status: { $in: ["success", "partial"] } }).sort({ startedAt: -1 }).limit(1).next(),
    ]);
    return buildModuleHealth("olsera-sales", "Olsera Sales", {
      lastSuccessfulSyncAt: lastSuccess?.startedAt ?? null,
      lastAttemptAt: lastLog?.startedAt ?? null,
      lastError: lastLog?.errorMessage ?? null,
      now,
    });
  });
}

export async function getOlseraInventoryHealth(now = new Date()): Promise<ModuleHealth> {
  return withMongo(async () => {
    const { olseraInventorySyncRuns } = await collections();
    const [lastRun, lastSuccess] = await Promise.all([
      olseraInventorySyncRuns.find().sort({ startedAt: -1 }).limit(1).next(),
      olseraInventorySyncRuns.find({ status: "success" }).sort({ startedAt: -1 }).limit(1).next(),
    ]);
    return buildModuleHealth("olsera-inventory", "Olsera Inventory", {
      lastSuccessfulSyncAt: lastSuccess?.completedAt ?? lastSuccess?.startedAt ?? null,
      lastAttemptAt: lastRun?.startedAt ?? null,
      lastError: lastRun?.errorMessage ?? null,
      now,
    });
  });
}

export async function getOlseraFinancialHealth(now = new Date()): Promise<ModuleHealth> {
  return withMongo(async () => {
    const { olseraFinancialSyncLogs } = await collections();
    const [lastLog, lastSuccess] = await Promise.all([
      olseraFinancialSyncLogs.find().sort({ startedAt: -1 }).limit(1).next(),
      olseraFinancialSyncLogs.find({ status: "success" }).sort({ startedAt: -1 }).limit(1).next(),
    ]);
    const health = buildModuleHealth("olsera-financial", "Olsera Financial", {
      lastSuccessfulSyncAt: lastSuccess?.completedAt ?? lastSuccess?.startedAt ?? null,
      lastAttemptAt: lastLog?.startedAt ?? null,
      lastError: lastLog?.errorMessage ?? null,
      now,
    });
    // Insiden Agustus 2026: run yang macet berjam-jam tanpa progres tetap TERHUBUNG
    // di sini karena tidak pernah tercatat lastError eksplisit. isFinancialSyncRunStale
    // (lib/cron-olsera-financial.ts) sudah mendeteksi ini untuk observability cron —
    // reuse ambang yang sama supaya health-check tidak menyamarkan run macet sebagai sehat.
    if (health.status === "TERHUBUNG" && lastLog && isFinancialSyncRunStale({ ...lastLog, finalized: lastLog.finalized ?? false }, now)) {
      const staleHours = Math.floor(RUNNING_STALE_THRESHOLD_MS / 3_600_000);
      return {
        ...health,
        status: "BERMASALAH",
        issue: "SINKRONISASI_MACET",
        lastError: `Sync periode ${lastLog.period} sudah running >${staleHours} jam tanpa progres (terakhir update ${lastLog.updatedAt.toISOString()}).`,
      };
    }
    return health;
  });
}

export type OlseraOverallHealth = {
  status: "TERHUBUNG" | "PERLU_DICEK";
  problemModules: ModuleHealth["module"][];
};

/** Ringkasan Olsera HANYA "Terhubung" bila Sales, Inventory, dan Financial semuanya sehat — tidak pernah disamarkan jadi satu status buram. */
export function summarizeOlseraHealth(sales: ModuleHealth, inventory: ModuleHealth, financial: ModuleHealth): OlseraOverallHealth {
  const modules = [sales, inventory, financial];
  const problemModules = modules.filter((m) => m.status === "BERMASALAH").map((m) => m.module);
  return {
    status: problemModules.length === 0 ? "TERHUBUNG" : "PERLU_DICEK",
    problemModules,
  };
}

export async function getConnectionHealthSummary(now = new Date()) {
  const [ayoBooking, ayoPaymentEvents, olseraSales, olseraInventory, olseraFinancial] = await Promise.all([
    getAyoBookingHealth(now),
    getAyoPaymentEventsHealth(now),
    getOlseraSalesHealth(now),
    getOlseraInventoryHealth(now),
    getOlseraFinancialHealth(now),
  ]);
  return {
    ayo: { booking: ayoBooking, paymentEvents: ayoPaymentEvents },
    olsera: {
      sales: olseraSales,
      inventory: olseraInventory,
      financial: olseraFinancial,
      overall: summarizeOlseraHealth(olseraSales, olseraInventory, olseraFinancial),
    },
    checkedAt: now.toISOString(),
  };
}
