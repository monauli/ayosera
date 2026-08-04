// Engine TERPUSAT — Rekonsiliasi Omzet AYOSERA (AYO vs Olsera), berbasis LEDGER
// (buku besar), BUKAN kategori/POS. SATU-SATUNYA sumber perhitungan dipakai oleh
// ringkasan semua bulan, detail bulanan, API, status, dan UI — lihat
// loadOmzetLedgerMonthSummary/loadOmzetLedgerMonthDetail di bawah, keduanya
// memanggil computeOmzetOlseraLedger() yang SAMA.
//
// ATURAN FINAL (disepakati bersama pengguna):
//   Omzet Olsera = akun 40001 (Court Fees) + akun 40004 (Pickleball) SEBELUM
//   reklasifikasi. Akun 21003 (Hutang Pickleball AMP) BUKAN omzet — dipakai
//   HANYA untuk memverifikasi bahwa nilai 40004 sudah direklasifikasi (jurnal
//   dengan transactionNo yang sama, debit di 40004 = credit di 21003).
//   BK/MN/POS TIDAK PERNAH dipisah sebagai sumber pendapatan berbeda — ledger
//   tidak membedakan itu, dan itu memang benar (BK/MN sudah termasuk total AYO,
//   POS hanya metode pencatatan transaksi di Olsera).
//
// TIDAK ADA tolerance otomatis. Status hanya salah satu dari 4 (lihat
// OmzetStatus): Cocok / Selisih Terjelaskan / Perlu Dicek / Bulan Berjalan.
// "Selisih Terjelaskan" HANYA tercapai lewat bukti jurnal nyata yang disimpan
// eksplisit (lib/reconciliation-omzet-explanation-store.ts) — TIDAK PERNAH
// disimpulkan otomatis dari besar-kecilnya selisih.
import "server-only";
import { isCurrentJakartaPeriod, jakartaCurrentPeriod } from "./olsera-financial-core.ts";
import { getRevenueAmount, isRevenueEligibleTransaction } from "./revenue.ts";
import type { BookingDocument } from "./mongodb.ts";
import type { AyoPaymentEventDocument } from "./ayo-payment-events.ts";
import { sumAyoPaymentEvents } from "./ayo-payment-events.ts";

// ---------------------------------------------------------------------------
// Konstanta akun (SATU-SATUNYA tempat kode akun ini dirujuk untuk omzet)
// ---------------------------------------------------------------------------
export const ACCOUNT_COURT_FEES = "40001";
export const ACCOUNT_PICKLEBALL = "40004";
export const ACCOUNT_PICKLEBALL_PAYABLE = "21003";

// ---------------------------------------------------------------------------
// Tipe data
// ---------------------------------------------------------------------------

export type LedgerEntryInput = {
  transactionNo: string | null;
  transactionDate: string | null;
  description: string | null;
  debit: number;
  credit: number;
  isOpeningBalance?: boolean;
};

export const OMZET_STATUSES = ["COCOK", "SELISIH_TERJELASKAN", "PERLU_DICEK", "BULAN_BERJALAN"] as const;
export type OmzetStatus = (typeof OMZET_STATUSES)[number];

export const OMZET_STATUS_LABEL: Record<OmzetStatus, string> = {
  COCOK: "Cocok",
  SELISIH_TERJELASKAN: "Selisih Terjelaskan",
  PERLU_DICEK: "Perlu Dicek",
  BULAN_BERJALAN: "Bulan Berjalan",
};

/** Kategori bukti jurnal nyata yang SAH untuk menjelaskan selisih — lihat lib/reconciliation-omzet-explanation-store.ts. Tidak ada kategori "lain-lain"/dugaan. */
export const OMZET_EVIDENCE_TYPES = ["shifted-period", "wrong-amount", "duplicate", "reversal", "correction", "wrong-account"] as const;
export type OmzetEvidenceType = (typeof OMZET_EVIDENCE_TYPES)[number];

export const OMZET_EVIDENCE_TYPE_LABEL: Record<OmzetEvidenceType, string> = {
  "shifted-period": "Transaksi bergeser bulan",
  "wrong-amount": "Salah nominal",
  duplicate: "Duplikat",
  reversal: "Reversal",
  correction: "Koreksi",
  "wrong-account": "Salah akun",
};

