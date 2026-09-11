"use client";

// Modul Mapping — TAHAP 3: halaman + dua panel unggah.
//
// Halaman ini SENGAJA belum membandingkan apa pun. Tugasnya hanya menampilkan
// hasil baca dua sumber berdampingan supaya bisa diperiksa mata: Excel di
// kiri, PDF di kanan. Aturan pengelompokan, perbandingan kiri-kanan,
// penyimpanan, dan kunci periode adalah Tahap 4 dan 5.
//
// Yang TIDAK boleh disembunyikan di sini: hasil pengaman aritmatika. Parser
// PDF (lib/mapping-parser.ts) dan parser Excel (lib/mapping-excel-parser.ts)
// MENOLAK dokumen yang subtotalnya tidak cocok dengan jumlah baris detail,
// karena kegagalan baca pada laporan keuangan bersifat senyap — angkanya tetap
// terlihat masuk akal. Penolakan itu ditampilkan lengkap dengan selisih tiap
// cek, bukan sekadar "gagal".

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, FileText, Loader2, Moon, Sun } from "lucide-react";
import { analyzeFinancialPdf, type MappingParseResult, type FinancialLine, type ReconciliationCheck } from "@/lib/mapping-parser";
import { compareFinancialReports, type ComparisonRow, type ComparisonStatus } from "@/lib/mapping-compare";
import {
  detectMonthColumns,
  parseFinancialSheet,
  type ExcelParseResult,
  type ExcelReportSheet,
  type FinancialSheetKind,
} from "@/lib/mapping-excel-parser";
import { readInitialThemeMode, THEME_MODE_STORAGE_KEY, type ThemeMode } from "@/lib/theme-mode";

type SessionUser = { id: string; role: "supervisor" | "user"; allowedModules: string[] };
type UploadedFile = { url: string; fileName: string; size: number; uploadedAt: string };

const REPORT_TITLES: Record<FinancialSheetKind, string> = {
  "profit-loss": "Laba Rugi",
  "balance-sheet": "Neraca",
  cashflow: "Arus Kas",
};
const REPORT_ORDER: FinancialSheetKind[] = ["profit-loss", "balance-sheet", "cashflow"];

const STATUS_LABEL: Record<ComparisonStatus, string> = {
  COCOK: "Cocok",
  BEDA: "Beda",
  HANYA_EXCEL: "Hanya di Excel",
  HANYA_PDF: "Hanya di PDF",
};
const STATUS_TONE: Record<ComparisonStatus, "ok" | "warn" | "danger" | "neutral"> = {
  COCOK: "ok",
  BEDA: "danger",
  HANYA_EXCEL: "warn",
  HANYA_PDF: "warn",
};

const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

/** "2026-02" -> "Februari 2026". */
function periodLabel(period: string): string {
  const [year, month] = period.split("-");
  return `${MONTH_NAMES[Number(month) - 1] ?? month} ${year}`;
}

const AMOUNT_FORMAT = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function formatAmount(value: number | null): string {
  return value === null ? "" : AMOUNT_FORMAT.format(value);
}

/**
 * Bentuk tampilan bersama untuk keenam kotak laporan (3 Excel + 3 PDF), supaya
 * kedua panel memakai satu komponen dan penolakan tampil identik di mana pun.
 */
type ReportView =
  | { state: "empty"; note: string }
  | { state: "loading"; note: string }
  | { state: "unsupported"; note: string }
  | { state: "ok"; lines: readonly FinancialLine[]; checks: readonly ReconciliationCheck[]; note?: string }
  | { state: "rejected"; reason: string; failedChecks: readonly ReconciliationCheck[] };

function excelResultToView(result: ExcelParseResult): ReportView {
  return result.status === "ok"
    ? { state: "ok", lines: result.lines, checks: result.checks }
    : { state: "rejected", reason: result.reason, failedChecks: result.failedChecks };
}

function pdfResultToView(result: MappingParseResult, note: string): ReportView {
  if (result.status === "ok") {
    return { state: "ok", lines: result.lines, checks: result.checks, note };
  }
  // Parser PDF mencoba dua offset layout; yang ditampilkan adalah kegagalan
  // percobaan TERAKHIR supaya daftarnya tidak berisi dua set selisih untuk
  // masalah yang sama. Alasan lengkapnya tetap memuat keduanya.
  return { state: "rejected", reason: result.reason, failedChecks: result.attempts.at(-1)?.failedChecks ?? [] };
}

