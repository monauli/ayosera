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

// CATATAN V7: dicek sebagai token persis "'unsafe-eval'" (dengan quote),
// BUKAN substring "unsafe-eval" mentah — 'wasm-unsafe-eval' (ditambahkan V7
// untuk mengizinkan kompilasi WebAssembly mesin OCR tesseract.js, lihat
// buildContentSecurityPolicy) secara sengaja MENGANDUNG substring yang sama
// tapi adalah primitif CSP berbeda dan jauh lebih sempit: hanya mengizinkan
// WebAssembly.compile/instantiate, TIDAK mengizinkan eval()/Function() JS
// string-to-code seperti 'unsafe-eval'. Assertion substring lama akan salah
// gagal (false positive) begitu 'wasm-unsafe-eval' ditambahkan.
test("production: tidak ada 'unsafe-eval' JS penuh (tidak melemahkan proteksi XSS demi kemudahan) — 'wasm-unsafe-eval' (WASM saja) TETAP diizinkan", () => {
  const csp = buildContentSecurityPolicy("n", false);
  assert.equal(csp.includes("'unsafe-eval'"), false);
  assert.ok(csp.includes("'wasm-unsafe-eval'"), "WASM mesin OCR tesseract.js butuh ini");
});

// V7: root cause OCR Berita Acara tidak pernah tampil di UI setelah upload —
// tesseract.js (client-side OCR, lib/reconciliation-berita-acara-client-ocr.ts)
// diam-diam gagal di production karena CSP lama menolak fetch CDN
// worker/core/lang-data-nya, blob: worker, dan kompilasi WASM. Test ini
// adalah regresi yang SEHARUSNYA menangkap bug itu dari awal — beda dengan
// reconciliation-berita-acara-client-ocr.test.ts yang mock.module tesseract.js
// total sehingga tidak pernah benar-benar melewati CSP.
//
// HARDENING PASCA-V7: aset tesseract.js (worker script, mesin OCR WASM, data
// bahasa) sekarang di-vendor same-origin di public/tesseract/ (lihat
// lib/reconciliation-berita-acara-client-ocr.ts, TESSERACT_ASSET_OPTIONS)
// alih-alih fetch ke CDN cdn.jsdelivr.net saat runtime. connect-src TIDAK
// LAGI perlu mengizinkan origin eksternal apa pun untuk OCR. worker-src
// 'self' blob: TETAP dipertahankan tanpa perubahan (workerBlobURL tesseract.js
// tidak diubah dari default true — mekanisme spawn worker persis sama
// dengan yang sudah terverifikasi jalan di production, cuma path aset di
// dalamnya sekarang same-origin).
test("Hardening: CSP TIDAK LAGI mereferensikan CDN eksternal apa pun untuk OCR client-side tesseract.js (aset di-self-host same-origin) — connect-src 'self' saja sudah cukup", () => {
  const csp = buildContentSecurityPolicy("n", false);
  const connectSrc = csp.split(";").find((d) => d.trim().startsWith("connect-src"))!;
  const workerSrc = csp.split(";").find((d) => d.trim().startsWith("worker-src"))!;
  assert.equal(connectSrc.trim(), "connect-src 'self'", "tidak boleh ada host CDN (cdn.jsdelivr.net atau lainnya) lagi di connect-src");
  assert.equal(csp.includes("jsdelivr"), false, "tidak ada jejak CDN jsdelivr tersisa di CSP mana pun");
  assert.ok(workerSrc.includes("'self'") && workerSrc.includes("blob:"), "tesseract.js workerBlobURL:true (tidak diubah) -> new Worker(blob:...) tetap butuh ini");
  // Tidak wildcard sembarang host lain.
  assert.equal(connectSrc.includes("*"), false);
});

test("V7: img-src dan frame-src mengizinkan *.public.blob.vercel-storage.com (satu-satunya origin lampiran Berita Acara publik) untuk preview PDF/gambar tanpa proxy", () => {
  const csp = buildContentSecurityPolicy("n", false);
  const imgSrc = csp.split(";").find((d) => d.trim().startsWith("img-src"))!;
  const frameSrc = csp.split(";").find((d) => d.trim().startsWith("frame-src"))!;
  assert.ok(imgSrc.includes("https://*.public.blob.vercel-storage.com"));
  assert.ok(frameSrc.includes("https://*.public.blob.vercel-storage.com"));
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
