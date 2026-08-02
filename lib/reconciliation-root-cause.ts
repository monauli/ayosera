// Klasifikasi Root Cause selisih Rekonsiliasi AYO vs Olsera (Milestone 3,
// Bagian E). MURNI (tanpa MongoDB) — dievaluasi dari CourtRevenueFinding
// (lib/reconciliation-court-revenue-source.ts) + sinyal tambahan OPSIONAL
// yang pemanggil kumpulkan dari data mentah (refund keyword, rasio multi-slot,
// dsb). TIDAK PERNAH mengklaim confidence lebih tinggi dari bukti yang benar-
// benar tersedia — bila tidak ada sinyal pendukung, hasilnya
// BELUM_BISA_DIPASTIKAN (LOW), bukan ditebak.
import { PADEL_UNIDENTIFIED_BUCKET } from "./court-mapping.ts";
import { isMatchLike, type ReconciliationConfidence, type ReconciliationStatus } from "./reconciliation-types.ts";

export const ROOT_CAUSE_IDS = [
  "BUG_SYNC_AYO",
  "BUG_SYNC_OLSERA",
  "BUG_MAPPING_KATEGORI",
  "BUG_FILTER_STATUS",
  "BUG_TANGGAL",
  "BUG_COURT",
  "AYO_TIDAK_TERSEDIA_DI_OLSERA",
  "OLSERA_TIDAK_PUNYA_PASANGAN_AYO",
  "TRANSAKSI_MANUAL_OLSERA",
  "REFUND_CANCEL_REVERSAL",
  "PERBEDAAN_GROSS_NET",
  "BOOKING_MULTI_SLOT",
  "PRODUK_HISTORIS_KEHILANGAN_ID",
  "KESALAHAN_INPUT_MANUAL",
  "PERBEDAAN_BISNIS_VALID",
  "BELUM_BISA_DIPASTIKAN",
] as const;

export type RootCauseId = (typeof ROOT_CAUSE_IDS)[number];

export const ROOT_CAUSE_LABEL: Record<RootCauseId, string> = {
  BUG_SYNC_AYO: "Bug sync AYO",
  BUG_SYNC_OLSERA: "Bug sync Olsera",
  BUG_MAPPING_KATEGORI: "Bug mapping kategori",
  BUG_FILTER_STATUS: "Bug filter status",
  BUG_TANGGAL: "Bug tanggal",
  BUG_COURT: "Bug court",
  AYO_TIDAK_TERSEDIA_DI_OLSERA: "Data AYO tidak tersedia di Olsera",
  OLSERA_TIDAK_PUNYA_PASANGAN_AYO: "Data Olsera tidak punya pasangan AYO",
  TRANSAKSI_MANUAL_OLSERA: "Transaksi manual Olsera",
  REFUND_CANCEL_REVERSAL: "Refund/cancel/reversal",
  PERBEDAAN_GROSS_NET: "Perbedaan gross/net",
  BOOKING_MULTI_SLOT: "Booking multi-slot",
  PRODUK_HISTORIS_KEHILANGAN_ID: "Produk historis kehilangan ID",
  KESALAHAN_INPUT_MANUAL: "Kesalahan input manual",
  PERBEDAAN_BISNIS_VALID: "Perbedaan bisnis yang valid",
  BELUM_BISA_DIPASTIKAN: "Belum bisa dipastikan",
};

export type RootCauseInput = {
  status: ReconciliationStatus;
  courtKey: string;
  diagnostics: Record<string, unknown>;
};

/** Sinyal tambahan OPSIONAL — hanya dipakai bila pemanggil sudah mengumpulkan bukti nyata dari data mentah (bukan tebakan). */
export type RootCauseSignals = {
  /** true bila status/label/note baris Olsera terkait mengandung kata kunci refund/void/cancel (lihat lib/revenue.ts CANCELLED_STATUS_MARKERS untuk pola serupa). */
  refundKeywordDetected?: boolean;
  /** jumlah booking AYO dan baris Olsera pada slot ini — dipakai mendeteksi pola "beberapa slot jam AYO = satu transaksi Olsera" (booking multi-slot dibayar sekaligus). */
  ayoBookingCount?: number;
  olseraOrderCount?: number;
  /** true bila salesByName/note Olsera mengindikasikan entri manual kasir (mis. tidak ada order_source terstruktur) — evidence untuk TRANSAKSI_MANUAL_OLSERA. */
  manualEntryIndicator?: boolean;
  /** jumlah baris Olsera terkait yang categoryResolutionStatus масih "unresolved" atau kehilangan productId/variantId/sku pada tanggal+court ini. */
  unresolvedOrMissingIdentityCount?: number;
};

export type RootCauseResult = {
  rootCauseId: RootCauseId;
  label: string;
  confidence: ReconciliationConfidence;
  evidence: string;
};

/**
 * Klasifikasikan root cause SATU finding court-revenue. `null` = finding ini
 * MATCH-like (tidak butuh root cause). Setiap hasil WAJIB evidence teks
 * berbasis data yang benar-benar diperiksa — lihat komentar per cabang.
 */
