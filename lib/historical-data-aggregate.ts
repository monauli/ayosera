// Milestone 4 Bagian A/E/F — agregasi PURE (tidak menyentuh DB) yang
// menggabungkan bukti read-only dari 8 kategori data historis menjadi satu
// laporan untuk panel Supervisor + export. Dipisah dari historical-data-audit.ts
// (yang mengambil bukti dari MongoDB) mengikuti pola
// reconciliation-court-revenue-aggregate.ts (pure/teruji) vs -source.ts
// (tipis/DB) — supaya logika pengelompokan bisa diuji tanpa Mongo.
import type { IdentityClassificationSummary } from "./historical-order-item-identity.ts";
import type { ManualReviewItem } from "./reconciliation-manual-review.ts";

export type HistoricalCategoryId = "PRODUCT_MAPPING" | "LEDGER" | "INVENTORY" | "SALES" | "RECONCILIATION" | "ACCOUNT" | "TRANSACTION" | "SNAPSHOT";

export const CATEGORY_LABEL: Record<HistoricalCategoryId, string> = {
  PRODUCT_MAPPING: "Historical Product Mapping",
  LEDGER: "Historical Ledger",
  INVENTORY: "Historical Inventory",
  SALES: "Historical Sales",
  RECONCILIATION: "Historical Reconciliation",
  ACCOUNT: "Historical Account",
  TRANSACTION: "Historical Transaction",
  SNAPSHOT: "Historical Snapshot",
};

export type HistoricalConfidence = "HIGH" | "MEDIUM" | "LOW";
export type HistoricalIssueStatus = "selesai" | "pending" | "manual";

export type HistoricalIssueItem = {
  id: string;
  category: HistoricalCategoryId;
  categoryLabel: string;
  period: string;
  issue: string;
  penyebab: string;
  confidence: HistoricalConfidence;
  canAutoFix: boolean;
  tindakan: string;
  status: HistoricalIssueStatus;
  jumlahData: number;
};

export type HistoricalCategoryReport = {
  category: HistoricalCategoryId;
  categoryLabel: string;
  periode: string;
  jumlahData: number;
  penyebab: string;
  dampak: string;
  canAutoFix: boolean;
  confidence: HistoricalConfidence;
};

export type HistoricalDataSummary = {
  generatedAt: string;
  totalIssues: number;
  autoFixable: number;
  manual: number;
  selesai: number;
  pending: number;
  categories: HistoricalCategoryReport[];
  issues: HistoricalIssueItem[];
};

function issueStatus(canAutoFix: boolean, jumlahOpen: number): HistoricalIssueStatus {
  if (jumlahOpen === 0) return "selesai";
  return canAutoFix ? "pending" : "manual";
}

