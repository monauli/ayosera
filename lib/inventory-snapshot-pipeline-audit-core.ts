// Klasifikasi murni (tanpa Mongo/HTTP) untuk audit pipeline snapshot inventori
// bulanan (lib/olsera-inventory-monthly-snapshot-core.ts /
// lib/olsera-inventory-monthly-snapshot-store.ts) — dipakai oleh
// scripts/audit-inventory-snapshot-rebuild.ts (read-only, tidak pernah
// menulis olsera_inventory_monthly_snapshots). Root cause yang mendasari
// (lihat kasus movement-qty:116138490:0, audit live 2026-07-27): produk yang
// productId-nya pernah diganti Olsera TANPA dokumen olsera_product_aliases
// yang menjembatani membuat stockmovement API "kehilangan" baris movement
// bulan-bulan lama itu (identity/SKU/nama tidak cocok ke katalog kanonik),
// sehingga carry-forward dipakai (salesQty dipaksa 0) walau
// olsera_inventory_movements (ledger penjualan independen AYOSERA) membuktikan
// ada aktivitas nyata. Modul ini HANYA mengklasifikasikan gejala tsb (dan
// gejala serupa) — TIDAK PERNAH menebak productId/variantId, TIDAK PERNAH
// mengubah expectedQty/salesQty.
import type { MonthlyLedgerSource, MonthlyLedgerStatus } from "./olsera-inventory-monthly-snapshot-core.ts";

export type SnapshotPipelineClassification =
  | "BUG_PIPELINE"
  | "STALE_SNAPSHOT"
  | "SOURCE_DATA_INCOMPLETE"
  | "LEGACY_STORE_ID_NULL"
  | "PRODUCT_IDENTITY_AMBIGUOUS"
  | "BOUNDARY_CURRENT_MONTH"
  | "REQUIRES_MANUAL_ADJUSTMENT"
  | "EXPECTED_NO_ACTION";

export type ExistingSnapshotSummary = {
  source: MonthlyLedgerSource;
  status: MonthlyLedgerStatus;
  salesQty: number | null;
};

export type ClassifyEntityInput = {
  existingDoc: ExistingSnapshotSummary | null;
  /** sumAbsQty dari olsera_inventory_movements (ledger independen) bulan ini utk entity ini. */
  rawSalesActivity: number;
  /** true bila sebagian/seluruh rawSalesActivity berasal dari movement storeId:null (legacy belum distempel — Known Case 37). */
  rawSalesActivityIncludesLegacyNullStore: boolean;
  /** true bila periode ini adalah bulan berjalan (Asia/Jakarta) — lihat isCurrentJakartaPeriod di lib/olsera-financial-core.ts. */
  isDraftPeriod: boolean;
  /**
   * true bila katalog (olsera_inventory_products) menandai entity ini sebagai
   * barang stok (trackInventory:true). Rantai ledger bulanan HANYA mencakup
   * barang trackInventory:true (terverifikasi live 2026-07-27: baseline Juni
   * 60 produk fisik — minuman LABERS/SEWA RAKET/PICKLEBALL COURT FEE dll
   * SENGAJA trackInventory:false, TIDAK PERNAH masuk rantai walau tercatat
   * penjualan di olsera_inventory_movements). Default true bila tidak
   * diketahui (productId tidak ditemukan di katalog sama sekali — kasus
   * langka, diperlakukan konservatif sebagai "seharusnya ada dokumen").
   */
  isTrackedInventory: boolean;
};

export type ClassifyEntityResult = {
  classification: SnapshotPipelineClassification;
  reason: string;
  proposedAction: string;
};

