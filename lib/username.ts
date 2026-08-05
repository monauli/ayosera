// Dipisah dari lib/users.ts (yang mengimpor "@/lib/auth", alias path yang
// tidak bisa diresolusi oleh node --test tanpa bundler) supaya logika murni
// ini bisa diuji langsung — lihat lib/users.test.ts.
//
// Dipakai bersama oleh POST/PATCH /api/users (validasi format) — 3-32
// karakter, huruf/angka/titik/underscore/strip saja supaya aman dipakai
// sebagai identifier login (bukan format email, jadi tidak bisa
// disalahartikan sebagai email pengguna lain saat login).
export const USERNAME_REGEX = /^[a-z0-9_.-]{3,32}$/;

/** Auto-generate dari local-part email saat username tidak diisi — null bila hasilnya terlalu pendek/kosong setelah dibersihkan (username tetap opsional, tidak memblokir pembuatan user). */
export function usernameFromEmail(email: string): string | null {
  const candidate = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9_.-]/g, "") ?? "";
  return USERNAME_REGEX.test(candidate) ? candidate : null;
}
