// Rule engine MURNI Modul Rekonsiliasi (Phase 5A) — TIDAK ADA akses MongoDB/
// fetch API di file ini (bisa diuji dengan node:test tanpa database sungguhan,
// sama pola dengan lib/olsera-category-resolver.ts). Pemuatan data (query
// Mongo, agregasi per tanggal/court) ada di lib/reconciliation-store.ts.
//
// DUA KELOMPOK RULE, TIDAK PERNAH DICAMPUR (lihat lib/reconciliation-types.ts):
//   A. CROSS_SYSTEM_COURT_REVENUE — AYO vs Olsera, HANYA omzet/booking lapangan.
//   B. INTERNAL_OLSERA — kategori, identitas produk, inventory movement, snapshot.
//
// Belum ada rule Ledger/Finansial penuh di Phase 5A (sesuai instruksi tugas).
import {
  defaultConfidenceForStatus,
  defaultImpactForStatus,
  KNOWN_CASE_REFS,
  RULE_IDS,
  type KnownCaseRef,
  type ReconciliationConfidence,
  type ReconciliationImpact,
  type ReconciliationStatus,
} from "./reconciliation-types.ts";

/** Hasil evaluasi SATU rule — bentuk seragam dipakai seluruh rule di file ini. */
export type RuleEvaluation = {
  status: ReconciliationStatus;
  /** Dampak bila finding ini dibiarkan (WAJIB diisi — lihat lib/reconciliation-types.ts STATUS_IMPACT). Rule BOLEH override default per sub-case. */
  impact: ReconciliationImpact;
  /** Seberapa yakin hasil matching/rule ini (HIGH=deterministik, MEDIUM=historical/alias/fallback, LOW=ambigu/butuh tinjauan). */
  confidence: ReconciliationConfidence;
  ruleId: string;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  difference: Record<string, unknown> | null;
  diagnostics: Record<string, unknown>;
  candidates: Array<{ label: string; value: unknown; note?: string }>;
  knownCaseRef: KnownCaseRef | null;
};

/** Default impact+confidence dari status — dipakai rule yang tidak butuh override khusus. */
function defaultImpactConfidence(status: ReconciliationStatus): Pick<RuleEvaluation, "impact" | "confidence"> {
  return { impact: defaultImpactForStatus(status), confidence: defaultConfidenceForStatus(status) };
}

// ---------------------------------------------------------------------------
// A. CROSS_SYSTEM_COURT_REVENUE — AYO vs Olsera, HANYA omzet/booking lapangan
// ---------------------------------------------------------------------------

/** Toleransi nominal "cocok persis" (pembulatan rupiah antar sistem independen). */
const AMOUNT_EXACT_TOLERANCE_IDR = 1;
/** Toleransi default "beda kecil, masih wajar" bila caller tidak menentukan sendiri. */
const DEFAULT_MINOR_TOLERANCE_IDR = 5000;

export type CourtRevenueSideData = {
  /** Jumlah booking (AYO) atau jumlah transaksi (Olsera) pada court+tanggal ini. */
  count: number;
  /** Omzet lapangan (IDR) sisi ini. */
  revenue: number;
  /** Status pembayaran bila tersedia dari sumbernya — null bila data tidak tersedia (TIDAK dinilai, sesuai instruksi "jika data tersedia"). */
  paymentStatus?: "paid" | "unpaid" | "partial" | null;
};

export type CourtRevenueComparisonInput = {
  date: string;
  court: string;
  /** null = tidak ada data booking AYO pada court+tanggal ini sama sekali. */
  ayo: CourtRevenueSideData | null;
  /**
   * null = tidak ada transaksi Olsera yang teridentifikasi sebagai lapangan
   * pada court+tanggal ini. WAJIB sudah difilter di pemanggil supaya HANYA
   * transaksi lapangan yang sampai ke rule ini (F&B/retail/LABERS/Jasa Host
   * TIDAK PERNAH masuk ke sini — lihat lib/reconciliation-store.ts).
   */
  olsera: CourtRevenueSideData | null;
  /**
   * Seberapa yakin transaksi Olsera yang dihitung di atas MEMANG transaksi
   * lapangan (bukan F&B/retail yang salah terklasifikasi) — evidence dari
   * resolver kategori/nama produk. false = JANGAN dipaksakan dibandingkan,
   * kembalikan AMBIGUOUS.
   */
  olseraCourtCategoryConfident: boolean;
  /** Seberapa yakin nama court AYO sudah dipetakan ke court/lapangan Olsera yang benar. */
  courtMappingConfidence: "exact" | "ambiguous" | "unmapped";
  /** Kandidat court Olsera lain bila courtMappingConfidence !== "exact" (evidence untuk AMBIGUOUS). */
  courtCandidates?: Array<{ label: string; value: unknown; note?: string }>;
};

