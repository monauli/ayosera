// Verifikasi Bearer CRON_SECRET — SATU-SATUNYA tempat perbandingan ini
// dilakukan, dipakai bersama oleh SEMUA endpoint cron (olsera-sync lama,
// cron/sync, dan cron/olsera/{sales,inventory,financial}) supaya konsisten
// (Task 4: sebelumnya ada 3 salinan logika yang sama, dua di antaranya
// memakai perbandingan string biasa). Secret HANYA dibaca dari env server,
// tidak pernah dikembalikan dalam response/log.
import { timingSafeEqual } from "node:crypto";

export type CronAuthResult = { ok: true } | { ok: false; status: 401 | 500; message: string };

// Perbandingan waktu-konstan: string biasa (`!==`) bisa membocorkan info lewat
// timing side-channel secara teoretis. Panjang beda -> tolak langsung (aman,
// timingSafeEqual sendiri melempar error bila panjang buffer tidak sama).
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyCronSecret(authHeader: string | null): CronAuthResult {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    return { ok: false, status: 500, message: "CRON_SECRET is not configured" };
  }
  if (!safeEqual(authHeader ?? "", `Bearer ${expectedSecret}`)) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  return { ok: true };
}
