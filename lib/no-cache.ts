/**
 * Header untuk memastikan response data realtime tidak di-cache oleh browser,
 * CDN/Vercel edge, maupun proxy perantara. Dipakai pada API dashboard,
 * transaksi, status sinkronisasi, dan webhook.
 */
export const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "Surrogate-Control": "no-store",
} as const;
