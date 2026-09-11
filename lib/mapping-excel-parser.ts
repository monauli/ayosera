// Parser laporan keuangan Excel — TAHAP 2 modul Mapping.
//
// Keluarannya SENGAJA sejajar dengan parser PDF (lib/mapping-parser.ts):
// FinancialLine yang sama (code / label / value / kind), pengaman aritmatika
// yang sama persis lewat reconcileSubtotals() dan reconcileNetProfitChain()
// yang diimpor dari sana — bukan disalin. Tahap 4 tinggal membandingkan dua
// daftar FinancialLine tanpa menerjemahkan bentuk dulu.
//
// Beda struktural yang nyata dengan sisi PDF, dan konsekuensinya:
//
//   PDF                              | Excel
//   kode akun 4-6 digit per baris    | TIDAK ADA kode akun sama sekali
//   detail dikenali dari kode akun   | detail dikenali dari TIDAK tebal
//   satu laporan per berkas/bundel   | 3 laporan, satu per sheet
//   satu periode                     | satu kolom per bulan
//
// Karena Excel tidak punya kode akun, `code` selalu null di sini — pencocokan
// baris di Tahap 4 harus lewat label, bukan kode.
//
// TIDAK ditangani di sini (sengaja, itu urusan Tahap 4): beda pengelompokan
// yang SAH antara Excel dan PDF, mis. "Penjualan" di PDF = "Penjualan" +
// "Pendapatan Sewa Raket Padel" di Excel. Parser ini mengeluarkan baris APA
// ADANYA seperti tercetak di sheet.
import {
  FINAL_TOLERANCE,
  isSubtotalLabel,
  reconcileNetProfitChain,
  reconcileSubtotals,
  type FinancialLine,
  type ReconciliationCheck,
} from "./mapping-parser.ts";

export type FinancialSheetKind = "profit-loss" | "balance-sheet" | "cashflow";

export type ExcelReportRow = {
  /** Nomor baris spreadsheet (1-based), untuk diagnosis. */
  row: number;
  /** Isi kolom A. */
  label: string;
  /**
   * Kolom A dicetak tebal.
   *
   * Ini SATU-SATUNYA sinyal yang memisahkan baris header/subtotal/turunan
   * dari baris detail di sheet ini — Excel-nya tidak punya kode akun, dan
   * baris detail bernilai nihil tampil kosong persis seperti baris header
   * ("Pendapatan Pickleball AMP" sama kosongnya dengan "PENDAPATAN"), jadi
   * nilai sel saja tidak cukup. Indentasi juga tidak dipakai: seluruh baris
   * di fixture ini indent 0.
   *
   * ponytail: kalau suatu saat ada header yang lupa ditebalkan, ia akan
   * terbaca sebagai baris detail bernilai 0 — jumlah section tidak berubah,
   * jadi lolos pengaman. Sebaliknya baris detail yang tertebalkan akan
   * dikeluarkan dari penjumlahan, subtotalnya meleset, dan sheet DITOLAK.
   * Arah yang berbahaya adalah yang pertama, dan dampaknya hanya label salah
   * kategori, bukan angka salah.
   */
  bold: boolean;
  /** Nilai per kolom; index 0 = kolom A. */
  cells: readonly (number | string | Date | null)[];
};

export type ExcelReportSheet = { name: string; kind: FinancialSheetKind; rows: ExcelReportRow[] };

/** FinancialLine plus nomor baris spreadsheet asalnya. */
export type ExcelFinancialLine = FinancialLine & { row: number };

export type ExcelParseResult =
  | {
      status: "ok";
      sheet: string;
      kind: FinancialSheetKind;
      /** Periode yang diminta, "YYYY-MM". */
      period: string;
      /** Index kolom bulan yang terdeteksi (0 = kolom A). */
      monthColumn: number;
      lines: ExcelFinancialLine[];
      checks: ReconciliationCheck[];
    }
  | { status: "rejected"; sheet: string; reason: string; failedChecks: ReconciliationCheck[] };

