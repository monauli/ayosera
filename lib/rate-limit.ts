// Rate limiting berbasis MongoDB (Task 4: security hardening). Serverless
// (Vercel) tidak punya memori bersama antar instance function, jadi
// penghitung in-memory akan menyesatkan (tiap instance punya angka sendiri,
// batasnya efektif jadi limit × jumlah instance) — MongoDB dipakai sebagai
// satu-satunya sumber kebenaran bersama, pola yang sama dengan distributed
// lock (lib/olsera-cron-lock.ts). Fixed window: satu dokumen per (key,
// window waktu), di-$inc atomik lewat findOneAndUpdate.
import { collections } from "./mongodb.ts";

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export type RateLimitCollection = {
  findOneAndUpdate(
    filter: { _id: string },
    update: unknown,
    options: { upsert: true; returnDocument: "after" },
  ): Promise<{ count: number } | null>;
};

/** Bucket tetap saat ini + sisa waktu — diekstrak murni supaya bisa diuji
 * tanpa MongoDB (lihat lib/rate-limit.test.ts). */
export function currentWindowBucket(nowMs: number, windowSeconds: number): { bucketStart: number; retryAfterSeconds: number } {
  const windowMs = windowSeconds * 1000;
  const bucketStart = Math.floor(nowMs / windowMs) * windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((bucketStart + windowMs - nowMs) / 1000));
  return { bucketStart, retryAfterSeconds };
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  collection?: RateLimitCollection,
): Promise<RateLimitResult> {
  const windowMs = windowSeconds * 1000;
  const { bucketStart, retryAfterSeconds } = currentWindowBucket(Date.now(), windowSeconds);
  const id = `${key}:${bucketStart}`;
  const rateLimits = collection ?? (await collections()).rateLimits;
  const doc = await rateLimits.findOneAndUpdate(
    { _id: id },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(bucketStart + windowMs * 2) } },
    { upsert: true, returnDocument: "after" },
  );
  const count = doc?.count ?? 1;
  return { allowed: count <= limit, retryAfterSeconds };
}

/** IP klien dari header standar Vercel/proxy. Tidak sempurna (bisa disamarkan
 * secara teoretis), tapi cukup untuk membatasi automated abuse yang wajar —
 * bukan untuk keputusan otorisasi. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

/**
 * Bungkus pemeriksaan rate limit dengan fail-open: bila MongoDB sedang
 * bermasalah, jangan sampai login/webhook yang sah ikut gagal hanya karena
 * lapisan pertahanan tambahan ini error — rate limit adalah defense-in-depth,
 * bukan gerbang otorisasi utama (itu tetap requireUser/requireSupervisor/
 * verifyCronSecret/dll, yang tidak fail-open).
 */
export async function checkRateLimitSafe(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  try {
    return await checkRateLimit(key, limit, windowSeconds);
  } catch (error) {
    console.error("[rate-limit] check failed, failing open", error instanceof Error ? error.message : error);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