function checkSummary(check: ReconciliationCheck): string {
  if (Number.isNaN(check.difference)) return `${check.label}: tidak bisa diperiksa.`;
  const arah = check.difference > 0 ? "lebih besar" : "lebih kecil";
  return `${check.label}: jumlah baris detail ${formatAmount(check.actual)} — ${arah} ${formatAmount(Math.abs(check.difference))} dari angka tercetak ${formatAmount(check.expected)}.`;
}

function ReportBox({ title, view, open }: { title: string; view: ReportView; open: boolean }) {
  const badge =
    view.state === "ok" ? (
      <span className="recon-badge recon-badge-ok">
        <CheckCircle2 style={{ width: ".8rem", marginRight: ".2rem" }} /> Rekonsiliasi cocok
      </span>
    ) : view.state === "rejected" ? (
      <span className="recon-badge recon-badge-danger">Ditolak</span>
    ) : view.state === "loading" ? (
      <span className="recon-badge recon-badge-neutral">
        <Loader2 className="spin" style={{ width: ".8rem", marginRight: ".2rem" }} /> Membaca
      </span>
    ) : (
      <span className="recon-badge recon-badge-neutral">{view.state === "unsupported" ? "Belum didukung" : "Belum ada data"}</span>
    );

  return (
    <details className="mapping-report" open={open && view.state === "ok"}>
      <summary>
        <span>{title}</span>
        {badge}
      </summary>
      <div className="mapping-report-body">
        {view.state === "rejected" && (
          <div className="mapping-reject" role="alert">
            <h4>
              <AlertTriangle /> Dokumen ditolak pengaman aritmatika
            </h4>
            <p>Angka yang terbaca tidak cocok dengan total yang tercetak di dokumen, jadi hasil bacanya tidak dipakai.</p>
            {view.failedChecks.length > 0 && (
              <ul>
                {view.failedChecks.map((check, index) => (
                  <li key={`${check.label}-${index}`}>{checkSummary(check)}</li>
                ))}
              </ul>
            )}
            <p className="mapping-note">{view.reason}</p>
          </div>
        )}
        {(view.state === "empty" || view.state === "loading" || view.state === "unsupported") && <p className="mapping-note">{view.note}</p>}
        {view.state === "ok" && (
          <>
            {view.note && <p className="mapping-note">{view.note}</p>}
            <div className="mapping-lines">
              <table className="recon-table">
                <thead>
                  <tr>
                    <th>Akun</th>
                    <th>Keterangan</th>
                    <th>Nominal</th>
                  </tr>
                </thead>
                <tbody>
                  {view.lines.map((line, index) => (
                    <tr
                      key={`${line.label}-${index}`}
                      className={line.kind === "header" ? "mapping-line-header" : line.kind === "detail" ? undefined : "mapping-line-total"}
                    >
                      <td>{line.code ?? ""}</td>
                      <td>
                        {line.label}
                        {line.assumedZero && <small>Nominal tidak terbaca, diasumsikan 0 — tetap lolos rekonsiliasi.</small>}
                      </td>
                      <td>{formatAmount(line.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mapping-note">
              {view.lines.filter((l) => l.kind === "detail").length} baris detail · {view.checks.length} cek rekonsiliasi lolos
            </p>
          </>
        )}
      </div>
    </details>
  );
}

function ComparisonSection({
  comparison,
  showEmptyRows,
  onToggleEmptyRows,
}: {
  comparison: ReturnType<typeof compareFinancialReports>;
  showEmptyRows: boolean;
  onToggleEmptyRows: (next: boolean) => void;
}) {
  const { summary, rows, appliedRules, skippedRules } = comparison;
  const visible = showEmptyRows ? rows : rows.filter((row) => !row.emptyOnOneSide);
  return (
    <section className="mapping-compare" aria-label="Hasil perbandingan Laba Rugi">
      <header>
        <h2>Perbandingan Laba Rugi — Excel vs PDF</h2>
        <div className="mapping-summary">
          <span className="recon-badge recon-badge-ok">{summary.cocok} cocok</span>
          <span className={`recon-badge recon-badge-${summary.beda > 0 ? "danger" : "neutral"}`}>{summary.beda} beda</span>
          <span className="recon-badge recon-badge-warn">{summary.hanyaExcel} hanya di Excel</span>
          <span className="recon-badge recon-badge-warn">{summary.hanyaPdf} hanya di PDF</span>
          <span className="recon-badge recon-badge-neutral">{summary.nihilSebelah} di antaranya nihil</span>
        </div>
      </header>

      {/* Aturan pengelompokan ditampilkan sebagai keterangan, bukan disembunyikan
          di dalam kode — lihat lib/mapping-rules.ts. */}
      {appliedRules.length > 0 && (
        <ul className="mapping-rules">
          {appliedRules.map((rule) => (
            <li key={rule.target}>
              Aturan pengelompokan dipakai pada <strong>{rule.target}</strong>: {rule.note} (dijumlahkan di sisi {rule.combine === "excel" ? "Excel" : "PDF"}).
              {!rule.verified && " Aturan ini belum diverifikasi terhadap periode nyata."}
            </li>
          ))}
        </ul>
      )}
      {skippedRules.length > 0 && (
        <ul className="mapping-rules">
          {skippedRules.map(({ rule, missing }) => (
            <li key={rule.target}>
              Aturan <strong>{rule.target}</strong> dilewati karena baris ini tidak ada di periode terpilih: {missing.join(", ")}. Baris terkait ditampilkan
              tanpa penggabungan.
            </li>
          ))}
        </ul>
      )}

      <label className="mapping-toggle">
        <input type="checkbox" checked={showEmptyRows} onChange={(event) => onToggleEmptyRows(event.target.checked)} />
        Tampilkan juga {summary.nihilSebelah} akun nihil yang hanya ada di satu sisi
      </label>

      <div className="mapping-compare-wrap">
        <table className="recon-table">
          <thead>
            <tr>
              <th>Akun</th>
              <th>Keterangan</th>
              <th>Excel</th>
              <th>PDF</th>
              <th>Selisih</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row: ComparisonRow, index: number) => (
              <tr key={`${row.label}-${index}`}>
                <td>{row.code ?? ""}</td>
                <td>
                  {row.label}
                  {row.rule && <small className="mapping-rule-tag">{row.rule.note}</small>}
                  {row.matchedBy === "fuzzy" && row.excelLabel !== row.pdfLabel && (
                    <small>Dijodohkan walau label beda tipis: Excel &quot;{row.excelLabel}&quot; / PDF &quot;{row.pdfLabel}&quot;.</small>
                  )}
                </td>
                <td>{formatAmount(row.excelValue)}</td>
                <td>{formatAmount(row.pdfValue)}</td>
                <td>{row.difference === null ? "" : formatAmount(row.difference)}</td>
                <td>
                  <span className={`recon-badge recon-badge-${STATUS_TONE[row.status]}`}>{STATUS_LABEL[row.status]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length === 0 && <p className="mapping-note">Tidak ada baris untuk ditampilkan.</p>}
    </section>
  );
}

export default function MappingPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [mode, setMode] = useState<ThemeMode>("dark");

  const [excelFile, setExcelFile] = useState<UploadedFile | null>(null);
  const [sheets, setSheets] = useState<ExcelReportSheet[] | null>(null);
  const [excelBusy, setExcelBusy] = useState(false);
  const [excelError, setExcelError] = useState<string | null>(null);
  const [period, setPeriod] = useState<string>("");

  const [pdfFile, setPdfFile] = useState<UploadedFile | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfStatus, setPdfStatus] = useState<string>("");
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfResult, setPdfResult] = useState<{ source: string; result: MappingParseResult } | null>(null);
  const [showEmptyRows, setShowEmptyRows] = useState(false);
  // id stabil untuk menghubungkan <label htmlFor> ke <input type="file">.
  const excelInputId = useId();
  const pdfInputId = useId();

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.user ?? null))
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    const initial = readInitialThemeMode();
    setMode(initial);
    document.documentElement.setAttribute("data-mode", initial);
  }, []);

  /** Bulan yang tersedia diambil dari kolom bertanggal di sheet, bukan daftar tetap. */
  const availablePeriods = useMemo(() => {
    if (!sheets || sheets.length === 0) return [];
    return [...detectMonthColumns(sheets[0].rows).columns.keys()].sort();
  }, [sheets]);

  useEffect(() => {
    if (availablePeriods.length > 0 && !availablePeriods.includes(period)) {
      setPeriod(availablePeriods[availablePeriods.length - 1]);
    }
  }, [availablePeriods, period]);

  const upload = useCallback(async (file: File, kind: "excel" | "pdf") => {
    const body = new FormData();
    body.append("file", file);
    body.append("kind", kind);
    const response = await fetch("/api/mapping/upload", { method: "POST", body });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error ?? "Gagal mengunggah berkas.");
    return payload.data as UploadedFile & { sheets?: ExcelReportSheet[] };
  }, []);

  const onExcelPicked = useCallback(
    async (file: File) => {
      setExcelBusy(true);
      setExcelError(null);
      try {
        const data = await upload(file, "excel");
        setExcelFile({ url: data.url, fileName: data.fileName, size: data.size, uploadedAt: data.uploadedAt });
        setSheets(data.sheets ?? []);
      } catch (error) {
        setExcelError(error instanceof Error ? error.message : "Gagal mengunggah berkas.");
        setSheets(null);
        setExcelFile(null);
      } finally {
        setExcelBusy(false);
      }
    },
    [upload],
  );

  const onPdfPicked = useCallback(
    async (file: File) => {
      setPdfBusy(true);
      setPdfError(null);
      setPdfResult(null);
      setPdfStatus("Mengunggah...");
      try {
        const data = await upload(file, "pdf");
        setPdfFile({ url: data.url, fileName: data.fileName, size: data.size, uploadedAt: data.uploadedAt });
        // Parsing PDF terjadi di BROWSER: halaman hasil scan dirender ke canvas
        // lalu di-OCR, dan Canvas API tidak tersedia di serverless Vercel.
        const analysed = await analyzeFinancialPdf(file, setPdfStatus);
        setPdfResult(analysed);
      } catch (error) {
        setPdfError(error instanceof Error ? error.message : "Gagal membaca PDF.");
      } finally {
        setPdfBusy(false);
        setPdfStatus("");
      }
    },
    [upload],
  );

  /** Hasil parse tiap sheet untuk periode terpilih; dipakai panel DAN perbandingan. */
  const excelResults = useMemo((): Partial<Record<FinancialSheetKind, ExcelParseResult>> => {
    if (!sheets || !period) return {};
    const results: Partial<Record<FinancialSheetKind, ExcelParseResult>> = {};
    for (const kind of REPORT_ORDER) {
      const sheet = sheets.find((s) => s.kind === kind);
      if (sheet) results[kind] = parseFinancialSheet(sheet, period);
    }
    return results;
  }, [sheets, period]);

  const excelViews = useMemo((): Record<FinancialSheetKind, ReportView> => {
    const empty: ReportView = { state: "empty", note: "Unggah workbook Excel untuk melihat laporan ini." };
    const views: Record<FinancialSheetKind, ReportView> = { "profit-loss": empty, "balance-sheet": empty, cashflow: empty };
    if (excelBusy) {
      for (const kind of REPORT_ORDER) views[kind] = { state: "loading", note: "Membaca workbook..." };
      return views;
    }
    if (!sheets || !period) return views;
    for (const kind of REPORT_ORDER) {
      const result = excelResults[kind];
      views[kind] = result ? excelResultToView(result) : { state: "unsupported", note: "Sheet ini tidak ada di workbook yang diunggah." };
    }
    return views;
  }, [sheets, period, excelBusy, excelResults]);

  /**
   * Perbandingan hanya untuk LABA RUGI — keputusan pengguna di Tahap 4. Neraca
   * dan Arus Kas dari PDF belum punya parser, jadi tidak ada sisi kanannya
   * untuk dibandingkan.
   *
   * Dua-duanya WAJIB lolos pengaman aritmatika dulu. Membandingkan hasil baca
   * yang sudah ditolak hanya menghasilkan selisih palsu.
   */
  const comparison = useMemo(() => {
    const excel = excelResults["profit-loss"];
    if (!excel || excel.status !== "ok") return null;
    if (!pdfResult || pdfResult.result.status !== "ok") return null;
    return compareFinancialReports(excel.lines, pdfResult.result.lines, "profit-loss");
  }, [excelResults, pdfResult]);

  const pdfViews = useMemo((): Record<FinancialSheetKind, ReportView> => {
    // Parser PDF Tahap 1 HANYA membaca Laba Rugi. Neraca dan Arus Kas dari PDF
    // belum punya parser sendiri — ditampilkan apa adanya sebagai belum
    // didukung, BUKAN sebagai kotak kosong yang menyesatkan.
    const pending: ReportView = { state: "empty", note: "Unggah PDF laporan keuangan untuk melihat hasil bacanya." };
    const unsupported: ReportView = {
      state: "unsupported",
      note: "Parser PDF saat ini baru membaca Laba Rugi. Neraca dan Arus Kas dari PDF belum punya parser sendiri, jadi sisi kanan untuk kedua laporan ini masih kosong.",
    };
    const labaRugi: ReportView = pdfBusy
      ? { state: "loading", note: pdfStatus || "Membaca PDF..." }
      : pdfResult
        ? pdfResultToView(
            pdfResult.result,
            pdfResult.source === "pdf-scanned-ocr"
              ? "Dibaca lewat OCR (PDF hasil scan). Nominal diverifikasi ulang terhadap total yang tercetak."
              : "Dibaca dari text layer PDF (bukan OCR).",
          )
        : pending;
    return { "profit-loss": labaRugi, "balance-sheet": unsupported, cashflow: unsupported };
  }, [pdfResult, pdfBusy, pdfStatus]);

  if (user && !user.allowedModules.includes("mapping") && user.role !== "supervisor") {
    return (
      <main className="recon-page">
        <p className="recon-empty">Akses ditolak. Hubungi supervisor untuk meminta modul Mapping.</p>
      </main>
    );
  }

  return (
    <main className="recon-page">
      <header className="recon-header">
        <div>
          <Link href="/" className="recon-back">
            ← Kembali ke Dashboard
          </Link>
          <h1>Mapping Laporan Keuangan</h1>
          <p>
            Menampilkan laporan keuangan versi Excel dan versi PDF berdampingan. Perbandingan otomatis, aturan pengelompokan, dan penyimpanan belum aktif di
            tahap ini.
          </p>
        </div>
        <div style={{ display: "flex", gap: ".5rem" }}>
          <button
            type="button"
            className="recon-button secondary"
            aria-label={mode === "dark" ? "Ganti ke Light Mode" : "Ganti ke Dark Mode"}
            title={mode === "dark" ? "Light Mode" : "Dark Mode"}
            onClick={() =>
              setMode((current) => {
                const next: ThemeMode = current === "dark" ? "light" : "dark";
                document.documentElement.setAttribute("data-mode", next);
                window.localStorage.setItem(THEME_MODE_STORAGE_KEY, next);
                return next;
              })
            }
          >
            {mode === "dark" ? <Sun /> : <Moon />}
          </button>
        </div>
      </header>

      <section className="recon-filters" aria-label="Pilih periode">
        <label>
          Periode
          <select value={period} disabled={availablePeriods.length === 0} onChange={(event) => setPeriod(event.target.value)}>
            {availablePeriods.length === 0 && <option value="">Unggah Excel dulu</option>}
            {availablePeriods.map((value) => (
              <option key={value} value={value}>
                {periodLabel(value)}
              </option>
            ))}
          </select>
        </label>
      </section>

      {comparison ? (
        <ComparisonSection comparison={comparison} showEmptyRows={showEmptyRows} onToggleEmptyRows={setShowEmptyRows} />
      ) : (
        <section className="mapping-compare" aria-label="Hasil perbandingan Laba Rugi">
          <header>
            <h2>Perbandingan Laba Rugi — Excel vs PDF</h2>
          </header>
          <p className="mapping-note">
            {/* Perbandingan sengaja tidak jalan kalau salah satu sisi ditolak
                pengaman aritmatika — membandingkan angka yang sudah diketahui
                tidak bisa dipercaya hanya menghasilkan selisih palsu. */}
            Perbandingan tampil setelah Laba Rugi di KEDUA sisi terbaca dan lolos pengaman aritmatika. Neraca dan Arus Kas belum dibandingkan karena PDF-nya
            belum punya parser.
          </p>
        </section>
      )}

      <div className="mapping-panels">
        <section className="mapping-panel" aria-label="Sumber Excel">
          <div className="mapping-panel-head">
            <h2>
              <FileSpreadsheet style={{ width: "1rem", verticalAlign: "-.15rem", marginRight: ".35rem" }} />
              Excel laporan keuangan
            </h2>
            <p>Satu berkas berisi semua bulan. Pilih periode di atas untuk berpindah bulan tanpa unggah ulang.</p>
          </div>
          <div className="mapping-upload">
            {/* Input asli disembunyikan (tetap fokusable via keyboard) dan
                dipicu lewat <label htmlFor> bergaya tombol — pola yang sama
                dengan app/reconciliation/page.tsx. Menampilkan input file
                native apa adanya TIDAK bisa dipakai di sini: Preflight
                Tailwind v4 menghapus padding, border, dan background
                ::file-selector-button, sehingga area klik yang benar-benar
                membuka dialog mengecil jadi sebatas teksnya saja. */}
            <input
              id={excelInputId}
              type="file"
              className="recon-file-input-hidden"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={excelBusy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onExcelPicked(file);
                event.currentTarget.value = "";
              }}
            />
            <label htmlFor={excelInputId} className={`recon-button secondary recon-file-trigger${excelBusy ? " is-disabled" : ""}`}>
              <FileSpreadsheet size={14} /> Pilih File Excel
            </label>
            {excelBusy && (
              <span className="mapping-note">
                <Loader2 className="spin" style={{ width: ".9rem", verticalAlign: "-.15rem" }} /> Mengunggah dan membaca...
              </span>
            )}
          </div>
          {excelError && <p className="recon-error">{excelError}</p>}
          {excelFile && (
            <p className="mapping-note">
              {excelFile.fileName} · {(excelFile.size / 1024).toFixed(0)} KB · {availablePeriods.length} bulan terdeteksi
            </p>
          )}
          {REPORT_ORDER.map((kind) => (
            <ReportBox key={kind} title={REPORT_TITLES[kind]} view={excelViews[kind]} open={kind === "profit-loss"} />
          ))}
        </section>

        <section className="mapping-panel" aria-label="Sumber PDF">
          <div className="mapping-panel-head">
            <h2>
              <FileText style={{ width: "1rem", verticalAlign: "-.15rem", marginRight: ".35rem" }} />
              PDF laporan keuangan{period ? ` — ${periodLabel(period)}` : ""}
            </h2>
            <p>Unggah PDF untuk periode yang dipilih. PDF hasil scan dibaca lewat OCR di browser ini, bukan di server.</p>
          </div>
          <div className="mapping-upload">
            <input
              id={pdfInputId}
              type="file"
              className="recon-file-input-hidden"
              accept="application/pdf"
              disabled={pdfBusy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onPdfPicked(file);
                event.currentTarget.value = "";
              }}
            />
            <label htmlFor={pdfInputId} className={`recon-button secondary recon-file-trigger${pdfBusy ? " is-disabled" : ""}`}>
              <FileText size={14} /> Pilih File PDF
            </label>
            {pdfBusy && (
              <span className="mapping-note">
                <Loader2 className="spin" style={{ width: ".9rem", verticalAlign: "-.15rem" }} /> {pdfStatus || "Membaca..."}
              </span>
            )}
          </div>
          {pdfError && <p className="recon-error">{pdfError}</p>}
          {pdfFile && (
            <p className="mapping-note">
              {pdfFile.fileName} · {(pdfFile.size / 1024 / 1024).toFixed(1)} MB
            </p>
          )}
          {REPORT_ORDER.map((kind) => (
            <ReportBox key={kind} title={REPORT_TITLES[kind]} view={pdfViews[kind]} open={kind === "profit-loss"} />
          ))}
        </section>
      </div>
    </main>
  );
}