/**
 * Penanda KHUSUS untuk note yang dikunci LANGSUNG dari status Cocok (selisih
 * Rp0) TANPA penjelasan manual — lihat lockOmzetPeriod di
 * lib/reconciliation-omzet-note-store.ts. SENGAJA dipisah dari
 * OMZET_EVIDENCE_TYPES/OmzetEvidenceType (bukan ditambahkan ke array itu)
 * supaya isOmzetEvidenceTypeValue (dipakai validasi POST .../explanation di
 * app/api/.../_shared.ts) otomatis MENOLAK nilai ini — mencegah penanda
 * internal ini disalahgunakan lewat jalur submit penjelasan manual biasa,
 * tanpa perlu guard eksplisit tambahan.
 */
export const OMZET_LOCK_WITHOUT_EXPLANATION_MARKER = "matched-no-explanation" as const;

export type OmzetExplanation = {
  /** OmzetEvidenceType untuk penjelasan manual sungguhan, ATAU OMZET_LOCK_WITHOUT_EXPLANATION_MARKER bila note ini hasil lock langsung dari status Cocok (lihat classifyStatus). */
  evidenceType: OmzetEvidenceType | typeof OMZET_LOCK_WITHOUT_EXPLANATION_MARKER;
  description: string;
  /** Nominal selisih yang dijelaskan — HARUS sama persis dengan differenceRevenue yang dihitung saat ini, tidak ada toleransi (kecuali locked:true, lihat classifyStatus). Selalu 0 bila evidenceType === OMZET_LOCK_WITHOUT_EXPLANATION_MARKER. */
  explainedAmount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** true bila periode ini sudah dikunci lewat Berita Acara (fitur Lock+Berita Acara) — lihat classifyStatus: begitu locked, status DIBEKUKAN ke SELISIH_TERJELASKAN tanpa recompute dari differenceRevenue. TIDAK ADA jalur unlock. */
  locked: boolean;
  /** userId yang mengunci — null bila locked:false. */
  lockedBy: string | null;
  /** Timestamp saat dikunci — null bila locked:false. */
  lockedAt: Date | null;
};

/** Satu akun (40001 atau 40004) setelah dedup + identifikasi jurnal penutup/reklasifikasi + netting koreksi/reversal. */
export type AccountLedgerBreakdown = {
  accountCode: string;
  rawEntryCount: number;
  duplicatesRemoved: number;
  creditTotal: number;
  /** Jurnal penutup (40001, prefix "CL") atau reklasifikasi (40004, cross-match ke 21003) — null bila tidak ditemukan/ambigu. */
  closingEntry: LedgerEntryInput | null;
  /** >1 kandidat ditemukan -> TIDAK dipilih otomatis (lihat closingEntry=null pada kasus ini). */
  ambiguousCandidates: LedgerEntryInput[];
  /** Debit lain (bukan jurnal penutup/reklasifikasi) — koreksi/reversal/pergeseran periode, dinetkan dari creditTotal. */
  otherDebitEntries: LedgerEntryInput[];
  otherDebitTotal: number;
  /** creditTotal - otherDebitTotal — omzet akun ini "sebelum reklasifikasi", sudah netto koreksi/reversal dalam periode ini. */
  net: number;
};

export type PickleballVerification = {
  applicable: boolean;
  verified: boolean | null;
  matchedEntry: LedgerEntryInput | null;
  reason: string;
};

export type OmzetLedgerSide = { count: number; revenue: number };

export type OmzetOlseraLedgerResult = {
  period: string;
  ayo: OmzetLedgerSide;
  courtFees: AccountLedgerBreakdown;
  pickleball: AccountLedgerBreakdown;
  pickleballVerification: PickleballVerification;
  olseraTotal: number;
  differenceRevenue: number;
  dataAvailable: boolean;
  status: OmzetStatus;
  statusReason: string;
  explanation: OmzetExplanation | null;
};

// ---------------------------------------------------------------------------
// Dedup — entri ledger duplikat (dokumen berbeda, isi identik: transactionNo+
// tanggal+debit+credit+deskripsi) HANYA dihitung SATU KALI. Ditemukan nyata
// pada data produksi Juni 2026 (seluruh baris tersimpan dobel). Lihat instruksi
// "6. Tangani reversal dan koreksi tanpa menghitung ganda".
// ---------------------------------------------------------------------------
function entryKey(e: LedgerEntryInput): string {
  return JSON.stringify([e.transactionNo ?? null, e.transactionDate ?? null, e.debit, e.credit, e.description ?? null]);
}

