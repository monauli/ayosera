// Perbandingan kiri-kanan Modul Mapping — TAHAP 4. Fungsi murni, node-testable.
//
// MASALAH INTINYA adalah penjodohan baris, bukan pengurangan angka: Excel
// TIDAK punya kode akun sama sekali (lihat lib/mapping-excel-parser.ts), jadi
// satu-satunya pengait antara kedua sisi adalah label — dan labelnya kotor di
// kedua sisi. Yang benar-benar ada di fixture:
//
//   Excel "Pendapatan Courts Fees"     vs PDF "Pendapatan Court Fees"
//   Excel "Total Biaya Opersional"     vs PDF "Total Biaya Operasional"
//   Excel "Biaya Telpon/Internet"      vs PDF "Biaya Telepon / Internet"
//   Excel "LABA KOTOR"                 vs PDF "Laba Kotor"
//   Excel "PENDAPATAN BERSIH OPERASIONAL" vs PDF "Bi Pendapatan Bersih Operasional"
//
// Karena itu penjodohan dilakukan BERTINGKAT, dari paling ketat ke paling
// longgar, dan berhenti begitu ketemu. Tingkat longgarnya dibatasi keras:
// jarak edit maksimal 2 DAN maksimal 10% panjang label DAN kata pertama harus
// sama persis. Batas itu bukan angka asal — pasangan yang HARUS tetap
// terpisah di fixture ini jaraknya jauh di atasnya ("Biaya Sewa" vs "Biaya
// Gaji" = 4, "Biaya Air" vs "Biaya Gaji" = 3), sedangkan semua typo nyata di
// atas jaraknya 1.
//
// Kandidat ganda TIDAK PERNAH ditebak: kalau satu label bisa berjodoh dengan
// lebih dari satu baris, keduanya dibiarkan tidak berjodoh dan muncul sebagai
// "hanya ada di satu sisi" — pola yang sama dengan
// buildCleanedCatalogNameIndex di scripts/bootstrap-monthly-snapshot-baseline.ts.
import type { FinancialLine, MappingLineKind } from "./mapping-parser.ts";
import { rulesForReport, type MappingGroupingRule, type MappingReportKind } from "./mapping-rules.ts";

export type ComparisonStatus = "COCOK" | "BEDA" | "HANYA_EXCEL" | "HANYA_PDF";
export type MatchTier = "normalized" | "fuzzy" | null;

export type ComparisonRow = {
  /** Label yang ditampilkan; sisi Excel bila ada, selain itu sisi PDF. */
  label: string;
  excelLabel: string | null;
  pdfLabel: string | null;
  /** Kode akun hanya ada di sisi PDF. */
  code: string | null;
  kind: MappingLineKind;
  excelValue: number | null;
  pdfValue: number | null;
  /** excelValue - pdfValue, null bila salah satu sisi tidak ada. */
  difference: number | null;
  status: ComparisonStatus;
  matchedBy: MatchTier;
  /** Terisi bila baris ini hasil penerapan aturan pengelompokan. */
  rule: { note: string; parts: readonly string[]; verified: boolean } | null;
  /**
   * true bila baris hanya ada di satu sisi DAN nilainya nol. Bukan selisih:
   * PDF Olsera tidak mencetak akun yang nihil, sedangkan Excel mencetak
   * seluruh bagan akun. Dipisah supaya ringkasan tidak tenggelam oleh baris
   * nol yang tidak berarti apa-apa.
   */
  emptyOnOneSide: boolean;
};

export type ComparisonSummary = {
  cocok: number;
  beda: number;
  hanyaExcel: number;
  hanyaPdf: number;
  /** Bagian dari hanyaExcel + hanyaPdf yang nilainya nol. */
  nihilSebelah: number;
};

export type ComparisonResult = {
  rows: ComparisonRow[];
  summary: ComparisonSummary;
  /** Aturan yang BENAR-BENAR terpakai (semua bagiannya ketemu). */
  appliedRules: MappingGroupingRule[];
  /** Aturan yang dilewati karena ada bagiannya tidak ditemukan. */
  skippedRules: { rule: MappingGroupingRule; missing: string[] }[];
};

/**
 * Selisih di bawah ini bukan beda data, dalam rupiah.
 *
 * Alasannya sama persis dengan TRUNCATION_TOLERANCE_PER_LINE di
 * lib/mapping-parser.ts dan sudah terbukti di fixture: exporter PDF MEMOTONG
 * desimal di baris detail sedangkan Excel menyimpannya penuh — Februari 2026
 * mencetak "42.653" untuk nilai yang di Excel 42.653,48, dan "560.679" untuk
 * 560.679,45. Tanpa toleransi ini, 2 dari 3 baris BEDA di Februari adalah
 * artefak cetak, yang justru melatih pengguna mengabaikan status BEDA.
 *
 * Tidak ada yang disembunyikan: kolom `difference` tetap berisi 0,48 dan
 * tetap ditampilkan di UI — hanya statusnya yang tidak dinaikkan jadi BEDA.
 * Marginnya aman, nominal terkecil di fixture adalah 2.600.
 */