// --- Bagian A/B/C: Product Mapping (olsera_order_items) ---
export function buildProductMappingReport(input: { periode: string; summary: IdentityClassificationSummary; resolvedCount: number }): { category: HistoricalCategoryReport; issues: HistoricalIssueItem[] } {
  const { periode, summary, resolvedCount } = input;
  const issues: HistoricalIssueItem[] = [];

  if (summary.exactMatchCount > 0) {
    issues.push({
      id: `product-mapping:${periode}:exact-match`,
      category: "PRODUCT_MAPPING", categoryLabel: CATEGORY_LABEL.PRODUCT_MAPPING, period: periode,
      issue: `${summary.exactMatchCount} baris kehilangan productId/variantId/sku, nama item cocok TEPAT satu produk di katalog`,
      penyebab: "Sync historis sebelum fitur identitas produk (productId/variantId/sku) ditambahkan pada olsera_order_items.",
      confidence: "HIGH", canAutoFix: true,
      tindakan: "Backfill otomatis dari katalog (Bagian C) — identifier jelas, mapping tunggal, tidak mengubah amount/qty/formula.",
      status: "pending", jumlahData: summary.exactMatchCount,
    });
  }
  const ambiguousManualCount = summary.byClassification["Butuh Adjust Manual"] + summary.byClassification["Exact Product, Variant Ambiguous"] + summary.byClassification["Name Match Only"];
  if (ambiguousManualCount > 0) {
    issues.push({
      id: `product-mapping:${periode}:ambiguous`,
      category: "PRODUCT_MAPPING", categoryLabel: CATEGORY_LABEL.PRODUCT_MAPPING, period: periode,
      issue: `${ambiguousManualCount} baris punya lebih dari satu kandidat produk/varian yang bertentangan atau tidak cukup spesifik`,
      penyebab: "Nama item cocok dengan >1 produk/varian di katalog, atau produk induk punya beberapa varian aktif tanpa penanda varian di nama transaksi.",
      confidence: "LOW", canAutoFix: false,
      tindakan: "Butuh Adjust Manual oleh admin yang mengecek struk asli / dashboard Olsera — TIDAK ditebak otomatis.",
      status: "manual", jumlahData: ambiguousManualCount,
    });
  }
  if (summary.historicalProductCount > 0) {
    issues.push({
      id: `product-mapping:${periode}:historical-product`,
      category: "PRODUCT_MAPPING", categoryLabel: CATEGORY_LABEL.PRODUCT_MAPPING, period: periode,
      issue: `${summary.historicalProductCount} baris — produk kemungkinan sudah nonaktif/dihapus dari katalog, histori transaksi lain dgn nama sama konsisten satu productId/variantId/sku`,
      penyebab: "Produk dihapus/dinonaktifkan dari katalog aktif setelah transaksi ini terjadi.",
      confidence: "MEDIUM", canAutoFix: false,
      tindakan: "Perlu konfirmasi admin katalog bahwa produk memang sengaja dihapus (bukan salah hapus) sebelum backfill — TIDAK diotomatisasi penuh (Bagian B: ambigu = jangan dipaksa).",
      status: "manual", jumlahData: summary.historicalProductCount,
    });
  }
  if (summary.unresolvedCount > 0) {
    issues.push({
      id: `product-mapping:${periode}:unresolved`,
      category: "PRODUCT_MAPPING", categoryLabel: CATEGORY_LABEL.PRODUCT_MAPPING, period: periode,
      issue: `${summary.unresolvedCount} baris tidak punya kandidat produk sama sekali, atau terindikasi duplikat`,
      penyebab: "Nama item tidak ditemukan di katalog aktif/nonaktif, tidak ada alias, tidak ada histori — atau baris ini duplikat dari baris gapped lain.",
      confidence: "LOW", canAutoFix: false,
      tindakan: "Butuh Adjust Manual — verifikasi transaksi asli sebelum tindakan apa pun.",
      status: "manual", jumlahData: summary.unresolvedCount,
    });
  }
  if (resolvedCount > 0) {
    issues.push({
      id: `product-mapping:${periode}:resolved`,
      category: "PRODUCT_MAPPING", categoryLabel: CATEGORY_LABEL.PRODUCT_MAPPING, period: periode,
      issue: `${resolvedCount} baris SUDAH dibackfill otomatis (Exact Match, HIGH CONFIDENCE) pada run sebelumnya`,
      penyebab: "Hasil Bagian C — backfill aman yang sudah dieksekusi dan tercatat di historical_backfill_audit_log (reversibel).",
      confidence: "HIGH", canAutoFix: true,
      tindakan: "Tidak perlu tindakan lanjutan.",
      status: "selesai", jumlahData: resolvedCount,
    });
  }

  const openCount = summary.exactMatchCount + ambiguousManualCount + summary.historicalProductCount + summary.unresolvedCount;
  const category: HistoricalCategoryReport = {
    category: "PRODUCT_MAPPING", categoryLabel: CATEGORY_LABEL.PRODUCT_MAPPING, periode,
    jumlahData: openCount + resolvedCount,
    penyebab: "Sync historis sebelum fitur identitas produk ditambahkan; sebagian nama transaksi ambigu terhadap katalog.",
    dampak: "Omzet/qty/kategori TIDAK terdampak (tersimpan independen di setiap baris) — HANYA akurasi reconciliation stok per-produk untuk subset baris yang terpengaruh.",
    canAutoFix: summary.exactMatchCount > 0,
    confidence: openCount === 0 ? "HIGH" : summary.exactMatchCount === openCount ? "HIGH" : "LOW",
  };
  return { category, issues };
}

