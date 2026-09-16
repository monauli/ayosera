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

// Jenis laporan dipakai apa adanya dari parser — satu daftar, bukan dua yang
// bisa menyimpang.
export type { FinancialSheetKind as MappingReportKind } from "./mapping-parser.ts";
import type { FinancialSheetKind as MappingReportKind } from "./mapping-parser.ts";

export type MappingGroupingRule = {
  report: MappingReportKind;
  /** Sisi yang baris-barisnya DIJUMLAHKAN jadi satu. */
  combine: "excel" | "pdf";
  /** Label hasil gabungan; harus cocok dengan label di sisi lawan. */
  target: string;
  /** Label yang dijumlahkan, apa adanya seperti tercetak di sisi `combine`. */
  parts: readonly string[];
  /** Kode akun PDF yang stabil ketika label OCR berubah. */
  partCodes?: readonly string[];
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

export type MappingAliasRule = {
  report: MappingReportKind;
  excelLabels: readonly string[];
  pdfLabel: string;
  pdfCode?: string;
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
  // --- Neraca ------------------------------------------------------------
  // Aktif sejak parser PDF Neraca ada dan sudah dibuktikan angkanya terhadap
  // Februari 2026.
  {
    report: "balance-sheet",
    combine: "pdf",
    target: "Kas dan Bank",
    parts: ["BANK BCA 7195-332266", "BANK BCA 719-5538808", "kas ayat silang QRIS/EDC"],
    partCodes: ["11105", "11106", "11107"],
    note: "Gabungan dari: BANK BCA 7195-332266 + BANK BCA 719-5538808 + kas ayat silang QRIS/EDC",
    // Februari 2026: 255.454.187,17 + 43.305.973,47 + 1.995.000,00
    // = 300.755.160,64 — sama persis dengan "Kas dan Bank" di Excel.
    verified: true,
  },
];

export const MAPPING_ALIAS_RULES: readonly MappingAliasRule[] = [
  { report: "cashflow", excelLabels: ["Total Aktivasi opersional"], pdfLabel: "Total Aktivitas Operasional" },
  { report: "balance-sheet", excelLabels: ["Piutang Sewa Lapangan"], pdfLabel: "Piutang Court Fee", pdfCode: "11301" },
  { report: "balance-sheet", excelLabels: ["Persedian barang dagang", "Persediaan barang dagang"], pdfLabel: "Persediaan barang dagang", pdfCode: "11400" },
  { report: "balance-sheet", excelLabels: ["Jumlah Aset Lancar"], pdfLabel: "Total Aset Lancar" },
  { report: "balance-sheet", excelLabels: ["Jumlah Aset Tidak Lancar"], pdfLabel: "SubTotal Aset Tidak Lancar" },
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
 * Logika perbandingan menerapkan aturan ini hanya ketika salah satu sisi
 * masih menggabungkan kedua akun dan sisi lainnya sudah memecahnya. Jika
 * keduanya sudah terpisah, aturan dilewati agar tidak membuat selisih palsu.
 */
export function rulesForReport(report: MappingReportKind): MappingGroupingRule[] {
  return MAPPING_GROUPING_RULES.filter((rule) => rule.report === report);
}

export function aliasRulesForReport(report: MappingReportKind): MappingAliasRule[] {
  return MAPPING_ALIAS_RULES.filter((rule) => rule.report === report);
}