export type CourtRevenueRuleOptions = { minorToleranceIdr?: number };

function compareAmount(expected: number, actual: number, minorTolerance: number): ReconciliationStatus {
  const diff = Math.abs(actual - expected);
  if (diff <= AMOUNT_EXACT_TOLERANCE_IDR) return "MATCH";
  if (diff <= minorTolerance) return "MINOR_DIFFERENCE";
  return "MISMATCH";
}

function compareCount(expected: number, actual: number): ReconciliationStatus {
  const diff = Math.abs(actual - expected);
  if (diff === 0) return "MATCH";
  if (diff <= 1) return "MINOR_DIFFERENCE";
  return "MISMATCH";
}

/** Urutan "keparahan" status untuk memilih status gabungan (yang paling butuh perhatian menang). */
function worstStatus(statuses: ReconciliationStatus[]): ReconciliationStatus {
  const RANK: Record<ReconciliationStatus, number> = {
    MATCH: 0,
    NOT_CHECKED: 0,
    IN_PROGRESS: 0,
    MINOR_DIFFERENCE: 1,
    AMBIGUOUS: 2,
    MISSING_IN_AYO: 3,
    MISSING_IN_OLSERA: 3,
    MISSING_IN_SNAPSHOT: 3,
    BUTUH_ADJUST_MANUAL: 3,
    MISMATCH: 4,
  };
  return statuses.reduce((worst, current) => (RANK[current] > RANK[worst] ? current : worst), "MATCH" as ReconciliationStatus);
}

/**
 * Bandingkan omzet lapangan AYO vs Olsera untuk SATU (tanggal, court).
 *
 * ATURAN KERAS (lihat docs/reconciliation-design.md "Penegasan Scope"):
 * fungsi ini TIDAK PERNAH menerima/menghasilkan perbandingan total omzet
 * Olsera (F&B/retail/LABERS/Jasa Host/laporan keuangan) — pemanggil WAJIB
 * memfilter input `olsera` HANYA dari transaksi yang teridentifikasi sebagai
 * lapangan sebelum memanggil fungsi ini.
 */