// --- Bagian A: Ledger & Account (getFinancialSummaryDiagnostics) ---
export type LedgerDiagnosticRow = { period: string; accountCode: string; status: string };

export function buildLedgerAndAccountReports(periods: string[], rows: LedgerDiagnosticRow[]): { ledger: { category: HistoricalCategoryReport; issues: HistoricalIssueItem[] }; account: { category: HistoricalCategoryReport; issues: HistoricalIssueItem[] } } {
  const periodeLabel = periods.length ? `${periods[0]}..${periods[periods.length - 1]}` : "-";
  const issueStatuses = ["Kandidat Data Lama", "Perlu Dicek", "Gagal Disinkronkan"] as const;
  const rowIssues: HistoricalIssueItem[] = [];
  const accountCodesAffected = new Set<string>();

  for (const status of issueStatuses) {
    const matching = rows.filter((r) => r.status === status);
    if (matching.length === 0) continue;
    for (const m of matching) accountCodesAffected.add(m.accountCode);
    rowIssues.push({
      id: `ledger:${periodeLabel}:${status}`,
      category: "LEDGER", categoryLabel: CATEGORY_LABEL.LEDGER, period: periodeLabel,
      issue: `${matching.length} kombinasi (periode, akun) berstatus "${status}"`,
      penyebab: status === "Kandidat Data Lama" ? "Akun kandidat dihapus otomatis karena dua pemeriksaan terpisah mengembalikan hasil kosong dari API Olsera." : status === "Gagal Disinkronkan" ? "Sinkronisasi akun ini gagal pada sync terakhir." : "Ringkasan summary tidak cocok dengan total detail ledger entries.",
      confidence: "HIGH", canAutoFix: false,
      tindakan: status === "Gagal Disinkronkan" ? "Jalankan retry sync untuk akun ini." : "Butuh Adjust Manual — verifikasi manual sebelum tindakan lanjutan (tidak mengubah nominal otomatis).",
      status: "manual", jumlahData: matching.length,
    });
  }

  const totalIssueRows = rowIssues.reduce((s, i) => s + i.jumlahData, 0);
  if (totalIssueRows === 0) {
    rowIssues.push({
      id: `ledger:${periodeLabel}:clean`,
      category: "LEDGER", categoryLabel: CATEGORY_LABEL.LEDGER, period: periodeLabel,
      issue: "Tidak ada akun/periode berstatus Kandidat Data Lama, Perlu Dicek, atau Gagal Disinkronkan",
      penyebab: "Diverifikasi langsung dari getFinancialSummaryDiagnostics untuk seluruh periode yang diaudit.",
      confidence: "HIGH", canAutoFix: false, tindakan: "Tidak ada tindakan diperlukan.", status: "selesai", jumlahData: 0,
    });
  }

  const ledgerCategory: HistoricalCategoryReport = {
    category: "LEDGER", categoryLabel: CATEGORY_LABEL.LEDGER, periode: periodeLabel, jumlahData: totalIssueRows,
    penyebab: totalIssueRows === 0 ? "Tidak ada penyebab — data bersih." : "Lihat rincian per status di atas.",
    dampak: totalIssueRows === 0 ? "Tidak ada dampak." : "Nominal ledger untuk kombinasi (periode, akun) ini berisiko tidak akurat sampai diverifikasi manual.",
    canAutoFix: false, confidence: "HIGH",
  };
  const accountCategory: HistoricalCategoryReport = {
    category: "ACCOUNT", categoryLabel: CATEGORY_LABEL.ACCOUNT, periode: periodeLabel, jumlahData: accountCodesAffected.size,
    penyebab: accountCodesAffected.size === 0 ? "Tidak ada penyebab — seluruh akun bersih." : "Akun-akun berikut punya minimal satu periode bermasalah (lihat kategori Historical Ledger untuk rincian).",
    dampak: accountCodesAffected.size === 0 ? "Tidak ada dampak." : `${accountCodesAffected.size} akun perlu ditinjau ulang.`,
    canAutoFix: false, confidence: "HIGH",
  };
  const accountIssues: HistoricalIssueItem[] = accountCodesAffected.size === 0 ? [{
    id: `account:${periodeLabel}:clean`, category: "ACCOUNT", categoryLabel: CATEGORY_LABEL.ACCOUNT, period: periodeLabel,
    issue: "Tidak ada akun dengan status bermasalah pada periode yang diaudit", penyebab: "Diverifikasi langsung dari getFinancialSummaryDiagnostics.",
    confidence: "HIGH", canAutoFix: false, tindakan: "Tidak ada tindakan diperlukan.", status: "selesai", jumlahData: 0,
  }] : [...accountCodesAffected].map((code) => ({
    id: `account:${periodeLabel}:${code}`, category: "ACCOUNT" as const, categoryLabel: CATEGORY_LABEL.ACCOUNT, period: periodeLabel,
    issue: `Akun ${code} punya minimal satu periode berstatus bermasalah`, penyebab: "Lihat kategori Historical Ledger untuk rincian status per periode.",
    confidence: "HIGH" as const, canAutoFix: false, tindakan: "Butuh Adjust Manual — tinjau akun ini di menu Supervisor Audit.", status: "manual" as const, jumlahData: 1,
  }));

  return { ledger: { category: ledgerCategory, issues: rowIssues }, account: { category: accountCategory, issues: accountIssues } };
}