function dedupeEntries(entries: LedgerEntryInput[]): LedgerEntryInput[] {
  const seen = new Map<string, LedgerEntryInput>();
  for (const entry of entries) {
    const key = entryKey(entry);
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Identifikasi jurnal penutup (40001) — deterministik lewat prefix nomor
// transaksi "CL" (Closing), BUKAN dari isi deskripsi bebas.
// ---------------------------------------------------------------------------
function findClosingEntries40001(entries: LedgerEntryInput[]): LedgerEntryInput[] {
  return entries.filter((e) => e.debit > 0 && e.credit === 0 && typeof e.transactionNo === "string" && e.transactionNo.startsWith("CL"));
}

// ---------------------------------------------------------------------------
// Identifikasi jurnal reklasifikasi (40004) — deterministik lewat cross-match
// transactionNo+nominal ke kredit akun 21003 (bukti jurnal nyata, bukan
// deskripsi bebas). Ini SATU-SATUNYA fungsi 21003 dalam engine ini.
// ---------------------------------------------------------------------------
function findReklasEntries40004(entries: LedgerEntryInput[], entries21003: LedgerEntryInput[]): { candidates: LedgerEntryInput[]; matchOf: Map<LedgerEntryInput, LedgerEntryInput> } {
  const creditsByNo = new Map<string, LedgerEntryInput[]>();
  for (const e of entries21003) {
    if (e.credit > 0 && typeof e.transactionNo === "string") {
      const list = creditsByNo.get(e.transactionNo) ?? [];
      list.push(e);
      creditsByNo.set(e.transactionNo, list);
    }
  }
  const candidates: LedgerEntryInput[] = [];
  const matchOf = new Map<LedgerEntryInput, LedgerEntryInput>();
  for (const e of entries) {
    if (e.debit <= 0 || e.credit !== 0 || typeof e.transactionNo !== "string") continue;
    const matches = (creditsByNo.get(e.transactionNo) ?? []).filter((m) => m.credit === e.debit);
    if (matches.length > 0) {
      candidates.push(e);
      matchOf.set(e, matches[0]);
    }
  }
  return { candidates, matchOf };
}

/**
 * @param rawNonOpeningCount jumlah baris non-opening SEBELUM dedup (untuk diagnostik duplicatesRemoved).
 * @param deduped baris non-opening SESUDAH dedup (lihat dedupeEntries) — SATU-SATUNYA data yang dipakai menghitung total.
 * @param closingCandidates kandidat jurnal penutup/reklasifikasi, HARUS berasal dari elemen yang sama (reference-equal) dengan `deduped`.
 */
function buildBreakdown(
  accountCode: string,
  rawNonOpeningCount: number,
  deduped: LedgerEntryInput[],
  closingCandidates: LedgerEntryInput[],
): AccountLedgerBreakdown {
  const closingEntry = closingCandidates.length === 1 ? closingCandidates[0] : null;
  const ambiguousCandidates = closingCandidates.length > 1 ? closingCandidates : [];

  const creditTotal = deduped.reduce((sum, e) => sum + e.credit, 0);
  const otherDebitEntries = deduped.filter((e) => e.debit > 0 && e !== closingEntry && !ambiguousCandidates.includes(e));
  const otherDebitTotal = otherDebitEntries.reduce((sum, e) => sum + e.debit, 0);

  return {
    accountCode,
    rawEntryCount: rawNonOpeningCount,
    duplicatesRemoved: rawNonOpeningCount - deduped.length,
    creditTotal,
    closingEntry,
    ambiguousCandidates,
    otherDebitEntries,
    otherDebitTotal,
    net: creditTotal - otherDebitTotal,
  };
}

function emptySide(): OmzetLedgerSide {
  return { count: 0, revenue: 0 };
}

/**
 * Hitung omzet AYO — booking eligible (bukan cancelled/internal/nol), sama
 * persis lib/revenue.ts yang sudah dipakai seluruh dashboard AYO lain.
 */
export function computeAyoSide(bookings: Array<Pick<BookingDocument, "date" | "total_price" | "status">>): OmzetLedgerSide {
  const side = emptySide();
  for (const booking of bookings) {
    if (!isRevenueEligibleTransaction(booking)) continue;
    side.count += 1;
    side.revenue += getRevenueAmount(booking);
  }
  return side;
}

/**
 * Engine murni (tanpa I/O) — SATU-SATUNYA fungsi yang menghitung status/omzet
 * Rekonsiliasi Omzet AYOSERA. Dipanggil oleh loader ringkasan DAN detail
 * (lihat loadOmzetLedgerMonthSummary/loadOmzetLedgerMonthDetail) sehingga
 * angka & status keduanya SELALU identik.
 */
export function computeOmzetOlseraLedger(
  period: string,
  ayo: OmzetLedgerSide,
  rawEntries40001: LedgerEntryInput[],
  rawEntries40004: LedgerEntryInput[],
  rawEntries21003: LedgerEntryInput[],
  explanation: OmzetExplanation | null = null,
  now: Date = new Date(),
): OmzetOlseraLedgerResult {
  const rawNonOpening40001Count = rawEntries40001.filter((e) => !e.isOpeningBalance).length;
  const rawNonOpening40004Count = rawEntries40004.filter((e) => !e.isOpeningBalance).length;
  const nonOpening40001 = dedupeEntries(rawEntries40001.filter((e) => !e.isOpeningBalance));
  const nonOpening40004 = dedupeEntries(rawEntries40004.filter((e) => !e.isOpeningBalance));
  const nonOpening21003 = dedupeEntries(rawEntries21003.filter((e) => !e.isOpeningBalance));

  const closing40001Candidates = findClosingEntries40001(nonOpening40001);
  const courtFees = buildBreakdown(ACCOUNT_COURT_FEES, rawNonOpening40001Count, nonOpening40001, closing40001Candidates);

  const { candidates: reklasCandidates, matchOf } = findReklasEntries40004(nonOpening40004, nonOpening21003);
  const pickleball = buildBreakdown(ACCOUNT_PICKLEBALL, rawNonOpening40004Count, nonOpening40004, reklasCandidates);

  const isCurrent = isCurrentJakartaPeriod(period, now);
  const dataAvailable = nonOpening40001.length > 0 || nonOpening40004.length > 0;

  let pickleballVerification: PickleballVerification;
  if (nonOpening40004.length === 0) {
    pickleballVerification = { applicable: false, verified: null, matchedEntry: null, reason: "Tidak ada aktivitas akun 40004 pada periode ini." };
  } else if (pickleball.ambiguousCandidates.length > 0) {
    pickleballVerification = { applicable: true, verified: false, matchedEntry: null, reason: "Ditemukan lebih dari satu kandidat jurnal reklasifikasi 40004->21003 — tidak dipilih otomatis." };
  } else if (!pickleball.closingEntry) {
    pickleballVerification = {
      applicable: true,
      verified: isCurrent ? null : false,
      matchedEntry: null,
      reason: isCurrent ? "Bulan berjalan — reklasifikasi belum tentu diproses." : "Jurnal reklasifikasi 40004->21003 tidak ditemukan untuk periode ini.",
    };
  } else {
    const matched = matchOf.get(pickleball.closingEntry) ?? null;
    pickleballVerification = { applicable: true, verified: matched !== null, matchedEntry: matched, reason: matched ? "Nilai debit 40004 cocok dengan kredit 21003 (transactionNo & nominal sama)." : "Tidak ditemukan padanan kredit 21003." };
  }

  const olseraTotal = courtFees.net + pickleball.net;
  const differenceRevenue = olseraTotal - ayo.revenue;

  const { status, statusReason } = classifyStatus({
    isCurrent,
    dataAvailable,
    courtFeesHasActivity: nonOpening40001.length > 0,
    courtFeesClosingFound: courtFees.closingEntry !== null,
    courtFeesAmbiguous: courtFees.ambiguousCandidates.length > 0,
    pickleballVerification,
    differenceRevenue,
    explanation,
  });

  return { period, ayo, courtFees, pickleball, pickleballVerification, olseraTotal, differenceRevenue, dataAvailable, status, statusReason, explanation };
}

function classifyStatus(input: {
  isCurrent: boolean;
  dataAvailable: boolean;
  courtFeesHasActivity: boolean;
  courtFeesClosingFound: boolean;
  courtFeesAmbiguous: boolean;
  pickleballVerification: PickleballVerification;
  differenceRevenue: number;
  explanation: OmzetExplanation | null;
}): { status: OmzetStatus; statusReason: string } {
  // Fitur Lock+Berita Acara — CABANG PALING AWAL, SEBELUM pengecekan apa
  // pun (termasuk isCurrent/dataAvailable/ambiguitas/verifikasi 40004): begitu
  // periode dikunci lewat Berita Acara, statusnya OTORITATIF di atas SEMUA
  // pengecekan otomatis lain, TIDAK PERNAH di-recompute dari differenceRevenue
  // terkini (mis. re-sync ledger susulan tidak boleh diam-diam membatalkan
  // status yang sudah ditandatangani). Syarat lock (lockOmzetPeriod di
  // lib/reconciliation-omzet-note-store.ts) sudah memvalidasi
  // explainedAmount === differenceRevenue PADA SAAT dikunci, jadi membekukan
  // ke SELISIH_TERJELASKAN di sini aman. Lihat "Desain Skema Lock+Berita
  // Acara" section 3c di tmp/ai-handoff.md.
  if (input.explanation?.locked) {
    // Dikunci LANGSUNG dari status Cocok (selisih Rp0), TANPA penjelasan
    // manual — bahasa status HARUS jujur (bukan "Selisih Terjelaskan", karena
    // tidak ada selisih yang dijelaskan). Tetap status COCOK yang sudah ada
    // (bukan status baru) supaya dibekukan sama seperti kasus lock lainnya:
    // begitu locked, TIDAK PERNAH di-recompute dari differenceRevenue terkini
    // (mis. re-sync susulan yang memunculkan selisih baru tidak diam-diam
    // membatalkan status Cocok yang sudah dikunci).
    if (input.explanation.evidenceType === OMZET_LOCK_WITHOUT_EXPLANATION_MARKER) {
      return {
        status: "COCOK",
        statusReason: `Status Cocok dikunci oleh ${input.explanation.lockedBy} pada ${input.explanation.lockedAt?.toISOString()} — dibekukan, tidak akan berubah otomatis meski data disinkron ulang di kemudian hari.`,
      };
    }
    return {
      status: "SELISIH_TERJELASKAN",
      statusReason: `Selisih dikunci lewat Berita Acara oleh ${input.explanation.lockedBy} pada ${input.explanation.lockedAt?.toISOString()}: ${OMZET_EVIDENCE_TYPE_LABEL[input.explanation.evidenceType]} — ${input.explanation.description}`,
    };
  }
  if (input.isCurrent) {
    return { status: "BULAN_BERJALAN", statusReason: "Bulan berjalan — data masih dapat berubah sampai bulan ini ditutup dan jurnal penutup/reklasifikasi diproses." };
  }
  if (!input.dataAvailable) {
    return { status: "PERLU_DICEK", statusReason: "Data ledger akun 40001/40004 belum tersedia untuk periode ini — belum dapat diverifikasi (bukan berarti selisih)." };
  }
  if (input.courtFeesAmbiguous) {
    return { status: "PERLU_DICEK", statusReason: "Ditemukan lebih dari satu kandidat jurnal penutup akun 40001 — tidak dipilih otomatis." };
  }
  if (input.courtFeesHasActivity && !input.courtFeesClosingFound) {
    return { status: "PERLU_DICEK", statusReason: "Jurnal penutup akun 40001 (tutup buku) belum ditemukan untuk periode ini." };
  }
  if (input.pickleballVerification.applicable && input.pickleballVerification.verified === false) {
    return { status: "PERLU_DICEK", statusReason: `Reklasifikasi akun 40004 belum terverifikasi ke akun 21003: ${input.pickleballVerification.reason}` };
  }

  if (input.differenceRevenue === 0) {
    return { status: "COCOK", statusReason: "Omzet AYO dan Olsera (akun 40001+40004 sebelum reklasifikasi) sama persis." };
  }

  // evidenceType !== marker: note dengan penanda lock-tanpa-penjelasan hanya
  // pernah dibuat SEKALIGUS locked:true (lihat lockOmzetPeriod) — tidak
  // pernah unlocked, jadi baris ini pada praktiknya tidak akan pernah
  // menerima penanda tsb (sudah ditangkap cabang locked di atas). Guard ini
  // tetap eksplisit supaya OMZET_EVIDENCE_TYPE_LABEL di bawah type-safe
  // (Record hanya mengenal OmzetEvidenceType asli, bukan penanda).
  if (input.explanation && input.explanation.evidenceType !== OMZET_LOCK_WITHOUT_EXPLANATION_MARKER && input.explanation.explainedAmount === input.differenceRevenue) {
    return {
      status: "SELISIH_TERJELASKAN",
      statusReason: `Selisih ${input.differenceRevenue} dijelaskan: ${OMZET_EVIDENCE_TYPE_LABEL[input.explanation.evidenceType]} — ${input.explanation.description}`,
    };
  }

  return { status: "PERLU_DICEK", statusReason: `Ada selisih ${input.differenceRevenue} yang penyebabnya belum terbukti dengan bukti jurnal nyata.` };
}

/**
 * Apakah SATU bulan layak ditampilkan di ringkasan bulanan — pure, dipakai
 * loadOmzetLedgerRecentSummaries (SATU-SATUNYA tempat aturan ini ditegakkan).
 * Bulan HANYA ditampilkan bila memenuhi salah satu:
 *   1. punya omzet AYO (booking eligible, `ayo.count > 0`);
 *   2. punya data ledger Olsera (`dataAvailable`);
 *   3. bulan berjalan (selalu ditampilkan, walau datanya masih kosong).
 * Bulan di luar cakupan data (belum ada AYO maupun ledger, dan bukan bulan
 * berjalan) TIDAK PERNAH ditampilkan — mencegah status "Perlu Dicek" palsu
 * untuk periode yang memang belum ada apa-apa untuk direkonsiliasi.
 */
export function hasOmzetActivity(result: OmzetOlseraLedgerResult): boolean {
  if (result.status === "BULAN_BERJALAN") return true;
  if (result.ayo.count > 0) return true;
  if (result.dataAvailable) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Loader Mongo (read-only) — dipakai ringkasan (summary) & detail, SATU-SATUNYA
// jalur baca data untuk keduanya supaya angka tidak pernah berbeda.
// ---------------------------------------------------------------------------

export type MinimalReadCollection<T> = {
  find(filter: Record<string, unknown>): { toArray(): Promise<T[]> };
};

export type OmzetLedgerSourceContext = {
  bookings: MinimalReadCollection<Pick<BookingDocument, "date" | "total_price" | "status">>;
  ayoPaymentEvents?: MinimalReadCollection<Pick<AyoPaymentEventDocument, "date" | "total_price" | "status" | "raw">>;
  /** Payment-event data is opt-in only after an external, period-level validation. */
  ayoPaymentEventsValidated?: boolean;
  ledgerEntries: MinimalReadCollection<LedgerEntryInput & { accountCode: string; period: string }>;
  loadExplanation: (period: string) => Promise<OmzetExplanation | null>;
};

async function resolveContext(context?: OmzetLedgerSourceContext): Promise<OmzetLedgerSourceContext> {
  if (context) return context;
  const { collections } = await import("./mongodb.ts");
  const { getCurrentOmzetNote } = await import("./reconciliation-omzet-note-store.ts");
  const { bookings, olseraFinancialLedgerEntries } = await collections();
  return {
    bookings,
    ledgerEntries: olseraFinancialLedgerEntries,
    // Skema BARU append-only (OlseraOmzetReconciliationNoteV2Document, lihat
    // lib/reconciliation-omzet-note-store.ts) — menggantikan
    // getOmzetExplanation (skema lama, lib/reconciliation-omzet-explanation-store.ts,
    // SENGAJA dibiarkan ada tapi tidak lagi dipanggil di sini, lihat "Desain
    // Skema Lock+Berita Acara" section 3c di tmp/ai-handoff.md). `storeId()`
    // (fungsi module ini, dipakai juga untuk query ledgerEntries di
    // loadPeriodData) sudah tersedia tanpa perlu memperluas signature
    // loadExplanation — SATU store per deployment, sama seperti seluruh
    // engine ledger ini.
    loadExplanation: async (period: string) => {
      const note = await getCurrentOmzetNote(storeId(), period);
      if (!note) return null;
      return {
        evidenceType: note.evidenceType,
        description: note.description,
        explainedAmount: note.explainedAmount,
        createdBy: note.createdBy,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        locked: note.locked,
        lockedBy: note.lockedBy,
        lockedAt: note.lockedAt,
      };
    },
  };
}

function storeId(): number {
  const value = Number(process.env.OLSERA_INTERNAL_STORE_ID);
  if (!Number.isInteger(value) || value <= 0) throw new Error("Konfigurasi store laporan keuangan tidak valid.");
  return value;
}

function periodToMonthRange(period: string): { start: string; end: string } {
  const [year, month] = period.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return { start: `${period}-01`, end: `${period}-${String(lastDay).padStart(2, "0")}` };
}

async function loadPeriodData(period: string, context?: OmzetLedgerSourceContext) {
  const ctx = await resolveContext(context);
  const { start, end } = periodToMonthRange(period);
  const [bookingRows, paymentEvents, entries40001, entries40004, entries21003, explanation] = await Promise.all([
    ctx.bookings.find({ date: { $gte: start, $lte: end } }).toArray(),
    ctx.ayoPaymentEventsValidated && ctx.ayoPaymentEvents
      ? ctx.ayoPaymentEvents.find({ date: { $gte: start, $lte: end } }).toArray()
      : Promise.resolve([]),
    ctx.ledgerEntries.find({ storeId: storeId(), period, accountCode: ACCOUNT_COURT_FEES }).toArray(),
    ctx.ledgerEntries.find({ storeId: storeId(), period, accountCode: ACCOUNT_PICKLEBALL }).toArray(),
    ctx.ledgerEntries.find({ storeId: storeId(), period, accountCode: ACCOUNT_PICKLEBALL_PAYABLE }).toArray(),
    ctx.loadExplanation(period),
  ]);
  return { bookingRows, paymentEvents, entries40001, entries40004, entries21003, explanation };
}

/** Ringkasan SATU bulan — dipakai daftar bulanan di /reconciliation. */
export async function loadOmzetLedgerMonthSummary(period: string, context?: OmzetLedgerSourceContext, now: Date = new Date()): Promise<OmzetOlseraLedgerResult> {
  const { bookingRows, paymentEvents, entries40001, entries40004, entries21003, explanation } = await loadPeriodData(period, context);
  const ayo = paymentEvents.length ? sumAyoPaymentEvents(paymentEvents) : computeAyoSide(bookingRows);
  return computeOmzetOlseraLedger(period, ayo, entries40001, entries40004, entries21003, explanation, now);
}

/** Detail SATU bulan — SAMA PERSIS engine-nya dengan ringkasan (satu sumber, lihat computeOmzetOlseraLedger). */
export async function loadOmzetLedgerMonthDetail(period: string, context?: OmzetLedgerSourceContext, now: Date = new Date()): Promise<OmzetOlseraLedgerResult> {
  return loadOmzetLedgerMonthSummary(period, context, now);
}

/**
 * Ringkasan `count` bulan terakhir, SUDAH DIFILTER lewat hasOmzetActivity —
 * SATU-SATUNYA jalur yang dipakai endpoint ringkasan (lihat
 * app/api/reconciliation/court-revenue/route.ts). Bulan kosong di luar
 * cakupan data (bukan bulan berjalan, tidak ada omzet AYO, tidak ada ledger
 * Olsera) dibuang di sini — bukan di UI — supaya perilaku ini SATU tempat
 * untuk ringkasan & tetap konsisten dengan detail (loadOmzetLedgerMonthDetail
 * pada periode yang sama menghitung ulang lewat engine yang identik).
 */
export async function loadOmzetLedgerRecentSummaries(count: number, context?: OmzetLedgerSourceContext, now: Date = new Date()): Promise<OmzetOlseraLedgerResult[]> {
  const periods = recentOmzetLedgerPeriods(count, now);
  const results = await Promise.all(periods.map((period) => loadOmzetLedgerMonthSummary(period, context, now)));
  return results.filter(hasOmzetActivity);
}

/** Daftar period (YYYY-MM) `count` bulan terakhir, dari bulan berjalan (Asia/Jakarta) mundur. */
export function recentOmzetLedgerPeriods(count: number, now: Date = new Date()): string[] {
  const current = jakartaCurrentPeriod(now);
  let [year, month] = current.split("-").map(Number);
  const periods: string[] = [];
  for (let i = 0; i < count; i++) {
    periods.push(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  return periods;
}
