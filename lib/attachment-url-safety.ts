// Pemeriksaan keamanan URL lampiran (Berita Acara) — dipakai LINTAS modul
// (inventory: app/reconciliation/inventory/page.tsx + app/api/reconciliation/inventory-opname/route.ts,
// omzet: app/api/reconciliation/court-revenue/[period]/finalization/analyze/route.ts)
// supaya logic tidak terduplikasi. DUA pemeriksaan TERPISAH dengan tujuan
// berbeda — jangan digabung jadi satu:
//
//  - isSafeAttachmentUrl: attachment.url AMAN dirender sebagai <a href> di
//    browser (cegah XSS lewat skema seperti "javascript:"/"data:") — cukup
//    tolak skema selain https, TIDAK peduli host-nya apa.
//
//  - isTrustedBlobAttachmentUrl: attachment.url AMAN di-fetch() dari SERVER
//    (cegah SSRF — server dipaksa fetch ke alamat internal/berbahaya
//    seperti https://127.0.0.1/ atau https://169.254.169.254/, yang
//    KEDUANYA tetap lolos cek https-only di atas). Origin-nya WAJIB cocok
//    domain Vercel Blob — satu-satunya sumber attachment sungguhan di app
//    ini (lib/blob-storage.ts) — sama persis allowlist yang sudah
//    dideklarasikan ke browser lewat CSP img-src/frame-src (lib/csp.ts).

export function isSafeAttachmentUrl(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\//i.test(value);
}

const TRUSTED_BLOB_HOST_EXACT = "public.blob.vercel-storage.com";
const TRUSTED_BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

export function isTrustedBlobAttachmentUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return url.hostname === TRUSTED_BLOB_HOST_EXACT || url.hostname.endsWith(TRUSTED_BLOB_HOST_SUFFIX);
}
