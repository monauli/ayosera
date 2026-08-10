// Content-Security-Policy — nonce-based (Task 4: security hardening). Dipakai
// dari middleware.ts (butuh nonce per-request, jadi tidak bisa lewat
// next.config.ts headers() yang statis). Diekstrak sebagai fungsi murni supaya
// bisa diuji tanpa next/server.
//
// script-src memakai nonce + 'strict-dynamic' (bukan daftar host) — skrip
// bootstrap tema inline (app/layout.tsx) dan seluruh chunk Next.js yang
// dimuatnya sendiri tetap jalan, tapi skrip asing yang disuntikkan (XSS) tidak
// akan pernah punya nonce yang benar. style-src tetap mengizinkan
// 'unsafe-inline' karena banyak komponen memakai style={{...}} (atribut style
// inline React) — risiko jauh lebih rendah dibanding script-src, dan mengganti
// seluruhnya ke class Tailwind adalah redesign di luar cakupan hardening ini.
//
// ROOT CAUSE V7 (rekonsiliasi Berita Acara: hasil OCR tidak pernah muncul di
// UI setelah upload sukses): CSP ini SEBELUMNYA memblokir tesseract.js
// (lib/reconciliation-berita-acara-client-ocr.ts) secara diam-diam di
// browser production:
//   1. `connect-src 'self'` menolak fetch tesseract.js ke
//      https://cdn.jsdelivr.net (workerPath/corePath/langPath default-nya,
//      lihat node_modules/tesseract.js/src/worker/browser/defaultOptions.js)
//      -> createWorker() langsung reject.
//   2. Tidak ada `worker-src` -> fallback ke script-src, yang tidak
//      mengizinkan `blob:` (tesseract.js membungkus worker script yang
//      di-fetch jadi Blob lalu `new Worker(blobURL)`, workerBlobURL:true).
//   3. `script-src` tanpa 'wasm-unsafe-eval' di production -> kompilasi
//      WebAssembly (mesin OCR tesseract-core.wasm) ditolak browser modern.
// Ketiganya menyebabkan setiap panggilan OCR di scanned-PDF/JPG/PNG (jalur
// SATU-SATUNYA yang men-support dokumen Berita Acara hasil scan) melempar
// error yang tertangkap oleh catch di app/reconciliation/page.tsx
// (analyzeFileClient) -> `analysis` TIDAK PERNAH ke-set -> 3 kartu hasil dan
// alasan auto-fill tidak pernah tampil, walau upload attachment-nya sendiri
// sukses (jalur upload tidak lewat OCR sama sekali). Test unit sebelumnya
// TIDAK menangkap ini karena reconciliation-berita-acara-client-ocr.test.ts
// mock.module("tesseract.js", ...) total — tidak pernah menjalankan fetch
// sungguhan yang kena CSP. Perbaikan V7 HANYA membuka host CDN resmi
// tesseract.js (npm mirror jsdelivr, bukan layanan AI berbayar) dan primitif
// browser (blob: worker, WASM) yang secara faktual dibutuhkan mesin OCR
// lokal ini — tidak melonggarkan apa pun di luar itu.
//
// HARDENING PASCA-V7 (self-host aset tesseract.js): host CDN cdn.jsdelivr.net
// dari poin (1) di atas DIHAPUS dari connect-src. Worker script, mesin OCR
// WASM (tesseract-core-lstm.wasm.js, varian LSTM-only non-SIMD saja — lihat
// lib/reconciliation-berita-acara-client-ocr.ts), dan data bahasa
// (ind+eng.traineddata.gz) sekarang di-vendor sebagai file statis di
// public/tesseract/ dan dilayani same-origin oleh Next.js — createWorker()
// diberi corePath/langPath/workerPath eksplisit yang menunjuk ke situ, jadi
// connect-src 'self' saja sudah cukup (tidak perlu origin eksternal apa pun
// untuk OCR lagi). worker-src 'self' blob: TETAP dipertahankan tanpa
// perubahan: workerBlobURL tesseract.js tidak diubah dari default (true),
// jadi mekanisme spawn worker (Blob + new Worker(blobURL)) persis sama
// dengan yang sudah terverifikasi jalan di production — hanya path aset di
// dalam Blob-nya sekarang same-origin, bukan CDN. 'wasm-unsafe-eval' juga
// tetap dipertahankan (masih dibutuhkan untuk kompilasi WASM lokal).
//
// img-src/frame-src juga diperluas ke *.public.blob.vercel-storage.com —
// SATU-SATUNYA origin tempat lampiran Berita Acara publik disimpan (lihat
// lib/blob-storage.ts, access:"public") — supaya preview PDF/gambar Berita
// Acara (Goal 2) bisa dirender langsung dari Blob URL tanpa proxy backend.
export function buildContentSecurityPolicy(nonce: string, isDev: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://*.public.blob.vercel-storage.com",
    "frame-src https://*.public.blob.vercel-storage.com",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (!isDev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
