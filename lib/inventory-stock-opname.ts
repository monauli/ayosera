// Rule murni "Rekonsiliasi Inventori dengan Berita Acara" — TIDAK ADA akses
// MongoDB di file ini (bisa diuji dengan node:test tanpa database sungguhan,
// pola sama lib/reconciliation-rules.ts). Pemuatan/penyimpanan data ada di
// lib/inventory-stock-opname-store.ts.
//
// Fitur ini HANYA membandingkan closingQty snapshot bulanan (sudah ada,
// lib/olsera-inventory-monthly-snapshot-core.ts — TIDAK dihitung ulang di
// sini) dengan stok fisik hasil berita acara (input manual). Snapshot TIDAK
// PERNAH ditulis/diubah oleh modul ini.

export type OpnameStatus = "BELUM_DIISI" | "COCOK" | "PERLU_DICEK" | "BUTUH_ADJUST_MANUAL";

export const OPNAME_STATUS_LABELS: Record<OpnameStatus, string> = {
  BELUM_DIISI: "Belum Diisi",
  COCOK: "Cocok",
  PERLU_DICEK: "Perlu Dicek",
  BUTUH_ADJUST_MANUAL: "Butuh Adjust Manual",
};

export type SnapshotFlowFields = {
  openingQty: number | null;
  incomingQty: number | null;
  returnQty: number | null;
  salesQty: number | null;
  outgoingQty: number | null;
  closingQty: number | null;
};

export type SnapshotDiagnosticFields = {
  status: "complete" | "boundary-only" | "incomplete";
  canonicalProductId: number | null;
};

/**
 * "Butuh Adjust Manual" mengikuti diagnostik yang SUDAH ADA pada snapshot
 * (bukan aturan baru): `status: "incomplete"` (snapshot sendiri sudah
 * menandai closingQty tidak bisa dipercaya penuh — lihat carryForwardStatusAndDiagnostic
 * di lib/olsera-inventory-monthly-snapshot-core.ts, mis. productId berubah
 * tanpa alias) atau `canonicalProductId !== null` (baris movement memakai
 * productId berbeda dari katalog stabil — bukti identitas produk berubah).
 * `status: "boundary-only"` SENGAJA tidak dianggap manual (angka closingQty-nya
 * tetap dipakai apa adanya untuk perbandingan bulan ini, hanya metadata asal
 * datanya berbeda) — konsisten dengan cara lib/reconciliation-rules.ts
 * memperlakukan boundary sebagai toleransi, bukan ketidakpastian data.
 */
export function needsManualAdjust(snapshot: SnapshotDiagnosticFields): boolean {
  return snapshot.status === "incomplete" || snapshot.canonicalProductId !== null;
}

/** Stok Akhir Sistem = Stok Awal + Barang Masuk + Retur Masuk - Penjualan - Barang Keluar. */
export function computeFormulaClosingQty(flow: SnapshotFlowFields): number | null {
  if (flow.openingQty === null) return null;
  return flow.openingQty + (flow.incomingQty ?? 0) + (flow.returnQty ?? 0) - (flow.salesQty ?? 0) - (flow.outgoingQty ?? 0);
}

/** closingQty snapshot adalah sumber utama; formula hanya dipakai bila closingQty snapshot kosong. */
export function resolveSystemClosingQty(flow: SnapshotFlowFields): number | null {
  return flow.closingQty !== null ? flow.closingQty : computeFormulaClosingQty(flow);
}

/** true bila closingQty snapshot ADA tapi berbeda dari hasil formula (validasi silang, informasi saja — tidak mengubah status/angka apa pun). */
export function hasFormulaMismatch(flow: SnapshotFlowFields): boolean {
  if (flow.closingQty === null) return false;
  const formula = computeFormulaClosingQty(flow);
  return formula !== null && formula !== flow.closingQty;
}

export function computeDifferenceQty(physicalQty: number | null, systemClosingQty: number | null): number | null {
  if (physicalQty === null || systemClosingQty === null) return null;
  return physicalQty - systemClosingQty;
}

export function determineOpnameStatus(input: {
  physicalQty: number | null;
  systemClosingQty: number | null;
  manualAdjust: boolean;
}): OpnameStatus {
  if (input.manualAdjust) return "BUTUH_ADJUST_MANUAL";
  if (input.physicalQty === null) return "BELUM_DIISI";
  if (input.systemClosingQty === null || input.physicalQty !== input.systemClosingQty) return "PERLU_DICEK";
  return "COCOK";
}

export type OpnameSummary = {
  totalProduk: number;
  cocok: number;
  perluDicek: number;
  belumDiisi: number;
  butuhAdjustManual: number;
  totalSelisihPositif: number;
  totalSelisihNegatif: number;
};

export function summarizeOpname(rows: ReadonlyArray<{ status: OpnameStatus; differenceQty: number | null }>): OpnameSummary {
  const summary: OpnameSummary = {
    totalProduk: rows.length,
    cocok: 0,
    perluDicek: 0,
    belumDiisi: 0,
    butuhAdjustManual: 0,
    totalSelisihPositif: 0,
    totalSelisihNegatif: 0,
  };
  for (const row of rows) {
    if (row.status === "COCOK") summary.cocok += 1;
    else if (row.status === "PERLU_DICEK") summary.perluDicek += 1;
    else if (row.status === "BELUM_DIISI") summary.belumDiisi += 1;
    else summary.butuhAdjustManual += 1;
    if (row.differenceQty !== null) {
      if (row.differenceQty > 0) summary.totalSelisihPositif += row.differenceQty;
      else if (row.differenceQty < 0) summary.totalSelisihNegatif += row.differenceQty;
    }
  }
  return summary;
}

/** Identitas dokumen berita acara — pola SAMA dengan `OlseraInventoryMonthlySnapshotDocument._id` (deterministik, upsert idempoten by construction). */
export function buildOpnameId(input: { storeId: number; year: number; month: number; productId: number; variantId: number | null }): string {
  return `${input.storeId}:${input.year}:${String(input.month).padStart(2, "0")}:${input.productId}:${input.variantId ?? 0}`;
}
