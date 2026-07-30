// storeId server-side (OLSERA_INTERNAL_STORE_ID) — SATU-SATUNYA sumber
// kebenaran, dipakai lintas modul (rekonsiliasi DAN inventori Olsera —
// diverifikasi read-only bahwa keduanya memakai angka storeId yang sama,
// lihat tmp/ai-handoff.md Task 4). storeId SELALU dari konfigurasi server,
// TIDAK PERNAH dari input klien — mencegah IDOR lintas toko (SEC-07).
//
// Diekstrak ke file netral (BUKAN "server-only") supaya bisa diimpor modul
// inventori yang juga dipakai oleh test yang dijalankan lewat `node`
// biasa (tanpa kondisi module "react-server") — lib/reconciliation-store.ts
// sendiri memakai "server-only" karena juga membaca MongoDB langsung di sana,
// tapi resolusi storeId ini murni process.env, tidak butuh proteksi itu.
export function validateStoreId(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error("storeId wajib diisi (integer positif).");
  return n;
}

export function currentStoreId(): number {
  return validateStoreId(process.env.OLSERA_INTERNAL_STORE_ID);
}
