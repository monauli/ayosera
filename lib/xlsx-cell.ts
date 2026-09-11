// Pembacaan nilai sel ExcelJS yang dipakai bersama oleh pembaca .xlsx di
// repo ini. Sebelumnya helper ini hidup sebagai fungsi privat di
// scripts/bootstrap-monthly-snapshot-baseline.ts; dipindah ke sini supaya
// lib/mapping-excel-parser.ts memakai SATU implementasi yang sama, bukan
// menyalinnya.
import type ExcelJS from "exceljs";

/**
 * Nilai efektif satu sel.
 *
 * Tiga hal yang ditangani, semuanya kasus nyata di file yang dibaca repo ini:
 *
 *  1. MERGED CELL — ExcelJS menyalin nilai sel jangkar ke SEMUA sel dalam
 *     rentang merge saat dibaca, sedangkan library `xlsx` lama hanya mengisi
 *     sel jangkar. Tanpa penjagaan ini, baris judul yang di-merge lebar (mis.
 *     "Laporan Stock Opname" di baris 1) membuat kolom B ikut berisi teks
 *     judul, bukan kosong.
 *
 *  2. FORMULA DENGAN HASIL TER-CACHE — nilai yang dipakai adalah `result`,
 *     bukan objek formulanya.
 *
 *  3. FORMULA TANPA HASIL TER-CACHE — sel shared-formula yang nilainya tidak
 *     pernah ikut disimpan Excel muncul sebagai `{ sharedFormula: "B21" }`
 *     TANPA properti `result`. Versi lama helper ini hanya memeriksa
 *     `"result" in v`, jadi objek formula itu lolos apa adanya dan berakhir
 *     jadi NaN di pemanggil. Nyata di fixture: sheet "Cashflow Arus kas"
 *     baris 21 dan 26. Sekarang dikembalikan `null` (nilai tidak diketahui) —
 *     BUKAN 0 — supaya pemanggil tidak menganggapnya nol sungguhan. Pengaman
 *     aritmatika di lib/mapping-excel-parser.ts yang memutuskan apakah itu
 *     bisa diterima.
 */
export function cellValue(cell: ExcelJS.Cell): unknown {
  if (cell.isMerged && cell.master !== cell) return null;
  const value = cell.value;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const record = value as unknown as Record<string, unknown>;
    if ("result" in record) return record.result;
    if ("formula" in record || "sharedFormula" in record) return null;
  }
  return value;
}