const EQUAL_TOLERANCE = 1;

const MAX_EDIT_DISTANCE = 2;
const MAX_EDIT_RATIO = 0.1;

/**
 * Bentuk label yang dipakai untuk menjodohkan.
 *
 * Membuang beda kapital, tanda baca, dan spasi ganda — sumber beda paling
 * umum antara kedua sisi ("Biaya Telpon/Internet" vs "Biaya Telepon /
 * Internet", "LABA KOTOR" vs "Laba Kotor").
 *
 * Token pertama sepanjang 1-2 karakter juga dibuang bila masih tersisa minimal
 * dua kata. Ini menangani artefak OCR di tepi halaman scan yang menempel di
 * depan label — nyata di fixture: "Bi Pendapatan Bersih Operasional" dan "Mm
 * Biaya Pokok Penjualan". Parser Tahap 1 sudah membuang artefak 1 karakter
 * sebelum mengelompokkan baris, tapi yang 2 karakter lolos.
 *
 * ponytail: aman selama tidak ada akun yang namanya benar-benar dimulai kata
 * 1-2 huruf. Di kedua fixture tidak ada satu pun. Kalau suatu saat ada, akun
 * itu akan gagal berjodoh dan muncul sebagai "hanya satu sisi" — terlihat,
 * bukan salah jodoh diam-diam.
 */
export function normalizeFinancialLabel(label: string): string {
  const words = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length > 2 && words[0].length <= 2) words.shift();
  return words.join(" ");
}

/** Jarak edit Levenshtein, dibatasi supaya tidak menghitung yang jelas jauh. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > MAX_EDIT_DISTANCE) return MAX_EDIT_DISTANCE + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** Dua label dianggap label yang sama walau salah ketik ringan. */
export function isNearLabel(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return false;
  const firstA = a.split(" ")[0];
  const firstB = b.split(" ")[0];
  // Kata pertama wajib sama persis: ini yang mencegah "biaya sewa" berjodoh
  // dengan "biaya gaji" lewat kelonggaran panjang label.
  if (firstA !== firstB) return false;
  const distance = editDistance(a, b);
  return distance <= MAX_EDIT_DISTANCE && distance <= Math.floor(longest * MAX_EDIT_RATIO) + 1;
}

type Side = { line: FinancialLine; normalized: string; rule: ComparisonRow["rule"] };

/** Baris yang ikut dibandingkan: yang punya nominal. Header tidak. */
function comparableSides(lines: readonly FinancialLine[]): Side[] {
  return lines
    .filter((line) => line.kind !== "header" && line.value !== null)
    .map((line) => ({ line, normalized: normalizeFinancialLabel(line.label), rule: null }));
}

/**
 * Terapkan aturan pengelompokan pada satu sisi: baris-baris `parts` diganti
 * SATU baris bernilai jumlahnya, berlabel `target`.
 *
 * Aturan yang salah satu bagiannya tidak ada DILEWATI seluruhnya (dilaporkan
 * lewat skippedRules), bukan diterapkan separuh — menjumlahkan sebagian akan
 * menghasilkan angka yang salah tanpa jejak.
 */
function applyRules(
  sides: Side[],
  rules: readonly MappingGroupingRule[],
  side: "excel" | "pdf",
): { sides: Side[]; applied: MappingGroupingRule[]; skipped: { rule: MappingGroupingRule; missing: string[] }[] } {
  let working = sides;
  const applied: MappingGroupingRule[] = [];
  const skipped: { rule: MappingGroupingRule; missing: string[] }[] = [];
  for (const rule of rules) {
    if (rule.combine !== side) continue;
    const wanted = rule.parts.map((part) => normalizeFinancialLabel(part));
    const found = wanted.map((part) => working.find((candidate) => candidate.normalized === part));
    const missing = wanted.map((part, index) => (found[index] ? null : rule.parts[index])).filter((part): part is string => part !== null);
    if (missing.length > 0) {
      skipped.push({ rule, missing });
      continue;
    }
    const parts = found as Side[];
    const total = parts.reduce((sum, part) => sum + (part.line.value ?? 0), 0);
    const anchor = parts[0];
    const merged: Side = {
      line: { ...anchor.line, label: rule.target, value: total },
      normalized: normalizeFinancialLabel(rule.target),
      rule: { note: rule.note, parts: rule.parts, verified: rule.verified },
    };
    // Baris gabungan menempati posisi bagian PERTAMA supaya urutan laporan
    // tetap terbaca wajar; bagian lainnya dibuang dari daftar.
    working = working.flatMap((candidate) => {
      if (candidate === anchor) return [merged];
      return parts.includes(candidate) ? [] : [candidate];
    });
    applied.push(rule);
  }
  return { sides: working, applied, skipped };
}