export function evaluateCourtRevenue(
  input: CourtRevenueComparisonInput,
  options: CourtRevenueRuleOptions = {},
): RuleEvaluation {
  const minorTolerance = options.minorToleranceIdr ?? DEFAULT_MINOR_TOLERANCE_IDR;
  const base = { ruleId: RULE_IDS.CROSS_SYSTEM_COURT_REVENUE };

  // Jangan memaksakan mapping court yang ambigu.
  if (input.courtMappingConfidence === "ambiguous") {
    return {
      ...base,
      ...defaultImpactConfidence("AMBIGUOUS"),
      status: "AMBIGUOUS",
      expected: { court: input.court },
      actual: {},
      difference: null,
      diagnostics: { reason: "Nama court AYO cocok dengan lebih dari satu court/lapangan Olsera — tidak dipetakan otomatis.", date: input.date, court: input.court },
      candidates: input.courtCandidates ?? [],
      knownCaseRef: null,
    };
  }
  if (input.courtMappingConfidence === "unmapped") {
    return {
      ...base,
      ...defaultImpactConfidence("BUTUH_ADJUST_MANUAL"),
      status: "BUTUH_ADJUST_MANUAL",
      expected: { court: input.court },
      actual: {},
      difference: null,
      diagnostics: { reason: "Court/lapangan pada sisi Olsera belum dipetakan ke court AYO manapun — perlu data master court diperbarui.", date: input.date, court: input.court },
      candidates: input.courtCandidates ?? [],
      knownCaseRef: null,
    };
  }

  // Klasifikasi "ini transaksi lapangan" pada sisi Olsera tidak pasti — jangan dipaksakan dibandingkan.
  if (input.olsera !== null && !input.olseraCourtCategoryConfident) {
    return {
      ...base,
      ...defaultImpactConfidence("AMBIGUOUS"),
      status: "AMBIGUOUS",
      expected: { court: input.court },
      actual: { olsera: input.olsera },
      difference: null,
      diagnostics: { reason: "Klasifikasi kategori/produk transaksi Olsera sebagai \"lapangan\" tidak pasti — dikeluarkan dari perbandingan sampai dipastikan.", date: input.date, court: input.court },
      candidates: [],
      knownCaseRef: null,
    };
  }

  if (input.ayo === null && input.olsera === null) {
    return {
      ...base,
      ...defaultImpactConfidence("NOT_CHECKED"),
      status: "NOT_CHECKED",
      expected: {},
      actual: {},
      difference: null,
      diagnostics: { reason: "Tidak ada data AYO maupun Olsera untuk court+tanggal ini.", date: input.date, court: input.court },
      candidates: [],
      knownCaseRef: null,
    };
  }
  if (input.ayo === null) {
    return {
      ...base,
      ...defaultImpactConfidence("MISSING_IN_AYO"),
      status: "MISSING_IN_AYO",
      expected: {},
      actual: { olsera: input.olsera },
      difference: null,
      diagnostics: { reason: "Ada transaksi lapangan Olsera tanpa booking AYO padanan (mis. walk-in/kasir langsung — bisa wajar, lihat Known Case \"Perbedaan AYO vs Olsera\").", date: input.date, court: input.court },
      candidates: [],
      knownCaseRef: null,
    };
  }
  if (input.olsera === null) {
    return {
      ...base,
      ...defaultImpactConfidence("MISSING_IN_OLSERA"),
      status: "MISSING_IN_OLSERA",
      expected: { ayo: input.ayo },
      actual: {},
      difference: null,
      diagnostics: { reason: "Ada booking AYO tanpa transaksi lapangan Olsera padanan.", date: input.date, court: input.court },
      candidates: [],
      knownCaseRef: null,
    };
  }

  const revenueStatus = compareAmount(input.ayo.revenue, input.olsera.revenue, minorTolerance);
  const countStatus = compareCount(input.ayo.count, input.olsera.count);
  const paymentStatus: ReconciliationStatus | null =
    input.ayo.paymentStatus && input.olsera.paymentStatus
      ? input.ayo.paymentStatus === input.olsera.paymentStatus
        ? "MATCH"
        : "MISMATCH"
      : null;

  const overall = worstStatus([revenueStatus, countStatus, ...(paymentStatus ? [paymentStatus] : [])]);
  const revenueDiff = input.olsera.revenue - input.ayo.revenue;
  const countDiff = input.olsera.count - input.ayo.count;

  return {
    ...base,
    ...defaultImpactConfidence(overall),
    status: overall,
    expected: { revenue: input.ayo.revenue, count: input.ayo.count, paymentStatus: input.ayo.paymentStatus ?? null },
    actual: { revenue: input.olsera.revenue, count: input.olsera.count, paymentStatus: input.olsera.paymentStatus ?? null },
    difference: { revenue: revenueDiff, count: countDiff },
    diagnostics: {
      date: input.date,
      court: input.court,
      revenueStatus,
      countStatus,
      paymentStatus,
      minorToleranceIdr: minorTolerance,
    },
    candidates: [],
    knownCaseRef: null,
  };
}

// ---------------------------------------------------------------------------
// B. INTERNAL_OLSERA — Rule Kategori
// ---------------------------------------------------------------------------

export type CategoryRuleInput = {
  itemName: string;
  categoryResolutionStatus: "resolved" | "unresolved" | null | undefined;
  categoryResolutionMethod: string | null | undefined;
  categoryResolutionReason: string | null | undefined;
  resolvedCategoryName: string | null | undefined;
  /** Kategori dari sumber independen (mis. olsera_sales_by_category) untuk validasi silang — opsional. Bila berbeda dari resolvedCategoryName -> MISMATCH. */
  expectedCategoryName?: string | null;
  /** true bila evidence eksternal menunjukkan >1 kandidat kategori sama validnya — AMBIGUOUS, tidak dipaksakan. */
  isAmbiguousCandidate?: boolean;
};

