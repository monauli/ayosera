// Parser MURNI (tanpa I/O) untuk hasil ekstraksi teks Berita Acara
// rekonsiliasi omzet (lihat lib/reconciliation-berita-acara-ocr.ts untuk
// ekstraksi teks dari PDF/JPG/PNG). Bertugas mendeteksi:
//   (A) nominal Rupiah (mis. "Rp740.000" -> 740000)
//   (B) arah penyesuaian: PENAMBAHAN / PENGURANGAN
//   (C) alasan singkat, DIAMBIL dari teks dokumen — tidak pernah dikarang.
// Jika sinyal ambigu/tidak ditemukan/OCR confidence rendah -> status
// PERLU_REVIEW, BUKAN tebakan.
//
// CATATAN: modul ini SENGAJA tidak ditandai "server-only" — dipakai baik di
// server (lib/reconciliation-berita-acara-ocr.ts, API route analyze) maupun
// di BROWSER (lib/reconciliation-berita-acara-client-ocr.ts, untuk PDF hasil
// scan yang di-OCR di sisi klien). Modul ini murni fungsi (tanpa I/O), jadi
// aman dijalankan di kedua lingkungan — tetap SATU-SATUNYA sumber kebenaran
// parsing, jangan digandakan/di-fork di sisi klien.

export type BeritaAcaraDirection = "PENAMBAHAN" | "PENGURANGAN";
export type BeritaAcaraParseStatus = "OK" | "PERLU_REVIEW";

export type BeritaAcaraParseResult = {
  nominal: number | null;
  direction: BeritaAcaraDirection | null;
  period: string | null;
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

/** Bersihkan artefak spasi/baris OCR (spasi ganda, baris terpotong) tanpa mengubah kata. */
function cleanOcrWhitespace(s: string): string {
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/(?:\/\s*4\s*\||\|\s*4\s*\/)/g, " ")
    .replace(/\b(?:halaman|page|hlm\.?)\s*\d+(?:\s*dari\s*\d+)?\b/gi, " ")
    .replace(/\b(?:row|baris|tabel)\s*\d+\b/gi, " ")
    .replace(/[|]+/g, " ")
    .trim();
}

const MONTHS: Record<string, string> = { januari: "01", februari: "02", maret: "03", april: "04", mei: "05", juni: "06", juli: "07", agustus: "08", september: "09", oktober: "10", november: "11", desember: "12" };
function extractPeriod(text: string): string | null {
  const numeric = text.match(/\b(20\d{2})[-\/]?(0[1-9]|1[0-2])\b/);
  if (numeric) return `${numeric[1]}-${numeric[2]}`;
  const named = text.match(new RegExp(`\\b(${Object.keys(MONTHS).join("|")})\\s+(20\\d{2})\\b`, "i"));
  return named ? `${named[2]}-${MONTHS[named[1].toLowerCase()]}` : null;
}

/**
 * Cari kalimat/paragraf di sekitar `index` (biasanya posisi nominal) yang
 * menjelaskan penyesuaian — bukan cuma satu baris pendek, karena OCR/PDF
 * sering membungkus kalimat panjang jadi banyak baris pendek. Batas kalimat
 * dicari via tanda titik/titik-koma/baris-baru terdekat sebelum & sesudah
 * index; TIDAK PERNAH menambah kata yang tidak ada di teks sumber.
 */
// Batas kalimat/paragraf: "." atau ";" yang TIDAK diikuti digit (supaya
// tidak salah potong di dalam nominal seperti "Rp500.000"), atau baris
// kosong (ganti paragraf). Baris baru TUNGGAL bukan batas — dokumen/OCR
// sering membungkus satu kalimat jadi beberapa baris pendek berturutan.
const SENTENCE_BOUNDARY_PATTERN = /[.;](?!\d)|\n{2,}/g;

function sentenceContaining(text: string, index: number): string {
  const before = text.slice(0, index);
  const boundaries = [...before.matchAll(SENTENCE_BOUNDARY_PATTERN)];
  const lastBoundary = boundaries.at(-1);
  const start = lastBoundary ? (lastBoundary.index ?? 0) + 1 : 0;
  const after = text.slice(index);
  const afterBoundary = [...after.matchAll(SENTENCE_BOUNDARY_PATTERN)][0];
  const end = afterBoundary ? index + (afterBoundary.index ?? 0) + 1 : text.length;
  return text.slice(start, end);
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
  if (explicit?.[1] && explicit.index !== undefined) {
    // Ambil sampai paragraf berakhir (baris kosong berikutnya), bukan hanya
    // baris pertama — dokumen/OCR sering membungkus kalimat panjang jadi
    // beberapa baris pendek berturutan setelah label "Alasan:"/"Keterangan:".
    const labelEnd = explicit.index + explicit[0].indexOf(explicit[1]);
    const paragraphEnd = text.indexOf("\n\n", labelEnd);
    const block = paragraphEnd === -1 ? text.slice(labelEnd) : text.slice(labelEnd, paragraphEnd);
    const reason = cleanOcrWhitespace(block).replace(/[.;]+$/, "").trim();
    if (reason) return reason;
  }
  if (nominalIndex !== null) {
    // Tidak ada label eksplisit: ambil kalimat/paragraf di sekitar nominal
    // yang menjelaskan penambahan/pengurangan (verbatim dari sumber, hanya
    // dibersihkan artefak spasi OCR — tidak pernah dikarang).
    const sentence = cleanOcrWhitespace(sentenceContaining(text, nominalIndex)).replace(/[.;]+$/, "").trim();
    if (sentence) return sentence;
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
  const period = extractPeriod(text);
  const reason = extractReason(text, matchIndex);
  const lowConfidence = typeof ocrConfidence === "number" && ocrConfidence < MIN_OCR_CONFIDENCE;
  const status: BeritaAcaraParseStatus = nominal !== null && direction !== null && reason !== null && !lowConfidence ? "OK" : "PERLU_REVIEW";
  return { nominal, direction, period, reason, status, rawText: text };
}

// ---------------------------------------------------------------------------
// Pencocokan BA vs selisih sistem (Langkah 4)
// ---------------------------------------------------------------------------

export type BeritaAcaraMatchStatus = "COCOK" | "TIDAK_COCOK" | "PERLU_REVIEW" | "SALAH_PERIODE";

import { RECONCILIATION_TOLERANCE_RUPIAH, isWithinReconciliationTolerance } from "./reconciliation-tolerance";
export const BA_MATCH_TOLERANCE_RUPIAH = RECONCILIATION_TOLERANCE_RUPIAH;

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
  ba: { nominal: number | null; direction: BeritaAcaraDirection | null; period?: string | null },
  expectedPeriod?: string,
): BeritaAcaraMatchStatus {
  if (expectedPeriod && !ba.period) return "PERLU_REVIEW";
  if (expectedPeriod && ba.period && ba.period !== expectedPeriod) return "SALAH_PERIODE";
  if (ba.nominal === null || ba.direction === null) return "PERLU_REVIEW";
  if (ba.direction === "PENAMBAHAN") {
    if (systemDifference <= 0) return "TIDAK_COCOK"; // arah salah
    return isWithinReconciliationTolerance(ba.nominal - systemDifference) ? "COCOK" : "TIDAK_COCOK";
  }
  // PENGURANGAN
  if (systemDifference >= 0) return "TIDAK_COCOK"; // arah salah
  return isWithinReconciliationTolerance(ba.nominal - -systemDifference) ? "COCOK" : "TIDAK_COCOK";
}
