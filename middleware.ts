import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy } from "@/lib/csp";

const BETTER_AUTH_SESSION_COOKIES = ["better-auth.session_token", "__Secure-better-auth.session_token"];

export function middleware(request: NextRequest) {
  const sessionCookie = BETTER_AUTH_SESSION_COOKIES.some((name) => request.cookies.has(name));
  const isLoginPage = request.nextUrl.pathname === "/login";

  // Nonce per-request untuk skrip bootstrap tema inline (app/layout.tsx) —
  // diteruskan lewat request header supaya layout.tsx bisa membacanya via
  // headers(), dan dipakai lagi di CSP response header agar keduanya cocok.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildContentSecurityPolicy(nonce, process.env.NODE_ENV !== "production");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  let response: NextResponse;
  if (!sessionCookie && !isLoginPage) {
    response = NextResponse.redirect(new URL("/login", request.url));
  } else {
    // Catatan: sengaja TIDAK memantulkan /login -> / hanya karena cookie ada.
    // Cookie bisa masih ada tapi sesinya sudah kedaluwarsa; memantulkannya akan
    // bertabrakan dengan redirect 401 di client dan menyebabkan loop refresh.
    // Biarkan /login selalu bisa diakses supaya user dapat login ulang.
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // icon.svg ikut dikecualikan bersama favicon.ico: ikon tab tidak boleh
  // memerlukan sesi — tanpa ini permintaan ikon dari halaman /login dijawab
  // 307 ke /login (browser menerima HTML untuk sebuah gambar).
  //
  // tesseract dikecualikan karena alasan yang SAMA PERSIS: aset OCR
  // tesseract.js yang di-self-host di public/tesseract/ (worker script, core
  // WASM, data bahasa — lihat lib/reconciliation-berita-acara-client-ocr.ts)
  // adalah aset statis publik, BUKAN halaman aplikasi. Tanpa pengecualian
  // ini permintaan tesseract.js ke path itu (fetch/importScripts dari dalam
  // Worker) akan dijawab 307 ke /login (HTML) alih-alih file JS/WASM/gzip
  // sungguhan bila cookie sesi kebetulan tidak terkirim — sebelum hardening
  // ini aset-aset itu di-fetch dari CDN eksternal (cdn.jsdelivr.net) yang
  // sama sekali tidak tunduk pada middleware auth aplikasi ini, jadi masalah
  // ini baru muncul setelah aset jadi same-origin.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg|tesseract/).*)"],
};
