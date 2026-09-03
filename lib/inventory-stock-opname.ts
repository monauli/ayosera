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

export type StockOpnameBaEntry = {
  productId: number | null;
  variantId?: number | null;
  physicalQty: number | null;
  differenceQty: number | null;
  note: string | null;
  cutoff: string | null;
};

export type StockOpnameSystemRow = {
  productId: number;
  variantId: number | null;
  systemClosingQty: number | null;
  productName?: string;
};

export type StockOpnameVerificationRow = StockOpnameBaEntry & {
  status: "COCOK" | "PERLU_DICEK";
  systemClosingQty: number | null;
  mappingCertain: boolean;
};

/** BA hanya memuat selisih; baris lain dianggap cocok tanpa membuat BA palsu. */
export function verifyStockOpnameBa(input: {
  systemRows: ReadonlyArray<StockOpnameSystemRow>;
  baEntries: ReadonlyArray<StockOpnameBaEntry>;
  expectedCutoff: string;
  baOnlyDifferencesConfirmed: boolean;
}): { rows: StockOpnameVerificationRow[]; canFinalize: boolean; reason: string | null } {
  if (!input.baOnlyDifferencesConfirmed) return { rows: [], canFinalize: false, reason: "Konfirmasi BA hanya memuat item yang selisih wajib dicentang." };
  const system = new Map(input.systemRows.map((row) => [`${row.productId}:${row.variantId ?? 0}`, row]));
  const seen = new Set<string>();
  const rows: StockOpnameVerificationRow[] = [];
  for (const entry of input.baEntries) {
    const mappingCertain = Number.isInteger(entry.productId) && system.has(`${entry.productId}:${entry.variantId ?? 0}`);
    const key = `${entry.productId ?? "?"}:${entry.variantId ?? 0}`;
    const source = mappingCertain ? system.get(key)! : null;
    const expectedDifference = source?.systemClosingQty !== null && source?.systemClosingQty !== undefined && entry.physicalQty !== null ? entry.physicalQty - source.systemClosingQty : null;
    const valid = mappingCertain && entry.cutoff === input.expectedCutoff && entry.physicalQty !== null && entry.differenceQty === expectedDifference && expectedDifference !== 0;
    rows.push({ ...entry, systemClosingQty: source?.systemClosingQty ?? null, mappingCertain, status: valid ? "COCOK" : "PERLU_DICEK" });
    seen.add(key);
  }
  const canFinalize = rows.length > 0 && rows.every((row) => row.status === "COCOK") && rows.every((row) => row.differenceQty !== 0) && seen.size === rows.length;
  return { rows, canFinalize, reason: canFinalize ? null : "BA memiliki mismatch produk, cutoff, angka, atau selisih nol." };
}

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

// ---------------------------------------------------------------------------
// Cutoff tanggal BA (BUKAN akhir bulan kalender) — riset live 2026-08
// (scratchpad, GET-only ke Open API Olsera) MEMBUKTIKAN GET .../inventory/
// stockmovement mengembalikan `sisa` presisi PER HARI mengikuti parameter
// `end_date` (mis. end_date=2026-07-16 -> sisa 36, end_date=2026-07-17 ->
// sisa 35 tepat mengikuti penjualan tanggal itu) — BUKAN agregat bulanan.
// lib/olsera-inventory-stockmovement.ts:fetchStockMovementRange SUDAH generik
// (menerima start_date/end_date apa pun); fungsi di bawah HANYA menentukan
// rentang tanggal & validitas cutoff — pemanggilan API tetap di
// lib/inventory-stock-opname-store.ts (glue I/O), file ini tetap murni.
// ---------------------------------------------------------------------------

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Validasi string tanggal ISO (YYYY-MM-DD) yang BENAR-BENAR kalender valid (mis. "2026-02-30" ditolak). */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * URL lampiran BA (attachment.url) aman untuk dirender sebagai `<a href>` —
 * WAJIB https:// (Vercel Blob selalu mengembalikan https). Dipakai di
 * PERBATASAN tulis (app/api/reconciliation/inventory-opname/route.ts) DAN
 * saat render ("Riwayat BA", app/reconciliation/inventory/page.tsx) — tanpa
 * ini, attachment.url yang dikirim client (bisa lewat request langsung ke
 * endpoint, bukan cuma lewat UI upload) bisa berisi skema seperti
 * "javascript:..." yang tereksekusi saat link diklik (stored XSS).
 */
