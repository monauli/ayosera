// Diekstrak dari lib/auth.ts supaya bisa diuji tanpa memicu koneksi MongoDB
// (mengimpor lib/auth.ts langsung membuka koneksi database karena
// mongodbAdapter dipanggil di top-level module). Lihat lib/auth.ts untuk
// konteks penuh: root cause bug logout 403 (Task 2).
export function describeAuthBaseURLIssue(raw: string | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `BETTER_AUTH_URL/NEXT_PUBLIC_APP_URL tidak valid: "${raw}". Harus URL absolut dengan skema, mis. "https://ayosera.vercel.app" (bukan hanya nama domain).`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `BETTER_AUTH_URL/NEXT_PUBLIC_APP_URL harus memakai skema http/https, ditemukan skema "${parsed.protocol}" pada "${raw}".`;
  }
  return null;
}
