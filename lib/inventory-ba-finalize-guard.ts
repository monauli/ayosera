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
  | { kind: "MATCHED"; row: CatalogRow };

/**
 * Cocokkan satu baris deskripsi BA terhadap katalog. Bila lebih dari satu
 * baris katalog cocok (nama/SKU ambigu), JANGAN auto-pilih salah satu —
 * kembalikan AMBIGUOUS supaya UI menandai "Perlu Dicek", bukan menebak.
 */
export function matchBaItemToCatalog(description: string, catalog: ReadonlyArray<CatalogRow>, normalize: (value: string) => string): BaMatchResult {
  const target = normalize(description);
  const candidates = catalog.filter((row) => normalize(row.productName) === target || (row.productSku && normalize(row.productSku) === target));
  if (candidates.length === 0) return { kind: "NO_MATCH" };
  if (candidates.length > 1) return { kind: "AMBIGUOUS", candidates };
  return { kind: "MATCHED", row: candidates[0] };
}
