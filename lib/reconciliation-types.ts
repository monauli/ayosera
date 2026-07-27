// Domain types Modul Rekonsiliasi AYOSERA (Phase 5A) — murni (tanpa MongoDB/
// Next.js), dipakai bersama oleh rule engine, aggregator, store, dan API.
// Lihat docs/reconciliation-design.md untuk desain lengkap.
//
// PENTING (penegasan scope Phase 5A — lihat docs/reconciliation-design.md §
// "Penegasan Scope"): ada DUA jenis rekonsiliasi yang TIDAK PERNAH tercampur:
//   - CROSS_SYSTEM_COURT_REVENUE: AYO vs Olsera, HANYA untuk omzet/booking
//     lapangan (court). TIDAK PERNAH membandingkan total omzet Olsera (F&B,
//     retail, LABERS, Jasa Host, laporan keuangan total tidak pernah masuk).
//   - INTERNAL_OLSERA: validasi silang ANTAR data Olsera sendiri (kategori,
//     produk, inventori, snapshot, ledger, laporan keuangan) — tidak pernah
//     dibandingkan ke AYO.

// ---------------------------------------------------------------------------
// Status (SATU sumber kebenaran nama status di seluruh modul)
// ---------------------------------------------------------------------------

export const RECONCILIATION_STATUSES = [
  "MATCH",
  "MINOR_DIFFERENCE",
  "MISMATCH",
  "MISSING_IN_AYO",
  "MISSING_IN_OLSERA",
  "MISSING_IN_SNAPSHOT",
  "AMBIGUOUS",
  "BUTUH_ADJUST_MANUAL",
  "IN_PROGRESS",
  "NOT_CHECKED",
] as const;

export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export function isReconciliationStatus(value: unknown): value is ReconciliationStatus {
  return typeof value === "string" && (RECONCILIATION_STATUSES as readonly string[]).includes(value);
}

/**
 * Metadata tiap status: label Indonesia, severity (0 = aman, makin besar
 * makin perlu perhatian — dipakai mengurutkan/menyorot temuan), dan `final`
 * (true = status sudah "settled", tidak butuh tindak lanjut; false = masih
 * butuh perhatian/tindakan sebelum dianggap selesai). `IN_PROGRESS`/
 * `NOT_CHECKED` bukan hasil akhir — jangan pernah dihitung sebagai "aman".
 */
export const STATUS_META: Record<ReconciliationStatus, { label: string; severity: 0 | 1 | 2 | 3 | 4; final: boolean }> = {
  MATCH: { label: "Cocok", severity: 0, final: true },
  MINOR_DIFFERENCE: { label: "Beda Kecil (Wajar)", severity: 1, final: true },
  MISMATCH: { label: "Tidak Cocok", severity: 4, final: false },
  MISSING_IN_AYO: { label: "Tidak Ditemukan di AYO", severity: 3, final: false },
  MISSING_IN_OLSERA: { label: "Tidak Ditemukan di Olsera", severity: 3, final: false },
  MISSING_IN_SNAPSHOT: { label: "Tidak Ditemukan di Snapshot", severity: 3, final: false },
  AMBIGUOUS: { label: "Ambigu (Banyak Kandidat)", severity: 2, final: false },
  BUTUH_ADJUST_MANUAL: { label: "Butuh Adjust Manual", severity: 3, final: false },
  IN_PROGRESS: { label: "Sedang Diproses", severity: 0, final: false },
  NOT_CHECKED: { label: "Belum Diperiksa", severity: 0, final: false },
};

export function statusLabel(status: ReconciliationStatus): string {
  return STATUS_META[status].label;
}

export function statusSeverity(status: ReconciliationStatus): number {
  return STATUS_META[status].severity;
}

/** true bila status sudah "settled" (tidak perlu tindak lanjut). NOT_CHECKED/IN_PROGRESS SELALU false — bukan "aman", hanya belum/sedang diperiksa. */
export function isFinalStatus(status: ReconciliationStatus): boolean {
  return STATUS_META[status].final;
}

