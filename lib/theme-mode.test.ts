// Test perilaku nyata untuk bug "tema kembali ke light setelah login" (lihat
// lib/theme-mode.ts untuk analisis akar masalah). readInitialThemeMode adalah
// satu-satunya logika yang menentukan nilai mode yang benar — diuji langsung
// di sini (bukan lewat pencarian string) karena logikanya bisa diekstrak
// murni tanpa DOM/React sungguhan. Struktur effect (yang tidak bisa dites
// murni tanpa DOM/React nyata) diverifikasi lewat pemeriksaan sumber yang
// menegaskan pola BENAR (baca+tulis dalam satu effect) dan TIDAK ADA lagi
// pola SALAH (effect penulis terpisah yang bergantung pada `mode` basi).
// Jalankan: npm run test:theme-mode
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { THEME_MODE_STORAGE_KEY, isValidThemeMode, readInitialThemeMode } from "./theme-mode.ts";

function fakeStorage(value: string | null) {
  return { getItem: (key: string) => (key === THEME_MODE_STORAGE_KEY ? value : null) };
}

function fakeMatchMedia(prefersLight: boolean) {
  return () => ({ matches: prefersLight });
}

const pageSource = () => readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const loginSource = () => readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");

// ---- 1 & 2. Preferensi dark/light dibaca apa adanya, tidak ditimpa ---------

test("readInitialThemeMode: localStorage 'dark' -> 'dark' (preferensi dark TIDAK ditimpa menjadi light)", () => {
  assert.equal(readInitialThemeMode(fakeStorage("dark"), fakeMatchMedia(true)), "dark");
});

test("readInitialThemeMode: localStorage 'light' -> 'light' (preferensi light tetap light)", () => {
  assert.equal(readInitialThemeMode(fakeStorage("light"), fakeMatchMedia(false)), "light");
});

// ---- 3. Nilai valid dibaca sebelum ada penulisan ulang ---------------------

test("readInitialThemeMode: dipakai sebagai NILAI BALIK murni (bukan efek) — memanggilnya berkali-kali tidak mengubah apa pun dan selalu konsisten", () => {
  const storage = fakeStorage("dark");
  assert.equal(readInitialThemeMode(storage), "dark");
  assert.equal(readInitialThemeMode(storage), "dark");
  assert.equal(readInitialThemeMode(storage), "dark");
});

test("readInitialThemeMode: localStorage tersimpan MENANG atas preferensi sistem (localStorage diperiksa lebih dulu, persis skrip bootstrap)", () => {
  assert.equal(readInitialThemeMode(fakeStorage("light"), fakeMatchMedia(false)), "light");
  assert.equal(readInitialThemeMode(fakeStorage("dark"), fakeMatchMedia(true)), "dark");
});

// ---- 4. Nilai tidak valid ditangani aman + mode system tetap dihormati ----

test("readInitialThemeMode: tanpa localStorage tersimpan, ikuti preferensi sistem (prefers-color-scheme) seperti skrip bootstrap", () => {
  assert.equal(readInitialThemeMode(fakeStorage(null), fakeMatchMedia(true)), "light");
  assert.equal(readInitialThemeMode(fakeStorage(null), fakeMatchMedia(false)), "dark");
});

test("readInitialThemeMode: nilai localStorage tidak valid/rusak ditangani aman (diperlakukan seperti tidak ada, ikut preferensi sistem)", () => {
  assert.equal(readInitialThemeMode(fakeStorage(""), fakeMatchMedia(true)), "light");
  assert.equal(readInitialThemeMode(fakeStorage("SYSTEM"), fakeMatchMedia(false)), "dark");
  assert.equal(readInitialThemeMode(fakeStorage("Dark"), fakeMatchMedia(true)), "light"); // case-sensitive, bukan tebakan
});

test("readInitialThemeMode: tanpa window/localStorage/matchMedia sama sekali (mis. SSR) -> aman, tidak melempar error", () => {
  assert.doesNotThrow(() => readInitialThemeMode(undefined, undefined));
});

test("isValidThemeMode: hanya 'dark'/'light' yang valid", () => {
  assert.equal(isValidThemeMode("dark"), true);
  assert.equal(isValidThemeMode("light"), true);
  assert.equal(isValidThemeMode("system"), false);
  assert.equal(isValidThemeMode(null), false);
  assert.equal(isValidThemeMode(undefined), false);
  assert.equal(isValidThemeMode(""), false);
  assert.equal(isValidThemeMode(1), false);
});

test("THEME_MODE_STORAGE_KEY: kunci localStorage tidak berubah dari mekanisme existing ('ayo-mode')", () => {
  assert.equal(THEME_MODE_STORAGE_KEY, "ayo-mode");
});