/** Rule Kategori: rujuk status resolusi yang SUDAH tersimpan saat sync (lib/olsera-category-resolver.ts) — tidak resolve ulang di sini. */
export function evaluateCategory(input: CategoryRuleInput): RuleEvaluation {
  const base = { ruleId: RULE_IDS.INTERNAL_CATEGORY, candidates: [] as RuleEvaluation["candidates"], knownCaseRef: null as KnownCaseRef | null };

  if (input.isAmbiguousCandidate) {
    return {
      ...base,
      ...defaultImpactConfidence("AMBIGUOUS"),
      status: "AMBIGUOUS",
      expected: { itemName: input.itemName },
      actual: { resolvedCategoryName: input.resolvedCategoryName ?? null },
      difference: null,
      diagnostics: { reason: "Lebih dari satu kandidat kategori sama validnya — tidak dipetakan otomatis." },
    };
  }
  if (input.categoryResolutionMethod === "manual_override") {
    return {
      ...base,
      ...defaultImpactConfidence("MATCH"),
      status: "MATCH",
      expected: { itemName: input.itemName },
      actual: { resolvedCategoryName: input.resolvedCategoryName, method: input.categoryResolutionMethod },
      difference: null,
      diagnostics: { reason: "Kategori sudah dikonfirmasi manual per item (manual_override) — dianggap final." },
    };
  }
  if (input.categoryResolutionStatus === "resolved" && input.resolvedCategoryName) {
    if (input.expectedCategoryName != null && input.expectedCategoryName !== input.resolvedCategoryName) {
      return {
        ...base,
        ...defaultImpactConfidence("MISMATCH"),
        status: "MISMATCH",
        expected: { itemName: input.itemName, category: input.expectedCategoryName },
        actual: { resolvedCategoryName: input.resolvedCategoryName, method: input.categoryResolutionMethod ?? null },
        difference: { category: `${input.expectedCategoryName} != ${input.resolvedCategoryName}` },
        diagnostics: { reason: "Kategori tersimpan berbeda dari kategori sumber independen (validasi silang)." },
      };
    }
    return {
      ...base,
      ...defaultImpactConfidence("MATCH"),
      status: "MATCH",
      expected: { itemName: input.itemName },
      actual: { resolvedCategoryName: input.resolvedCategoryName, method: input.categoryResolutionMethod ?? null },
      difference: null,
      diagnostics: { reason: "Kategori sudah resolved saat sync." },
    };
  }
  return {
    ...base,
    ...defaultImpactConfidence("BUTUH_ADJUST_MANUAL"),
    status: "BUTUH_ADJUST_MANUAL",
    expected: { itemName: input.itemName },
    actual: { resolvedCategoryName: input.resolvedCategoryName ?? null },
    difference: null,
    diagnostics: { reason: input.categoryResolutionReason ?? "Kategori belum berhasil di-resolve (unresolved) saat sync." },
  };
}

// ---------------------------------------------------------------------------
// A. CROSS_SYSTEM_COURT_REVENUE — Klasifikasi kelayakan kategori Olsera
// ---------------------------------------------------------------------------

/** Kata kunci kategori/nama yang MEMANG omzet lapangan (court/lapangan itu sendiri). */
const COURT_REVENUE_KEYWORDS = ["LAPANGAN", "COURT FEE", "COURT RENTAL", "SEWA LAPANGAN"];
/**
 * Kata kunci kategori yang WAJIB DIKECUALIKAN dari CROSS_SYSTEM_COURT_REVENUE
 * (F&B, retail, LABERS, Jasa Host, dan turunannya) — lihat penegasan scope di
 * docs/reconciliation-design.md. Daftar ini SENGAJA eksplisit (bukan
 * "selain court"), supaya kategori baru yang belum dikenal jatuh ke
 * "ambiguous" (tidak dipaksakan), bukan diam-diam ikut/tidak ikut.
 */
const NON_COURT_REVENUE_KEYWORDS = ["LABERS", "JASA HOST", "F&B", "FNB", "F & B", "RETAIL", "MAKANAN", "MINUMAN"];

export type CourtCategoryClassification = "court" | "excluded" | "ambiguous";

