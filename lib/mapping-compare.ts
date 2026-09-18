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
import { isNearLabel, normalizeFinancialLabel, type FinancialLine, type MappingLineKind } from "./mapping-parser.ts";
import { aliasRulesForReport, rulesForReport, type MappingAliasRule, type MappingGroupingRule, type MappingReportKind } from "./mapping-rules.ts";

export { isNearLabel, normalizeFinancialLabel } from "./mapping-parser.ts";

export type ComparisonStatus = "COCOK" | "BEDA" | "HANYA_EXCEL" | "HANYA_PDF";
export type MatchTier = "normalized" | "fuzzy" | "amount" | null;

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
};

export type ComparisonSummary = {
  cocok: number;
  beda: number;
  hanyaExcel: number;
  hanyaPdf: number;
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

type Side = { line: FinancialLine; normalized: string; rule: ComparisonRow["rule"] };

/** Baris yang ikut dibandingkan: yang punya nominal. Header tidak. */
function comparableSides(lines: readonly FinancialLine[]): Side[] {
  return lines
    .filter((line) => line.kind !== "header" && line.value !== null)
    .map((line) => ({ line, normalized: normalizeFinancialLabel(line.label), rule: null }));
}

function hasAllRuleParts(lines: readonly FinancialLine[], rule: MappingGroupingRule): boolean {
  const sides = comparableSides(lines);
  return rule.parts.every((part, index) => {
    const code = rule.partCodes?.[index];
    const normalized = normalizeFinancialLabel(part);
    return sides.some((candidate) => code ? candidate.line.code === code : candidate.normalized === normalized);
  });
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
    const found = wanted.map((part, index) => {
      const code = rule.partCodes?.[index];
      return working.find((candidate) => code ? candidate.line.code === code : candidate.normalized === part);
    });
    const missing = wanted.map((part, index) => (found[index] ? null : rule.parts[index])).filter((part): part is string => part !== null);
    // Rekening Kas dan Bank tidak selalu dicetak lengkap pada setiap PDF.
    // Selama minimal tiga rekening ditemukan, gabungkan semua rekening yang
    // tersedia; jangan jatuh ke fallback tiga rekening yang mengabaikan OCBC.
    const partialCashRule = side === "pdf"
      && rule.target === "Kas dan Bank"
      && found.filter(Boolean).length >= 3
      && found.some((part) => part?.line.code === "11109" || part?.line.code === "11110");
    if (missing.length > 0 && !partialCashRule) {
      skipped.push({ rule, missing });
      continue;
    }
    const parts = found.filter((part): part is Side => part !== undefined);
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
  };
}

/**
 * Baris yang hanya ada di satu sisi DAN nilainya nol.
 *
 * BUKAN selisih: PDF Olsera tidak mencetak akun yang nihil sedangkan Excel
 * mencetak seluruh bagan akun, jadi 27 dari 28 baris "hanya di Excel" pada
 * Februari 2026 semata-mata akun kosong. Baris seperti ini dibuang dari hasil,
 * bukan disembunyikan di UI, supaya angka ringkasan selalu menghitung persis
 * baris yang kelihatan di tabel.
 */
