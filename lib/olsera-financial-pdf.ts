// Generator PDF Laporan Keuangan Olsera (Tahap 4C) — satu berkas per jenis
// laporan (Neraca, Laba Rugi, Arus Kas, Ringkasan Buku Besar, Buku Besar Detail),
// mengikuti struktur & tampilan laporan resmi Olsera Mei 2026 (doc export/*.pdf):
// blok judul (perusahaan / judul laporan / periode) di atas, tabel dengan header
// konsisten, subtotal & total dibedakan garis, nomor halaman di kaki, nilai
// negatif konsisten dalam tanda kurung.
//
// Memakai pdf-lib (pure JS, font standar Helvetica — tanpa baca file font, aman
// di serverless Next). Murni terhadap sumber data: menerima payload snapshot
// yang SUDAH diambil dari MongoDB, tidak menyentuh Mongo/Olsera.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import {
  buildBalanceSheetLines,
  buildCashFlowLines,
  buildLedgerDetailGroups,
  buildLedgerSummaryRows,
  buildProfitLossLines,
  draftReportNotice,
  filterZeroLedgerSummaryRows,
  filterZeroStatementLines,
  formatAccountingID,
  formatPeriodDateRangeEN,
  formatPeriodLabelID,
  type BalanceSheetPayload,
  type CashFlowPayload,
  type LedgerAccountDetailReport,
  type LedgerEntryInput,
  type LedgerSummaryRow,
  type ProfitLossPayload,
  type StatementLine,
} from "./olsera-financial-export-core.ts";

const MARGIN = 40;
const HEADER_BLOCK_HEIGHT = 82;
const HEADER_TABLE_GAP = 24;
const FOOTER_HEIGHT = 28;
const LINE_HEIGHT = 18;
const A4 = { w: 595.28, h: 841.89 };

/** Kontrak koordinat agar header, tabel, dan footer tidak saling menimpa. */
export const PDF_REPORT_LAYOUT = {
  margin: MARGIN,
  headerBlockHeight: HEADER_BLOCK_HEIGHT,
  headerTableGap: HEADER_TABLE_GAP,
  footerHeight: FOOTER_HEIGHT,
  rightNumberInset: 8,
  titleBottomOffset: MARGIN + HEADER_BLOCK_HEIGHT,
  tableTopOffset: MARGIN + HEADER_BLOCK_HEIGHT + HEADER_TABLE_GAP - (LINE_HEIGHT - 4),
};

const INK = rgb(0.09, 0.11, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.7, 0.72, 0.75);
const GROUP_BG = rgb(0.93, 0.94, 0.95);
const TOTAL_BG = rgb(0.85, 0.87, 0.89);
const DRAFT_INK = rgb(0.72, 0.24, 0.1);
const DRAFT_LINE_HEIGHT = 13;

/**
 * Normalisasi teks untuk font standar PDF (WinAnsi).
 *
 * pdf-lib tidak dapat meng-encode semua Unicode. Pemetaan di sini menjaga
 * makna tanda baca/simbol umum dalam bentuk ASCII, mengubah whitespace yang
 * tidak terlihat menjadi spasi biasa, lalu membuang control/format character.
 * Angka tidak disentuh.
 */
const PDF_TEXT_REPLACEMENTS: Record<string, string> = {
  "\u00a0": " ", // non-breaking space
  "\u2007": " ", // figure space
  "\u202f": " ", // narrow no-break space
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u2032": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u2033": '"',
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u2022": "-", // bullet
  "\u2023": "-",
  "\u2043": "-",
  "\u2219": "-",
  "\u2026": "...",
  "\u2190": "<-",
  "\u2192": "->",
  "\u2194": "<->",
  "\u2264": "<=",
  "\u2265": ">=",
  "\u2260": "!=",
  "\u00d7": "x",
  "\u00f7": "/",
  "\u00b1": "+/-",
};

const WINANSI_EXTRA_CODEPOINTS = new Set([0x0192, 0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x20ac]);

function isWinAnsiCandidate(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  return (codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff) || WINANSI_EXTRA_CODEPOINTS.has(codePoint);
}