/**
 * Klasifikasikan apakah suatu kategori/nama transaksi Olsera layak masuk
 * rekonsiliasi CROSS_SYSTEM_COURT_REVENUE. HANYA "court" yang boleh
 * dibandingkan ke AYO — "excluded" (F&B/retail/LABERS/Jasa Host) dan
 * "ambiguous" (kategori tak dikenal) TIDAK PERNAH ikut perbandingan omzet
 * (lihat evaluateCourtRevenue: caller wajib memfilter sebelum memanggil rule).
 */
export function classifyCategoryForCourtRevenue(categoryOrName: string): CourtCategoryClassification {
  const upper = categoryOrName.toUpperCase();
  if (NON_COURT_REVENUE_KEYWORDS.some((keyword) => upper.includes(keyword))) return "excluded";
  if (COURT_REVENUE_KEYWORDS.some((keyword) => upper.includes(keyword))) return "court";
  return "ambiguous";
}

// ---------------------------------------------------------------------------
// B. INTERNAL_OLSERA — Rule Identitas Produk (Product Identity)
// ---------------------------------------------------------------------------

export type ProductIdentityCandidate = { productId: number; variantId: number | null; sku?: string | null; label?: string };

export type ProductIdentityInput = {
  itemName: string;
  /** true bila productId/variantId/sku SUDAH lengkap tersimpan (tidak perlu resolusi apa pun). */
  hasIdentity: boolean;
  /** Kandidat dari katalog yang cocok NAMA LENGKAP (termasuk suffix varian bila ada). */
  catalogFullNameMatches: ProductIdentityCandidate[];
  /** Kandidat dari katalog yang cocok NAMA DASAR (tanpa suffix varian) — dipakai mendeteksi "variant ambiguous". */
  catalogBaseNameMatches: ProductIdentityCandidate[];
  /** Kandidat dari baris histori lain (order_items lama/baru) dengan nama sama yang PUNYA identitas. */
  historicalMatches: ProductIdentityCandidate[];
  /** Kandidat dari olsera_product_aliases. */
  aliasMatches: ProductIdentityCandidate[];
};

function comboKey(c: { productId: number | null; variantId: number | null }): string {
  return `${c.productId ?? "null"}:${c.variantId ?? "null"}`;
}
function toCandidateList(items: ProductIdentityCandidate[], note: string): RuleEvaluation["candidates"] {
  return items.map((c) => ({ label: c.label ?? `${c.productId}/${c.variantId ?? "-"}`, value: { productId: c.productId, variantId: c.variantId, sku: c.sku ?? null }, note }));
}

/**
 * Rule Identitas Produk — port murni dari logika klasifikasi
 * scripts/audit-order-item-identity-2026.ts (Phase 2), disesuaikan ke status
 * baku modul ini. ATURAN KERAS: variantId TIDAK PERNAH diisi otomatis hanya
 * dari nama produk induk — bila produk punya >1 varian dan tidak ada info
 * lain yang membedakan, hasilnya WAJIB AMBIGUOUS.
 */