// --- Bagian A kategori 3: Inventory (movement stok tidak tertaut ke produk) ---
export function buildInventoryReport(input: { periode: string; movementUnmatchedCount: number; movementMissingDocCount: number }): { category: HistoricalCategoryReport; issues: HistoricalIssueItem[] } {
  const { periode, movementUnmatchedCount, movementMissingDocCount } = input;
  const totalMovementIssue = movementUnmatchedCount + movementMissingDocCount;
  const issues: HistoricalIssueItem[] = totalMovementIssue > 0 ? [{
    id: `inventory:${periode}:movement`,
    category: "INVENTORY", categoryLabel: CATEGORY_LABEL.INVENTORY, period: periode,
    issue: `${movementUnmatchedCount} movement stok tidak tertaut ke produk manapun (productId null), ${movementMissingDocCount} baris belum punya dokumen movement`,
    penyebab: "Nama item tidak cocok unik di katalog saat sync inventori (subset dari gap productId/variantId/sku olsera_order_items).",
    confidence: "LOW", canAutoFix: false,
    tindakan: "Review manual terpisah sebagai bagian audit stok — TIDAK ditebak, karena salah tautkan produk akan salah mengubah kartu stok.",
    status: "manual", jumlahData: totalMovementIssue,
  }] : [{ id: `inventory:${periode}:clean`, category: "INVENTORY", categoryLabel: CATEGORY_LABEL.INVENTORY, period: periode, issue: "Tidak ada movement stok yang tidak tertaut", penyebab: "-", confidence: "HIGH", canAutoFix: false, tindakan: "Tidak ada tindakan diperlukan.", status: "selesai", jumlahData: 0 }];

  const category: HistoricalCategoryReport = {
    category: "INVENTORY", categoryLabel: CATEGORY_LABEL.INVENTORY, periode, jumlahData: totalMovementIssue,
    penyebab: "Subset dari gap identitas produk olsera_order_items — nama item tidak cocok unik di katalog saat sync inventori.",
    dampak: totalMovementIssue > 0 ? "Akurasi reconciliation stok per-produk untuk subset baris terpengaruh." : "Total qty/omzet keseluruhan tidak terdampak.",
    canAutoFix: false, confidence: "LOW",
  };
  return { category, issues };
}

