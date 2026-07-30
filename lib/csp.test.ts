// Regression test untuk Task 4 (security hardening): Content-Security-Policy
// nonce-based. Membuktikan CSP tidak wildcard berlebihan (tidak ada '*' di
// script-src atau default-src) dan skrip bootstrap tema tetap diizinkan lewat
// nonce yang sama persis dengan yang dipakai di header.
import assert from "node:assert/strict";
import test from "node:test";
import { buildContentSecurityPolicy } from "./csp.ts";

test("CSP tidak memakai wildcard '*' pada default-src/script-src (bukan proteksi kosong)", () => {
  const csp = buildContentSecurityPolicy("abc123", false);
  const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))!;
  const defaultSrc = csp.split(";").find((d) => d.trim().startsWith("default-src"))!;
  assert.equal(scriptSrc.includes("*"), false);
  assert.equal(defaultSrc.includes("*"), false);
});

test("nonce yang diberikan muncul persis di script-src (skrip bootstrap tema bisa jalan)", () => {
  const csp = buildContentSecurityPolicy("my-unique-nonce-value", false);
  assert.ok(csp.includes("'nonce-my-unique-nonce-value'"));
});

test("production: tidak ada 'unsafe-eval' (tidak melemahkan proteksi XSS demi kemudahan)", () => {
  const csp = buildContentSecurityPolicy("n", false);
  assert.equal(csp.includes("unsafe-eval"), false);
});

test("development: 'unsafe-eval' diizinkan (Fast Refresh butuh eval) tanpa mengubah production", () => {
  const csp = buildContentSecurityPolicy("n", true);
  assert.ok(csp.includes("unsafe-eval"));
});

test("frame-ancestors 'none' selalu ada (proteksi clickjacking, setara X-Frame-Options DENY)", () => {
  const csp = buildContentSecurityPolicy("n", false);
  assert.ok(csp.includes("frame-ancestors 'none'"));
});

test("object-src dan base-uri dibatasi ke 'none'/'self' (tidak dibiarkan default longgar)", () => {
  const csp = buildContentSecurityPolicy("n", false);
  assert.ok(csp.includes("object-src 'none'"));
  assert.ok(csp.includes("base-uri 'self'"));
});

test("style-src mengizinkan 'unsafe-inline' (dibutuhkan atribut style={{}} React) — didokumentasikan sebagai trade-off sengaja", () => {
  const csp = buildContentSecurityPolicy("n", false);
  assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"));
});

test("upgrade-insecure-requests hanya di production (tidak memaksa https di dev/localhost)", () => {
  const prod = buildContentSecurityPolicy("n", false);
  const dev = buildContentSecurityPolicy("n", true);
  assert.ok(prod.includes("upgrade-insecure-requests"));
  assert.equal(dev.includes("upgrade-insecure-requests"), false);
});
