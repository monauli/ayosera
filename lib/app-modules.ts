// Logika murni (tanpa dependensi Next.js/better-auth) diekstrak dari lib/auth.ts
// supaya bisa diuji langsung lewat node --test, mengikuti pola auth-secret.ts /
// auth-base-url.ts.

export type AppRole = "supervisor" | "user";

// "rekonsiliasi" (Modul Rekonsiliasi, Phase 5A) ditambahkan paling akhir agar
// TIDAK mengubah urutan/nilai module yang sudah dipakai user existing —
// hanya supervisor yang otomatis mendapatkannya (lihat normalizeModules di
// bawah); user biasa TIDAK mendapat akses ini kecuali diberi eksplisit
// (default paling ketat, sesuai docs/reconciliation-design.md).
//
// "audit" (Audit & Sinkronisasi / Monitoring Integritas Data — lihat
// components/private-integration-monitor.tsx) menggantikan allowlist env
// AYOSERA_PRIVATE_TOOLS_USER_IDS lama: aksesnya sekarang murni modul biasa,
// dicentang/dicabut lewat menu Pengguna seperti modul lain, TIDAK auto-granted
// via modul lain (beda dari "rekonsiliasi") — default tetap tidak memiliki akses.
//
// "kunci-rekonsiliasi-omset" mengatur akses ke aksi Kunci/Buka Kunci Periode
// Rekonsiliasi Omset (app/api/reconciliation/court-revenue/[period]/finalization/lock
// & unlock), sebelumnya wajib supervisor — sekarang bisa didelegasikan lewat modul ini.
export const APP_MODULES = [
  "dasbor",
  "transaksi",
  "olsera",
  "webhook",
  "rekonsiliasi",
  "audit",
  "kunci-rekonsiliasi-omset",
] as const;
export type AppModule = (typeof APP_MODULES)[number];

/**
 * "olsera" adalah parent permission untuk seluruh fitur terkait Olsera.
 * Kategori Penjualan/Inventori/Laporan Keuangan sudah gated lewat modul
 * "olsera" itu sendiri di setiap route (lihat requireModule("olsera") di
 * seluruh app/api/olsera/**) dan di navItems sidebar (app/page.tsx) — ketiganya
 * anak dari satu grup "Olsera", tidak punya modul terpisah.
 *
 * Rekonsiliasi (Omset AYO vs Olsera & Inventori) historisnya memakai modul
 * terpisah "rekonsiliasi" (Phase 5A, lihat APP_MODULES di atas), tapi secara
 * bisnis juga bagian dari Olsera. Supaya TIDAK perlu checkbox baru di
 * Manajemen Pengguna, user yang diberi "olsera" otomatis mendapat
 * "rekonsiliasi" juga — dinormalisasi SATU KALI di sini sehingga berlaku untuk
 * getCurrentUser/requireModule/requireAnyModule/sidebar/semua route sekaligus
 * (satu-satunya sumber kebenaran, bukan dicek ulang per tempat).
 */
export function normalizeModules(role: AppRole, modules: unknown): AppModule[] {
  if (role === "supervisor") return [...APP_MODULES];
  if (!Array.isArray(modules)) return [];
  const granted = new Set(APP_MODULES.filter((module) => modules.includes(module)));
  if (granted.has("olsera")) granted.add("rekonsiliasi");
  return APP_MODULES.filter((module) => granted.has(module));
}