export function evaluateProductIdentity(input: ProductIdentityInput): RuleEvaluation {
  const base = { ruleId: RULE_IDS.INTERNAL_PRODUCT_IDENTITY, expected: { itemName: input.itemName } };

  if (input.hasIdentity) {
    return {
      ...base,
      ...defaultImpactConfidence("MATCH"),
      status: "MATCH",
      actual: {},
      difference: null,
      diagnostics: { reason: "productId/variantId/sku sudah lengkap tersimpan." },
      candidates: [],
      knownCaseRef: null,
    };
  }

  const fullHits = input.catalogFullNameMatches;
  const baseHits = input.catalogBaseNameMatches;
  const hist = input.historicalMatches;
  const alias = input.aliasMatches;

  const distinctFull = new Set(fullHits.map(comboKey));
  const distinctHist = new Set(hist.map(comboKey));
  const distinctBaseProducts = new Set(baseHits.map((h) => h.productId));
  const distinctAlias = new Set(alias.map(comboKey));

  // 1. Nama lengkap cocok TEPAT satu kombinasi produk+varian, dan histori (bila ada) tidak bertentangan.
  if (fullHits.length > 0 && distinctFull.size === 1 && (hist.length === 0 || (distinctHist.size === 1 && distinctHist.has([...distinctFull][0])))) {
    return {
      ...base,
      ...defaultImpactConfidence("MATCH"),
      status: "MATCH",
      actual: { productId: fullHits[0].productId, variantId: fullHits[0].variantId, sku: fullHits[0].sku ?? null },
      difference: null,
      diagnostics: { reason: "Nama lengkap cocok tepat satu produk+varian di katalog." },
      candidates: [],
      knownCaseRef: null,
    };
  }

  // 2. Nama lengkap cocok LEBIH dari satu kombinasi berbeda.
  if (fullHits.length > 0 && distinctFull.size > 1) {
    return {
      ...base,
      ...defaultImpactConfidence("AMBIGUOUS"),
      status: "AMBIGUOUS",
      actual: {},
      difference: null,
      diagnostics: { subCase: "name-multi-product", reason: "Nama lengkap cocok lebih dari satu kombinasi produk+varian di katalog." },
      candidates: toCandidateList(fullHits, "katalog"),
      knownCaseRef: null,
    };
  }

  // 3. Nama dasar cocok SATU produk yang punya >1 varian, tanpa info pembeda — "exact product, variant ambiguous".
  if (fullHits.length === 0 && distinctBaseProducts.size === 1 && baseHits.length > 1) {
    return {
      ...base,
      ...defaultImpactConfidence("AMBIGUOUS"),
      status: "AMBIGUOUS",
      actual: { productId: baseHits[0].productId },
      difference: null,
      diagnostics: {
        subCase: "variant-ambiguous",
        reason: "Produk teridentifikasi via nama dasar, tetapi punya beberapa varian aktif dan histori tidak cukup untuk memastikan varian mana — variantId TIDAK diisi otomatis.",
      },
      candidates: toCandidateList(baseHits, "varian katalog"),
      knownCaseRef: KNOWN_CASE_REFS.PHASE2_AMBIGUOUS_276,
    };
  }

  // 4. Nama dasar cocok lebih dari satu productId berbeda.
  if (distinctBaseProducts.size > 1) {
    return {
      ...base,
      ...defaultImpactConfidence("AMBIGUOUS"),
      status: "AMBIGUOUS",
      actual: {},
      difference: null,
      diagnostics: { subCase: "base-name-multi-product", reason: "Nama dasar cocok dengan lebih dari satu productId berbeda di katalog." },
      candidates: toCandidateList(baseHits, "katalog (nama dasar)"),
      knownCaseRef: KNOWN_CASE_REFS.PHASE2_AMBIGUOUS_276,
    };
  }

  // 5. Tidak ada di katalog aktif, tapi histori KONSISTEN pada satu kombinasi (produk kemungkinan nonaktif/dihapus).
  if (fullHits.length === 0 && distinctBaseProducts.size === 0 && hist.length > 0) {
    if (distinctHist.size === 1) {
      return {
        ...base,
        // Override: histori/fallback -> WARNING+MEDIUM (bukan default ERROR+HIGH MISSING_IN_SNAPSHOT) — produk kemungkinan besar benar tapi nonaktif, bukan kegagalan rekonsiliasi.
        impact: "WARNING",
        confidence: "MEDIUM",
        status: "MISSING_IN_SNAPSHOT",
        actual: { productId: hist[0].productId, variantId: hist[0].variantId, sku: hist[0].sku ?? null },
        difference: null,
        diagnostics: { subCase: "historical-product", reason: "Tidak ada di katalog aktif, tapi histori order lain dengan nama sama konsisten pada satu identitas." },
        candidates: [],
        knownCaseRef: KNOWN_CASE_REFS.PHASE3_HISTORICAL_PRODUCT_4,
      };
    }
    return {
      ...base,
      ...defaultImpactConfidence("AMBIGUOUS"),
      status: "AMBIGUOUS",
      actual: {},
      difference: null,
      diagnostics: { subCase: "historical-inconsistent", reason: "Histori nama yang sama menunjukkan lebih dari satu kombinasi identitas berbeda." },
      candidates: toCandidateList(hist, "histori"),
      knownCaseRef: null,
    };
  }

  // 6. Tidak ada katalog/histori, tapi ada alias.
  if (fullHits.length === 0 && distinctBaseProducts.size === 0 && hist.length === 0 && alias.length > 0) {
    if (distinctAlias.size === 1) {
      return {
        ...base,
        // Override: alias = fallback -> WARNING+MEDIUM (bukan default ERROR+HIGH MISSING_IN_SNAPSHOT).
        impact: "WARNING",
        confidence: "MEDIUM",
        status: "MISSING_IN_SNAPSHOT",
        actual: { productId: alias[0].productId, variantId: alias[0].variantId },
        difference: null,
        diagnostics: { subCase: "alias-product", reason: "Dipetakan lewat alias produk (olsera_product_aliases)." },
        candidates: [],
        knownCaseRef: null,
      };
    }
    return {
      ...base,
      ...defaultImpactConfidence("AMBIGUOUS"),
      status: "AMBIGUOUS",
      actual: {},
      difference: null,
      diagnostics: { subCase: "alias-multi", reason: "Lebih dari satu alias produk untuk nama yang sama." },
      candidates: toCandidateList(alias, "alias"),
      knownCaseRef: null,
    };
  }

  // 7. Tidak ada kandidat sama sekali.
  return {
    ...base,
    ...defaultImpactConfidence("BUTUH_ADJUST_MANUAL"),
    status: "BUTUH_ADJUST_MANUAL",
    actual: {},
    difference: null,
    diagnostics: { subCase: "missing-product", reason: "Tidak ditemukan di katalog aktif/nonaktif, tidak ada alias, dan tidak ada histori dengan identitas." },
    candidates: [],
    knownCaseRef: null,
  };
}

