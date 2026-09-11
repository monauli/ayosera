// Aturan pengelompokan Modul Mapping — TAHAP 4.
//
// Ditulis sebagai DATA, bukan cabang if di dalam logika perbandingan, karena
// tiap aturan adalah keputusan akuntansi manusia yang harus bisa dibaca,
// ditinjau, dan DITAMPILKAN KE PENGGUNA apa adanya. lib/mapping-compare.ts
// memakainya; app/mapping/page.tsx menampilkan `note`-nya di baris yang
// terkena aturan supaya tidak ada penggabungan yang terjadi diam-diam.
//
// Menambah aturan = menambah satu entri di sini. Tidak ada tempat lain yang
// perlu disentuh.

export type MappingReportKind = "profit-loss" | "balance-sheet";

export type MappingGroupingRule = {
  report: MappingReportKind;
  /** Sisi yang baris-barisnya DIJUMLAHKAN jadi satu. */
  combine: "excel" | "pdf";
  /** Label hasil gabungan; harus cocok dengan label di sisi lawan. */
  target: string;
  /** Label yang dijumlahkan, apa adanya seperti tercetak di sisi `combine`. */
  parts: readonly string[];
  /** Kalimat yang ditampilkan ke pengguna pada baris hasil gabungan. */
  note: string;
  /**
   * true bila kecocokan angkanya sudah dibuktikan terhadap periode nyata.
   * Aturan yang belum terbukti TETAP diterapkan — tapi tandanya ikut tampil,
   * supaya selisih yang muncul karena aturannya sendiri tidak disangka
   * selisih data.
   */
  verified: boolean;
};

export const MAPPING_GROUPING_RULES: readonly MappingGroupingRule[] = [
  {
    report: "profit-loss",
    combine: "excel",
    target: "Penjualan",
    parts: ["Penjualan", "Pendapatan Sewa Raket Padel"],
    note: "Gabungan dari: Penjualan + Pendapatan Sewa Raket Padel",
    // Terbukti pada Februari 2026: 39.781.000 + 200.000 = 39.981.000, sama
    // persis dengan "Penjualan" di PDF. TAPI lihat catatan lingkup di bawah.
    verified: true,
  },
  // --- Neraca: ditulis sekarang, BELUM dipakai ---------------------------
  // Perbandingan Neraca belum jalan karena PDF-nya belum punya parser (lihat
  // app/mapping/page.tsx). Kedua aturan di bawah disimpan di sini supaya tidak
  // hilang, dan akan langsung terpakai begitu parser Neraca ada.
  {
    report: "balance-sheet",
    combine: "pdf",
    target: "Kas dan Bank",
    parts: ["BANK BCA 7195-332266", "BANK BCA 719-5538808", "kas ayat silang QRIS/EDC"],
    note: "Gabungan dari: BANK BCA 7195-332266 + BANK BCA 719-5538808 + kas ayat silang QRIS/EDC",
    verified: false,
  },
  {
    report: "balance-sheet",
    combine: "pdf",
    target: "Laba rugi ditahan",
    parts: ["Laba rugi ditahan", "Pendapatan Periode ini"],
    note: "Gabungan dari: Laba rugi ditahan + Pendapatan Periode ini",
    verified: false,
  },
];

/**
 * CATATAN LINGKUP — aturan "Penjualan" TIDAK berlaku di semua periode.
 *
 * Di Februari 2026 PDF tidak mencetak akun 40003 "Pendapatan Sewa Raket Padel"
 * sama sekali dan nilainya tergabung ke "Penjualan", sehingga aturan ini
 * membuat kedua sisi cocok. Di Mei 2026 justru sebaliknya: PDF mencetak 40000
 * Penjualan (33.230.000) dan 40003 Pendapatan Sewa Raket Padel (28.470.000)
 * sebagai dua baris terpisah, persis seperti Excel — jadi menjumlahkan
 * keduanya di sisi Excel malah MEMBUAT selisih yang sebenarnya tidak ada.
 *
 * Aturan ini sengaja tetap diterapkan tanpa syarat periode, sesuai keputusan
 * yang diambil saat Tahap 4 dirancang. Konsekuensinya nyata dan harus
 * diketahui sebelum dipakai lintas bulan; kalau nanti diputuskan aturan perlu
 * berlaku per periode, tambahkan field `periods` di MappingGroupingRule dan
 * saring di appliedRules() — bukan dengan menebak di dalam logika
 * perbandingan.
 */
export function rulesForReport(report: MappingReportKind): MappingGroupingRule[] {
  return MAPPING_GROUPING_RULES.filter((rule) => rule.report === report);
}