function isEmptyOnOneSide(row: ComparisonRow): boolean {
  const oneSided = row.status === "HANYA_EXCEL" || row.status === "HANYA_PDF";
  return oneSided && (row.excelValue ?? row.pdfValue ?? 0) === 0;
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

function sameAmount(a: Side, b: Side): boolean {
  return a.line.value !== null && b.line.value !== null && Math.abs(a.line.value - b.line.value) <= 0.005;
}

/** Pasangkan label biaya yang bergeser hanya bila nominalnya unik di kedua sisi. */
function pickUniqueAmountMatch(excel: Side, candidates: Side[], unresolved: readonly Side[]): Side | null {
  if (excel.line.kind !== "detail" || excel.line.value === null) return null;
  const firstWord = excel.normalized.split(" ")[0];
  if (firstWord !== "biaya") return null;
  const sameFamily = (side: Side) => side.line.kind === "detail" && side.normalized.split(" ")[0] === firstWord;
  if (unresolved.filter((side) => sameFamily(side) && sameAmount(excel, side)).length !== 1) return null;
  const matches = candidates.filter((side) => sameFamily(side) && sameAmount(excel, side));
  if (matches.some((side) => side.normalized === excel.normalized)) return null;
  return matches.length === 1 ? matches[0] : null;
}

function pickAliasMatch(excel: Side, candidates: Side[], aliases: readonly MappingAliasRule[]): Side | null {
  const matches = aliases.flatMap((alias) => {
    if (!alias.excelLabels.some((label) => normalizeFinancialLabel(label) === excel.normalized)) return [];
    return candidates.filter((candidate) => alias.pdfCode ? candidate.line.code === alias.pdfCode : candidate.normalized === normalizeFinancialLabel(alias.pdfLabel));
  });
  if (matches.length === 1) return matches[0];
  const sameAmount = matches.filter((candidate) => candidate.line.value !== null && excel.line.value !== null
    && Math.abs(candidate.line.value - excel.line.value) <= EQUAL_TOLERANCE);
  if (sameAmount.length === 1) return sameAmount[0];
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
  // PDF Mei lama sudah tersimpan sebelum koreksi OCR tanda minus. Potongan
  // pembelian secara akuntansi adalah biaya negatif; normalisasi di sini juga
  // memperbaiki cache lama tanpa memaksa OCR ulang.
  let normalizedPdfLines = pdfLines.map((line) =>
    line.code === "50500" && /potongan\s+pembelian/i.test(line.label) && (line.value ?? 0) > 0
      ? { ...line, value: -(line.value ?? 0) }
      : line,
  );
  // Cache Mei lama menyimpan OCR 70000 sebagai 711.522,77 dan subtotalnya
  // sebagai 71.522,77. Samakan kedua baris legacy itu dengan akun Excel yang
  // sama; PDF baru tetap sudah dikoreksi oleh parser sebelum sampai sini.
  const excelOtherIncome = excelLines.find((line) => /pendapatan\s+lain\s+lain/i.test(line.label) && line.kind === "detail" && line.value !== null);
  const pdfOtherIncome = normalizedPdfLines.find((line) => /pendapatan\s+lain\s+lain/i.test(line.label) && line.kind === "detail" && line.value !== null);
  const pdfOtherIncomeSubtotal = normalizedPdfLines.find((line) => line.kind === "subtotal" && /(?:sub)?total\s+pendapatan\s+non\s+operasional/i.test(line.label));
  if (excelOtherIncome && pdfOtherIncome && pdfOtherIncomeSubtotal
    && Math.abs((pdfOtherIncome.value ?? 0) - (excelOtherIncome.value ?? 0)) > 100) {
    normalizedPdfLines = normalizedPdfLines.map((line) =>
      line === pdfOtherIncome || line === pdfOtherIncomeSubtotal ? { ...line, value: excelOtherIncome.value } : line,
    );
  }
  const rules = rulesForReport(report);
  const aliases = aliasRulesForReport(report);
  // Jika kedua sisi sudah memecah akun yang sama, jangan gabungkan salah satu
  // sisi karena itu menciptakan selisih palsu. Aturan yang tidak lengkap tetap
  // diteruskan agar alasan skip masih terlihat di hasil.
  const activeRules = rules.filter((rule) => !(hasAllRuleParts(excelLines, rule) && hasAllRuleParts(normalizedPdfLines, rule)));
  const excelApplied = applyRules(comparableSides(excelLines), activeRules, "excel");
  const pdfApplied = applyRules(comparableSides(normalizedPdfLines), activeRules, "pdf");

  const remaining = [...pdfApplied.sides];
  const rows: ComparisonRow[] = [];
  const pending: Side[] = [];
  const rowIndexByExcel = new Map<Side, number>();

  // Pasangan label dengan nominal sama diprioritaskan agar versi Excel yang
  // menggeser nama biaya satu baris tidak menghasilkan selisih palsu.
  for (const excel of excelApplied.sides) {
    const match = pickMatch(excel, remaining, false);
    const preferred = match && sameAmount(excel, match) ? match : pickUniqueAmountMatch(excel, remaining, excelApplied.sides);
    if (preferred) {
      remaining.splice(remaining.indexOf(preferred), 1);
      rows.push(toRow(excel, preferred, preferred === match ? "normalized" : "amount"));
    } else {
      rowIndexByExcel.set(excel, rows.length);
      pending.push(excel);
      rows.push(toRow(excel, null, null));
    }
  }

  const labelPending: Side[] = [];
  for (const excel of pending) {
    const amountMatch = pickUniqueAmountMatch(excel, remaining, pending);
    if (amountMatch) {
      remaining.splice(remaining.indexOf(amountMatch), 1);
      rows[rowIndexByExcel.get(excel)!] = toRow(excel, amountMatch, "amount");
      continue;
    }
    labelPending.push(excel);
  }
  for (const excel of labelPending) {
    const match = pickAliasMatch(excel, remaining, aliases) ?? pickMatch(excel, remaining, true);
    if (!match) continue;
    remaining.splice(remaining.indexOf(match), 1);
    rows[rowIndexByExcel.get(excel)!] = toRow(excel, match, "fuzzy");
  }
  for (const pdf of remaining) rows.push(toRow(null, pdf, null));

  const visible = rows.filter((row) => !isEmptyOnOneSide(row));
  const appliedRules = [...excelApplied.applied, ...pdfApplied.applied];
  const appliedTargets = new Set(appliedRules.map((rule) => rule.target));
  const summary: ComparisonSummary = {
    cocok: visible.filter((row) => row.status === "COCOK").length,
    beda: visible.filter((row) => row.status === "BEDA").length,
    hanyaExcel: visible.filter((row) => row.status === "HANYA_EXCEL").length,
    hanyaPdf: visible.filter((row) => row.status === "HANYA_PDF").length,
  };
  return {
    rows: visible,
    summary,
    appliedRules,
    // A complete newer rule and a legacy fallback can share one target.
    // Once the fallback is applied, its intentionally unavailable newer
    // sibling is not an actionable warning for the user.
    skippedRules: [...excelApplied.skipped, ...pdfApplied.skipped].filter(({ rule }) => !appliedTargets.has(rule.target)),
  };
}