// ---------------------------------------------------------------------------
// B. INTERNAL_OLSERA — Rule Inventory Movement
// ---------------------------------------------------------------------------

export type InventoryMovementRuleInput = {
  /** productId pada dokumen movement — null = movement tidak tertaut produk manapun (Known Case 37). */
  productId: number | null;
  /** Apakah dokumen snapshot bulanan untuk produk+periode ini ada. */
  hasSnapshotDoc: boolean;
  /** Qty pergerakan yang DIHARAPKAN (dihitung dari movement). */
  expectedQty: number;
  /** Qty pergerakan yang TERCATAT di snapshot. */
  actualQty: number;
  /** true bila selisih terjadi tepat di batas periode (akhir/awal bulan) — toleransi Known Case "snapshot boundary". */
  isBoundaryPeriod?: boolean;
  /** Toleransi qty untuk kasus boundary (default 1 unit). */
  boundaryToleranceQty?: number;
};

export function evaluateInventoryMovement(input: InventoryMovementRuleInput): RuleEvaluation {
  const base = { ruleId: RULE_IDS.INTERNAL_INVENTORY_MOVEMENT, expected: { expectedQty: input.expectedQty }, candidates: [] as RuleEvaluation["candidates"] };

  if (input.productId === null) {
    return {
      ...base,
      // Override: sudah diketahui akar masalahnya (Known Case 37) & tidak berdampak ke produk lain -> WARNING+MEDIUM, bukan default ERROR+HIGH.
      impact: "WARNING",
      confidence: "MEDIUM",
      status: "MISSING_IN_SNAPSHOT",
      actual: { productId: null },
      difference: null,
      diagnostics: {
        reason: "Inventory movement tidak tertaut ke productId manapun (nama tidak cocok unik saat sync inventori).",
        potentialImpact: "Movement ini TIDAK mengubah closingQty produk manapun (baik benar maupun salah) — qty pada baris ini hilang dari kartu stok, bukan salah tercatat ke produk lain.",
      },
      knownCaseRef: KNOWN_CASE_REFS.PHASE3_MOVEMENT_37,
    };
  }

  if (!input.hasSnapshotDoc) {
    return {
      ...base,
      ...defaultImpactConfidence("MISSING_IN_SNAPSHOT"),
      status: "MISSING_IN_SNAPSHOT",
      actual: {},
      difference: null,
      diagnostics: { reason: "Belum ada dokumen snapshot bulanan untuk produk+periode ini." },
      knownCaseRef: null,
    };
  }

  const diff = input.actualQty - input.expectedQty;
  if (diff === 0) {
    return { ...base, ...defaultImpactConfidence("MATCH"), status: "MATCH", actual: { actualQty: input.actualQty }, difference: { qty: 0 }, diagnostics: { reason: "Qty pergerakan cocok dengan snapshot." }, knownCaseRef: null };
  }
  const boundaryTolerance = input.boundaryToleranceQty ?? 1;
  if (input.isBoundaryPeriod && Math.abs(diff) <= boundaryTolerance) {
    return {
      ...base,
      ...defaultImpactConfidence("MINOR_DIFFERENCE"),
      status: "MINOR_DIFFERENCE",
      actual: { actualQty: input.actualQty },
      difference: { qty: diff },
      diagnostics: { reason: "Selisih kecil tepat di batas periode (transaksi dekat pergantian bulan) — dianggap wajar." },
      knownCaseRef: KNOWN_CASE_REFS.SNAPSHOT_BOUNDARY,
    };
  }
  return {
    ...base,
    ...defaultImpactConfidence("MISMATCH"),
    status: "MISMATCH",
    actual: { actualQty: input.actualQty },
    difference: { qty: diff },
    diagnostics: { reason: "Selisih qty pergerakan vs snapshot melampaui toleransi." },
    knownCaseRef: null,
  };
}

