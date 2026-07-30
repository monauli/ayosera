// Content-Security-Policy — nonce-based (Task 4: security hardening). Dipakai
// dari middleware.ts (butuh nonce per-request, jadi tidak bisa lewat
// next.config.ts headers() yang statis). Diekstrak sebagai fungsi murni supaya
// bisa diuji tanpa next/server.
//
// script-src memakai nonce + 'strict-dynamic' (bukan daftar host) — skrip
// bootstrap tema inline (app/layout.tsx) dan seluruh chunk Next.js yang
// dimuatnya sendiri tetap jalan, tapi skrip asing yang disuntikkan (XSS) tidak
// akan pernah punya nonce yang benar. style-src tetap mengizinkan
// 'unsafe-inline' karena banyak komponen memakai style={{...}} (atribut style
// inline React) — risiko jauh lebih rendah dibanding script-src, dan mengganti
// seluruhnya ke class Tailwind adalah redesign di luar cakupan hardening ini.
export function buildContentSecurityPolicy(nonce: string, isDev: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (!isDev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
