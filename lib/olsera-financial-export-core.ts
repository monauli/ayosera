// Inti (pure) export Laporan Keuangan Olsera — Tahap 4C.
//
// TIDAK ADA dependensi Next/React/Mongo/pdf-lib/ExcelJS di file ini supaya bisa
// diuji dengan node:test (--experimental-strip-types), sama pola dengan
// lib/olsera-financial-response.ts & lib/olsera-financial-core.ts.
//
// Bertugas:
// - format angka/tanggal gaya Indonesia (dipakai sama oleh Excel & PDF supaya
//   konsisten),
// - validasi periode & nama file,
// - meratakan (flatten) normalizedPayload snapshot MongoDB menjadi baris siap
//   render — MEMAKAI ANGKA yang sudah tersimpan (tidak menghitung ulang rumus
//   laporan), agar angka export == angka UI == snapshot Olsera.
//
// Angka diambil apa adanya dari normalizedPayload (node.amount / section.amount /
// totals). Satu-satunya "keputusan tampilan" di sini: nilai negatif SELALU
// ditampilkan dalam tanda kurung `( )` secara KONSISTEN di semua laporan
// (memenuhi syarat "Nilai negatif ditampilkan konsisten").

import { isCurrentJakartaPeriod } from "./olsera-financial-core.ts";

export type FinancialReportKind =
  | "neraca"
  | "laba-rugi"
  | "arus-kas"
  | "ringkasan-buku-besar"
  | "buku-besar-detail";

export const FINANCIAL_REPORT_KINDS: FinancialReportKind[] = [
  "neraca",
  "laba-rugi",
  "arus-kas",
  "ringkasan-buku-besar",
  "buku-besar-detail",
];

export function isFinancialReportKind(value: unknown): value is FinancialReportKind {
  return typeof value === "string" && (FINANCIAL_REPORT_KINDS as string[]).includes(value);
}

export const DEFAULT_COMPANY_NAME = "BC PADEL CLUB";

const MONTH_NAMES_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];
const MONTH_NAMES_EN_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Decode sekali untuk entity yang memang dikirim Olsera, tanpa recursive decode. */
export function decodeFinancialHtmlEntities(value: unknown): string {
  return String(value ?? "").replace(/&#039;|&amp;|&quot;|&lt;|&gt;/g, (entity) => ({
    "&#039;": "'", "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">",
  })[entity] ?? entity);
}