export function isSafeAttachmentUrl(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\//i.test(value);
}

/**
 * Batas aman jendela query stockmovement — Olsera menolak (HTTP 406, "not
 * allowed pulling data for more than 3 mounts") jendela lebih dari ~90-100
 * hari (lihat lib/olsera-inventory-monthly-core.ts). Nilai di bawah ini
 * sengaja diberi margin aman (bukan mepet ke batas Olsera).
 */
export const CUTOFF_MAX_LOOKBACK_DAYS = 75;

/**
 * Rentang query stockmovement untuk SATU cutoff tanggal spesifik (bukan
 * akhir bulan kalender). `endDate` = cutoffDate PERSIS — movement setelah
 * cutoff otomatis tidak pernah ikut (dijamin parameter API, BUKAN dipotong
 * manual di sini/pemanggil). `desiredStartDate` opsional (default: awal
 * bulan cutoff, rentang "wajar" untuk laporan periode berjalan); DIKLEM ke
 * CUTOFF_MAX_LOOKBACK_DAYS sebelum cutoff bila lebih lebar dari itu — supaya
 * request TIDAK PERNAH gagal 406 tanpa fallback.
 */
export function resolveCutoffQueryRange(cutoffDate: string, desiredStartDate?: string): { startDate: string; endDate: string } {
  if (!isValidIsoDate(cutoffDate)) throw new RangeError(`cutoffDate tidak valid: ${String(cutoffDate)}`);
  const [year, month] = cutoffDate.split("-").map(Number);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const wanted = desiredStartDate && isValidIsoDate(desiredStartDate) ? desiredStartDate : monthStart;
  const cutoffMs = Date.parse(`${cutoffDate}T00:00:00Z`);
  const wantedMs = Date.parse(`${wanted}T00:00:00Z`);
  const windowDays = Math.round((cutoffMs - wantedMs) / 86_400_000);
  if (wantedMs <= cutoffMs && windowDays <= CUTOFF_MAX_LOOKBACK_DAYS) return { startDate: wanted, endDate: cutoffDate };
  const clampedMs = cutoffMs - CUTOFF_MAX_LOOKBACK_DAYS * 86_400_000;
  return { startDate: new Date(clampedMs).toISOString().slice(0, 10), endDate: cutoffDate };
}

/**
 * Awal periode BA EFEKTIF untuk satu dokumen. Dokumen lama (disimpan sebelum
 * rentang bebas ada) tidak punya `startDate` sama sekali — dokumen seperti itu
 * diperlakukan sebagai **BA bulan penuh**, yaitu tanggal 1 bulan periodenya.
 * Aturan ini yang membuat 48 dokumen Februari 2026 existing tidak memblokir
 * penyimpanan secara tidak sengaja: menyimpan ulang BA bulan penuh yang sama
 * (atau menyimpan tanpa startDate seperti jalur lama) menghasilkan awal periode
 * efektif yang SAMA, jadi tidak dianggap konflik.
 */
export function effectiveBaStartDate(input: { startDate?: string | null; year: number; month: number }): string {
  if (input.startDate && isValidIsoDate(input.startDate)) return input.startDate;
  return `${input.year}-${String(input.month).padStart(2, "0")}-01`;
}

/** Label rentang BA untuk pesan error — ISO penuh supaya tidak ambigu antar bulan. */
function baRangeLabel(doc: { startDate?: string | null; cutoffDate?: string | null; year: number; month: number }): string {
  const start = effectiveBaStartDate(doc);
  return doc.cutoffDate && isValidIsoDate(doc.cutoffDate) ? `${start} s/d ${doc.cutoffDate}` : `mulai ${start}`;
}

export type BaPeriodConflict = { ok: boolean; reason: string | null };

/**
 * Tahap 3a — cegah BA kedua dengan periode BERBEDA menimpa BA yang sudah ada
 * dalam bulan yang sama secara diam-diam. `_id` dokumen SENGAJA tidak diubah
 * (lihat audit Tahap 3): pemisahan dilakukan lewat field `startDate`, dan
 * konflik DITOLAK, bukan diakomodasi. Dukungan penuh BA terpecah (dua BA hidup
 * berdampingan dalam satu bulan) butuh perubahan `_id` dan keputusan produk
 * tersendiri — di luar cakupan fungsi ini.
 *
 * Dokumen tanpa `startDate` dianggap BA bulan penuh (lihat effectiveBaStartDate),
 * jadi data lama hanya memblokir bila BA baru memang periodenya berbeda.
 */
