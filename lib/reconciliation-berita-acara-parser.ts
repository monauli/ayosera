// Parser MURNI (tanpa I/O) untuk hasil ekstraksi teks Berita Acara
// rekonsiliasi omzet (lihat lib/reconciliation-berita-acara-ocr.ts untuk
// ekstraksi teks dari PDF/JPG/PNG). Bertugas mendeteksi:
//   (A) nominal Rupiah (mis. "Rp740.000" -> 740000)
//   (B) arah penyesuaian: PENAMBAHAN / PENGURANGAN
//   (C) alasan singkat, DIAMBIL dari teks dokumen — tidak pernah dikarang.
// Jika sinyal ambigu/tidak ditemukan/OCR confidence rendah -> status
// PERLU_REVIEW, BUKAN tebakan.
import "server-only";

export type BeritaAcaraDirection = "PENAMBAHAN" | "PENGURANGAN";
export type BeritaAcaraParseStatus = "OK" | "PERLU_REVIEW";

export type BeritaAcaraParseResult = {
  nominal: number | null;
  direction: BeritaAcaraDirection | null;
  reason: string | null;
  status: BeritaAcaraParseStatus;
  rawText: string;
};

/** Confidence OCR di bawah ini dianggap tidak cukup andal untuk auto-fill. */
export const MIN_OCR_CONFIDENCE = 0.6;

/**
 * Normalisasi nominal Rupiah format Indonesia: "Rp740.000", "Rp 740.000,00",
 * "740000" -> 740000 (integer). "." adalah pemisah ribuan, "," adalah
 * pemisah desimal (dibuang, BA berita acara selalu bulat Rupiah).
 * Mengembalikan null bila tidak bisa diparse dengan yakin.
 */