/** Status yang mewajibkan tinjauan manusia sebelum data sumber boleh dianggap benar (lihat field `requiresManualAdjustment` pada finding). */
export function requiresManualAdjustment(status: ReconciliationStatus): boolean {
  return status === "AMBIGUOUS" || status === "BUTUH_ADJUST_MANUAL";
}

/** NOT_CHECKED bukan MATCH — helper eksplisit supaya tidak ada kode yang keliru menganggap "belum diperiksa" sebagai "cocok". */
export function isMatchLike(status: ReconciliationStatus): boolean {
  return status === "MATCH" || status === "MINOR_DIFFERENCE";
}

// ---------------------------------------------------------------------------
// Jenis rekonsiliasi (TIDAK PERNAH dicampur satu sama lain, lihat catatan atas)
// ---------------------------------------------------------------------------

export const RECONCILIATION_TYPES = ["CROSS_SYSTEM_COURT_REVENUE", "INTERNAL_OLSERA"] as const;
export type ReconciliationType = (typeof RECONCILIATION_TYPES)[number];

export function isReconciliationType(value: unknown): value is ReconciliationType {
  return typeof value === "string" && (RECONCILIATION_TYPES as readonly string[]).includes(value);
}

export const RECONCILIATION_TYPE_LABEL: Record<ReconciliationType, string> = {
  CROSS_SYSTEM_COURT_REVENUE: "Lintas Sistem — Omzet Lapangan (AYO vs Olsera)",
  INTERNAL_OLSERA: "Internal Olsera",
};

// ---------------------------------------------------------------------------
// Domain (setiap domain HANYA valid untuk SATU reconciliationType — lihat
// DOMAINS_BY_TYPE/validateDomainForType di bawah, supaya CROSS_SYSTEM dan
// INTERNAL tidak pernah tercampur dalam satu temuan)
// ---------------------------------------------------------------------------

export const RECONCILIATION_DOMAINS = [
  "COURT_REVENUE",
  "BOOKING",
  "COURT",
  "DATE",
  "PAYMENT",
  "CATEGORY",
  "PRODUCT",
  "INVENTORY",
  "SNAPSHOT",
  "FINANCIAL",
  "LEDGER",
] as const;

export type ReconciliationDomain = (typeof RECONCILIATION_DOMAINS)[number];

export function isReconciliationDomain(value: unknown): value is ReconciliationDomain {
  return typeof value === "string" && (RECONCILIATION_DOMAINS as readonly string[]).includes(value);
}

export const DOMAIN_LABEL: Record<ReconciliationDomain, string> = {
  COURT_REVENUE: "Omzet Lapangan",
  BOOKING: "Booking Lapangan",
  COURT: "Court/Lapangan",
  DATE: "Tanggal",
  PAYMENT: "Status Pembayaran",
  CATEGORY: "Kategori",
  PRODUCT: "Produk/Identitas Produk",
  INVENTORY: "Inventori",
  SNAPSHOT: "Snapshot Bulanan",
  FINANCIAL: "Laporan Keuangan",
  LEDGER: "Ledger",
};

/** Domain yang SAH untuk masing-masing reconciliationType — pagar keras supaya CROSS_SYSTEM tidak pernah tercampur INTERNAL_OLSERA (lihat validateDomainForType). */
export const DOMAINS_BY_TYPE: Record<ReconciliationType, readonly ReconciliationDomain[]> = {
  CROSS_SYSTEM_COURT_REVENUE: ["COURT_REVENUE", "BOOKING", "COURT", "DATE", "PAYMENT"],
  INTERNAL_OLSERA: ["CATEGORY", "PRODUCT", "INVENTORY", "SNAPSHOT", "FINANCIAL", "LEDGER"],
};

/** Validasi keras: domain HARUS terdaftar untuk reconciliationType-nya. Dipakai rule engine & store sebelum menyimpan/menerima temuan apa pun. */
export function validateDomainForType(type: ReconciliationType, domain: ReconciliationDomain): boolean {
  return DOMAINS_BY_TYPE[type].includes(domain);
}