export function normalizePdfText(value: unknown): string {
  const replaced = Array.from(String(value ?? ""), (char) => PDF_TEXT_REPLACEMENTS[char] ?? char).join("");
  let result = "";
  for (const char of replaced) {
    if (char === "\t" || char === "\n" || char === "\r") {
      result += " ";
    } else if (isWinAnsiCandidate(char)) {
      result += char;
    } else {
      const fallback = char.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      if (fallback !== char) result += Array.from(fallback).filter(isWinAnsiCandidate).join("");
    }
  }
  return result;
}

/** Pastikan fallback terakhir tetap bisa diterima font yang dipakai. */
function pdfText(value: unknown, font: PDFFont): string {
  const normalized = normalizePdfText(value);
  let result = "";
  for (const char of normalized) {
    try {
      font.encodeText(char);
      result += char;
    } catch {
      // Pertahankan huruf beraksen bila tersedia padanan Latin dasar.
      const fallback = char.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      if (fallback !== char) {
        for (const fallbackChar of fallback) {
          try {
            font.encodeText(fallbackChar);
            result += fallbackChar;
          } catch {
            // Karakter tetap tidak didukung; lewati tanpa menggagalkan export.
          }
        }
      }
    }
  }
  return result;
}

interface Column {
  header: string;
  x: number;
  width: number;
  align: "left" | "right";
}

interface ReportOptions {
  orientation: "portrait" | "landscape";
  companyName: string;
  title: string;
  periodText: string;
  /** Header kolom tabel yang digambar ulang di tiap halaman (opsional). */
  columns?: Column[];
  /**
   * Baris info tambahan di blok judul (opsional) — mis. Kode Akun/Nama
   * Akun/Saldo Awal untuk laporan Buku Besar satu akun. Ditulis dengan gaya
   * normal (bukan warna DRAFT), di bawah periode & sebelum draftLines.
   */
  infoLines?: string[];
  /**
   * Baris peringatan "bulan berjalan / belum final" (opsional) — HANYA diisi
   * bila periode laporan adalah bulan berjalan (lihat draftReportNotice di
   * olsera-financial-export-core.ts). Menambah tinggi blok header hanya untuk
   * dokumen ini; laporan bulan lain/lama tidak terpengaruh.
   */
  draftLines?: string[];
}

class ReportPdf {
  private doc: PDFDocument;
  private regular: PDFFont;
  private bold: PDFFont;
  private opts: ReportOptions;
  private pageW: number;
  private pageH: number;
  private headerBlockHeight: number;
  page!: PDFPage;
  private y = 0;

  private constructor(doc: PDFDocument, regular: PDFFont, bold: PDFFont, opts: ReportOptions, pageW: number, pageH: number) {
    this.doc = doc;
    this.regular = regular;
    this.bold = bold;
    this.opts = opts;
    this.pageW = pageW;
    this.pageH = pageH;
    const infoLineCount = opts.infoLines?.length ?? 0;
    const draftLineCount = opts.draftLines?.length ?? 0;
    this.headerBlockHeight =
      HEADER_BLOCK_HEIGHT +
      (infoLineCount > 0 ? infoLineCount * DRAFT_LINE_HEIGHT + 4 : 0) +
      (draftLineCount > 0 ? draftLineCount * DRAFT_LINE_HEIGHT + 6 : 0);
  }

  static async create(opts: ReportOptions): Promise<ReportPdf> {
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const pageW = opts.orientation === "landscape" ? A4.h : A4.w;
    const pageH = opts.orientation === "landscape" ? A4.w : A4.h;
    const report = new ReportPdf(doc, regular, bold, opts, pageW, pageH);
    report.newPage();
    return report;
  }

  get contentLeft() {
    return MARGIN;
  }
  get contentRight() {
    return this.pageW - MARGIN;
  }
  get cursorY() {
    return this.y;
  }

  private newPage() {
    this.page = this.doc.addPage([this.pageW, this.pageH]);
    this.drawTitleBlock();
    this.y = this.pageH - MARGIN - this.headerBlockHeight - HEADER_TABLE_GAP;
    if (this.opts.columns) this.drawColumnHeader();
  }