export function classifySnapshotEntity(input: ClassifyEntityInput): ClassifyEntityResult {
  const { existingDoc, rawSalesActivity, rawSalesActivityIncludesLegacyNullStore, isDraftPeriod, isTrackedInventory } = input;

  if (!existingDoc) {
    if (!isTrackedInventory) {
      return {
        classification: "EXPECTED_NO_ACTION",
        reason: "Katalog menandai entity ini trackInventory:false (bukan barang stok, mis. minuman/sewa/court fee) — rantai ledger bulanan sengaja tidak mencakupnya walau tercatat penjualan.",
        proposedAction: "Tidak ada aksi.",
      };
    }
    if (isDraftPeriod) {
      return {
        classification: "BOUNDARY_CURRENT_MONTH",
        reason: "Belum ada dokumen snapshot untuk bulan berjalan — wajar, rantai maju belum diproses sampai bulan ini.",
        proposedAction: "Tidak ada aksi — akan terbentuk otomatis saat backfill maju rutin berikutnya.",
      };
    }
    return {
      classification: "STALE_SNAPSHOT",
      reason: "Bulan sudah tutup (bukan bulan berjalan) tapi tidak ada dokumen snapshot sama sekali untuk entity ini (barang stok/trackInventory:true).",
      proposedAction: "Verifikasi lalu jalankan backfill eksplisit (scripts/backfill-monthly-snapshot.ts) untuk bulan ini.",
    };
  }

  if (existingDoc.source === "carry-forward") {
    if (existingDoc.status === "incomplete") {
      return {
        classification: "PRODUCT_IDENTITY_AMBIGUOUS",
        reason: `Carry-forward kontradiktif — sudah ditandai kode (status "incomplete") karena ada bukti penjualan mentah (sumAbsQty=${rawSalesActivity}) TAPI stockmovement API tidak melaporkan baris apa pun bulan ini (kemungkinan productId berganti di sisi Olsera tanpa alias penjembatan).`,
        proposedAction: "Verifikasi manual apakah productId ini pernah berganti di Olsera; bila terbukti, tambahkan dokumen olsera_product_aliases (butuh persetujuan) lalu jalankan rebuild eksplisit untuk bulan ini.",
      };
    }
    if (rawSalesActivity > 0) {
      return {
        classification: "STALE_SNAPSHOT",
        reason: `Dokumen carry-forward ini berstatus "complete" TAPI ada bukti penjualan mentah (sumAbsQty=${rawSalesActivity}) yang seharusnya membuatnya "incomplete" pada kode saat ini — dokumen dibuat SEBELUM perbaikan carryForwardStatusAndDiagnostic, belum direbuild ulang.`,
        proposedAction: "Jalankan rebuild eksplisit untuk bulan ini (kode saat ini akan menandainya 'incomplete' otomatis) — TIDAK mengubah angka, hanya status/diagnostics.",
      };
    }
    if (isDraftPeriod) {
      return {
        classification: "BOUNDARY_CURRENT_MONTH",
        reason: "Carry-forward pada bulan berjalan tanpa kontradiksi bukti — wajar (belum ada aktivitas tercatat bulan ini).",
        proposedAction: "Tidak ada aksi.",
      };
    }
    return {
      classification: "EXPECTED_NO_ACTION",
      reason: "Carry-forward tanpa kontradiksi bukti penjualan independen — produk memang tidak bergerak bulan ini.",
      proposedAction: "Tidak ada aksi.",
    };
  }

  // source matched (stockmovement-backward/forward/baseline-file) — API MELAPORKAN baris untuk entity ini.
  const diff = rawSalesActivity - (existingDoc.salesQty ?? 0);
  if (diff === 0) {
    return { classification: "EXPECTED_NO_ACTION", reason: "salesQty snapshot cocok dengan ledger penjualan independen.", proposedAction: "Tidak ada aksi." };
  }
  if (isDraftPeriod) {
    return {
      classification: "BOUNDARY_CURRENT_MONTH",
      reason: `Selisih (${diff}) pada bulan berjalan — kemungkinan besar timing (stockmovement API belum mengejar penjualan hari-hari terakhir).`,
      proposedAction: "Tidak ada aksi — verifikasi ulang setelah bulan ditutup.",
    };
  }
  if (rawSalesActivityIncludesLegacyNullStore) {
    return {
      classification: "LEGACY_STORE_ID_NULL",
      reason: `Selisih (${diff}) sebagian/seluruhnya berasal dari movement storeId:null (legacy belum distempel, Known Case 37) — perlu verifikasi cakupan sebelum disimpulkan sebagai mismatch murni.`,
      proposedAction: "Verifikasi cakupan Known Case 37 untuk entity ini; bila sudah sesuai, tandai REQUIRES_MANUAL_ADJUSTMENT.",
    };
  }
  return {
    classification: "SOURCE_DATA_INCOMPLETE",
    reason: `Snapshot sudah "complete" (bukan carry-forward, API MELAPORKAN baris) TAPI berbeda (${diff}) dari ledger penjualan independen AYOSERA — dua sumber data tidak sepakat, bukan bug kode rekonsiliasi.`,
    proposedAction: "Investigasi terpisah pada pipeline upstream (mis. lib/olsera-inventory-monthly-snapshot-store.ts sumber stockmovement API) — TIDAK mengubah expectedQty untuk memaksa cocok.",
  };
}

