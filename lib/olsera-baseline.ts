// Konstanta baseline tetap Olsera — SATU sumber kebenaran untuk seluruh
// modul (penjualan & inventori). Jangan hardcode tanggal baseline di file lain;
// import dari sini. Zero dependency (aman dipakai di client component & script).
//
// Zona waktu acuan seluruh perhitungan tanggal Olsera: Asia/Jakarta.
// Jangan hardcode "hari ini" — turunkan selalu dari waktu berjalan (lihat
// todayJakarta() di lib/olsera-sync.ts).

export const OLSERA_TIMEZONE = "Asia/Jakarta";

/** Baseline sync penjualan Olsera (order + item + kategori + addon). */
export const OLSERA_SALES_BASELINE_DATE = "2026-02-01";

/** Baseline sync inventori Olsera (katalog, snapshot stok, mutasi turunan penjualan). */
export const OLSERA_INVENTORY_BASELINE_DATE = "2026-02-01";
