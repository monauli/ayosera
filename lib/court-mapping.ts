// Pemetaan court/lapangan AYO <-> Olsera untuk Modul Rekonsiliasi AYO vs
// Olsera granular (Milestone 3). MURNI (tanpa MongoDB) — sama pola dengan
// lib/reconciliation-rules.ts.
//
// DASAR KEPUTUSAN (lihat docs/reconciliation-ayo-olsera-scope.md §2 "Bukti
// Data" — bukan asumsi): suku kata setelah "COURT FEES -" pada itemName
// Olsera adalah TEKS BEBAS yang diketik kasir (dikonfirmasi lewat variantId:
// satu variantId dibuat otomatis per string unik yang pernah diketik), BUKAN
// field terstruktur. Nomor 1-4 cocok dengan 4 court Padel AYO yang nyata;
// nomor 5-9 dan placeholder (-, ., .., ...) TIDAK bisa dipetakan ke court
// tertentu. Pickleball tidak PERNAH punya suku kata bernomor sama sekali di
// Olsera — hanya bisa direkonsiliasi di level agregat sport.
import { classifyCategoryForCourtRevenue, type CourtCategoryClassification } from "./reconciliation-rules.ts";

export type Sport = "PADEL" | "PICKLEBALL";

/** 4 court Padel nyata (AYO field_name persis). Sumber kebenaran nomor court — lihat docs §2. */
export const PADEL_COURT_NUMBERS = [1, 2, 3, 4] as const;

export const PADEL_UNIDENTIFIED_BUCKET = "Padel — Nomor Tidak Teridentifikasi";
export const PICKLEBALL_AGGREGATE_BUCKET = "Pickleball (Gabungan)";

export type CourtMappingConfidence = "exact" | "ambiguous" | "unmapped";

export type CourtBucket = {
  /** Label unik dipakai sebagai key perbandingan Level 3 ("court"). */
  courtKey: string;
  sport: Sport;
  confidence: CourtMappingConfidence;
};

/** Klasifikasi sport dari AYO field_name. Semua court AYO sudah dikonfirmasi masuk salah satu dari dua pola ini (lihat docs §2 — tidak ada field_name lain di production). */
export function classifyAyoSport(fieldName: string): Sport | "UNKNOWN" {
  if (/pickleball/i.test(fieldName)) return "PICKLEBALL";
  if (/^court no \d+$/i.test(fieldName.trim())) return "PADEL";
  return "UNKNOWN";
}

/** Bucket AYO: Padel dipetakan 1:1 ke court aslinya ("Court No N"); Pickleball SELALU digabung (lihat docs §2 — AYO sendiri sempat rename field_name pickleball tanpa mengubah sport). */
export function ayoCourtBucket(fieldName: string): CourtBucket | null {
  const sport = classifyAyoSport(fieldName);
  if (sport === "UNKNOWN") return null;
  if (sport === "PICKLEBALL") return { courtKey: PICKLEBALL_AGGREGATE_BUCKET, sport, confidence: "exact" };

  const num = Number(fieldName.trim().match(/^court no (\d+)$/i)?.[1]);
  if (!PADEL_COURT_NUMBERS.includes(num as (typeof PADEL_COURT_NUMBERS)[number])) {
    // Court Padel dengan nomor di luar 1-4 belum pernah terjadi di AYO (lihat docs §2) — bila muncul, jangan dipetakan otomatis.
    return { courtKey: PADEL_UNIDENTIFIED_BUCKET, sport, confidence: "unmapped" };
  }
  return { courtKey: `Court No ${num}`, sport, confidence: "exact" };
}

/** Ekstrak nomor court dari suku kata "COURT FEES - N" HANYA bila suku kata itu murni digit (bukan placeholder "-"/"."/"..."). */
export function extractOlseraCourtNumber(itemName: string): number | null {
  const match = itemName.trim().match(/-\s*(\d+)\s*,?$/);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Bucket Olsera dari (itemName, resolvedCategoryName). `null` = baris ini
 * BUKAN omzet lapangan sama sekali (dikecualikan total, lihat
 * classifyCategoryForCourtRevenue) — pemanggil wajib membedakan `null`
 * (dikecualikan) dari confidence `"ambiguous"` (masuk hitungan sport tapi
 * tidak per-court, lihat docs §2).
 */
export function olseraCourtBucket(itemName: string, resolvedCategoryName: string | null | undefined): CourtBucket | null {
  const categorySource = resolvedCategoryName ?? itemName;
  const classification: CourtCategoryClassification = classifyCategoryForCourtRevenue(categorySource);
  if (classification !== "court") return null;

  const upperCategory = (resolvedCategoryName ?? "").toUpperCase();
  const sport: Sport | null = upperCategory.includes("PICKLEBALL")
    ? "PICKLEBALL"
    : upperCategory.includes("PADEL")
      ? "PADEL"
      : /pickleball/i.test(itemName)
        ? "PICKLEBALL"
        : /padel|court fee/i.test(itemName)
          ? "PADEL"
          : null;
  if (!sport) return { courtKey: PADEL_UNIDENTIFIED_BUCKET, sport: "PADEL", confidence: "ambiguous" };

  if (sport === "PICKLEBALL") return { courtKey: PICKLEBALL_AGGREGATE_BUCKET, sport, confidence: "exact" };

  const num = extractOlseraCourtNumber(itemName);
  if (num !== null && PADEL_COURT_NUMBERS.includes(num as (typeof PADEL_COURT_NUMBERS)[number])) {
    return { courtKey: `Court No ${num}`, sport, confidence: "exact" };
  }
  // Placeholder ("-", ".", "...") atau nomor di luar 1-4 (5-9, lihat docs §2) — tidak bisa dipetakan ke court tertentu.
  return { courtKey: PADEL_UNIDENTIFIED_BUCKET, sport, confidence: "unmapped" };
}

/** Semua courtKey yang sah untuk ditampilkan di Level 3, urutan tampil tetap. */
export function allCourtKeys(): string[] {
  return [...PADEL_COURT_NUMBERS.map((n) => `Court No ${n}`), PADEL_UNIDENTIFIED_BUCKET, PICKLEBALL_AGGREGATE_BUCKET];
}
