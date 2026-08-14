// Presentation-only status for the reconciliation screen. The canonical
// reconciliation engine still owns the calculation and its financial-report
// validation status; the UI labels a match when the computed difference is
// within the existing ±Rp1 tolerance.
export type ReconciliationOmzetUiStatus = "COCOK" | "SELISIH_TERJELASKAN" | "PERLU_DICEK" | "BULAN_BERJALAN";

import { isWithinReconciliationTolerance } from "./reconciliation-tolerance";

// V10: `beritaAcaraVerified` opsional (default false — SEMUA pemanggil lama
// dengan 2 argumen tetap berperilaku IDENTIK, termasuk perilaku existing
// yang sengaja menurunkan status "COCOK" balik ke PERLU_DICEK bila selisih
// SAAT INI di luar toleransi — lihat test "rekonsiliasi di luar toleransi
// adalah Perlu Dicek" di reconciliation-omzet-ui.test.ts, TIDAK diubah).
// `beritaAcaraVerified` SENGAJA jadi satu-satunya jalur baru untuk memaksa
// "COCOK" terlepas dari besar selisih mentahnya (bukan `status === "COCOK"`
// yang di-passthrough begitu saja — itu akan melemahkan safety-net existing
// di atas) — hanya periode yang BENAR-BENAR sudah di-Simpan dan
// server-verified (lihat isBeritaAcaraVerifiedUnlocked di
// lib/reconciliation-omzet-period-lock.ts) yang boleh lewat jalur ini.
export function reconciliationOmzetUiStatus(
  status: ReconciliationOmzetUiStatus,
  differenceRevenue: number,
  beritaAcaraVerified = false,
): ReconciliationOmzetUiStatus {
  if (beritaAcaraVerified) return "COCOK";
  if (isWithinReconciliationTolerance(differenceRevenue)) return "COCOK";
  if (status === "BULAN_BERJALAN") return "BULAN_BERJALAN";
  if (status === "SELISIH_TERJELASKAN") return "SELISIH_TERJELASKAN";
  return "PERLU_DICEK";
}