// --- Bagian A kategori 8: Snapshot (monthly snapshot boundary-only/incomplete) ---
export function buildSnapshotReport(input: { periode: string; boundaryOnlyCount: number; incompleteCount: number }): { category: HistoricalCategoryReport; issues: HistoricalIssueItem[] } {
  const { periode, boundaryOnlyCount, incompleteCount } = input;
  const issues: HistoricalIssueItem[] = [];
  if (incompleteCount > 0) {
    issues.push({
      id: `snapshot:${periode}:incomplete`, category: "SNAPSHOT", categoryLabel: CATEGORY_LABEL.SNAPSHOT, period: periode,
      issue: `${incompleteCount} entri snapshot bulanan produk berstatus "incomplete"`,
      penyebab: "Carry-forward tidak menemukan cukup data raw sales activity untuk memastikan status lengkap.",
      confidence: "LOW", canAutoFix: false, tindakan: "Butuh Adjust Manual — cek data source asli untuk bulan/produk terkait.", status: "manual", jumlahData: incompleteCount,
    });
  }
  if (boundaryOnlyCount > 0) {
    issues.push({
      id: `snapshot:${periode}:boundary`, category: "SNAPSHOT", categoryLabel: CATEGORY_LABEL.SNAPSHOT, period: periode,
      issue: `${boundaryOnlyCount} entri snapshot bulanan hanya punya boundary (opening/closing), tanpa rincian harian penuh`,
      penyebab: "Keterbatasan data historis — carry-forward sudah membuat keputusan definitif berdasarkan data yang tersedia, bukan bug.",
      confidence: "HIGH", canAutoFix: false, tindakan: "Informasional — tidak memerlukan tindakan (bukan status error).", status: "selesai", jumlahData: boundaryOnlyCount,
    });
  }
  if (issues.length === 0) {
    issues.push({ id: `snapshot:${periode}:clean`, category: "SNAPSHOT", categoryLabel: CATEGORY_LABEL.SNAPSHOT, period: periode, issue: "Seluruh snapshot bulanan berstatus complete", penyebab: "-", confidence: "HIGH", canAutoFix: false, tindakan: "Tidak ada tindakan diperlukan.", status: "selesai", jumlahData: 0 });
  }
  const category: HistoricalCategoryReport = {
    category: "SNAPSHOT", categoryLabel: CATEGORY_LABEL.SNAPSHOT, periode, jumlahData: boundaryOnlyCount + incompleteCount,
    penyebab: "Keterbatasan data historis pada rekonstruksi kartu stok bulanan (computeMonthlyStepBackward/Forward).",
    dampak: incompleteCount > 0 ? "Sebagian entri belum bisa dipastikan lengkap." : "Tidak ada dampak — boundary-only adalah keputusan definitif yang valid, bukan error.",
    canAutoFix: false, confidence: "HIGH",
  };
  return { category, issues };
}

// --- Bagian A: Sales (independensi dari gap identitas — selalu aman secara struktural) ---
export function buildSalesReport(periode: string, gappedRowCount: number): { category: HistoricalCategoryReport; issues: HistoricalIssueItem[] } {
  const issue: HistoricalIssueItem = {
    id: `sales:${periode}:safe`,
    category: "SALES", categoryLabel: CATEGORY_LABEL.SALES, period: periode,
    issue: gappedRowCount > 0 ? `${gappedRowCount} baris terdampak gap identitas produk, TAPI amount/qty tetap benar (tersimpan independen)` : "Tidak ada isu penjualan historis",
    penyebab: "amount/qty tersimpan langsung di setiap baris olsera_order_items, tidak diturunkan dari productId/variantId/sku.",
    confidence: "HIGH", canAutoFix: false, tindakan: "Tidak ada tindakan diperlukan — dikonfirmasi aman secara struktural.", status: "selesai", jumlahData: gappedRowCount,
  };
  const category: HistoricalCategoryReport = {
    category: "SALES", categoryLabel: CATEGORY_LABEL.SALES, periode, jumlahData: gappedRowCount,
    penyebab: "Lihat Historical Product Mapping untuk penyebab baris terdampak.",
    dampak: "Tidak ada — omzet/qty penjualan aman secara struktural.",
    canAutoFix: false, confidence: "HIGH",
  };
  return { category, issues: [issue] };
}