// ---------------------------------------------------------------------------
// B. INTERNAL_OLSERA — Rule Snapshot Consistency (rantai closing↔opening)
// ---------------------------------------------------------------------------

export type SnapshotConsistencyRuleInput = {
  productId: number;
  variantId: number | null;
  /** closingQty bulan N. null = snapshot bulan N belum ada. */
  closingPrev: number | null;
  /** openingQty bulan N+1. null = snapshot bulan N+1 belum ada. */
  openingNext: number | null;
  isBoundaryPeriod?: boolean;
  boundaryToleranceQty?: number;
};

export function evaluateSnapshotConsistency(input: SnapshotConsistencyRuleInput): RuleEvaluation {
  const base = {
    ruleId: RULE_IDS.INTERNAL_SNAPSHOT_CONSISTENCY,
    expected: { productId: input.productId, variantId: input.variantId },
    candidates: [] as RuleEvaluation["candidates"],
  };

  if (input.closingPrev === null || input.openingNext === null) {
    // missingSide: field machine-readable (BUKAN cuma teks reason) supaya pemanggil (mis. runner) bisa
    // membedakan "opening bulan berikutnya belum ada" (wajar bila bulan berjalan/draft — lihat
    // lib/reconciliation-runner.ts capImpactForDraftPeriod) dari "closing bulan INI sendiri belum ada"
    // (bukan sekadar bulan berjalan, layak tetap dilaporkan penuh).
    const missingSide: "current" | "next" | "both" =
      input.closingPrev === null && input.openingNext === null ? "both" : input.closingPrev === null ? "current" : "next";
    return {
      ...base,
      ...defaultImpactConfidence("MISSING_IN_SNAPSHOT"),
      status: "MISSING_IN_SNAPSHOT",
      actual: { closingPrev: input.closingPrev, openingNext: input.openingNext },
      difference: null,
      diagnostics: { reason: "Salah satu sisi snapshot (closing bulan sebelumnya / opening bulan berikutnya) belum ada.", missingSide },
      knownCaseRef: null,
    };
  }

  const diff = input.openingNext - input.closingPrev;
  if (diff === 0) {
    return { ...base, ...defaultImpactConfidence("MATCH"), status: "MATCH", actual: { closingPrev: input.closingPrev, openingNext: input.openingNext }, difference: { qty: 0 }, diagnostics: { reason: "Rantai closing→opening berkelanjutan." }, knownCaseRef: null };
  }
  const boundaryTolerance = input.boundaryToleranceQty ?? 1;
  if (input.isBoundaryPeriod && Math.abs(diff) <= boundaryTolerance) {
    return {
      ...base,
      ...defaultImpactConfidence("MINOR_DIFFERENCE"),
      status: "MINOR_DIFFERENCE",
      actual: { closingPrev: input.closingPrev, openingNext: input.openingNext },
      difference: { qty: diff },
      diagnostics: { reason: "Selisih kecil di batas bulan — dianggap wajar." },
      knownCaseRef: KNOWN_CASE_REFS.SNAPSHOT_BOUNDARY,
    };
  }
  return {
    ...base,
    ...defaultImpactConfidence("MISMATCH"),
    status: "MISMATCH",
    actual: { closingPrev: input.closingPrev, openingNext: input.openingNext },
    difference: { qty: diff },
    diagnostics: { reason: "Rantai closing→opening TERPUTUS — closing bulan sebelumnya tidak sama dengan opening bulan berikutnya." },
    knownCaseRef: null,
  };
}
