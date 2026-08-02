// Unified "Butuh Adjust Manual" — Milestone 3 Bagian F. Menggabungkan SEMUA
// item yang butuh tinjauan manusia dari sumber yang SUDAH ADA (tidak
// membuat sumber kebenaran baru):
//   1. `reconciliation_findings` requiresManualAdjustment=true, LINTAS domain
//      (CATEGORY/PRODUCT/INVENTORY/SNAPSHOT dari Phase 5B, COURT_REVENUE dari
//      Milestone 3) — lewat lib/reconciliation-store.ts listFindings (generik,
//      TIDAK perlu diubah untuk mendukung ini, lihat komentar
//      lib/reconciliation-court-revenue-runner.ts).
//   2. Periode Rekonsiliasi Omzet AYOSERA (ledger) berstatus PERLU_DICEK —
//      lib/reconciliation-omzet-ledger.ts loadOmzetLedgerRecentSummaries.
//
// SENGAJA TIDAK menduplikasi baris stock-opname BUTUH_ADJUST_MANUAL
// (app/reconciliation/inventory) di sini — itu domain fisik (hitung barang
// manual bulanan) dengan halaman aksinya sendiri; menduplikasinya di sini
// akan membuat dua sumber kebenaran untuk status yang sama. Bagian H
// (menu supervisor) menaut ke halaman itu, bukan menyalin datanya.
//
// READ-ONLY MURNI — tidak pernah mengubah status apa pun (lihat instruksi
// "Jangan mengubah status menjadi selesai tanpa bukti").
import "server-only";
import { listFindings, type ReconciliationStoreContext } from "./reconciliation-store.ts";
import { loadOmzetLedgerRecentSummaries, type OmzetLedgerSourceContext } from "./reconciliation-omzet-ledger.ts";
import { DOMAIN_LABEL, type ReconciliationDomain, type ReconciliationType } from "./reconciliation-types.ts";

const MAX_PAGES = 5; // batas wajar (5 x 200 = 1000 finding) — cegah kerja tak terbatas bila data membengkak.
const LEDGER_LOOKBACK_MONTHS = 24;

export type ManualReviewItem = {
  source: "FINDING" | "LEDGER";
  id: string;
  reconciliationType: ReconciliationType | null;
  domain: string;
  domainLabel: string;
  period: string;
  status: string;
  impact: string | null;
  confidence: string | null;
  reason: string;
  /** Bagian F: "bisa otomatis atau tidak" — SELALU false di sini (butuh keputusan manusia, lihat catatan atas). */
  canAutoResolve: false;
  recommendedAction: string;
  lastCheckedAt: Date | null;
};

function recommendActionFor(domain: string, status: string): string {
  if (domain === "COURT_REVENUE") {
    if (status === "BUTUH_ADJUST_MANUAL") return "Cek transaksi Olsera terkait — kemungkinan kasir tidak mengisi nomor court saat transaksi (lihat docs/reconciliation-ayo-olsera-scope.md §2).";
    if (status === "AMBIGUOUS") return "Pastikan kategori Olsera transaksi ini benar lapangan sebelum dimasukkan rekonsiliasi.";
    return "Bandingkan booking AYO dan transaksi Olsera pada tanggal+court ini secara manual.";
  }
  if (domain === "CATEGORY") return "Tetapkan kategori manual untuk item ini (lihat menu Kategori Olsera).";
  if (domain === "PRODUCT") return "Lengkapi productId/variantId/sku item ini atau konfirmasi produk historis/alias.";
  if (domain === "INVENTORY") return "Cek movement inventori terkait — kemungkinan tidak tertaut ke produk manapun.";
  if (domain === "SNAPSHOT") return "Cek snapshot bulanan produk ini — rantai closing/opening mungkin terputus.";
  return "Tinjau manual — lihat detail finding.";
}

export type BuildManualReviewOptions = { storeContext?: ReconciliationStoreContext; ledgerContext?: OmzetLedgerSourceContext };

export type ManualReviewSummary = { items: ManualReviewItem[]; totalFindings: number; truncated: boolean };

/** Bangun daftar gabungan seluruh item "Butuh Adjust Manual" lintas domain untuk SATU store. Read-only. */
export async function buildManualReviewSummary(storeId: number, options: BuildManualReviewOptions = {}): Promise<ManualReviewSummary> {
  const items: ManualReviewItem[] = [];
  let page = 1;
  let total = 0;
  let truncated = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await listFindings({ storeId, requiresManualAdjustment: true, page, limit: 200, sort: "lastCheckedAt", sortDir: "desc" }, options.storeContext);
    total = result.total;
    for (const finding of result.items) {
      items.push({
        source: "FINDING",
        id: finding._id,
        reconciliationType: finding.reconciliationType,
        domain: finding.domain,
        domainLabel: DOMAIN_LABEL[finding.domain as ReconciliationDomain] ?? finding.domain,
        period: finding.period,
        status: finding.status,
        impact: finding.impact,
        confidence: finding.confidence,
        reason: String((finding.diagnostics as Record<string, unknown> | null)?.reason ?? "Butuh tinjauan manual."),
        canAutoResolve: false,
        recommendedAction: recommendActionFor(finding.domain, finding.status),
        lastCheckedAt: finding.lastCheckedAt ?? null,
      });
    }
    if (page * 200 >= total || page >= MAX_PAGES) {
      truncated = page >= MAX_PAGES && page * 200 < total;
      break;
    }
    page += 1;
  }

  const ledgerSummaries = await loadOmzetLedgerRecentSummaries(LEDGER_LOOKBACK_MONTHS, options.ledgerContext);
  for (const summary of ledgerSummaries) {
    if (summary.status !== "PERLU_DICEK") continue;
    items.push({
      source: "LEDGER",
      id: `omzet-ledger:${summary.period}`,
      reconciliationType: null,
      domain: "LEDGER",
      domainLabel: DOMAIN_LABEL.LEDGER,
      period: summary.period,
      status: summary.status,
      impact: null,
      confidence: null,
      reason: summary.statusReason,
      canAutoResolve: false,
      recommendedAction: "Tambahkan penjelasan selisih dengan bukti jurnal nyata (menu Rekonsiliasi Omzet AYOSERA), atau investigasi lebih lanjut.",
      lastCheckedAt: null,
    });
  }

  return { items, totalFindings: total, truncated };
}