// ---- 5. Tidak ada state default yang bisa tertulis SEBELUM preferensi
// tersimpan terbaca. Dibuktikan lewat struktur sumber: state `mode` boleh
// hardcode "light" sebagai nilai AWAL RENDER (aman, sama di server & klien,
// mencegah hydration mismatch), TAPI baca-dan-tulis localStorage harus
// terjadi dalam SATU effect yang sama — bukan effect "baca" terpisah dari
// effect "tulis" yang bergantung pada `mode` (pola lama penyebab bug: effect
// tulis sempat jalan dengan `mode` basi sebelum effect baca sempat mengoreksi,
// dan di bawah React StrictMode koreksi itu tidak pernah benar-benar menang).

test("app/page.tsx: baca (readInitialThemeMode) dan tulis (setAttribute + localStorage.setItem) mode terjadi dalam SATU effect mount yang sama", () => {
  const source = pageSource();
  const mountEffectMatch = source.match(/useEffect\(\(\) => \{\s*const saved = window\.localStorage\.getItem\(THEME_STORAGE_KEY\);[\s\S]*?\}, \[\]\);/);
  assert.ok(mountEffectMatch, "effect mount yang membaca theme+mode harus ditemukan");
  const mountEffectBody = mountEffectMatch[0];
  assert.ok(mountEffectBody.includes("readInitialThemeMode()"));
  assert.ok(mountEffectBody.includes("setMode(initialMode)"));
  assert.ok(mountEffectBody.includes('document.documentElement.setAttribute("data-mode", initialMode)'));
  assert.ok(mountEffectBody.includes("window.localStorage.setItem(THEME_MODE_STORAGE_KEY, initialMode)"));
});

test("app/page.tsx: TIDAK ADA lagi effect terpisah yang menulis mode berdasarkan dependency [mode] (sumber race bug lama)", () => {
  const source = pageSource();
  assert.equal(
    /useEffect\(\(\) => \{\s*document\.documentElement\.setAttribute\("data-mode", mode\);\s*window\.localStorage\.setItem\(THEME_MODE_STORAGE_KEY, mode\);\s*\}, \[mode\]\);/.test(source),
    false,
    "effect terpisah berbasis [mode] inilah yang dulu menulis nilai basi — tidak boleh ada lagi",
  );
});

test("app/login/page.tsx: mode dikoreksi lewat effect mount yang memanggil readInitialThemeMode() (bukan lazy initializer yang bisa memicu hydration mismatch)", () => {
  const source = loginSource();
  assert.ok(source.includes('const [mode, setMode] = useState<ThemeMode>("light");'));
  assert.ok(/useEffect\(\(\) => \{\s*setMode\(readInitialThemeMode\(\)\);\s*\}, \[\]\);/.test(source));
  assert.equal(source.includes('useState<ThemeMode>(() => readInitialThemeMode())'), false, "lazy initializer menyebabkan mismatch server/klien (server tidak punya window)");
});

test("app/page.tsx: state mode juga hardcode 'light' di render pertama (SSR-safe, sama seperti login) — bukan lazy initializer", () => {
  const source = pageSource();
  assert.ok(source.includes('const [mode, setMode] = useState<ThemeMode>("light");'));
  assert.equal(source.includes('useState<ThemeMode>(() => readInitialThemeMode())'), false);
});

// ---- 6. Toggle tema tetap bisa mengubah & menyimpan preferensi -------------

test("app/page.tsx: onToggleMode tetap mengubah state DAN langsung menulis data-mode + localStorage (kunci existing)", () => {
  const source = pageSource();
  assert.ok(source.includes("onToggleMode={() =>"));
  assert.ok(source.includes('document.documentElement.setAttribute("data-mode", next);'));
  assert.ok(source.includes("window.localStorage.setItem(THEME_MODE_STORAGE_KEY, next);"));
});

test("app/login/page.tsx: toggleMode tetap mengubah state DAN menyimpan ke localStorage dengan kunci existing", () => {
  const source = loginSource();
  assert.ok(source.includes("function toggleMode()"));
  assert.ok(source.includes('document.documentElement.setAttribute("data-mode", next);'));
  assert.ok(source.includes("window.localStorage.setItem(THEME_MODE_STORAGE_KEY, next);"));
});

// ---- 7. Tidak ada regresi lain di halaman login/dashboard: satu sumber ----
// kebenaran kunci localStorage (tidak ada lagi konstanta ganda "ayo-mode")

test("kunci localStorage 'ayo-mode' hanya didefinisikan SEKALI (lib/theme-mode.ts), tidak digandakan sebagai konstanta terpisah di page.tsx/login", () => {
  const page = pageSource();
  const login = loginSource();
  assert.equal(page.includes('const MODE_STORAGE_KEY = "ayo-mode"'), false);
  assert.equal(login.includes('const MODE_STORAGE_KEY = "ayo-mode"'), false);
  assert.ok(page.includes('import { readInitialThemeMode, THEME_MODE_STORAGE_KEY, type ThemeMode } from "@/lib/theme-mode";'));
  assert.ok(login.includes('import { readInitialThemeMode, THEME_MODE_STORAGE_KEY, type ThemeMode } from "@/lib/theme-mode";'));
});