export function classifyCourtRevenueRootCause(input: RootCauseInput, signals: RootCauseSignals = {}): RootCauseResult | null {
  const { status, courtKey, diagnostics } = input;

  if (isMatchLike(status) || status === "NOT_CHECKED" || status === "IN_PROGRESS") return null;

  if (status === "BUTUH_ADJUST_MANUAL") {
    if (courtKey === PADEL_UNIDENTIFIED_BUCKET) {
      return {
        rootCauseId: "KESALAHAN_INPUT_MANUAL",
        label: ROOT_CAUSE_LABEL.KESALAHAN_INPUT_MANUAL,
        confidence: "HIGH",
        evidence: "Suku kata nomor court pada itemName Olsera berupa placeholder atau di luar rentang 1-4 (lihat docs/reconciliation-ayo-olsera-scope.md §2) — kasir tidak mengisi nomor court saat transaksi.",
      };
    }
    return {
      rootCauseId: "BELUM_BISA_DIPASTIKAN",
      label: ROOT_CAUSE_LABEL.BELUM_BISA_DIPASTIKAN,
      confidence: "LOW",
      evidence: String(diagnostics.reason ?? "Court/kategori tidak dapat dipetakan otomatis."),
    };
  }

  if (status === "AMBIGUOUS") {
    return {
      rootCauseId: "BUG_MAPPING_KATEGORI",
      label: ROOT_CAUSE_LABEL.BUG_MAPPING_KATEGORI,
      confidence: "MEDIUM",
      evidence: String(diagnostics.reason ?? "Klasifikasi kategori/court tidak pasti."),
    };
  }

  if (status === "MISSING_IN_OLSERA") {
    // AYO booking ada, tidak ada transaksi Olsera padanan pada (tanggal, court) ini.
    return {
      rootCauseId: "AYO_TIDAK_TERSEDIA_DI_OLSERA",
      label: ROOT_CAUSE_LABEL.AYO_TIDAK_TERSEDIA_DI_OLSERA,
      confidence: "MEDIUM",
      evidence: "Ada booking AYO revenue-eligible tanpa transaksi kategori lapangan Olsera padanan pada tanggal+court ini — perlu dicek apakah sync Olsera pada hari ini lengkap.",
    };
  }

  if (status === "MISSING_IN_AYO") {
    // Olsera ada, tidak ada booking AYO padanan — BISA wajar (walk-in/kasir langsung tanpa app AYO).
    if (signals.manualEntryIndicator) {
      return {
        rootCauseId: "TRANSAKSI_MANUAL_OLSERA",
        label: ROOT_CAUSE_LABEL.TRANSAKSI_MANUAL_OLSERA,
        confidence: "MEDIUM",
        evidence: "Transaksi Olsera terindikasi diinput manual di kasir (walk-in) tanpa booking AYO — kemungkinan besar perbedaan bisnis yang valid, bukan bug.",
      };
    }
    return {
      rootCauseId: "OLSERA_TIDAK_PUNYA_PASANGAN_AYO",
      label: ROOT_CAUSE_LABEL.OLSERA_TIDAK_PUNYA_PASANGAN_AYO,
      confidence: "MEDIUM",
      evidence: "Ada transaksi kategori lapangan Olsera tanpa booking AYO padanan — bisa wajar (walk-in) atau booking AYO belum/gagal sync, perlu tinjauan manual untuk memastikan.",
    };
  }

  if (status === "MISMATCH") {
    if (signals.refundKeywordDetected) {
      return {
        rootCauseId: "REFUND_CANCEL_REVERSAL",
        label: ROOT_CAUSE_LABEL.REFUND_CANCEL_REVERSAL,
        confidence: "HIGH",
        evidence: "Ditemukan indikasi kata kunci refund/cancel/void pada transaksi terkait.",
      };
    }
    const ayoCount = signals.ayoBookingCount ?? 0;
    const olseraCount = signals.olseraOrderCount ?? 0;
    if (ayoCount > 1 && olseraCount >= 1 && ayoCount > olseraCount) {
      return {
        rootCauseId: "BOOKING_MULTI_SLOT",
        label: ROOT_CAUSE_LABEL.BOOKING_MULTI_SLOT,
        confidence: "MEDIUM",
        evidence: `${ayoCount} booking AYO (slot jam terpisah) berpotensi dibayar dalam ${olseraCount} transaksi Olsera — pola sesi multi-slot, perlu konfirmasi nominal per sesi.`,
      };
    }
    if ((signals.unresolvedOrMissingIdentityCount ?? 0) > 0) {
      return {
        rootCauseId: "PRODUK_HISTORIS_KEHILANGAN_ID",
        label: ROOT_CAUSE_LABEL.PRODUK_HISTORIS_KEHILANGAN_ID,
        confidence: "MEDIUM",
        evidence: `${signals.unresolvedOrMissingIdentityCount} baris Olsera terkait belum punya identitas produk lengkap (productId/variantId/sku) — lihat temuan historis 6.271 baris.`,
      };
    }
    return {
      rootCauseId: "BELUM_BISA_DIPASTIKAN",
      label: ROOT_CAUSE_LABEL.BELUM_BISA_DIPASTIKAN,
      confidence: "LOW",
      evidence: "Selisih nominal terdeteksi pada tanggal+court yang sama-sama punya data — penyebab spesifik belum bisa dipastikan dari sinyal yang tersedia, perlu tinjauan manual.",
    };
  }

  return {
    rootCauseId: "BELUM_BISA_DIPASTIKAN",
    label: ROOT_CAUSE_LABEL.BELUM_BISA_DIPASTIKAN,
    confidence: "LOW",
    evidence: `Status "${status}" belum punya aturan klasifikasi root cause spesifik.`,
  };
}