/** "2026-05" → { year, month } (0-safe; melempar bila bukan periode valid). */
export function splitPeriod(period: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error("Periode tidak valid.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error("Periode tidak valid.");
  return { year, month };
}

/** Label periode Bahasa Indonesia: "2026-05" → "Mei 2026". */
export function formatPeriodLabelID(period: string): string {
  const { year, month } = splitPeriod(period);
  return `${MONTH_NAMES_ID[month - 1]} ${year}`;
}

/** Rentang tanggal gaya laporan Arus Kas resmi Olsera: "01 May 2026 - 31 May 2026". */
export function formatPeriodDateRangeEN(period: string): string {
  const { year, month } = splitPeriod(period);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mon = MONTH_NAMES_EN_SHORT[month - 1];
  return `01 ${mon} ${year} - ${String(lastDay).padStart(2, "0")} ${mon} ${year}`;
}

/**
 * Format angka gaya akuntansi Indonesia: pemisah ribuan titik, desimal koma,
 * nilai negatif dalam tanda kurung. `2519025675.61` → `2.519.025.675,61`,
 * `-1056854` → `(1.056.854,00)`, `0` → `0,00`.
 */
export function formatAccountingID(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const negative = value < 0;
  const abs = Math.abs(value);
  const formatted = new Intl.NumberFormat("id-ID", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(abs);
  return negative ? `(${formatted})` : formatted;
}

/** "05 Jul 2026 21:14" (Asia/Jakarta) — dipakai untuk menampilkan tanggal sinkron terakhir di export. */
export function formatJakartaDateTime(value: string | Date | null | undefined): string {
  if (!value) return "belum pernah sinkron";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "belum pernah sinkron";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/\./g, ":");
}

export interface DraftReportNotice {
  isDraft: boolean;
  /** Baris label utama, mis. "DRAFT / BELUM FINAL". Kosong bila bukan bulan berjalan. */
  label: string;
  /** Baris keterangan periode + tanggal sinkron terakhir. Kosong bila bukan bulan berjalan. */
  detail: string;
}

/**
 * Status "bulan berjalan / belum final" untuk laporan keuangan — HANYA berlaku
 * bila periode laporan adalah bulan berjalan menurut Asia/Jakarta (bukan UTC
 * server). Bulan sebelumnya tidak pernah dianggap draft, apa pun status sync-nya.
 */
export function draftReportNotice(period: string, lastSyncedAt: string | Date | null | undefined, now: Date = new Date()): DraftReportNotice {
  const isDraft = isCurrentJakartaPeriod(period, now);
  if (!isDraft) return { isDraft: false, label: "", detail: "" };
  return {
    isDraft: true,
    label: "DRAFT / BELUM FINAL",
    detail: `Data sementara sampai tanggal sinkron terakhir: ${formatJakartaDateTime(lastSyncedAt)}`,
  };
}

/** Nama file export untuk kombinasi jenis laporan + periode. */
export function financialExportFileName(kind: FinancialReportKind | "excel", period: string): string {
  // Validasi bentuk periode sebelum dipakai di nama file (mencegah path aneh).
  splitPeriod(period);
  if (kind === "excel") return `laporan-keuangan-${period}.xlsx`;
  return `${kind}-${period}.pdf`;
}

/**
 * Sanitasi teks bebas (mis. nama akun) untuk dipakai SEBAGAI BAGIAN NAMA FILE
 * saja — tidak pernah dipakai untuk isi laporan (isi laporan tetap memakai
 * nama akun asli). Setiap karakter di luar alfanumerik (spasi, slash, tanda
 * baca, sisa Unicode) diringkas jadi satu strip, supaya nama file aman lintas
 * OS dan aman ditaruh mentah di header Content-Disposition.
 */
export function sanitizeForFileName(value: string): string {
  const ascii = String(value ?? "").normalize("NFKD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "");
  return ascii.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

/** Nama file export Buku Besar SATU akun: "Buku-Besar-<kode>-<nama>-<YYYY-MM>.pdf|xlsx". */
export function financialLedgerAccountExportFileName(kind: "pdf" | "excel", accountCode: string, accountName: string, period: string): string {
  splitPeriod(period);
  const code = sanitizeForFileName(accountCode) || "akun";
  const name = sanitizeForFileName(accountName);
  const ext = kind === "excel" ? "xlsx" : "pdf";
  return `Buku-Besar-${code}${name ? `-${name}` : ""}-${period}.${ext}`;
}

// ---------------------------------------------------------------------------
// Bentuk normalizedPayload (subset yang dibutuhkan) — sengaja longgar/opsional
// supaya tahan terhadap payload sebagian.
// ---------------------------------------------------------------------------

export interface ExportNode {
  name?: string | null;
  accountCode?: string | null;
  amount?: number | null;
  formattedAmount?: string | null;
  children?: ExportNode[] | null;
}
export interface ExportSection {
  amount?: number | null;
  formattedAmount?: string | null;
  children?: ExportNode[] | null;
}

export interface BalanceSheetPayload {
  assets?: ExportSection | null;
  liabilityCapital?: ExportSection | null;
  totals?: { totalAssets?: number; totalLiabilityCapital?: number; balanced?: boolean; difference?: number } | null;
}
export interface ProfitLossPayload {
  revenue?: ExportSection | null;
  costOfGoodsSold?: ExportSection | null;
  grossProfit?: ExportSection | null;
  operatingExpenses?: ExportSection | null;
  nonOperatingIncome?: ExportSection | null;
  nonOperatingExpenses?: ExportSection | null;
  netProfit?: ExportSection | null;
  totals?: Record<string, number> | null;
}
export interface CashFlowPayload {
  operational?: ExportSection | null;
  investing?: ExportSection | null;
  funding?: ExportSection | null;
  cashIncrease?: ExportSection | null;
  openingCash?: ExportSection | null;
  endingCash?: ExportSection | null;
  totals?: Record<string, number> | null;
}
export interface LedgerSummaryRow {
  accountCode?: string | null;
  accountName?: string | null;
  classification?: string | null;
  debit?: number | null;
  credit?: number | null;
  balance?: number | null;
  formattedDebit?: string | null;
  formattedCredit?: string | null;
  formattedBalance?: string | null;
}

// ---------------------------------------------------------------------------
// Baris laporan (untuk laporan berstruktur bagian/akun: Neraca, Laba Rugi,
// Arus Kas). Dipakai bersama oleh Excel & PDF.
// ---------------------------------------------------------------------------

export type StatementLineKind =
  | "section" // judul bagian tebal (mis. "Aset")
  | "group" //  sub-judul tebal (mis. "Aset Lancar")
  | "account" // baris akun: kode + nama + nilai
  | "line" //   baris nilai tanpa kode (mis. baris Arus Kas / "Pendapatan periode ini")
  | "subtotal" // "Total <grup>" — tebal, garis tipis
  | "total"; //  total besar (mis. "Total Aset", "Laba bersih") — tebal, garis tebal

export interface StatementLine {
  kind: StatementLineKind;
  code: string | null;
  label: string;
  amount: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function finiteAmount(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nodeAmount(node: unknown): number {
  return finiteAmount(isRecord(node) ? node.amount : undefined);
}
function sectionAmount(section: ExportSection | null | undefined): number {
  return finiteAmount(section?.amount);
}
function childrenOf(node: ExportNode | ExportSection | null | undefined): unknown[] {
  return node && Array.isArray(node.children) ? node.children : [];
}

/** Ratakan satu node: leaf → account; internal → group + rekursi + subtotal. */
function walkNode(node: unknown, out: StatementLine[]): void {
  if (!isRecord(node)) return;
  const kids = childrenOf(node);
  const label = decodeFinancialHtmlEntities(typeof node.name === "string" ? node.name.trim() : node.name == null ? "" : String(node.name).trim());
  if (kids.length > 0) {
    out.push({ kind: "group", code: null, label: label || "-", amount: null });
    for (const child of kids) walkNode(child, out);
    out.push({ kind: "subtotal", code: null, label: label ? `Total ${label}` : "Total", amount: nodeAmount(node) });
  } else {
    // Baris tanpa kode akun (mis. "Pendapatan periode ini" di bawah Modal) tetap
    // ditampilkan sebagai baris nilai biasa.
    const codeValue = node.accountCode;
    const code = (codeValue == null ? "" : String(codeValue)).trim() || null;
    out.push({ kind: code ? "account" : "line", code, label: label || "-", amount: nodeAmount(node) });
  }
}

/** Neraca → baris: Aset (+grup+total) lalu Kewajiban dan Modal (+grup+total). */
export function buildBalanceSheetLines(payload: BalanceSheetPayload): StatementLine[] {
  const lines: StatementLine[] = [];
  const safePayload = isRecord(payload) ? payload : {};
  const assets = (safePayload.assets as ExportSection | null | undefined) ?? null;
  const liabilityCapital = (safePayload.liabilityCapital as ExportSection | null | undefined) ?? null;
  const totals = isRecord(safePayload.totals) ? safePayload.totals : {};

  lines.push({ kind: "section", code: null, label: "Aset", amount: null });
  for (const child of childrenOf(assets)) walkNode(child, lines);
  lines.push({
    kind: "total",
    code: null,
    label: "Total Aset",
    amount: finiteAmount(totals.totalAssets, sectionAmount(assets)),
  });

  lines.push({ kind: "section", code: null, label: "Kewajiban dan Modal", amount: null });
  for (const child of childrenOf(liabilityCapital)) walkNode(child, lines);
  lines.push({
    kind: "total",
    code: null,
    label: "Total Kewajiban dan Modal",
    amount: finiteAmount(totals.totalLiabilityCapital, sectionAmount(liabilityCapital)),
  });

  return lines;
}

/** Baris akun dari children sebuah section (kode + nama + nilai). */
function accountLinesFromSection(section: ExportSection | null | undefined): StatementLine[] {
  const out: StatementLine[] = [];
  for (const child of childrenOf(section)) {
    // Di Laba Rugi struktur akun selalu satu tingkat (tanpa sub-grup) — bila
    // ada anak, tetap ratakan rekursif untuk aman.
    walkNode(child, out);
  }
  return out;
}

/** Laba Rugi → mengikuti urutan laporan resmi Olsera Mei 2026. */
export function buildProfitLossLines(payload: ProfitLossPayload): StatementLine[] {
  const safePayload = isRecord(payload) ? payload : {};
  const t = isRecord(safePayload.totals) ? safePayload.totals : {};
  const num = (key: string, fallback: number) =>
    typeof t[key] === "number" && Number.isFinite(t[key]) ? (t[key] as number) : fallback;

  const revenueSection = safePayload.revenue as ExportSection | null | undefined;
  const cogsSection = safePayload.costOfGoodsSold as ExportSection | null | undefined;
  const operatingExpensesSection = safePayload.operatingExpenses as ExportSection | null | undefined;
  const nonOperatingIncomeSection = safePayload.nonOperatingIncome as ExportSection | null | undefined;
  const nonOperatingExpensesSection = safePayload.nonOperatingExpenses as ExportSection | null | undefined;
  const revenue = num("revenue", sectionAmount(revenueSection));
  const cogs = num("costOfGoodsSold", sectionAmount(cogsSection));
  const grossProfit = num("grossProfit", revenue - cogs);
  const opex = num("operatingExpenses", sectionAmount(operatingExpensesSection));
  const nonOpIncome = num("nonOperatingIncome", sectionAmount(nonOperatingIncomeSection));
  const nonOpExpense = num("nonOperatingExpenses", sectionAmount(nonOperatingExpensesSection));
  const netProfit = num("netProfit", grossProfit - opex + nonOpIncome - nonOpExpense);

  const lines: StatementLine[] = [];

  lines.push({ kind: "group", code: null, label: "Pendapatan", amount: null });
  lines.push(...accountLinesFromSection(revenueSection));
  lines.push({ kind: "subtotal", code: null, label: "Total Pendapatan", amount: revenue });

  lines.push({ kind: "group", code: null, label: "Biaya pokok penjualan", amount: null });
  lines.push(...accountLinesFromSection(cogsSection));
  lines.push({ kind: "subtotal", code: null, label: "Total Biaya pokok penjualan", amount: cogs });

  lines.push({ kind: "total", code: null, label: "Laba kotor", amount: grossProfit });

  lines.push({ kind: "group", code: null, label: "Biaya Operasional", amount: null });
  lines.push(...accountLinesFromSection(operatingExpensesSection));
  lines.push({ kind: "subtotal", code: null, label: "Total Biaya Operasional", amount: opex });

  lines.push({ kind: "total", code: null, label: "Pendapatan bersih operasional", amount: grossProfit - opex });

  lines.push({ kind: "group", code: null, label: "Pendapatan non operasional", amount: null });
  lines.push(...accountLinesFromSection(nonOperatingIncomeSection));
  lines.push({ kind: "subtotal", code: null, label: "Total Pendapatan non operasional", amount: nonOpIncome });

  lines.push({ kind: "group", code: null, label: "Biaya non operasional", amount: null });
  lines.push(...accountLinesFromSection(nonOperatingExpensesSection));
  lines.push({ kind: "subtotal", code: null, label: "Total Biaya non operasional", amount: nonOpExpense });

  lines.push({ kind: "total", code: null, label: "Total pendapatan non operasional", amount: nonOpIncome - nonOpExpense });

  lines.push({ kind: "total", code: null, label: "Laba bersih", amount: netProfit });

  return lines;
}

/** Baris nilai tanpa kode akun (Arus Kas) dari children section. */
function cashLinesFromSection(section: ExportSection | null | undefined): StatementLine[] {
  return childrenOf(section).map((child) => ({
    kind: "line" as const,
    code: null,
    label: !isRecord(child) ? "-" : decodeFinancialHtmlEntities((child.name == null ? "" : String(child.name)).trim()) || "-",
    amount: nodeAmount(child),
  }));
}

/** Arus Kas → operasional / investasi / pendanaan + total kas. */
export function buildCashFlowLines(payload: CashFlowPayload): StatementLine[] {
  const safePayload = isRecord(payload) ? payload : {};
  const t = isRecord(safePayload.totals) ? safePayload.totals : {};
  const num = (key: string, fallback: number) =>
    typeof t[key] === "number" && Number.isFinite(t[key]) ? (t[key] as number) : fallback;

  const lines: StatementLine[] = [];

  lines.push({ kind: "group", code: null, label: "Aktivitas operasional", amount: null });
  const operational = safePayload.operational as ExportSection | null | undefined;
  const investing = safePayload.investing as ExportSection | null | undefined;
  const funding = safePayload.funding as ExportSection | null | undefined;
  const cashIncrease = safePayload.cashIncrease as ExportSection | null | undefined;
  const openingCash = safePayload.openingCash as ExportSection | null | undefined;
  const endingCash = safePayload.endingCash as ExportSection | null | undefined;
  lines.push(...cashLinesFromSection(operational));
  lines.push({ kind: "subtotal", code: null, label: "Total Aktivitas operasional", amount: num("operational", sectionAmount(operational)) });

  lines.push({ kind: "group", code: null, label: "Aktivitas Investasi", amount: null });
  lines.push(...cashLinesFromSection(investing));
  lines.push({ kind: "subtotal", code: null, label: "Total Aktivitas Investasi", amount: num("investing", sectionAmount(investing)) });

  lines.push({ kind: "group", code: null, label: "Aktivitas Pendanaan", amount: null });
  lines.push(...cashLinesFromSection(funding));
  lines.push({ kind: "subtotal", code: null, label: "Total Aktivitas Pendanaan", amount: num("funding", sectionAmount(funding)) });

  lines.push({ kind: "total", code: null, label: "Kenaikan/penurunan kas", amount: num("cashIncrease", sectionAmount(cashIncrease)) });
  lines.push({ kind: "total", code: null, label: "Saldo kas awal", amount: num("openingCash", sectionAmount(openingCash)) });
  lines.push({ kind: "total", code: null, label: "Saldo kas akhir", amount: num("endingCash", sectionAmount(endingCash)) });

  return lines;
}

// ---------------------------------------------------------------------------
// Fitur 2 — sembunyikan baris nominal nol (Neraca/Laba Rugi/Arus Kas). Dipakai
// bersama oleh Excel & PDF supaya aturan filtering konsisten & tidak
// diduplikasi. Pemeriksaan NUMERIK (line.amount === 0), bukan string.
//
// Tidak pernah membuang: section (header bagian wajib), subtotal, total —
// hanya baris "account"/"line" (baris detail) yang nilainya benar-benar nol.
// Bila sebuah "group" (sub-judul) kehilangan SELURUH baris detail di
// bawahnya (termasuk nested group) setelah difilter, heading grup itu ikut
// dibuang — subtotal penutupnya tetap tampil (dibutuhkan untuk rekonsiliasi).
// ---------------------------------------------------------------------------

export function filterZeroStatementLines(lines: StatementLine[]): StatementLine[] {
  const out: StatementLine[] = [];
  const cursor = { pos: 0 };
  while (cursor.pos < lines.length) {
    const line = lines[cursor.pos];
    if (line.kind === "group") {
      cursor.pos++;
      const groupOut: StatementLine[] = [];
      const hasDetail = collectStatementGroupBody(lines, cursor, groupOut);
      if (hasDetail) out.push(line, ...groupOut);
      if (cursor.pos < lines.length && lines[cursor.pos].kind === "subtotal") {
        out.push(lines[cursor.pos]); // subtotal penutup grup — tidak pernah dibuang
        cursor.pos++;
      }
      continue;
    }
    if (line.kind === "account" || line.kind === "line") {
      if (line.amount !== 0) out.push(line);
      cursor.pos++;
      continue;
    }
    out.push(line); // section / subtotal / total — tidak pernah dibuang
    cursor.pos++;
  }
  return out;
}

/** Ratakan isi satu grup sampai (TIDAK termasuk) subtotal penutupnya; return true bila ada baris detail tersisa di dalamnya (termasuk nested group). */
function collectStatementGroupBody(lines: StatementLine[], cursor: { pos: number }, out: StatementLine[]): boolean {
  let hasDetail = false;
  while (cursor.pos < lines.length) {
    const line = lines[cursor.pos];
    if (line.kind === "subtotal") return hasDetail; // batas: subtotal penutup grup ini, jangan dikonsumsi di sini
    if (line.kind === "group") {
      cursor.pos++;
      const nestedOut: StatementLine[] = [];
      const nestedHasDetail = collectStatementGroupBody(lines, cursor, nestedOut);
      if (nestedHasDetail) {
        out.push(line, ...nestedOut);
        hasDetail = true;
      }
      if (cursor.pos < lines.length && lines[cursor.pos].kind === "subtotal") {
        out.push(lines[cursor.pos]);
        cursor.pos++;
      }
      continue;
    }
    if (line.kind === "account" || line.kind === "line") {
      if (line.amount !== 0) {
        out.push(line);
        hasDetail = true;
      }
      cursor.pos++;
      continue;
    }
    out.push(line); // section/total tidak semestinya bersarang di sini — dipertahankan defensif
    cursor.pos++;
  }
  return hasDetail;
}

// ---------------------------------------------------------------------------
// Ringkasan Buku Besar
// ---------------------------------------------------------------------------

export interface LedgerSummaryExportRow {
  code: string;
  name: string;
  classification: string;
  debit: number;
  credit: number;
  balance: number;
  hasMovement: boolean;
}

export function buildLedgerSummaryRows(rows: LedgerSummaryRow[] | null | undefined): LedgerSummaryExportRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is LedgerSummaryRow => isRecord(row)).map((row) => {
    const debit = typeof row.debit === "number" && Number.isFinite(row.debit) ? row.debit : 0;
    const credit = typeof row.credit === "number" && Number.isFinite(row.credit) ? row.credit : 0;
    const balance = typeof row.balance === "number" && Number.isFinite(row.balance) ? row.balance : 0;
    return {
      code: (row.accountCode ?? "").toString().trim() || "-",
      name: decodeFinancialHtmlEntities((row.accountName ?? "").toString().trim()) || "-",
      classification: decodeFinancialHtmlEntities((row.classification ?? "").toString().trim()) || "-",
      debit,
      credit,
      balance,
      hasMovement: debit !== 0 || credit !== 0 || balance !== 0,
    };
  });
}

/** Fitur 2 — baris Ringkasan Buku Besar dengan debit=kredit=saldo=0 disembunyikan. */
export function filterZeroLedgerSummaryRows(rows: LedgerSummaryExportRow[]): LedgerSummaryExportRow[] {
  return rows.filter((row) => row.hasMovement);
}

// ---------------------------------------------------------------------------
// Buku Besar Detail — pengelompokan per akun
// ---------------------------------------------------------------------------

export interface LedgerEntryInput {
  accountCode?: string | null;
  accountName?: string | null;
  transactionDate?: string | null;
  formattedTransactionDate?: string | null;
  transactionNo?: string | null;
  description?: string | null;
  debit?: number | null;
  credit?: number | null;
  balance?: number | null;
  isOpeningBalance?: boolean | null;
}

export interface LedgerDetailEntry {
  date: string;
  transactionNo: string;
  description: string;
  debit: number;
  credit: number;
  /** Saldo berjalan dari sumber (Olsera famount), bukan hasil hitung ulang. */
  balance: number | null;
  isOpeningBalance: boolean;
}
export interface LedgerDetailGroup {
  code: string;
  name: string;
  entries: LedgerDetailEntry[];
  totalDebit: number;
  totalCredit: number;
}

/**
 * Kelompokkan seluruh baris ledger periode menjadi grup per akun (kode+nama),
 * urut kode akun. Total debit/kredit per akun mengecualikan baris saldo awal
 * (konsisten dengan getFinancialLedgerMovementTotals). Nama akun diambil dari
 * baris, lalu fallback ke katalog akun bila kosong.
 */
export function buildLedgerDetailGroups(
  entries: LedgerEntryInput[],
  accountNameByCode: Map<string, string> = new Map(),
): LedgerDetailGroup[] {
  const groups = new Map<string, LedgerDetailGroup>();
  const order: string[] = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isRecord(entry)) continue;
    const code = (entry.accountCode ?? "").toString().trim() || "-";
    if (!groups.has(code)) {
      order.push(code);
      groups.set(code, {
        code,
        name: decodeFinancialHtmlEntities((entry.accountName ?? "").toString().trim()) || decodeFinancialHtmlEntities(accountNameByCode.get(code)) || "-",
        entries: [],
        totalDebit: 0,
        totalCredit: 0,
      });
    }
    const group = groups.get(code)!;
    if ((!group.name || group.name === "-") && entry.accountName) group.name = decodeFinancialHtmlEntities(String(entry.accountName).trim());

    const debit = typeof entry.debit === "number" && Number.isFinite(entry.debit) ? entry.debit : 0;
    const credit = typeof entry.credit === "number" && Number.isFinite(entry.credit) ? entry.credit : 0;
    const isOpening = entry.isOpeningBalance === true;
    // Fitur 2: baris transaksi dengan debit=0 DAN kredit=0 disembunyikan dari
    // tampilan, KECUALI baris saldo awal (selalu tampil). Total tetap dihitung
    // dari seluruh baris (baris nol tidak mengubah jumlah).
    if (!isHiddenZeroLedgerRow(debit, credit, isOpening)) {
      const display = deriveLedgerRowDisplay(entry);
      const balance = typeof entry.balance === "number" && Number.isFinite(entry.balance) ? entry.balance : null;
      group.entries.push({
        date: isOpening ? "Saldo Awal" : display.date,
        transactionNo: display.transactionNo,
        description: display.description,
        debit,
        credit,
        balance,
        isOpeningBalance: isOpening,
      });
    }
    if (!isOpening) {
      group.totalDebit += debit;
      group.totalCredit += credit;
    }
  }

  return order.map((code) => groups.get(code)!);
}

/** Fitur 2 — true bila baris transaksi (bukan saldo awal) boleh disembunyikan (debit=0 DAN kredit=0). */
function isHiddenZeroLedgerRow(debit: number, credit: number, isOpeningBalance: boolean): boolean {
  return !isOpeningBalance && debit === 0 && credit === 0;
}

/** Tanggal/no. jurnal/deskripsi tampilan dari satu baris ledger mentah — dipakai buildLedgerDetailGroups & buildLedgerAccountDetail. */
function deriveLedgerRowDisplay(entry: LedgerEntryInput): { date: string; transactionNo: string; description: string } {
  const dateValue = entry.formattedTransactionDate ?? entry.transactionDate;
  const dateText = dateValue == null ? "" : String(dateValue).trim();
  // Metadata seperti total/count tidak boleh masuk sebagai tanggal laporan.
  const date = dateText && !/^\d+$/.test(dateText) ? dateText : "-";
  const transactionNoText = (entry.transactionNo ?? "").toString().trim();
  const transactionNo = date === "-" && /^\d+$/.test(transactionNoText) ? "-" : transactionNoText || "-";
  return {
    date: decodeFinancialHtmlEntities(date),
    transactionNo: decodeFinancialHtmlEntities(transactionNo),
    description: decodeFinancialHtmlEntities((entry.description ?? "").toString().trim()) || "-",
  };
}

// ---------------------------------------------------------------------------
// Buku Besar Detail — SATU akun (Fitur 1: "Download Akun Ini")
// ---------------------------------------------------------------------------

export interface LedgerAccountDetailReport {
  code: string;
  name: string;
  /** Saldo berjalan pada baris saldo awal (0 bila tidak ada baris saldo awal). */
  openingBalance: number;
  /** Transaksi periode (baris saldo awal TIDAK ikut di sini — ditampilkan terpisah). */
  entries: LedgerDetailEntry[];
  totalDebit: number;
  totalCredit: number;
  /** = totalDebit - totalCredit, sama seperti "Pergerakan Periode" di UI. */
  movement: number;
  /** Saldo berjalan baris transaksi terakhir; fallback openingBalance + movement bila tidak tersedia. */
  endingBalance: number;
}

/**
 * Buku Besar Detail SATU akun — dipakai export "Download Akun Ini". Sumber
 * `entries` idealnya SUDAH difilter per akun oleh pemanggil (store query),
 * tapi fungsi ini tetap defensif memfilter ulang accountCode supaya aman
 * dites langsung dengan fixture campuran akun.
 */
export function buildLedgerAccountDetail(
  entries: LedgerEntryInput[],
  accountCode: string,
  accountNameByCode: Map<string, string> = new Map(),
): LedgerAccountDetailReport {
  const code = (accountCode ?? "").toString().trim();
  const rows = (Array.isArray(entries) ? entries : []).filter(
    (entry): entry is LedgerEntryInput => isRecord(entry) && (entry.accountCode ?? "").toString().trim() === code,
  );

  let name = "";
  let openingBalance = 0;
  let totalDebit = 0;
  let totalCredit = 0;
  let lastBalance: number | null = null;
  const detailEntries: LedgerDetailEntry[] = [];

  for (const entry of rows) {
    if (!name && entry.accountName) name = decodeFinancialHtmlEntities(String(entry.accountName).trim());
    const debit = typeof entry.debit === "number" && Number.isFinite(entry.debit) ? entry.debit : 0;
    const credit = typeof entry.credit === "number" && Number.isFinite(entry.credit) ? entry.credit : 0;
    const isOpening = entry.isOpeningBalance === true;
    const balanceValue = typeof entry.balance === "number" && Number.isFinite(entry.balance) ? entry.balance : null;

    if (isOpening) {
      if (balanceValue !== null) openingBalance = balanceValue;
      continue; // saldo awal ditampilkan sebagai field terpisah, bukan baris transaksi
    }

    totalDebit += debit;
    totalCredit += credit;
    if (balanceValue !== null) lastBalance = balanceValue;

    if (isHiddenZeroLedgerRow(debit, credit, false)) continue; // Fitur 2

    const display = deriveLedgerRowDisplay(entry);
    detailEntries.push({
      date: display.date,
      transactionNo: display.transactionNo,
      description: display.description,
      debit,
      credit,
      balance: balanceValue,
      isOpeningBalance: false,
    });
  }

  if (!name) name = decodeFinancialHtmlEntities(accountNameByCode.get(code) ?? "");
  const movement = totalDebit - totalCredit;
  const endingBalance = lastBalance !== null ? lastBalance : openingBalance + movement;

  return { code: code || "-", name: name || "-", openingBalance, entries: detailEntries, totalDebit, totalCredit, movement, endingBalance };
}

// ---------------------------------------------------------------------------
// Pemetaan error export → respons aman (dipakai kedua route). Tidak pernah
// memuat BSON/stack/payload mentah.
// ---------------------------------------------------------------------------

export type ExportFailureReason =
  | "invalid-period"
  | "invalid-account"
  | "snapshot-missing"
  | "invalid-payload"
  | "ledger-empty"
  | "generation-failed";

export function exportFailureResponse(reason: ExportFailureReason): { httpStatus: number; body: { status: string; message: string } } {
  switch (reason) {
    case "invalid-period":
      return { httpStatus: 400, body: { status: "invalid-period", message: "Periode tidak valid." } };
    case "invalid-account":
      return { httpStatus: 400, body: { status: "invalid-account", message: "Kode akun tidak valid." } };
    case "snapshot-missing":
      return {
        httpStatus: 404,
        body: { status: "snapshot-missing", message: "Snapshot laporan keuangan untuk periode ini belum tersedia. Lakukan Sync terlebih dahulu." },
      };
    case "invalid-payload":
      return {
        httpStatus: 422,
        body: { status: "invalid-payload", message: "Data snapshot laporan keuangan tidak lengkap untuk membuat laporan ini." },
      };
    case "ledger-empty":
      return { httpStatus: 404, body: { status: "ledger-empty", message: "Tidak ada data buku besar pada periode ini." } };
    case "generation-failed":
    default:
      return { httpStatus: 500, body: { status: "generation-failed", message: "Gagal membuat berkas laporan. Coba lagi." } };
  }
}
