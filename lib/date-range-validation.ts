// Validasi start_date/end_date bersama untuk endpoint export yang menerima
// rentang tanggal lewat query string (Task 4: security hardening — cegah
// export tak terbatas yang berisiko memory/timeout function serverless).
// Satu helper dipakai bersama, bukan digandakan di tiap route.
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type DateRangeValidation = { ok: true } | { ok: false; error: string };

/** maxDays generous secukupnya untuk pemakaian wajar (mis. 1 tahun penuh),
 * tapi tetap membatasi permintaan ekstrem (mis. satu dekade) yang bisa
 * menyebabkan memory/timeout pada export baris-per-transaksi. */
export function validateDateRangeQuery(start: string, end: string, maxDays: number): DateRangeValidation {
  if (!DATE_PATTERN.test(start) || !DATE_PATTERN.test(end)) {
    return { ok: false, error: "start_date & end_date wajib diisi dengan format YYYY-MM-DD." };
  }
  if (start > end) {
    return { ok: false, error: "start_date tidak boleh lebih besar dari end_date." };
  }
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  if (days > maxDays) {
    return { ok: false, error: `Rentang tanggal maksimum ${maxDays} hari (diminta ${days} hari). Persempit rentang lalu coba lagi.` };
  }
  return { ok: true };
}