// ---------------------------------------------------------------------------
// Klasifikasi PER PERIODE (bulan) — dipakai scripts/audit-inventory-monthly-periods.ts
// (npm run inventory:audit-periods). Beda dari classifySnapshotEntity di atas
// (per entity/produk): ini rekap satu baris per bulan, dibangun dari
// perbandingan LANGSUNG dokumen lokal vs tarikan LIVE stockmovement API
// Olsera untuk rentang tanggal bulan yang sama — bukti data, BUKAN tebakan
// dari timestamp createdAt (lihat tmp/ai-handoff.md "Inventory July-August
// Product Timing Audit": createdAt lokal terbukti TIDAK cukup untuk
// membuktikan staleness, sengaja tidak dipakai di sini).
// ---------------------------------------------------------------------------

export type InventoryPeriodClassification = "OK" | "CURRENT_REFRESHABLE" | "STALE_NEEDS_REBUILD" | "MANUAL_REVIEW";

export type ClassifyPeriodInput = {
  periodState: "future" | "current" | "historical";
  /** Jumlah entity (productId:variantId) yang PUNYA dokumen snapshot lokal bulan ini. */
  localEntityCount: number;
  /** Jumlah entity yang muncul di tarikan LIVE stockmovement API Olsera bulan ini. */
  sourceEntityCount: number;
  /** Entity yang ADA di sumber Olsera TAPI TIDAK ADA dokumen lokalnya sama sekali — bukti langsung staleness (kasus Juli 2026). */
  missingLocalCount: number;
  /** Entity yang qty-nya (mis. closingQty) berbeda antara dokumen lokal vs tarikan sumber — butuh tinjauan manual (bisa productId rename/alias, bukan sekadar stale). */
  qtyMismatchCount: number;
};

export type ClassifyPeriodResult = { classification: InventoryPeriodClassification; reason: string };

export function classifySnapshotPeriod(input: ClassifyPeriodInput): ClassifyPeriodResult {
  if (input.periodState === "future") {
    return { classification: "MANUAL_REVIEW", reason: "Periode masa depan tidak seharusnya diaudit/digenerate — periksa argumen rentang audit." };
  }
  if (input.periodState === "current") {
    return {
      classification: "CURRENT_REFRESHABLE",
      reason: "Bulan berjalan — ensureMonthlySnapshotChain SELALU menghitung ulang setiap diakses (lihat lib/olsera-inventory-monthly-snapshot-store.ts), tidak perlu rebuild manual.",
    };
  }
  // historical
  if (input.missingLocalCount > 0) {
    return {
      classification: "STALE_NEEDS_REBUILD",
      reason: `${input.missingLocalCount} entity ADA di sumber Olsera (tarikan live) tapi TIDAK ADA dokumen lokal sama sekali — snapshot bulan ini kemungkinan dikunci SEBELUM entity tsb muncul di Olsera (pola sama root cause Juli 2026).`,
    };
  }
  if (input.qtyMismatchCount > 0) {
    return {
      classification: "MANUAL_REVIEW",
      reason: `${input.qtyMismatchCount} entity qty-nya berbeda antara dokumen lokal vs tarikan sumber — perlu tinjauan manual (mungkin productId rename/alias tanpa jembatan, bukan sekadar stale) sebelum rebuild.`,
    };
  }
  return { classification: "OK", reason: "Dokumen lokal cocok dengan tarikan live sumber Olsera untuk periode ini — tidak perlu tindakan." };
}