  private drawTitleBlock() {
    const top = this.pageH - MARGIN;
    // Kotak header
    this.page.drawRectangle({
      x: MARGIN,
      y: top - this.headerBlockHeight,
      width: this.pageW - MARGIN * 2,
      height: this.headerBlockHeight,
      borderColor: RULE,
      borderWidth: 1,
    });
    const centerX = this.pageW / 2;
    const lines: Array<{ text: string; font: PDFFont; size: number; color?: ReturnType<typeof rgb> }> = [
      { text: this.opts.companyName, font: this.bold, size: 13 },
      { text: this.opts.title, font: this.regular, size: 11 },
      { text: this.opts.periodText, font: this.regular, size: 11 },
      ...(this.opts.infoLines ?? []).map((text) => ({ text, font: this.regular, size: 9.5 })),
      ...(this.opts.draftLines ?? []).map((text) => ({ text, font: this.bold, size: 9.5, color: DRAFT_INK })),
    ];
    let ly = top - 20;
    for (const line of lines) {
      const text = pdfText(line.text, line.font);
      const width = line.font.widthOfTextAtSize(text, line.size);
      this.page.drawText(text, { x: centerX - width / 2, y: ly - line.size, size: line.size, font: line.font, color: line.color ?? INK });
      ly -= line.size + 4;
    }
  }

  private drawColumnHeader() {
    const columns = this.opts.columns!;
    const rowY = this.y;
    this.page.drawRectangle({
      x: this.contentLeft,
      y: rowY - 4,
      width: this.contentRight - this.contentLeft,
      height: LINE_HEIGHT,
      color: rgb(0.22, 0.25, 0.3),
    });
    for (const col of columns) {
      const text = pdfText(col.header, this.bold);
      const size = 9;
      const tx = col.align === "right" ? col.x + col.width - PDF_REPORT_LAYOUT.rightNumberInset - this.bold.widthOfTextAtSize(text, size) : col.x;
      this.page.drawText(text, { x: tx, y: rowY, size, font: this.bold, color: rgb(1, 1, 1) });
    }
    this.y -= LINE_HEIGHT + 2;
  }

  private ensureSpace(height: number) {
    if (this.y - height < MARGIN + FOOTER_HEIGHT) this.newPage();
  }

  text(x: number, text: string, opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {}) {
    const size = opts.size ?? 9.5;
    const font = opts.bold ? this.bold : this.regular;
    this.page.drawText(pdfText(text, font), { x, y: this.y, size, font, color: opts.color ?? INK });
  }
  textRight(xRight: number, text: string, opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {}) {
    const size = opts.size ?? 9.5;
    const font = opts.bold ? this.bold : this.regular;
    const clean = pdfText(text, font);
    const width = font.widthOfTextAtSize(clean, size);
    this.page.drawText(clean, { x: xRight - width, y: this.y, size, font, color: opts.color ?? INK });
  }

  /** Potong teks agar muat di lebar kolom (dengan elipsis). */
  fit(text: string, maxWidth: number, size = 9.5, bold = false): string {
    const font = bold ? this.bold : this.regular;
    const clean = pdfText(text, font);
    if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
    let cut = clean;
    while (cut.length > 1 && font.widthOfTextAtSize(cut + "...", size) > maxWidth) cut = cut.slice(0, -1);
    return cut + "...";
  }

  /** Pecah teks panjang pada kata agar tinggi baris dapat disesuaikan. */
  wrap(text: string, maxWidth: number, size = 9.5, bold = false): string[] {
    const font = bold ? this.bold : this.regular;
    return wrapPdfText(text, maxWidth, font, size);
  }
  
