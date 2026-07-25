/**
 * Orkestrator murni (tanpa DOM/React) untuk tombol "Sync Semua Olsera".
 * Menjalankan 3 tahap SECARA BERURUTAN (bukan paralel):
 *   1. Kategori/Penjualan
 *   2. Inventori
 *   3. Laporan Keuangan
 * Tahap berikutnya HANYA dijalankan jika tahap sebelumnya `ok: true`. Sync
 * AYO TIDAK pernah menjadi bagian dari orkestrator ini — pemanggil (page.tsx)
 * tidak pernah menyertakan runner AYO di sini.
 *
 * Modul ini murni logika sequencing + lock; pemanggilan endpoint aktual
 * (fetch ke /api/olsera/sync, /api/olsera/inventory/sync,
 * /api/olsera/financial/sync/*) dilakukan oleh runner yang di-inject dari
 * app/page.tsx, sehingga modul ini bisa diuji tanpa jaringan/DOM.
 */

export type StageId = "kategori" | "inventori" | "keuangan";

/** Empat status progres yang wajib ditampilkan ke user, plus "Tidak Dijalankan" untuk tahap yang dilewati akibat kegagalan tahap sebelumnya. */
export type StageStatus = "Menunggu" | "Sedang Sinkron" | "Berhasil" | "Gagal" | "Tidak Dijalankan";

export type StageOutcome = "success" | "partial" | "failed" | "connection-expired";

export interface StageResult {
  /** Hanya "success" yang dianggap ok — "partial" dianggap TIDAK cukup untuk melanjutkan ke tahap berikutnya (data tahap sebelumnya tetap dipertahankan, tapi proses berhenti). */
  ok: boolean;
  status: StageOutcome;
  /** Pesan aman untuk ditampilkan ke user — tidak boleh berisi token/URI/password/raw payload/stack trace. */
  message: string;
}

export type StageRunner = () => Promise<StageResult>;

export interface OlseraSyncAllDeps {
  /** Mengembalikan false bila lock sudah dipegang proses lain (mis. tombol per-modul atau orkestrator lain). */
  acquireLock: () => boolean;
  releaseLock: () => void;
  runKategori: StageRunner;
  runInventori: StageRunner;
  runKeuangan: StageRunner;
  onStageChange?: (stage: StageId, status: StageStatus) => void;
}

export interface OlseraSyncAllResult {
  ok: boolean;
  stages: Record<StageId, StageStatus>;
  /** Tahap yang menyebabkan proses berhenti, atau null bila semua berhasil / lock gagal didapat sebelum mulai. */
  failedStage: StageId | null;
  /** true bila proses tidak sempat dimulai karena proses "Sync Semua Olsera" (atau sync modul individual) lain sedang berjalan. */
  alreadyRunning: boolean;
  message: string;
}

const STAGE_ORDER: StageId[] = ["kategori", "inventori", "keuangan"];

const STAGE_LABEL: Record<StageId, string> = {
  kategori: "Kategori/Penjualan",
  inventori: "Inventori",
  keuangan: "Laporan Keuangan",
};

export async function runOlseraSyncAll(deps: OlseraSyncAllDeps): Promise<OlseraSyncAllResult> {
  const stages: Record<StageId, StageStatus> = { kategori: "Menunggu", inventori: "Menunggu", keuangan: "Menunggu" };
  const setStage = (stage: StageId, status: StageStatus) => {
    stages[stage] = status;
    deps.onStageChange?.(stage, status);
  };

  if (!deps.acquireLock()) {
    return {
      ok: false,
      stages,
      failedStage: null,
      alreadyRunning: true,
      message: "Proses sync Olsera lain sedang berjalan. Tunggu sampai selesai, lalu coba lagi.",
    };
  }

  const runners: Record<StageId, StageRunner> = {
    kategori: deps.runKategori,
    inventori: deps.runInventori,
    keuangan: deps.runKeuangan,
  };

  try {
    let failedStage: StageId | null = null;
    let lastMessage = "";

    for (const stage of STAGE_ORDER) {
      if (failedStage) {
        setStage(stage, "Tidak Dijalankan");
        continue;
      }

      setStage(stage, "Sedang Sinkron");
      let result: StageResult;
      try {
        result = await runners[stage]();
      } catch {
        // Kesalahan tak terduga (mis. jaringan putus) — jangan pernah membocorkan
        // detail teknis (stack trace/pesan asli) ke UI.
        result = { ok: false, status: "failed", message: "Terjadi kesalahan saat sinkronisasi. Coba lagi." };
      }

      lastMessage = result.message;
      if (result.ok) {
        setStage(stage, "Berhasil");
      } else {
        setStage(stage, "Gagal");
        failedStage = stage;
      }
    }

    return {
      ok: failedStage === null,
      stages: { ...stages },
      failedStage,
      alreadyRunning: false,
      message: failedStage
        ? `Sinkronisasi dihentikan pada tahap ${STAGE_LABEL[failedStage]}. ${lastMessage} Data tahap sebelumnya yang sudah berhasil tetap tersimpan.`
        : `Sinkronisasi semua modul Olsera (Kategori/Penjualan → Inventori → Laporan Keuangan) selesai. ${lastMessage}`,
    };
  } finally {
    deps.releaseLock();
  }
}

export { STAGE_ORDER, STAGE_LABEL };
