// Diekstrak dari lib/auth.ts supaya bisa diuji tanpa memicu koneksi MongoDB
// (mengimpor lib/auth.ts langsung membuka koneksi database di top-level module).
// Task 4 (security hardening): secret penandatanganan sesi TIDAK BOLEH diam-diam
// jatuh ke nilai hardcode di production — kalau BETTER_AUTH_SECRET/JWT_SECRET
// belum diset, gagal keras saat startup (bukan session token yang bisa dipalsukan
// siapa pun yang membaca kode ini). Development tetap dapat fallback praktis.
const DEV_FALLBACK_SECRET = "local-dev-secret-change-before-production-please-32chars";

export function resolveAuthSecret(env: { BETTER_AUTH_SECRET?: string; JWT_SECRET?: string; NODE_ENV?: string }): string {
  const secret = env.BETTER_AUTH_SECRET || env.JWT_SECRET;
  if (secret) return secret;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "BETTER_AUTH_SECRET (atau JWT_SECRET) wajib diset di production — tidak ada fallback yang aman untuk secret penandatanganan sesi.",
    );
  }
  return DEV_FALLBACK_SECRET;
}