  textLines(x: number, lines: string[], opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb>; leading?: number } = {}) {
    const size = opts.size ?? 9.5; const leading = opts.leading ?? size + 2; const font = opts.bold ? this.bold : this.regular;
    lines.forEach((line, index) => this.page.drawText(pdfText(line, font), { x, y: this.y - index * leading, size, font, color: opts.color ?? INK }));
  }

  advance(height = LINE_HEIGHT) {
    this.y -= height;
  }

  fillRow(height: number, color: ReturnType<typeof rgb>) {
    this.page.drawRectangle({
      x: this.contentLeft,
      y: this.y - 4,
      width: this.contentRight - this.contentLeft,
      height,
      color,
    });
  }
  ruleAbove() {
    const ry = this.y + LINE_HEIGHT - 6;
    this.page.drawLine({ start: { x: this.contentLeft, y: ry }, end: { x: this.contentRight, y: ry }, thickness: 0.7, color: RULE });
  }

  moveToRowThenEnsure(height: number) {
    this.ensureSpace(height);
  }

  async finalize(): Promise<Uint8Array> {
    // Nomor halaman: "Halaman X / N" di kaki tiap halaman.
    const pages = this.doc.getPages();
    const total = pages.length;
    pages.forEach((page, index) => {
      const text = `Halaman ${index + 1} / ${total}`;
      const size = 8;
      const width = this.regular.widthOfTextAtSize(text, size);
      page.drawText(pdfText(text, this.regular), { x: page.getWidth() / 2 - width / 2, y: MARGIN - 8, size, font: this.regular, color: MUTED });
    });
    return this.doc.save();
  }
}

export function wrapPdfText(text: string, maxWidth: number, font: PDFFont, size = 9.5): string[] {
  const words = pdfText(text, font).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      if (line) { lines.push(line); line = ""; }
      let chunk = "";
      for (const char of word) {
        const candidate = chunk + char;
        if (chunk && font.widthOfTextAtSize(candidate, size) > maxWidth) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk = candidate;
        }
      }
      line = chunk;
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

// ---------------------------------------------------------------------------
// Laporan berstruktur (Neraca / Laba Rugi / Arus Kas)
// ---------------------------------------------------------------------------

async function renderStatementPdf(
  companyName: string,
  title: string,
  periodText: string,
  lines: StatementLine[],
  layout: "code-name-amount" | "name-amount",
  draftLines?: string[],
  warningLines?: string[],
): Promise<Uint8Array> {
  const report = await ReportPdf.create({ orientation: "portrait", companyName, title, periodText, draftLines: [...(draftLines ?? []), ...(warningLines ?? [])] });
  const left = report.contentLeft;
  const right = report.contentRight;
  const codeX = left;
  const nameX = layout === "code-name-amount" ? left + 70 : left + 14;

  for (const line of lines) {
    report.moveToRowThenEnsure(LINE_HEIGHT);
    const amountText = line.amount === null ? "" : formatAccountingID(line.amount);
    switch (line.kind) {
      case "section":
        report.advance(6);
        report.moveToRowThenEnsure(LINE_HEIGHT);
        report.text(left, line.label, { bold: true, size: 11 });
        break;
      case "group":
        report.fillRow(LINE_HEIGHT, GROUP_BG);
        report.text(left, line.label, { bold: true, size: 10 });
        break;
      case "account":
        report.text(codeX, line.code ?? "", { size: 9.5, color: MUTED });
        report.text(nameX, report.fit(line.label, right - nameX - 110, 9.5), { size: 9.5 });
        report.textRight(right, amountText, { size: 9.5 });
        break;
      case "line":
        report.text(nameX, report.fit(line.label, right - nameX - 110, 9.5), { size: 9.5 });
        report.textRight(right, amountText, { size: 9.5 });
        break;
      case "subtotal":
        report.ruleAbove();
        report.text(left, line.label, { bold: true, size: 9.5 });
        report.textRight(right, amountText, { bold: true, size: 9.5 });
        break;
      case "total":
        report.fillRow(LINE_HEIGHT, TOTAL_BG);
        report.text(left, line.label, { bold: true, size: 10.5 });
        report.textRight(right, amountText, { bold: true, size: 10.5 });
        break;
    }
    report.advance();
  }

  return report.finalize();
}

/** Baris peringatan bulan berjalan untuk header PDF, atau undefined bila bukan draft. */
function draftLinesFor(period: string, lastSyncedAt: string | Date | null | undefined): string[] | undefined {
  const notice = draftReportNotice(period, lastSyncedAt);
  return notice.isDraft ? [notice.label, notice.detail] : undefined;
}