// --- Bagian A: Reconciliation (buildManualReviewSummary, sudah ada & teruji) ---
export function buildReconciliationReport(periode: string, manualReview: { items: ManualReviewItem[]; totalFindings: number }): { category: HistoricalCategoryReport; issues: HistoricalIssueItem[] } {
  const issues: HistoricalIssueItem[] = manualReview.items.length
    ? manualReview.items.map((item) => ({
        id: `reconciliation:${item.source}:${item.id}`,
        category: "RECONCILIATION" as const, categoryLabel: CATEGORY_LABEL.RECONCILIATION, period: item.period,
        issue: `[${item.domainLabel}] ${item.status}`,
        penyebab: item.reason,
        confidence: (item.confidence as HistoricalConfidence | null) ?? "LOW",
        canAutoFix: false, tindakan: item.recommendedAction, status: "manual" as const, jumlahData: 1,
      }))
    : [{ id: `reconciliation:${periode}:clean`, category: "RECONCILIATION" as const, categoryLabel: CATEGORY_LABEL.RECONCILIATION, period: periode, issue: "Tidak ada finding requiresManualAdjustment=true saat ini", penyebab: "-", confidence: "HIGH" as const, canAutoFix: false, tindakan: "Tidak ada tindakan diperlukan.", status: "selesai" as const, jumlahData: 0 }];
  const category: HistoricalCategoryReport = {
    // SENGAJA pakai manualReview.items.length, BUKAN manualReview.totalFindings —
    // totalFindings hanya menghitung sumber "FINDING" (reconciliation_findings),
    // sedangkan items juga memuat sumber "LEDGER" (loadOmzetLedgerRecentSummaries,
    // PERLU_DICEK) yang tidak pernah masuk hitungan totalFindings. Memakai
    // totalFindings di sini pernah membuat kartu kategori menampilkan 0 padahal
    // Issue Detail-nya sendiri memuat 4 baris ledger PERLU_DICEK nyata —
    // ditemukan saat verifikasi Milestone 5 terhadap production live.
    category: "RECONCILIATION", categoryLabel: CATEGORY_LABEL.RECONCILIATION, periode, jumlahData: manualReview.items.length,
    penyebab: manualReview.items.length === 0 ? "Tidak ada penyebab — bersih." : "Lihat buildManualReviewSummary lintas domain untuk rincian per finding.",
    dampak: manualReview.items.length === 0 ? "Tidak ada dampak." : "Butuh keputusan manusia sebelum finding-finding ini dianggap selesai.",
    canAutoFix: false, confidence: "LOW",
  };
  return { category, issues };
}

// --- Bagian A: Transaction (AYO bookings — duplicate impossible by construction) ---
export function buildTransactionReport(periode: string, totalBookings: number): { category: HistoricalCategoryReport; issues: HistoricalIssueItem[] } {
  const issue: HistoricalIssueItem = {
    id: `transaction:${periode}:safe`, category: "TRANSACTION", categoryLabel: CATEGORY_LABEL.TRANSACTION, period: periode,
    issue: `${totalBookings} booking AYO — tidak ada duplikat terdeteksi`,
    penyebab: "Duplicate dicegah struktural: _id Mongo default + upsert oleh order_detail_id/booking_id (lib/booking-sync.ts).",
    confidence: "HIGH", canAutoFix: false, tindakan: "Tidak ada tindakan diperlukan.", status: "selesai", jumlahData: totalBookings,
  };
  const category: HistoricalCategoryReport = {
    category: "TRANSACTION", categoryLabel: CATEGORY_LABEL.TRANSACTION, periode, jumlahData: totalBookings,
    penyebab: "-", dampak: "Tidak ada — duplikat structural mustahil terjadi.", canAutoFix: false, confidence: "HIGH",
  };
  return { category, issues: [issue] };
}

/** Gabungkan seluruh laporan kategori menjadi satu HistoricalDataSummary untuk panel Supervisor + export. */
export function combineHistoricalDataSummary(reports: { category: HistoricalCategoryReport; issues: HistoricalIssueItem[] }[], generatedAt: Date = new Date()): HistoricalDataSummary {
  const categories = reports.map((r) => r.category);
  const issues = reports.flatMap((r) => r.issues).filter((i) => i.jumlahData > 0 || i.status === "selesai");
  const totalIssues = issues.filter((i) => i.status !== "selesai").length;
  const autoFixable = issues.filter((i) => i.canAutoFix && i.status === "pending").length;
  const manual = issues.filter((i) => i.status === "manual").length;
  const selesai = issues.filter((i) => i.status === "selesai").length;
  const pending = issues.filter((i) => i.status === "pending" || i.status === "manual").length;
  return { generatedAt: generatedAt.toISOString(), totalIssues, autoFixable, manual, selesai, pending, categories, issues };
}