// ---------------------------------------------------------------------------
// Rule ID — identitas rule yang menghasilkan satu finding (untuk audit/debug,
// bukan enum tertutup: format "<type>.<domain>.v<versi>" supaya rule baru
// bisa ditambah tanpa breaking rule lama yang sudah tersimpan).
// ---------------------------------------------------------------------------

export const RULE_IDS = {
  CROSS_SYSTEM_COURT_REVENUE: "cross-system.court-revenue.v1",
  INTERNAL_CATEGORY: "internal.category.v1",
  INTERNAL_PRODUCT_IDENTITY: "internal.product-identity.v1",
  INTERNAL_INVENTORY_MOVEMENT: "internal.inventory-movement.v1",
  INTERNAL_SNAPSHOT_CONSISTENCY: "internal.snapshot-consistency.v1",
} as const;

export type RuleId = (typeof RULE_IDS)[keyof typeof RULE_IDS];

// ---------------------------------------------------------------------------
// Known Case reference — dipertahankan agar temuan yang SUDAH diketahui akar
// masalahnya (audit Phase 2/3 sebelumnya) tidak dilaporkan sebagai "misteri
// baru" (lihat docs/reconciliation-design.md § Known Cases).
// ---------------------------------------------------------------------------

export const KNOWN_CASE_REFS = {
  PHASE2_AMBIGUOUS_276: "phase2-ambiguous-276",
  PHASE3_MOVEMENT_37: "phase3-movement-37",
  PHASE3_HISTORICAL_PRODUCT_4: "phase3-historical-product-4",
  SNAPSHOT_BOUNDARY: "snapshot-boundary",
} as const;

export type KnownCaseRef = (typeof KNOWN_CASE_REFS)[keyof typeof KNOWN_CASE_REFS];

// ---------------------------------------------------------------------------
// Impact — dampak SATU finding bila dibiarkan, dasar Dashboard/Priority.
// SETIAP finding WAJIB punya impact (tidak boleh null/opsional).
// ---------------------------------------------------------------------------

export const RECONCILIATION_IMPACTS = ["INFO", "WARNING", "ERROR", "CRITICAL"] as const;
export type ReconciliationImpact = (typeof RECONCILIATION_IMPACTS)[number];

export function isReconciliationImpact(value: unknown): value is ReconciliationImpact {
  return typeof value === "string" && (RECONCILIATION_IMPACTS as readonly string[]).includes(value);
}

export const IMPACT_META: Record<ReconciliationImpact, { label: string; rank: 0 | 1 | 2 | 3; description: string }> = {
  INFO: { label: "Info", rank: 0, description: "Hanya informasi — tidak memerlukan tindakan." },
  WARNING: { label: "Peringatan", rank: 1, description: "Perlu dicek — sistem masih dapat dioperasikan normal." },
  ERROR: { label: "Error", rank: 2, description: "Menyebabkan rekonsiliasi gagal pada entitas ini — perlu tindakan." },
  CRITICAL: { label: "Kritis", rank: 3, description: "Memengaruhi validitas laporan — memblokir release bila muncul pada domain tertentu (mis. FINANCIAL/LEDGER)." },
};

export function impactRank(impact: ReconciliationImpact): number {
  return IMPACT_META[impact].rank;
}

/** Domain di mana ERROR WAJIB dieskalasi menjadi CRITICAL (dampaknya ke validitas laporan, bukan sekadar satu entitas). */
export const CRITICAL_ESCALATION_DOMAINS: readonly ReconciliationDomain[] = ["FINANCIAL", "LEDGER"];

/** Eskalasi ERROR -> CRITICAL bila domain temuan adalah domain yang memblokir release (FINANCIAL/LEDGER). Domain lain tidak berubah. */
export function escalateImpactForDomain(domain: ReconciliationDomain, impact: ReconciliationImpact): ReconciliationImpact {
  if (impact === "ERROR" && CRITICAL_ESCALATION_DOMAINS.includes(domain)) return "CRITICAL";
  return impact;
}

