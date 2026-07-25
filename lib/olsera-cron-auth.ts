// Verifikasi Bearer CRON_SECRET — pola sama seperti lib/cron-olsera-sync.ts
// (endpoint cron Olsera lama), dipakai bersama oleh ketiga endpoint cron baru
// (app/api/cron/olsera/{sales,inventory,financial}) supaya konsisten. Secret
// HANYA dibaca dari env server, tidak pernah dikembalikan dalam response/log.

export type CronAuthResult = { ok: true } | { ok: false; status: 401 | 500; message: string };

export function verifyCronSecret(authHeader: string | null): CronAuthResult {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    return { ok: false, status: 500, message: "CRON_SECRET is not configured" };
  }
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  return { ok: true };
}
