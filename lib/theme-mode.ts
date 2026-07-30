// Sumber kebenaran untuk mode terang/gelap AYOSERA (kunci localStorage + cara
// membaca nilai awal). Dipakai oleh app/page.tsx dan app/login/page.tsx
// supaya kedua tempat itu memakai logika baca-mode yang SAMA PERSIS, bukan
// dua logika terpisah yang bisa berbeda.
//
// Root cause bug "tema kembali ke light setelah login" (lihat tmp/ai-handoff.md
// untuk kronologi audit lengkap):
//
// 1. Kedua halaman sebelumnya menginisialisasi state React `mode` dengan
//    hardcode "light", lalu MENGOREKSI-nya lewat useEffect setelah mount
//    (membaca atribut data-mode yang sudah diisi benar oleh skrip bootstrap
//    blocking di app/layout.tsx). Di app/page.tsx, effect KOREKSI itu (deps
//    `[]`) berjalan bersamaan dengan effect PENULIS localStorage/atribut
//    (deps `[mode]`) pada commit mount yang sama — dan di bawah React
//    StrictMode (aktif otomatis oleh Next.js App Router saat development),
//    React menjalankan seluruh effect mount tersebut DUA KALI, sehingga
//    effect penulis sempat menulis nilai `mode` AWAL ("light") ke DOM
//    SEBELUM giliran kedua effect koreksi membaca ulang.
// 2. Diverifikasi lebih lanjut lewat instrumentasi langsung di browser
//    (patch setAttribute/localStorage.setItem + polling atribut) bahwa
//    atribut `data-mode` yang sudah benar di halaman /login TIDAK bisa
//    diandalkan tetap utuh persis pada momen komponen dashboard pertama kali
//    dirender setelah navigasi client-side Next.js App Router (atributnya
//    sempat teramati kosong sesaat sebelum effect penulis dashboard berjalan)
//    — artinya membaca ULANG ATRIBUT DOM saat inisialisasi state juga tidak
//    cukup andal untuk transisi rute ini.
//
// Perbaikan: baca preferensi LANGSUNG DARI localStorage (sumber yang sama
// persis dipakai skrip bootstrap, dan TIDAK disentuh oleh reconciliation
// DOM/React apa pun) sebagai bagian dari inisialisasi state (lazy initializer
// useState), memakai persis logika fallback yang sama dengan skrip bootstrap:
// localStorage tersimpan -> preferensi sistem (prefers-color-scheme) -> light.
// Dengan begitu `mode` React benar sejak render pertama, tidak bergantung
// pada urutan effect maupun kondisi atribut DOM saat itu.

export type ThemeMode = "dark" | "light";

export const THEME_MODE_STORAGE_KEY = "ayo-mode";

/** True hanya untuk "dark"/"light" — nilai lain (termasuk null/undefined/typo) tidak valid. */
export function isValidThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light";
}

type MinimalStorage = { getItem(key: string): string | null };
type MinimalMatchMedia = (query: string) => { matches: boolean };

/**
 * Baca mode awal memakai PERSIS logika skrip bootstrap di app/layout.tsx:
 * localStorage tersimpan -> preferensi sistem (prefers-color-scheme: light)
 * -> default "dark" bila sistem tidak menyatakan preferensi terang. Aman
 * dipanggil di server (tanpa window) maupun saat localStorage/matchMedia
 * bermasalah — selalu jatuh ke "light" tanpa melempar error.
 *
 * `storage`/`matchMediaFn` opsional untuk kebutuhan test (lihat
 * lib/theme-mode.test.ts); di browser cukup panggil `readInitialThemeMode()`
 * tanpa argumen.
 */
export function readInitialThemeMode(storage?: MinimalStorage, matchMediaFn?: MinimalMatchMedia): ThemeMode {
  try {
    const store = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const stored = store?.getItem(THEME_MODE_STORAGE_KEY) ?? null;
    if (isValidThemeMode(stored)) return stored;

    const matchMedia = matchMediaFn ?? (typeof window === "undefined" ? undefined : window.matchMedia?.bind(window));
    if (matchMedia && matchMedia("(prefers-color-scheme: light)").matches) return "light";
    return "dark";
  } catch {
    return "light";
  }
}