export function renderNeracaPdf(companyName: string, period: string, balanceSheet: BalanceSheetPayload, lastSyncedAt?: string | Date | null, warningLines?: string[]): Promise<Uint8Array> {
  return renderStatementPdf(companyName, "Laporan Neraca", formatPeriodLabelID(period), filterZeroStatementLines(buildBalanceSheetLines(balanceSheet)), "code-name-amount", draftLinesFor(period, lastSyncedAt), warningLines);
}
export function renderLabaRugiPdf(companyName: string, period: string, profitLoss: ProfitLossPayload, lastSyncedAt?: string | Date | null, warningLines?: string[]): Promise<Uint8Array> {
  return renderStatementPdf(companyName, "Laporan Laba Rugi", formatPeriodLabelID(period), filterZeroStatementLines(buildProfitLossLines(profitLoss)), "code-name-amount", draftLinesFor(period, lastSyncedAt), warningLines);
}
export function renderArusKasPdf(companyName: string, period: string, cashFlow: CashFlowPayload, lastSyncedAt?: string | Date | null, warningLines?: string[]): Promise<Uint8Array> {
  return renderStatementPdf(companyName, "Laporan Arus Kas", formatPeriodDateRangeEN(period), filterZeroStatementLines(buildCashFlowLines(cashFlow)), "name-amount", draftLinesFor(period, lastSyncedAt), warningLines);
}

// ---------------------------------------------------------------------------
// Ringkasan Buku Besar (landscape)
// ---------------------------------------------------------------------------

export async function renderRingkasanBukuBesarPdf(
  companyName: string,
  period: string,
  ledgerSummary: LedgerSummaryRow[] | null,
  lastSyncedAt?: string | Date | null,
  warningLines?: string[],
): Promise<Uint8Array> {
  const pageW = A4.h;
  const tableRight = pageW - MARGIN - 6;
  const usable = tableRight - MARGIN;
  const amountWidth = (usable - 420) / 3;
  // Kolom: Nomor Akun | Nama Akun | Klasifikasi | Debit | Kredit | Saldo
  const columns: Column[] = [
    { header: "Nomor Akun", x: MARGIN, width: 70, align: "left" },
    { header: "Nama Akun", x: MARGIN + 70, width: 200, align: "left" },
    { header: "Klasifikasi", x: MARGIN + 270, width: 150, align: "left" },
    { header: "Debit", x: MARGIN + 420, width: amountWidth, align: "right" },
    { header: "Kredit", x: MARGIN + 420 + amountWidth, width: amountWidth, align: "right" },
    { header: "Saldo", x: MARGIN + 420 + amountWidth * 2, width: amountWidth, align: "right" },
  ];
  const report = await ReportPdf.create({
    orientation: "landscape",
    companyName,
    title: "Ringkasan Buku Besar",
    periodText: formatPeriodLabelID(period),
    columns,
    draftLines: [...(draftLinesFor(period, lastSyncedAt) ?? []), ...(warningLines ?? [])],
  });

  for (const row of filterZeroLedgerSummaryRows(buildLedgerSummaryRows(ledgerSummary))) {
    report.moveToRowThenEnsure(LINE_HEIGHT - 3);
    report.text(columns[0].x, row.code, { size: 8.5 });
    report.text(columns[1].x, report.fit(row.name, columns[1].width - 6, 8.5), { size: 8.5 });
    report.text(columns[2].x, report.fit(row.classification, columns[2].width - 6, 8.5), { size: 8.5, color: MUTED });
    // Semua kolom memakai dua desimal; nilai negatif tetap dalam tanda kurung.
    report.textRight(columns[3].x + columns[3].width - PDF_REPORT_LAYOUT.rightNumberInset, formatAccountingID(row.debit), { size: 8.5 });
    report.textRight(columns[4].x + columns[4].width - PDF_REPORT_LAYOUT.rightNumberInset, formatAccountingID(row.credit), { size: 8.5 });
    report.textRight(columns[5].x + columns[5].width - PDF_REPORT_LAYOUT.rightNumberInset, formatAccountingID(row.balance), { size: 8.5 });
    report.advance(LINE_HEIGHT - 3);
  }

  return report.finalize();
}