export function parseIndonesianRupiah(raw: string): number | null {
  let s = raw.trim().replace(/^Rp\.?\s*/i, "");
  if (!s) return null;
  // Buang bagian desimal (mis. ",00") sebelum menghapus pemisah ribuan.
  s = s.replace(/,\d{1,2}$/, "");
  // Hapus semua pemisah ribuan "." dan spasi yang tersisa.
  s = s.replace(/[.\s]/g, "");
  // Jika masih ada koma (kasus format Barat "740,000"), perlakukan sebagai pemisah ribuan.
  s = s.replace(/,/g, "");
  if (!/^\d+$/.test(s)) return null;
  const value = Number(s);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

const NOMINAL_PATTERN = /Rp\.?\s*[\d.,]+/gi;
const PENAMBAHAN_PATTERN = /\b(penambahan|ditambahkan|menambah(?:kan)?|tambah(?:an)?)\b/i;
const PENGURANGAN_PATTERN = /\b(pengurangan|dikurangkan|mengurangi|kurang(?:i|an)?)\b/i;
const REASON_FIELD_PATTERN = /(?:alasan|keterangan)\s*[:\-]\s*(.+)/i;

function firstLineContaining(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const nextNewline = text.indexOf("\n", index);
  const end = nextNewline === -1 ? text.length : nextNewline;
  return text.slice(start, end).trim();
}

/** Cari nominal terbesar/paling meyakinkan dalam teks (biasanya nominal utama BA). */
function extractNominal(text: string): { nominal: number | null; matchIndex: number | null } {
  const matches = [...text.matchAll(NOMINAL_PATTERN)];
  if (matches.length === 0) return { nominal: null, matchIndex: null };
  const parsed = matches
    .map((m) => ({ value: parseIndonesianRupiah(m[0]), index: m.index ?? 0 }))
    .filter((m): m is { value: number; index: number } => m.value !== null);
  if (parsed.length === 0) return { nominal: null, matchIndex: null };
  // Ambil yang muncul lebih dulu — BA rekonsiliasi biasanya menyatakan
  // nominal utama di kalimat pembuka, bukan angka pendukung di akhir.
  const chosen = parsed[0];
  return { nominal: chosen.value, matchIndex: chosen.index };
}

function extractDirection(text: string): BeritaAcaraDirection | null {
  const hasPenambahan = PENAMBAHAN_PATTERN.test(text);
  const hasPengurangan = PENGURANGAN_PATTERN.test(text);
  if (hasPenambahan && hasPengurangan) return null; // ambigu, dua-duanya disebut
  if (hasPenambahan) return "PENAMBAHAN";
  if (hasPengurangan) return "PENGURANGAN";
  return null;
}

function extractReason(text: string, nominalIndex: number | null): string | null {
  const explicit = text.match(REASON_FIELD_PATTERN);
  if (explicit?.[1]) {
    const reason = explicit[1].split(/\r?\n/)[0].trim().replace(/[.;]+$/, "");
    if (reason) return reason;
  }
  if (nominalIndex !== null) {
    const line = firstLineContaining(text, nominalIndex);
    if (line) return line;
  }
  return null;
}

/**
 * Parse teks hasil ekstraksi (PDF text layer atau OCR) menjadi field
 * terstruktur. `ocrConfidence` opsional (0..1) — bila diisi dan di bawah
 * MIN_OCR_CONFIDENCE, status dipaksa PERLU_REVIEW walau field lain terbaca.
 */
export function parseBeritaAcaraText(rawText: string, ocrConfidence?: number | null): BeritaAcaraParseResult {
  const text = rawText ?? "";
  const { nominal, matchIndex } = extractNominal(text);
  const direction = extractDirection(text);
  const reason = extractReason(text, matchIndex);
  const lowConfidence = typeof ocrConfidence === "number" && ocrConfidence < MIN_OCR_CONFIDENCE;
  const status: BeritaAcaraParseStatus = nominal !== null && direction !== null && reason !== null && !lowConfidence ? "OK" : "PERLU_REVIEW";
  return { nominal, direction, reason, status, rawText: text };
}

// ---------------------------------------------------------------------------
// Pencocokan BA vs selisih sistem (Langkah 4)
// ---------------------------------------------------------------------------

export type BeritaAcaraMatchStatus = "COCOK" | "TIDAK_COCOK" | "PERLU_REVIEW";

export const BA_MATCH_TOLERANCE_RUPIAH = 1;

/**
 * Cocokkan selisih sistem (olseraRevenue - ayoRevenue, tanda dipertahankan)
 * dengan nominal+arah Berita Acara. Toleransi maksimal Rp1. Arah HARUS
 * sesuai tanda:
 *  - PENAMBAHAN: BA menyatakan sistem harus DITAMBAH -> berlaku saat
 *    systemDifference > 0, BA nominal ≈ +systemDifference.
 *  - PENGURANGAN: BA menyatakan sistem harus DIKURANGI -> berlaku saat
 *    systemDifference < 0, BA nominal (angka positif) ≈ -systemDifference.
 * TIDAK PERNAH membandingkan nilai absolut saja tanpa memeriksa arah.
 */
export function matchBeritaAcaraToSystemDifference(
  systemDifference: number,
  ba: { nominal: number | null; direction: BeritaAcaraDirection | null },
): BeritaAcaraMatchStatus {
  if (ba.nominal === null || ba.direction === null) return "PERLU_REVIEW";
  if (ba.direction === "PENAMBAHAN") {
    if (systemDifference <= 0) return "TIDAK_COCOK"; // arah salah
    return Math.abs(ba.nominal - systemDifference) <= BA_MATCH_TOLERANCE_RUPIAH ? "COCOK" : "TIDAK_COCOK";
  }
  // PENGURANGAN
  if (systemDifference >= 0) return "TIDAK_COCOK"; // arah salah
  return Math.abs(ba.nominal - -systemDifference) <= BA_MATCH_TOLERANCE_RUPIAH ? "COCOK" : "TIDAK_COCOK";
}