export function checkBaPeriodConflict(input: {
  existing: ReadonlyArray<{ startDate?: string | null; cutoffDate?: string | null }>;
  year: number;
  month: number;
  incomingStartDate?: string | null;
}): BaPeriodConflict {
  const incoming = effectiveBaStartDate({ startDate: input.incomingStartDate, year: input.year, month: input.month });
  for (const doc of input.existing) {
    const docStart = effectiveBaStartDate({ startDate: doc.startDate, year: input.year, month: input.month });
    if (docStart === incoming) continue;
    return {
      ok: false,
      reason: `Periode ${input.year}-${String(input.month).padStart(2, "0")} sudah memuat BA ${baRangeLabel({ ...doc, year: input.year, month: input.month })}. Hapus BA lama itu dulu sebelum menyimpan BA periode berbeda (${incoming}).`,
    };
  }
  return { ok: true, reason: null };
}

export type CutoffValidationResult = { ok: boolean; reason: string | null };

/**
 * "BA salah periode diblok": cutoff WAJIB tanggal valid, WAJIB berada pada
 * bulan/tahun filter yang sedang dibuka (BA periode lain tidak boleh
 * terpasang diam-diam ke filter yang salah), dan TIDAK BOLEH tanggal masa
 * depan relatif `today` (BA tidak bisa merekonsiliasi stok yang belum
 * terjadi). Dipanggil SEBELUM finalisasi — gagal di sini WAJIB memblokir
 * finalisasi (butuh review manual), TIDAK PERNAH menebak cutoff yang
 * "masuk akal".
 */
