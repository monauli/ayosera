// Logika murni endpoint cron Sync Olsera (app/api/cron/olsera-sync/route.ts),
// dipisah agar bisa diuji tanpa bergantung pada runtime Next.js.
import { syncOlseraSalesByCategory, todayJakarta } from "@/lib/olsera-sync";
import { verifyCronSecret } from "@/lib/olsera-cron-auth";

export type CronOlseraSyncResponse = {
  status: number;
  body: {
    success: boolean;
    mode: "cron";
    message: string;
    period?: { start_date: string; end_date: string };
    result?: unknown;
  };
};

export async function runOlseraCronSync(authHeader: string | null): Promise<CronOlseraSyncResponse> {
  const auth = verifyCronSecret(authHeader);
  if (!auth.ok) {
    if (auth.status === 500) console.error("[cron:olsera-sync] CRON_SECRET is not configured");
    return { status: auth.status, body: { success: false, mode: "cron", message: auth.message } };
  }

  try {
    // Selalu sinkronkan ulang hari ini (bukan lastFullySyncedDate + 1) supaya
    // transaksi baru yang masuk setelah sync sebelumnya di hari yang sama tetap
    // ikut tertarik. syncOlseraSalesByCategory sudah upsert per tanggal, jadi
    // sync ulang tanggal yang sama aman dan tidak menghasilkan duplikat.
    // force: true dipakai (opsi existing di syncOlseraSalesByCategory) supaya
    // hari ini tidak dilewati meski sudah pernah tercatat "fully synced" oleh
    // run cron sebelumnya di hari yang sama.
    const start_date = todayJakarta();
    const end_date = start_date;

    const result = await syncOlseraSalesByCategory(start_date, end_date, { force: true });

    return {
      status: 200,
      body: {
        success: true,
        mode: "cron",
        message: "Cron sync Olsera completed",
        period: { start_date, end_date },
        result,
      },
    };
  } catch (error) {
    console.error("[cron:olsera-sync] failed", error);
    return {
      status: 500,
      body: {
        success: false,
        mode: "cron",
        message: error instanceof Error ? error.message : "Scheduled Olsera sync failed",
      },
    };
  }
}
