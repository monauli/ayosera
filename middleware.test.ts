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
import { config, middleware } from "./middleware.ts";

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

// ---- Task 4 (security hardening): security headers ------------------------

test("Content-Security-Policy selalu ada di response (baik redirect ke /login maupun diteruskan)", () => {
  const redirected = middleware(requestTo("/"));
  const passed = middleware(requestTo("/login"));
  assert.ok(redirected.headers.get("Content-Security-Policy"));
  assert.ok(passed.headers.get("Content-Security-Policy"));
});

test("CSP tidak memakai wildcard '*' pada script-src/default-src (bukan proteksi kosong)", () => {
  const response = middleware(requestTo("/login"));
  const csp = response.headers.get("Content-Security-Policy")!;
  assert.equal(csp.includes("script-src *"), false);
  assert.equal(csp.includes("default-src *"), false);
});

test("nonce diteruskan konsisten: x-nonce pada request header sama dengan nonce di CSP response header", () => {
  const request = requestTo("/login");
  const response = middleware(request);
  const forwardedNonce = response.headers.get("x-middleware-request-x-nonce") ?? request.headers.get("x-nonce");
  const csp = response.headers.get("Content-Security-Policy")!;
  // Setidaknya satu nonce (apapun nilainya) harus benar-benar tercantum di CSP.
  const match = csp.match(/'nonce-([^']+)'/);
  assert.ok(match, "CSP harus memuat nonce");
  if (forwardedNonce) assert.equal(match![1], forwardedNonce);
});

test("nonce berbeda di setiap request (tidak statis/dipakai ulang)", () => {
  const csp1 = middleware(requestTo("/login")).headers.get("Content-Security-Policy")!;
  const csp2 = middleware(requestTo("/login")).headers.get("Content-Security-Policy")!;
  const nonce1 = csp1.match(/'nonce-([^']+)'/)![1];
  const nonce2 = csp2.match(/'nonce-([^']+)'/)![1];
  assert.notEqual(nonce1, nonce2);
});

test("ikon tab dikecualikan dari matcher: /icon.svg tidak pernah dijawab redirect ke /login", () => {
  // Regresi Task 5: tanpa pengecualian ini, permintaan ikon dari halaman /login
  // dijawab 307 ke /login sehingga browser menerima HTML untuk sebuah gambar.
  const pattern = new RegExp(config.matcher[0].replace(/^\/\(/, "^/(").concat("$"));
  for (const excluded of ["/icon.svg", "/favicon.ico"]) {
    assert.equal(pattern.test(excluded), false, `${excluded} seharusnya tidak diproses middleware`);
  }
  assert.equal(pattern.test("/"), true, "route aplikasi harus tetap diproses middleware");
});