/**
 * Sheet mana yang diparse, dikenali dari kata kunci pada NAMA sheet — bukan
 * dari urutannya, karena nama di fixture menggabungkan istilah Inggris dan
 * Indonesia ("Balance Sheet fokus neraca", "Profit & Loss fokus laba rugi",
 * "Cashflow Arus kas"). Sheet yang tidak cocok pola mana pun diabaikan;
 * "cocokan dengan BA" adalah kerangka kerja manual, bukan laporan.
 */
const SHEET_PATTERNS: readonly { pattern: RegExp; kind: FinancialSheetKind }[] = [
  { pattern: /profit|laba\s*rugi/i, kind: "profit-loss" },
  { pattern: /balance|neraca/i, kind: "balance-sheet" },
  { pattern: /cash\s*flow|arus\s*kas/i, kind: "cashflow" },
];

export function sheetKindFromName(name: string): FinancialSheetKind | null {
  return SHEET_PATTERNS.find((candidate) => candidate.pattern.test(name))?.kind ?? null;
}

/** Baris header dicari di sini saja; semua sheet fixture memakai baris 6. */
const HEADER_SEARCH_DEPTH = 12;

function monthKey(date: Date): string {
  // Getter UTC dipakai supaya tanggal akhir-bulan tengah malam UTC tidak
  // bergeser bulan di zona waktu mana pun.
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Sel tanggal, menerima Date MAUPUN string ISO.
 *
 * ExcelJS mengembalikan Date sungguhan, tapi model sheet ini melintasi
 * jaringan: app/api/mapping/upload/route.ts memparse workbook di server lalu
 * mengirim barisnya sebagai JSON ke browser, dan JSON tidak punya tipe
 * tanggal — Date berubah jadi string ISO di perjalanan. Menerima keduanya di
 * sini membuat model tetap JSON-safe tanpa perlu reviver khusus di setiap
 * pemanggil. Pola ISO cukup spesifik untuk tidak pernah cocok dengan label
 * akun mana pun.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function asDateCell(cell: number | string | Date | null): Date | null {
  if (cell instanceof Date) return cell;
  if (typeof cell === "string" && ISO_DATE_TIME.test(cell)) {
    const parsed = new Date(cell);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Petakan "YYYY-MM" -> index kolom, DARI ISI baris header, bukan dari indeks
 * kolom yang di-hardcode.
 *
 * Baris header dikenali sebagai baris pertama yang memuat minimal dua sel
 * bertipe tanggal. Sel-sel itu berisi tanggal AKHIR bulan (2026-02-28), jadi
 * kuncinya diambil dari tahun+bulannya. Aturan ini tahan terhadap kolom yang
 * ditambah/digeser/disisipkan, dan tahan terhadap baris 4 yang memuat angka
 * tahun telanjang (2025, 2026) karena angka bukan tanggal.
 */
export function detectMonthColumns(rows: readonly ExcelReportRow[]): { headerRow: number; columns: Map<string, number> } {
  for (const row of rows.slice(0, HEADER_SEARCH_DEPTH)) {
    const dated = row.cells
      .map((cell, index) => ({ date: asDateCell(cell), index }))
      .filter((entry): entry is { date: Date; index: number } => entry.date !== null);
    if (dated.length >= 2) {
      return { headerRow: row.row, columns: new Map(dated.map((entry) => [monthKey(entry.date), entry.index])) };
    }
  }
  return { headerRow: 0, columns: new Map() };
}

function classify(sheet: ExcelReportSheet, column: number, headerRow: number): ExcelFinancialLine[] {
  const lines: ExcelFinancialLine[] = [];
  let pendingDetails = 0;
  for (const row of sheet.rows) {
    if (row.row <= headerRow) continue;
    const label = row.label.trim();
    if (!label) continue;
    const raw = row.cells[column];
    const value = typeof raw === "number" ? raw : null;
    if (!row.bold) {
      pendingDetails += 1;
      // Sel kosong di laporan ini berarti nihil, bukan gagal baca — beda
      // dengan jalur OCR, jadi tidak ditandai assumedZero.
      lines.push({ code: null, label, value: value ?? 0, kind: "detail", assumedZero: false, row: row.row });
      continue;
    }
    // Cek label subtotal DIDAHULUKAN sebelum cek nilai kosong: "Jumlah Aset
    // Tidak Lancar" di sheet Neraca adalah subtotal bernilai nihil, dan kalau
    // ia diperlakukan sebagai header, baris detail di atasnya tidak pernah
    // ditutup dan ikut terbawa menjumlah ke section berikutnya.
    const isSubtotal = isSubtotalLabel(label) && pendingDetails > 0;
    if (isSubtotal) {
      pendingDetails = 0;
      lines.push({ code: null, label, value: value ?? 0, kind: "subtotal", assumedZero: false, row: row.row });
      continue;
    }
    lines.push({ code: null, label, value, kind: value === null ? "header" : "derived", assumedZero: false, row: row.row });
  }
  return lines;
}

function findLine(lines: readonly ExcelFinancialLine[], pattern: RegExp): ExcelFinancialLine | undefined {
  return lines.find((line) => pattern.test(line.label.trim()));
}

/**
 * Bandingkan dua angka yang secara aritmatika HARUS sama.
 *
 * Salah satu sisi tidak ada atau kosong = identitasnya tidak bisa diuji, dan
 * itu dihitung GAGAL, bukan dilewati. Nyata di fixture: sheet Arus Kas
 * periode 2025-11 tidak punya Saldo Kas Awal (bulan pertama, belum ada saldo
 * sebelumnya), jadi periode itu ditolak alih-alih diterima tanpa verifikasi.
 */
function identityCheck(label: string, expected: number | undefined, actual: number | undefined): ReconciliationCheck {
  if (expected === undefined || actual === undefined) {
    return { kind: "final", label: `${label} (nilai tidak lengkap untuk periode ini)`, expected: Number.NaN, actual: Number.NaN, difference: Number.NaN, tolerance: FINAL_TOLERANCE, passed: false };
  }
  return {
    kind: "final",
    label,
    expected,
    actual,
    difference: actual - expected,
    tolerance: FINAL_TOLERANCE,
    passed: Math.abs(actual - expected) <= FINAL_TOLERANCE,
  };
}

/**
 * Cek akhir per jenis laporan. Cek subtotal-vs-detail sama untuk ketiganya
 * (reconcileSubtotals), tapi "rantai subtotal vs total akhir" punya bentuk
 * yang berbeda-beda karena identitas aritmatikanya memang berbeda:
 *
 *   Laba Rugi | rantai subtotal (pendapatan + / biaya -) = Laba Bersih
 *   Neraca    | Total Aset = Total Kewajiban dan Modal
 *   Arus Kas  | Saldo Kas Awal + jumlah subtotal aktivitas = Saldo Kas Akhir
 */
function finalCheck(kind: FinancialSheetKind, lines: readonly ExcelFinancialLine[]): ReconciliationCheck {
  if (kind === "profit-loss") return reconcileNetProfitChain(lines);
  if (kind === "balance-sheet") {
    return identityCheck(
      "Total Aset = Total Kewajiban dan Modal",
      findLine(lines, /^total\s+aset$/i)?.value ?? undefined,
      findLine(lines, /^total\s+kewajiban\s+dan\s+modal$/i)?.value ?? undefined,
    );
  }
  const opening = findLine(lines, /^saldo\s+kas\s+awal$/i)?.value;
  const closing = findLine(lines, /^saldo\s+kas\s+akhir$/i)?.value;
  const activities = lines.filter((line) => line.kind === "subtotal").reduce((sum, line) => sum + (line.value ?? 0), 0);
  return identityCheck(
    "Saldo Kas Awal + aktivitas = Saldo Kas Akhir",
    closing ?? undefined,
    opening === null || opening === undefined ? undefined : opening + activities,
  );
}

/**
 * Parse satu sheet untuk satu bulan.
 *
 * Sama seperti parser PDF: hasilnya TIDAK PERNAH dikembalikan tanpa lolos
 * rekonsiliasi terhadap angka total yang tercetak di sheet itu sendiri.
 * Sheet yang tidak rekonsiliasi DITOLAK dengan alasan yang menyebut selisih
 * dan nomor barisnya, bukan diterima dengan peringatan.
 */
export function parseFinancialSheet(sheet: ExcelReportSheet, period: string): ExcelParseResult {
  const { headerRow, columns } = detectMonthColumns(sheet.rows);
  const column = columns.get(period);
  if (column === undefined) {
    const available = [...columns.keys()].sort().join(", ") || "(tidak ada kolom bertanggal)";
    return { status: "rejected", sheet: sheet.name, reason: `Kolom bulan ${period} tidak ada di sheet "${sheet.name}". Tersedia: ${available}.`, failedChecks: [] };
  }
  const lines = classify(sheet, column, headerRow);
  const hasAnyValue = lines.some((line) => line.kind === "detail" && (line.value ?? 0) !== 0);
  if (!hasAnyValue) {
    // Bulan yang seluruh baris detailnya kosong akan LULUS rekonsiliasi
    // secara hampa (0 = 0 di mana-mana). Ditolak eksplisit supaya tidak
    // terbaca sebagai laporan sah yang kebetulan nol.
    return { status: "rejected", sheet: sheet.name, reason: `Kolom bulan ${period} di sheet "${sheet.name}" kosong — tidak ada satu pun baris detail bernilai.`, failedChecks: [] };
  }
  // Toleransi per baris 0: beda dengan PDF, spreadsheet menyimpan nilai
  // presisi penuh sehingga tidak ada galat pemotongan desimal yang perlu
  // dimaafkan. Yang tersisa hanya FINAL_TOLERANCE untuk derau float.
  const checks = [...reconcileSubtotals(lines, 0), finalCheck(sheet.kind, lines)];
  const failedChecks = checks.filter((check) => !check.passed);
  if (failedChecks.length > 0) {
    const summary = failedChecks.map((check) => `${check.label}: selisih ${check.difference}`).join("; ");
    return {
      status: "rejected",
      sheet: sheet.name,
      reason: `Sheet "${sheet.name}" periode ${period} tidak rekonsiliasi terhadap total yang tercetak, jadi angkanya tidak bisa dipercaya. ${summary}`,
      failedChecks,
    };
  }
  return { status: "ok", sheet: sheet.name, kind: sheet.kind, period, monthColumn: column, lines, checks };
}

/** Parse seluruh sheet laporan yang dikenali, satu periode. */
export function parseFinancialWorkbook(sheets: readonly ExcelReportSheet[], period: string): ExcelParseResult[] {
  return sheets.map((sheet) => parseFinancialSheet(sheet, period));
}

// --- Jalur I/O. Dipisah supaya inti di atas tetap murni dan node-testable. ---

/**
 * Baca workbook jadi model baris di atas.
 *
 * Memakai jalur muat yang sama dengan parseSummaryWorkbookBuffer di
 * lib/olsera-inventory-monthly-export.ts (ExcelJS + `workbook.xlsx.load`,
 * indeks kolom ExcelJS 1-based digeser ke 0-based) dan cellValue bersama di
 * lib/xlsx-cell.ts untuk sel formula dan merged cell. Fungsi
 * parseSummaryWorkbookBuffer sendiri TIDAK dipakai ulang apa adanya: ia
 * memvalidasi header file summary inventaris lalu mengembalikan baris produk,
 * bentuk yang tidak berlaku untuk laporan keuangan ini.
 *
 * ExcelJS di-import dinamis supaya inti parser tetap ringan di bundle.
 */
export async function readFinancialWorkbook(buffer: ArrayBuffer | Buffer): Promise<ExcelReportSheet[]> {
  const [{ default: ExcelJS }, { cellValue }] = await Promise.all([import("exceljs"), import("./xlsx-cell.ts")]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);
  const sheets: ExcelReportSheet[] = [];
  for (const worksheet of workbook.worksheets) {
    const kind = sheetKindFromName(worksheet.name);
    if (!kind) continue;
    const rows: ExcelReportRow[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: (number | string | Date | null)[] = [];
      for (let column = 1; column <= worksheet.columnCount; column++) {
        const value = cellValue(row.getCell(column));
        cells.push(typeof value === "number" || typeof value === "string" || value instanceof Date ? value : null);
      }
      const first = row.getCell(1);
      rows.push({ row: row.number, label: String(cells[0] ?? "").trim(), bold: first.font?.bold === true, cells });
    });
    sheets.push({ name: worksheet.name, kind, rows });
  }
  return sheets;
}