// ---------------------------------------------------------------------------
// Buku Besar Detail (landscape, banyak halaman) — kolom dipakai bareng oleh
// laporan lengkap (semua akun) dan per akun ("Download Akun Ini").
// ---------------------------------------------------------------------------

/** Kolom Tanggal/No. Jurnal/Deskripsi/Debit/Kredit/Saldo (landscape, sesuai lebar halaman A4). */
function ledgerDetailColumns(): Column[] {
  const pageW = A4.h;
  const usable = pageW - MARGIN * 2;
  const amountW = 80;
  const dateW = 85;
  const noW = 120;
  const descX = MARGIN + dateW + noW;
  const descW = usable - dateW - noW - amountW * 3;
  return [
    { header: "Tanggal", x: MARGIN, width: dateW, align: "left" },
    { header: "No. Jurnal", x: MARGIN + dateW, width: noW, align: "left" },
    { header: "Deskripsi", x: descX, width: descW, align: "left" },
    { header: "Debit", x: descX + descW, width: amountW, align: "right" },
    { header: "Kredit", x: descX + descW + amountW, width: amountW, align: "right" },
    { header: "Saldo", x: descX + descW + amountW * 2, width: amountW, align: "right" },
  ];
}

export async function renderBukuBesarDetailPdf(
  companyName: string,
  period: string,
  entries: LedgerEntryInput[],
  accountNameByCode: Map<string, string> = new Map(),
  lastSyncedAt?: string | Date | null,
): Promise<Uint8Array> {
  const columns = ledgerDetailColumns();
  const descW = columns[2].width;
  const report = await ReportPdf.create({
    orientation: "landscape",
    companyName,
    title: "Buku Besar Detail",
    periodText: formatPeriodLabelID(period),
    columns,
    draftLines: draftLinesFor(period, lastSyncedAt),
  });

  const groups = buildLedgerDetailGroups(entries, accountNameByCode);
  if (!groups.length) {
    report.moveToRowThenEnsure(LINE_HEIGHT);
    report.text(report.contentLeft, "Tidak ada data buku besar pada periode ini.", { size: 10, color: MUTED });
    report.advance();
    return report.finalize();
  }

  const rightOf = (col: Column) => col.x + col.width - PDF_REPORT_LAYOUT.rightNumberInset;
  for (const group of groups) {
    // Jangan biarkan header akun menjadi orphan di bawah halaman: sisakan
    // ruang untuk header akun dan minimal satu baris transaksi pertama.
    const firstEntry = group.entries[0];
    const firstEntryHeight = firstEntry
      ? Math.max(LINE_HEIGHT - 4, report.wrap(firstEntry.description, descW - 6, 8).length * 10 + 3)
      : LINE_HEIGHT - 4;
    report.moveToRowThenEnsure(LINE_HEIGHT + firstEntryHeight);
    report.fillRow(LINE_HEIGHT, GROUP_BG);
    report.text(report.contentLeft, report.fit(`${group.code} - ${group.name}`, report.contentRight - report.contentLeft - 6, 9.5, true), { bold: true, size: 9.5 });
    report.advance();

    for (const entry of group.entries) {
      const descriptionLines = report.wrap(entry.description, descW - 6, 8);
      const rowHeight = Math.max(LINE_HEIGHT - 4, descriptionLines.length * 10 + 3);
      report.moveToRowThenEnsure(rowHeight);
      report.text(columns[0].x, report.fit(entry.date, columns[0].width - 4, 8), { size: 8 });
      report.text(columns[1].x, report.fit(entry.transactionNo, columns[1].width - 4, 8), { size: 8 });
      report.textLines(columns[2].x, descriptionLines, { size: 8, leading: 10 });
      if (!entry.isOpeningBalance && entry.debit) report.textRight(rightOf(columns[3]), formatAccountingID(entry.debit), { size: 8 });
      if (!entry.isOpeningBalance && entry.credit) report.textRight(rightOf(columns[4]), formatAccountingID(entry.credit), { size: 8 });
      if (entry.balance != null) report.textRight(rightOf(columns[5]), formatAccountingID(entry.balance), { size: 8 });
      report.advance(rowHeight);
    }

    // Total pergerakan akun — kolom Saldo (col 6) sengaja dikosongkan: ini
    // total movement (SUM Debit/SUM Kredit), bukan posisi saldo.
    report.moveToRowThenEnsure(LINE_HEIGHT);
    report.ruleAbove();
    report.text(columns[2].x, "Total Pergerakan", { bold: true, size: 8 });
    report.textRight(rightOf(columns[3]), formatAccountingID(group.totalDebit), { bold: true, size: 8 });
    report.textRight(rightOf(columns[4]), formatAccountingID(group.totalCredit), { bold: true, size: 8 });
    report.advance();
    report.advance(6);
  }

  return report.finalize();
}

