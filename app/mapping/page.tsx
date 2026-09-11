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

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, FileText, Loader2, Moon, Sun } from "lucide-react";
import { analyzeFinancialPdf, type MappingParseResult, type FinancialLine, type ReconciliationCheck } from "@/lib/mapping-parser";
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

  const excelViews = useMemo((): Record<FinancialSheetKind, ReportView> => {
    const empty: ReportView = { state: "empty", note: "Unggah workbook Excel untuk melihat laporan ini." };
    const views: Record<FinancialSheetKind, ReportView> = { "profit-loss": empty, "balance-sheet": empty, cashflow: empty };
    if (excelBusy) {
      for (const kind of REPORT_ORDER) views[kind] = { state: "loading", note: "Membaca workbook..." };
      return views;
    }
    if (!sheets || !period) return views;
    for (const kind of REPORT_ORDER) {
      const sheet = sheets.find((s) => s.kind === kind);
      views[kind] = sheet
        ? excelResultToView(parseFinancialSheet(sheet, period))
        : { state: "unsupported", note: "Sheet ini tidak ada di workbook yang diunggah." };
    }
    return views;
  }, [sheets, period, excelBusy]);

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
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={excelBusy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onExcelPicked(file);
                event.currentTarget.value = "";
              }}
            />
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
              type="file"
              accept="application/pdf"
              disabled={pdfBusy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onPdfPicked(file);
                event.currentTarget.value = "";
              }}
            />
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
