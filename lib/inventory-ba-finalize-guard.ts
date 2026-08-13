// Rule murni (tanpa DOM/React/MongoDB) untuk mencegah bug produksi: BA PDF
// berhasil diupload tapi parser menghasilkan 0 item -> UI TIDAK BOLEH
// mengasumsikan seluruh katalog "cocok" (BA_OMITTED_ASSUMED_MATCH) karena itu
// membuat tombol Finalisasi terlihat aman padahal BA belum benar-benar
// terbaca. BA_OMITTED_ASSUMED_MATCH HANYA boleh aktif setelah minimal SATU
// baris berhasil diparse DARI BA itu sendiri (bukan sekadar checkbox
// baOnlyDifferencesConfirmed dicentang).

export const BA_UNREAD_MESSAGE = "Item pada Berita Acara belum berhasil dibaca. Periksa file atau isi secara manual.";

export type BaParseOutcome = {
  /** true bila upload+ekstraksi teks berhasil (tidak melempar) sebelum parsing item dijalankan. */
  uploadSucceeded: boolean;
  /** jumlah baris item yang berhasil diparse dari BA (0 = bug/format tidak terbaca). */
  itemsFound: number;
};

/** true bila BA sudah berhasil diupload TAPI parser gagal menghasilkan baris apa pun -> harus diblok, bukan diasumsikan cocok. */
export function isBaParseUnread(outcome: BaParseOutcome): boolean {
  return outcome.uploadSucceeded && outcome.itemsFound === 0;
}

/**
 * BA_OMITTED_ASSUMED_MATCH (produk katalog yang TIDAK muncul di BA dianggap
 * cocok/tidak ada selisih) HANYA boleh aktif ketika:
 * 1. User sudah mencentang konfirmasi "BA hanya memuat item yang selisih" (flow existing, TIDAK diubah).
 * 2. Minimal satu baris BERHASIL diparse dari BA (mencegah 0-row silently mengunci seluruh katalog).
 */
export function canApplyBaOmittedAssumedMatch(input: { baOnlyDifferencesConfirmed: boolean; itemsFound: number }): boolean {
  return input.baOnlyDifferencesConfirmed && input.itemsFound > 0;
}

/** Finalisasi WAJIB diblok bila BA sudah upload tapi 0 item terbaca — status "Perlu Dicek", bukan lolos diam-diam. */
export function shouldBlockFinalizeForUnreadBa(outcome: BaParseOutcome): boolean {
  return isBaParseUnread(outcome);
}

export type CatalogRow = { productId: number; variantId: number | null; productName: string; productSku?: string | null };

export type BaMatchResult =
  | { kind: "NO_MATCH" }
  | { kind: "AMBIGUOUS"; candidates: CatalogRow[] }
  | { kind: "MATCHED"; row: CatalogRow; via: "sku" | "exact-name" | "fuzzy" };

// Ambang confidence untuk fuzzy match (tier terakhir, hanya dipakai bila SKU
// dan nama exact TIDAK menemukan apa pun). Dice coefficient token-based:
// 2*|irisan token|/(|token A|+|token B|). Threshold 0.85 dipilih supaya
// pasangan nama yang HANYA beda satu kata varian pendek (mis. "ODEA RED" vs
// "ODEA ROSE", token irisan {ODEA}=1 dari total 2+2 token -> Dice 0.5) TIDAK
// PERNAH lolos sebagai fuzzy match — jauh di bawah threshold. Fuzzy hanya
// menembus untuk variasi kecil seperti spasi/singkatan berlebih pada nama
// yang sama persis secara token, bukan produk yang benar-benar berbeda.
export const BA_FUZZY_MATCH_THRESHOLD = 0.85;

function tokenSet(value: string, normalize: (value: string) => string): string[] {
  return normalize(value).split(" ").filter(Boolean);
}