// ---------------------------------------------------------------------------
// Buku Besar Detail — SATU akun ("Download Akun Ini", landscape)
// ---------------------------------------------------------------------------

export async function renderLedgerAccountDetailPdf(
  companyName: string,
  period: string,
  detail: LedgerAccountDetailReport,
  lastSyncedAt?: string | Date | null,
): Promise<Uint8Array> {
  const columns = ledgerDetailColumns();
  const descW = columns[2].width;
  const report = await ReportPdf.create({
    orientation: "landscape",
    companyName,
    title: "Buku Besar Detail",
    periodText: formatPeriodLabelID(period),
    columns,
    infoLines: [`Kode Akun: ${detail.code}`, `Nama Akun: ${detail.name}`, `Saldo Awal: ${formatAccountingID(detail.openingBalance)}`],
    draftLines: draftLinesFor(period, lastSyncedAt),
  });
  const rightOf = (col: Column) => col.x + col.width - PDF_REPORT_LAYOUT.rightNumberInset;

  if (!detail.entries.length) {
    report.moveToRowThenEnsure(LINE_HEIGHT);
    report.text(report.contentLeft, "Tidak ada transaksi pada periode ini.", { size: 10, color: MUTED });
    report.advance();
  }

  for (const entry of detail.entries) {
    const descriptionLines = report.wrap(entry.description, descW - 6, 8);
    const rowHeight = Math.max(LINE_HEIGHT - 4, descriptionLines.length * 10 + 3);
    report.moveToRowThenEnsure(rowHeight);
    report.text(columns[0].x, report.fit(entry.date, columns[0].width - 4, 8), { size: 8 });
    report.text(columns[1].x, report.fit(entry.transactionNo, columns[1].width - 4, 8), { size: 8 });
    report.textLines(columns[2].x, descriptionLines, { size: 8, leading: 10 });
    if (entry.debit) report.textRight(rightOf(columns[3]), formatAccountingID(entry.debit), { size: 8 });
    if (entry.credit) report.textRight(rightOf(columns[4]), formatAccountingID(entry.credit), { size: 8 });
    if (entry.balance != null) report.textRight(rightOf(columns[5]), formatAccountingID(entry.balance), { size: 8 });
    report.advance(rowHeight);
  }

  // Total debit/kredit, pergerakan periode, saldo akhir — selalu tampil (baris saldo/total, tidak difilter Fitur 2).
  // "Total"/"Pergerakan Periode" TIDAK mengisi kolom Saldo — nilai saldo eksplisit hanya di baris "Saldo Akhir".
  report.moveToRowThenEnsure(LINE_HEIGHT * 4);
  report.ruleAbove();
  report.text(columns[2].x, "Total", { bold: true, size: 8.5 });
  report.textRight(rightOf(columns[3]), formatAccountingID(detail.totalDebit), { bold: true, size: 8.5 });
  report.textRight(rightOf(columns[4]), formatAccountingID(detail.totalCredit), { bold: true, size: 8.5 });
  report.advance();
  report.text(columns[2].x, "Pergerakan Periode", { bold: true, size: 8.5 });
  report.textRight(rightOf(columns[4]), formatAccountingID(detail.movement), { bold: true, size: 8.5 });
  report.advance();
  report.text(columns[2].x, "Saldo Akhir", { bold: true, size: 8.5 });
  report.textRight(rightOf(columns[5]), formatAccountingID(detail.endingBalance), { bold: true, size: 8.5 });
  report.advance();

  return report.finalize();
}