export function validateCutoffPlausibility(input: { cutoffDate: string | null; year: number; month: number; today: string; startDate?: string | null }): CutoffValidationResult {
  if (!input.cutoffDate || !isValidIsoDate(input.cutoffDate)) {
    return { ok: false, reason: "Tanggal cutoff BA tidak terbaca/tidak valid — perlu ditinjau manual sebelum finalisasi." };
  }
  const period = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const startDate = input.startDate ?? null;

  // Masa depan diblok lebih dulu — berlaku untuk KEDUA mode, tidak ada BA yang
  // sah dengan cutoff yang belum terjadi.
  if (input.cutoffDate > input.today) {
    return { ok: false, reason: "Cutoff BA berada di masa depan — tidak bisa direkonsiliasi." };
  }

  // Mode LAMA (tanpa startDate): cutoff wajib sebulan dengan periode terpilih.
  // Dipertahankan PERSIS supaya BA existing yang tidak punya awal periode
  // eksplisit tidak berubah perilakunya sama sekali.
  if (startDate === null) {
    const [cy, cm] = input.cutoffDate.split("-").map(Number);
    if (cy !== input.year || cm !== input.month) {
      return {
        ok: false,
        reason: `Cutoff BA (${input.cutoffDate}) tidak berada pada periode ${period} yang dipilih — kemungkinan BA salah periode, perlu ditinjau manual.`,
      };
    }
    return { ok: true, reason: null };
  }

  // Mode RENTANG BEBAS: periode BA boleh melintasi batas bulan (BA Februari
  // 2026 = 04 Feb s/d 04 Mar) atau hanya sebagian bulan (BA Juni paruh kedua =
  // 17 s/d 30 Juni). Yang menggantikan gate "sebulan dengan periode" adalah
  // JANGKAR AWAL PERIODE: startDate wajib jatuh di bulan yang dipilih. Itu
  // sesuai cara BA dinamai (BA dinamai menurut bulan MULAI-nya), dan tetap
  // menolak BA yang jauh dari periode — BA Desember tidak bisa dimasukkan ke
  // periode Februari karena startDate-nya bukan bulan Februari.
  if (!isValidIsoDate(startDate)) {
    return { ok: false, reason: "Tanggal awal periode BA tidak terbaca/tidak valid — perlu ditinjau manual sebelum finalisasi." };
  }
  if (input.cutoffDate < startDate) {
    return { ok: false, reason: `Cutoff BA (${input.cutoffDate}) mendahului awal periode (${startDate}) — rentang terbalik, perlu ditinjau manual.` };
  }
  if (startDate.slice(0, 7) !== period) {
    return {
      ok: false,
      reason: `Awal periode BA (${startDate}) tidak berada pada periode ${period} yang dipilih — kemungkinan BA salah periode, perlu ditinjau manual.`,
    };
  }
  const spanDays = Math.round((Date.parse(`${input.cutoffDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
  if (spanDays > CUTOFF_MAX_LOOKBACK_DAYS) {
    return {
      ok: false,
      reason: `Rentang BA ${startDate} s/d ${input.cutoffDate} (${spanDays} hari) melebihi batas ${CUTOFF_MAX_LOOKBACK_DAYS} hari — perlu ditinjau manual.`,
    };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Parsing periode dari teks BA (opsional, murni — TIDAK terhubung ke OCR
// otomatis apa pun di modul ini; dipakai sebagai bantuan pengisian yang tetap
// WAJIB dikonfirmasi user, bukan pengganti konfirmasi). Contoh nyata: "Stock
// Opname Periode 01 Juli 2026 s/d 16 Juli 2026" -> cutoff = AKHIR periode
// (16 Juli), BUKAN tanggal BA diterbitkan/ditandatangani (bisa beberapa hari
// setelah periode berakhir).
// ---------------------------------------------------------------------------

const ID_MONTHS: Record<string, string> = {
  januari: "01",
  februari: "02",
  maret: "03",
  april: "04",
  mei: "05",
  juni: "06",
  juli: "07",
  agustus: "08",
  september: "09",
  oktober: "10",
  november: "11",
  desember: "12",
};

export type BaPeriodParseResult = { periodStartDate: string | null; periodEndDate: string | null; status: "OK" | "PERLU_REVIEW" };

/** Ambil rentang tanggal presisi HARI dari teks BA. Tidak pernah menebak — format ambigu/tidak ditemukan -> PERLU_REVIEW. */
export function parseInventoryBaPeriodText(rawText: string): BaPeriodParseResult {
  const text = (rawText ?? "").trim();
  if (!text) return { periodStartDate: null, periodEndDate: null, status: "PERLU_REVIEW" };
  const monthNamePattern = Object.keys(ID_MONTHS).join("|");
  const connector = "(?:s\\s*/\\s*d|sampai(?:\\s+dengan)?|-|–|—)";

  // "01 Juli 2026 s/d 16 Juli 2026" (bulan/tahun ditulis di kedua sisi).
  const twoDatesPattern = new RegExp(`\\b(\\d{1,2})\\s+(${monthNamePattern})\\s+(20\\d{2})\\s*${connector}\\s*(\\d{1,2})\\s+(${monthNamePattern})\\s+(20\\d{2})\\b`, "i");
  const twoDates = text.match(twoDatesPattern);
  if (twoDates) {
    const [, d1, m1, y1, d2, m2, y2] = twoDates;
    const start = `${y1}-${ID_MONTHS[m1.toLowerCase()]}-${d1.padStart(2, "0")}`;
    const end = `${y2}-${ID_MONTHS[m2.toLowerCase()]}-${d2.padStart(2, "0")}`;
    if (isValidIsoDate(start) && isValidIsoDate(end) && start <= end) return { periodStartDate: start, periodEndDate: end, status: "OK" };
  }

  // "01 - 16 Juli 2026" (bulan/tahun ditulis sekali, berlaku untuk kedua tanggal).
  const sameMonthPattern = new RegExp(`\\b(\\d{1,2})\\s*${connector}\\s*(\\d{1,2})\\s+(${monthNamePattern})\\s+(20\\d{2})\\b`, "i");
  const sameMonth = text.match(sameMonthPattern);
  if (sameMonth) {
    const [, d1, d2, m, y] = sameMonth;
    const mm = ID_MONTHS[m.toLowerCase()];
    const start = `${y}-${mm}-${d1.padStart(2, "0")}`;
    const end = `${y}-${mm}-${d2.padStart(2, "0")}`;
    if (isValidIsoDate(start) && isValidIsoDate(end) && start <= end) return { periodStartDate: start, periodEndDate: end, status: "OK" };
  }

  return { periodStartDate: null, periodEndDate: null, status: "PERLU_REVIEW" };
}