function diceCoefficient(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bCount = new Map<string, number>();
  for (const t of b) bCount.set(t, (bCount.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of a) {
    const remaining = bCount.get(t) ?? 0;
    if (remaining > 0) {
      overlap++;
      bCount.set(t, remaining - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length);
}

/**
 * Cocokkan satu baris deskripsi BA terhadap katalog, urutan prioritas:
 * 1. SKU (bila BA menyertakan SKU pada deskripsi/kolom terpisah dan cocok persis).
 * 2. Nama ternormalisasi (exact match).
 * 3. (Alias) — tidak ada tabel alias produk<->BA generik di codebase saat ini
 *    (grep "alias" hanya menemukan alias identitas order-item historis di
 *    lib/historical-order-item-identity.ts, domain berbeda); bila tabel
 *    semacam itu ditambahkan untuk BA di masa depan, sisipkan di sini SEBELUM
 *    fuzzy, bukan menggantikan exact match.
 * 4. Fuzzy (token Dice coefficient) HANYA bila skor >= BA_FUZZY_MATCH_THRESHOLD
 *    dan hasilnya TUNGGAL (tidak ambigu di antara kandidat fuzzy lain).
 * Bila lebih dari satu baris katalog cocok pada tier manapun (nama/SKU
 * ambigu), JANGAN auto-pilih salah satu — kembalikan AMBIGUOUS supaya UI
 * menandai "Perlu Dicek", bukan menebak.
 */
export function matchBaItemToCatalog(description: string, catalog: ReadonlyArray<CatalogRow>, normalize: (value: string) => string): BaMatchResult {
  const target = normalize(description);
  const skuCandidates = catalog.filter((row) => row.productSku && normalize(row.productSku) === target);
  if (skuCandidates.length === 1) return { kind: "MATCHED", row: skuCandidates[0], via: "sku" };
  if (skuCandidates.length > 1) return { kind: "AMBIGUOUS", candidates: skuCandidates };

  const nameCandidates = catalog.filter((row) => normalize(row.productName) === target);
  if (nameCandidates.length === 1) return { kind: "MATCHED", row: nameCandidates[0], via: "exact-name" };
  if (nameCandidates.length > 1) return { kind: "AMBIGUOUS", candidates: nameCandidates };

  const targetTokens = tokenSet(description, normalize);
  const scored = catalog
    .map((row) => ({ row, score: diceCoefficient(targetTokens, tokenSet(row.productName, normalize)) }))
    .filter((entry) => entry.score >= BA_FUZZY_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 1) return { kind: "MATCHED", row: scored[0].row, via: "fuzzy" };
  if (scored.length > 1) {
    // Skor teratas jauh lebih tinggi dari runner-up -> tetap dianggap tunggal (bukan ambigu semu akibat kandidat lemah ikut lolos threshold).
    if (scored[0].score - scored[1].score >= 0.1) return { kind: "MATCHED", row: scored[0].row, via: "fuzzy" };
    return { kind: "AMBIGUOUS", candidates: scored.map((s) => s.row) };
  }
  return { kind: "NO_MATCH" };
}

export type BaRowStatus = "COCOK" | "PERLU_DICEK" | "TIDAK_DITEMUKAN";

export type BaRowEvaluation = {
  status: BaRowStatus;
  matchedProduct: CatalogRow | null;
  matchedVia: "sku" | "exact-name" | "fuzzy" | null;
  reasons: string[];
};

export type BaRowInput = {
  description: string;
  systemQty: number | null;
  physicalQty: number | null;
  differenceQty: number | null;
  /** status arithmetic dari parser sendiri: fisik - sistem === selisih tercetak (CEK A). */
  arithmeticStatus: InventoryBaParseStatusLike;
};

type InventoryBaParseStatusLike = "OK" | "PERLU_DICEK";

/**
 * Evaluasi SATU baris BA terhadap katalog AYOSERA, menerapkan dua pengecekan
 * selisih (CEK A: aritmetika cetak BA sendiri, sudah dihitung parser; CEK B:
 * Stok Sistem BA vs stok sistem AYOSERA sendiri pada cutoff) plus matching.
 * TIDAK PERNAH menulis ulang angka BA supaya "cocok" secara paksa.
 */
export function evaluateBaRow(item: BaRowInput, catalog: ReadonlyArray<CatalogRow>, normalize: (value: string) => string, systemStockAtCutoff: number | null): BaRowEvaluation {
  const reasons: string[] = [];
  if (item.arithmeticStatus !== "OK") reasons.push("Selisih tercetak pada BA tidak konsisten dengan Stok Fisik − Stok Sistem.");

  const match = matchBaItemToCatalog(item.description, catalog, normalize);
  if (match.kind === "NO_MATCH") {
    return { status: "TIDAK_DITEMUKAN", matchedProduct: null, matchedVia: null, reasons: [...reasons, "Tidak ditemukan produk AYOSERA yang cocok."] };
  }
  if (match.kind === "AMBIGUOUS") {
    return { status: "PERLU_DICEK", matchedProduct: null, matchedVia: null, reasons: [...reasons, `Nama ambigu, cocok dengan ${match.candidates.length} produk katalog.`] };
  }

  if (systemStockAtCutoff !== null && item.systemQty !== null && systemStockAtCutoff !== item.systemQty) {
    reasons.push(`Stok Sistem BA (${item.systemQty}) berbeda dari stok sistem AYOSERA pada cutoff (${systemStockAtCutoff}).`);
  }

  if (reasons.length > 0) return { status: "PERLU_DICEK", matchedProduct: match.row, matchedVia: match.via, reasons };
  return { status: "COCOK", matchedProduct: match.row, matchedVia: match.via, reasons: [] };
}

/** Finalisasi WAJIB diblok bila ADA baris BA berstatus PERLU_DICEK atau TIDAK_DITEMUKAN. */
export function shouldBlockFinalizeForBaRows(evaluations: ReadonlyArray<{ status: BaRowStatus }>): boolean {
  return evaluations.some((e) => e.status !== "COCOK");
}

/** true bila `date` (ISO yyyy-mm-dd) berada di dalam [periodStart, periodEnd] inklusif. Perbandingan string ISO valid secara leksikografis. */
export function isDateWithinPeriod(date: string | null, periodStart: string | null, periodEnd: string | null): boolean {
  if (!date || !periodStart || !periodEnd) return false;
  return date >= periodStart && date <= periodEnd;
}
