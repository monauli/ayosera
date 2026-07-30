// Regression test untuk proteksi route (Task 2 — logout 403): membuktikan
// perilaku NYATA middleware (bukan pencarian string) — request tanpa cookie
// sesi diarahkan ke /login, request dengan cookie sesi diteruskan, dan /login
// sendiri selalu bisa diakses. Ini adalah bagian dari kontrak "setelah logout,
// route terproteksi tidak bisa dibuka" — middleware hanya bisa memeriksa
// KEHADIRAN cookie (bukan validitas sesi di server, sengaja, lihat komentar di
// middleware.ts), jadi baris pertahanan sesungguhnya adalah: sign-out server
// benar-benar menghapus cookie (lihat lib/auth.test.ts + app/page.tsx).
// Jalankan: npm run test:middleware
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { middleware } from "./middleware.ts";

function requestTo(pathname: string, cookieHeader?: string) {
  return new NextRequest(`https://ayosera.vercel.app${pathname}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });
}

test("tanpa cookie sesi: route terproteksi (dashboard) diarahkan ke /login", () => {
  const response = middleware(requestTo("/"));
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location")!).pathname, "/login");
});

test("dengan cookie sesi (better-auth.session_token): route terproteksi diteruskan (bukan redirect)", () => {
  const response = middleware(requestTo("/", "better-auth.session_token=fake-value-for-test"));
  assert.equal(response.headers.get("location"), null);
});

test("dengan cookie sesi __Secure- (produksi https): route terproteksi diteruskan", () => {
  const response = middleware(requestTo("/", "__Secure-better-auth.session_token=fake-value-for-test"));
  assert.equal(response.headers.get("location"), null);
});

test("setelah logout (cookie dihapus/tidak ada), reload ke route terproteksi tetap diarahkan ke /login", () => {
  const response = middleware(requestTo("/olsera/inventori"));
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location")!).pathname, "/login");
});

test("/login selalu bisa diakses walau tanpa cookie sesi (supaya user bisa login ulang)", () => {
  const response = middleware(requestTo("/login"));
  assert.equal(response.headers.get("location"), null);
});

test("/login tetap bisa diakses walau cookie sesi (basi) masih ada — tidak dipantulkan ke /", () => {
  const response = middleware(requestTo("/login", "better-auth.session_token=stale-value"));
  assert.equal(response.headers.get("location"), null);
});
