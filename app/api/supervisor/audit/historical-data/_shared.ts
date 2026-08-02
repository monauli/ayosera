// Helper bersama — Milestone 4 Bagian E/F/H (Historical Data). SATU jalur
// komputasi dipakai oleh route ringkasan DAN export supaya angka yang
// ditampilkan dan yang diexport SELALU identik (pola sama
// app/api/supervisor/audit/court-revenue/_shared.ts).
import { NextResponse } from "next/server";
import { buildHistoricalDataAudit } from "@/lib/historical-data-audit";
import { currentStoreId } from "@/lib/reconciliation-store";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export function jsonError(message: string, status: number) {
  return NextResponse.json({ status: "failed", message }, { status, headers: NO_CACHE_HEADERS });
}

/** Bangun laporan Historical Data lengkap (8 kategori) — read-only, live compute. */
export async function buildHistoricalDataSummary() {
  return buildHistoricalDataAudit(currentStoreId());
}