function statusOf(excelValue: number | null, pdfValue: number | null): ComparisonStatus {
  if (excelValue === null) return "HANYA_PDF";
  if (pdfValue === null) return "HANYA_EXCEL";
  return Math.abs(excelValue - pdfValue) <= EQUAL_TOLERANCE ? "COCOK" : "BEDA";
}

function toRow(excel: Side | null, pdf: Side | null, matchedBy: MatchTier): ComparisonRow {
  const excelValue = excel?.line.value ?? null;
  const pdfValue = pdf?.line.value ?? null;
  const status = statusOf(excelValue, pdfValue);
  const oneSided = status === "HANYA_EXCEL" || status === "HANYA_PDF";
  return {
    label: excel?.line.label ?? pdf?.line.label ?? "",
    excelLabel: excel?.line.label ?? null,
    pdfLabel: pdf?.line.label ?? null,
    code: pdf?.line.code ?? null,
    kind: (excel ?? pdf)!.line.kind,
    excelValue,
    pdfValue,
    difference: excelValue !== null && pdfValue !== null ? excelValue - pdfValue : null,
    status,
    matchedBy,
    rule: excel?.rule ?? pdf?.rule ?? null,
    emptyOnOneSide: oneSided && (excelValue ?? pdfValue ?? 0) === 0,
  };
}

/**
 * Jodohkan satu baris Excel ke kandidat PDF yang belum terpakai.
 *
 * Kandidat ganda dengan label sama diselesaikan lewat `kind` (subtotal vs
 * baris turunan) — perlu karena "Total Pendapatan Non Operasional" muncul DUA
 * KALI di kedua sisi: sekali sebagai subtotal section, sekali sebagai angka
 * netto. Kalau `kind` pun tidak memisahkan, tidak ada yang dijodohkan.
 */
function pickMatch(excel: Side, candidates: Side[], near: boolean): Side | null {
  const matches = candidates.filter((candidate) =>
    near ? isNearLabel(excel.normalized, candidate.normalized) : candidate.normalized === excel.normalized,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return null;
  const sameKind = matches.filter((candidate) => candidate.line.kind === excel.line.kind);
  return sameKind.length === 1 ? sameKind[0] : null;
}

/**
 * Bandingkan laporan versi Excel dengan versi PDF.
 *
 * Urutan hasil mengikuti sisi EXCEL karena Excel memuat bagan akun LENGKAP
 * (13 baris pendapatan di Februari 2026) sedangkan PDF hanya mencetak akun
 * yang ada isinya (7 baris pada periode yang sama). Baris PDF yang tidak
 * berjodoh ditambahkan di akhir supaya tidak ada yang hilang dari tampilan.
 */
export function compareFinancialReports(
  excelLines: readonly FinancialLine[],
  pdfLines: readonly FinancialLine[],
  report: MappingReportKind = "profit-loss",
): ComparisonResult {
  const rules = rulesForReport(report);
  const excelApplied = applyRules(comparableSides(excelLines), rules, "excel");
  const pdfApplied = applyRules(comparableSides(pdfLines), rules, "pdf");

  const remaining = [...pdfApplied.sides];
  const rows: ComparisonRow[] = [];
  const pending: Side[] = [];

  // Tahap ketat dulu untuk SELURUH baris, baru tahap longgar — supaya sebuah
  // label tidak keburu diambil pasangan mirip padahal ada pasangan persisnya.
  for (const excel of excelApplied.sides) {
    const match = pickMatch(excel, remaining, false);
    if (match) {
      remaining.splice(remaining.indexOf(match), 1);
      rows.push(toRow(excel, match, "normalized"));
    } else {
      pending.push(excel);
      rows.push(toRow(excel, null, null));
    }
  }
  for (const excel of pending) {
    const match = pickMatch(excel, remaining, true);
    if (!match) continue;
    remaining.splice(remaining.indexOf(match), 1);
    rows[rows.findIndex((row) => row.excelLabel === excel.line.label && row.pdfLabel === null)] = toRow(excel, match, "fuzzy");
  }
  for (const pdf of remaining) rows.push(toRow(null, pdf, null));

  const summary: ComparisonSummary = {
    cocok: rows.filter((row) => row.status === "COCOK").length,
    beda: rows.filter((row) => row.status === "BEDA").length,
    hanyaExcel: rows.filter((row) => row.status === "HANYA_EXCEL").length,
    hanyaPdf: rows.filter((row) => row.status === "HANYA_PDF").length,
    nihilSebelah: rows.filter((row) => row.emptyOnOneSide).length,
  };
  return {
    rows,
    summary,
    appliedRules: [...excelApplied.applied, ...pdfApplied.applied],
    skippedRules: [...excelApplied.skipped, ...pdfApplied.skipped],
  };
}
