// Regression test untuk Task 2 (logout 403): redirectToLogin() di app/page.tsx
// tidak bisa diuji sebagai fungsi murni (memanggil fetch/window.location, dan
// tidak ada infra render React/jsdom di proyek ini — sama seperti
// lib/theme-mode.test.ts). Yang diuji lewat pemeriksaan sumber di sini adalah
// KONTRAK yang sebelumnya hilang dan menyebabkan "UI berpura-pura berhasil
// walau server logout gagal": versi lama tidak pernah memeriksa response.ok
// sama sekali. Root cause 403 itu sendiri (BETTER_AUTH_URL salah) diuji murni
// di lib/auth-base-url.test.ts. Jalankan: npm run test:logout-flow
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pageSource = () => readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("attemptSignOut memeriksa response.ok (bukan asal fetch selesai) sebelum dianggap berhasil", () => {
  const source = pageSource();
  const fnMatch = source.match(/async function attemptSignOut\(\): Promise<boolean> \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, "attemptSignOut harus ditemukan");
  assert.ok(fnMatch[0].includes("return response.ok;"));
  assert.ok(fnMatch[0].includes('method: "POST"'));
});

test("redirectToLogin mencoba sign-out DUA KALI (fallback) sebelum menyerah — bukan sekali lalu diam", () => {
  const source = pageSource();
  assert.ok(source.includes("const success = (await attemptSignOut()) || (await attemptSignOut());"));
});

test("kegagalan sign-out TIDAK disembunyikan (dicatat), tapi tidak membocorkan token/cookie mentah", () => {
  const source = pageSource();
  const redirectFnMatch = source.match(/function redirectToLogin\(\) \{[\s\S]*?\n\}/);
  assert.ok(redirectFnMatch, "redirectToLogin harus ditemukan");
  const body = redirectFnMatch[0];
  assert.ok(/console\.error\(/.test(body), "kegagalan harus dicatat, tidak didiamkan");
  assert.equal(/token|cookie[^)]*\.value|session_token/i.test(body), false, "log tidak boleh menyertakan token/cookie mentah");
});

test("redirectToLogin tetap selalu berakhir di /login (kontrak existing untuk 20+ caller reaktif 401 tidak berubah)", () => {
  const source = pageSource();
  const redirectFnMatch = source.match(/function redirectToLogin\(\) \{[\s\S]*?\n\}/);
  assert.ok(redirectFnMatch);
  assert.ok(redirectFnMatch[0].includes('window.location.href = "/login";'));
});
