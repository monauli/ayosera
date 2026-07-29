// Helper MURNI (tanpa I/O — tidak menyentuh `window`/`fetch`) untuk state
// "period" (YYYY-MM) aktif pada panel Laporan Keuangan Olsera
// (components/olsera-financial-panel.tsx). Dibuat untuk memperbaiki bug
// produksi: pemilihan bulan sering "terkunci"/kembali ke Februari 2026.
//
// AKAR MASALAH (sebelum perbaikan ini):
//   1. Panel di-mount/unmount setiap kali pengguna pindah tab navigasi
//      (app/page.tsx merender <OlseraFinancialPanel/> di dalam kondisi
//      `activeNav === "OlseraKeuangan"` — bukan disembunyikan lewat CSS,
//      betul-betul dilepas dari tree). Setiap remount mereset SELURUH state
//      lokal (termasuk `period` dan ref penanda "pengguna sudah memilih").
//   2. Efek fetch snapshot punya sisi-efek DIAM-DIAM memindahkan `period` ke
//      `latestSyncedPeriod` dari server setiap kali `userChangedPeriodRef`
//      masih false — yang (karena poin 1) menjadi false lagi setiap kali
//      panel di-remount. Bila `latestSyncedPeriod` di server kebetulan/selalu
//      "2026-02", maka SETIAP kali pengguna pindah tab lalu kembali ke
//      Laporan Keuangan, pilihan bulan mereka ditimpa balik ke Februari
//      sebelum mereka sempat memilih ulang.
//
// PERBAIKAN: satu sumber kebenaran period = QUERY STRING URL (bertahan
// lintas remount/reload, lihat resolveInitialPeriod), dan TIDAK ADA lagi
// jalur yang diam-diam mengganti period berdasarkan data dari server.

export const FINANCIAL_PERIOD_QUERY_KEY = "financialPeriod";

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

export function isValidPeriodFormat(value: string | null | undefined): value is string {
  return typeof value === "string" && PERIOD_PATTERN.test(value);
}

/** Jepit period ke rentang [minPeriod, maxPeriod] (perbandingan string leksikografis aman untuk format YYYY-MM). */
export function clampFinancialPeriod(period: string, minPeriod: string, maxPeriod: string): string {
  if (period < minPeriod) return minPeriod;
  if (period > maxPeriod) return maxPeriod;
  return period;
}

/** Baca period dari query string (mis. "?financialPeriod=2026-05&x=1"). null bila tidak ada atau formatnya bukan YYYY-MM. */
export function readPeriodFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get(FINANCIAL_PERIOD_QUERY_KEY);
  return isValidPeriodFormat(raw) ? raw : null;
}

/** Tulis/timpa period ke query string — PURE, mengembalikan string baru, param lain di search dipertahankan apa adanya. */
export function writePeriodToSearch(search: string, period: string): string {
  const params = new URLSearchParams(search);
  params.set(FINANCIAL_PERIOD_QUERY_KEY, period);
  return params.toString();
}

/**
 * Tentukan period AWAL saat panel mount — SATU-SATUNYA tempat default
 * ditentukan. Prioritas: (1) period dari URL bila valid & masih dalam
 * rentang [minPeriod, currentPeriod] (mempertahankan pilihan pengguna lintas
 * reload/remount tab), (2) bulan berjalan (Asia/Jakarta).
 *
 * SENGAJA TIDAK menerima parameter seperti "latestSyncedPeriod" atau
 * "hasData" dari server — fallback berbasis data server adalah akar bug yang
 * diperbaiki di sini. Bila bulan yang diminta (dari URL ataupun default)
 * belum punya data, itu urusan lapisan UI untuk menampilkan status "Belum
 * ada data" (lihat snapshot.hasData), BUKAN alasan mengganti period aktif.
 */
export function resolveInitialPeriod(input: { periodFromUrl: string | null; currentPeriod: string; minPeriod: string }): string {
  const base = input.periodFromUrl ?? input.currentPeriod;
  return clampFinancialPeriod(base, input.minPeriod, input.currentPeriod);
}

/**
 * Race-guard: apakah response untuk `respondedPeriod` masih relevan
 * diterapkan ke state, mengingat period yang SEDANG aktif sekarang adalah
 * `activePeriod`? Dipakai di efek fetch snapshot/ledger SEBAGAI TAMBAHAN
 * (bukan pengganti) guard `cancelled` closure yang sudah ada — false berarti
 * pengguna sudah berpindah period sebelum response ini tiba (response
 * "lama"), sehingga TIDAK BOLEH menimpa tampilan bulan terbaru yang sedang
 * diminta pengguna.
 */
export function shouldApplyPeriodResponse(respondedPeriod: string, activePeriod: string): boolean {
  return respondedPeriod === activePeriod;
}