/** Periode bulan berjalan (draft) selalu ditampilkan sebagai INFO — hasil belum final, jangan menakuti pengguna dengan impact tinggi yang bisa berubah sebelum bulan ditutup. */
export function capImpactForDraftPeriod(impact: ReconciliationImpact, isDraftPeriod: boolean): ReconciliationImpact {
  return isDraftPeriod ? "INFO" : impact;
}

// ---------------------------------------------------------------------------
// Confidence — seberapa yakin hasil MATCHING (rule engine) terhadap finding
// ini. Dipakai untuk seluruh finding yang berasal dari proses pencocokan
// (bukan hanya perbandingan sederhana) — mis. identitas produk, kategori.
// ---------------------------------------------------------------------------

export const RECONCILIATION_CONFIDENCES = ["HIGH", "MEDIUM", "LOW"] as const;
export type ReconciliationConfidence = (typeof RECONCILIATION_CONFIDENCES)[number];

export function isReconciliationConfidence(value: unknown): value is ReconciliationConfidence {
  return typeof value === "string" && (RECONCILIATION_CONFIDENCES as readonly string[]).includes(value);
}

export const CONFIDENCE_META: Record<ReconciliationConfidence, { label: string; rank: 0 | 1 | 2; description: string }> = {
  HIGH: { label: "Tinggi", rank: 2, description: "Exact match / deterministik — tidak butuh tinjauan tambahan." },
  MEDIUM: { label: "Sedang", rank: 1, description: "Historical product / alias / fallback — kemungkinan besar benar, tetap bisa ditinjau." },
  LOW: { label: "Rendah", rank: 0, description: "Ambigu / banyak kandidat — butuh tinjauan manual sebelum dipercaya." },
};

export function confidenceRank(confidence: ReconciliationConfidence): number {
  return CONFIDENCE_META[confidence].rank;
}

// ---------------------------------------------------------------------------
// Rule mapping baku: status -> impact/confidence DEFAULT. Rule engine
// (lib/reconciliation-rules.ts) BOLEH override per sub-case (mis. inventory
// productId null / historical product diturunkan ke WARNING+MEDIUM meskipun
// status dasarnya MISSING_IN_SNAPSHOT) — override itu eksplisit di rule,
// bukan di tabel ini. Tabel ini adalah DEFAULT/fallback.
// ---------------------------------------------------------------------------

export const STATUS_IMPACT: Record<ReconciliationStatus, ReconciliationImpact> = {
  MATCH: "INFO",
  MINOR_DIFFERENCE: "WARNING",
  MISMATCH: "ERROR",
  MISSING_IN_AYO: "ERROR",
  MISSING_IN_OLSERA: "ERROR",
  MISSING_IN_SNAPSHOT: "ERROR",
  AMBIGUOUS: "WARNING",
  BUTUH_ADJUST_MANUAL: "WARNING",
  IN_PROGRESS: "INFO",
  NOT_CHECKED: "INFO",
};

export const STATUS_CONFIDENCE: Record<ReconciliationStatus, ReconciliationConfidence> = {
  MATCH: "HIGH",
  MINOR_DIFFERENCE: "HIGH",
  MISMATCH: "HIGH",
  MISSING_IN_AYO: "HIGH",
  MISSING_IN_OLSERA: "HIGH",
  MISSING_IN_SNAPSHOT: "HIGH",
  AMBIGUOUS: "LOW",
  BUTUH_ADJUST_MANUAL: "LOW",
  IN_PROGRESS: "LOW",
  NOT_CHECKED: "LOW",
};

export function defaultImpactForStatus(status: ReconciliationStatus): ReconciliationImpact {
  return STATUS_IMPACT[status];
}

export function defaultConfidenceForStatus(status: ReconciliationStatus): ReconciliationConfidence {
  return STATUS_CONFIDENCE[status];
}
