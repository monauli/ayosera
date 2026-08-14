"use client";

import { Check, CircleAlert, FileSearch, Loader2 } from "lucide-react";
import { useState } from "react";

type ValidationStatus = "Cocok" | "Selisih" | "Data Belum Lengkap" | "Gagal Dicek";

const statusClass: Record<ValidationStatus, string> = {
  Cocok: "text-emerald-300",
  Selisih: "text-rose-300",
  "Data Belum Lengkap": "text-amber-300",
  "Gagal Dicek": "text-rose-300",
};

function Status({ value }: { value: ValidationStatus }) {
  return <span className={`text-xs font-semibold ${statusClass[value]}`}>{value}</span>;
}

function ValidationRow({ title, detail, status }: { title: string; detail: string; status: ValidationStatus }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/10 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-100">{title}</p>
          <p className="mt-1 text-xs text-slate-400">{detail}</p>
        </div>
        <Status value={status} />
      </div>
    </div>
  );
}
// Root cause Phase 1 production: status "Gagal Dicek" pernah dirender tanpa
// alasan sama sekali (backend sudah punya `detail`/`code`/`stage` tapi UI
// tidak pernah membacanya) — semua section sekarang WAJIB lewat sini.
function FailureReason({ section }: { section: { status?: string; detail?: string; code?: string } | undefined }) {
  if (section?.status !== "Gagal Dicek" || !section.detail) return null;
  return (
    <p className="mt-1 text-xs text-rose-300">
      {section.detail}
      {section.code ? ` (${section.code})` : ""}
    </p>
  );
}

function DetailList({ items }: { items: unknown[] | undefined }) {
  if (!items?.length) return null;
  return <div className="mt-2 space-y-1 text-xs text-slate-400">{items.slice(0, 10).map((item, index) => <div key={index} className="rounded bg-black/10 px-2 py-1">{typeof item === "string" ? item : JSON.stringify(item)}</div>)}</div>;
}

// Null-safe numeric display — sumber utama NaN production sebelumnya adalah
// subtraction langsung atas field yang bisa undefined. Semua angka di panel
// ini WAJIB lewat sini, tidak pernah subtraction/interpolasi mentah lagi.
function fmt(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("id-ID") : "-";
}
function fmtDelta(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("id-ID")}`;
}

type ReportTotals = Record<string, { ayosera: number | null; olsera: number | null; delta: number | null } | undefined>;

function TotalsTable({ title, totals }: { title: string; totals: ReportTotals | undefined }) {
  const keys = totals ? Object.keys(totals) : [];
  if (!keys.length) return null;
  return (
    <details className="mt-2 rounded-lg border border-white/10 bg-black/10 p-2">
      <summary className="cursor-pointer text-xs font-medium text-slate-200">{title}</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500"><tr><th className="pr-2 py-1">Field</th><th className="pr-2 py-1">AYOSERA</th><th className="pr-2 py-1">Olsera</th><th className="py-1">Delta</th></tr></thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key} className="border-t border-white/5 text-slate-300">
                <td className="pr-2 py-1">{key}</td>
                <td className="pr-2 py-1">{fmt(totals![key]?.ayosera)}</td>
                <td className="pr-2 py-1">{fmt(totals![key]?.olsera)}</td>
                <td className="py-1">{fmtDelta(totals![key]?.delta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

type LedgerDifference = { accountCode: string; name: unknown; ayosera: Record<string, unknown>; olsera: Record<string, unknown> };

function LedgerMismatchTable({ checked, differences }: { checked: number | undefined; differences: LedgerDifference[] | undefined }) {
  if (!differences?.length) return null;
  return (
    <details className="mt-2 rounded-lg border border-white/10 bg-black/10 p-2">
      <summary className="cursor-pointer text-xs font-medium text-slate-200">{differences.length} dari {fmt(checked)} akun mismatch — lihat detail</summary>
      <div className="mt-2 max-h-72 overflow-y-auto overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500"><tr><th className="pr-2 py-1">Kode</th><th className="pr-2 py-1">Nama</th><th className="pr-2 py-1">Debit A/O</th><th className="pr-2 py-1">Credit A/O</th><th className="py-1">Saldo A/O</th></tr></thead>
          <tbody>
            {differences.map((row) => (
              <tr key={row.accountCode} className="border-t border-white/5 text-slate-300">
                <td className="pr-2 py-1">{row.accountCode}</td>
                <td className="pr-2 py-1">{typeof row.name === "string" ? row.name : "-"}</td>
                <td className="pr-2 py-1">{fmt(row.ayosera?.debit)} / {fmt(row.olsera?.debit)}</td>
                <td className="pr-2 py-1">{fmt(row.ayosera?.credit)} / {fmt(row.olsera?.credit)}</td>
                <td className="py-1">{fmt(row.ayosera?.balance)} / {fmt(row.olsera?.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// Akhir bulan (ISO yyyy-mm-dd) dari period "YYYY-MM" — versi client-side dari
// lib/olsera-validation-sections.ts periodEnd (itu "server-only", tidak bisa
// diimpor ke client component ini), logika identik.
function periodEndClient(period: string): string {
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
}

// Phase 1: "Auto Fix Semua" HANYA menjalankan recovery yang sudah ada per
// source (Cek Gap -> Pulihkan Data lewat /api/private/integration-monitor,
// SAMA PERSIS endpoint yang dipakai panel Gap Data — bukan jalur baru) untuk
// Kategori/Inventori/Financial berurutan. Recovery = re-fetch/re-sync/rebuild
// resmi (lihat repairInventoryGap/repairFinancialGap/repairOlsera di route
// itu) — TIDAK PERNAH memaksa nilai stored disamakan begitu saja ke live,
// dan TIDAK PERNAH memaksa delta jadi 0. Repair hanya dipanggil bila Cek Gap
// SEGAR menunjukkan mismatch (source sudah
// Cocok -> dilewati, tidak ada yang perlu dipulihkan).
const AUTO_FIX_SOURCES = [
  { source: "olsera" as const, label: "Kategori", needsRepairStatus: "GAP_FOUND" },
  { source: "olsera-inventory" as const, label: "Inventori", needsRepairStatus: "Selisih" },
  { source: "olsera-financial" as const, label: "Financial", needsRepairStatus: "Selisih" },
];

export function OlseraValidationPanel() {
  const [period, setPeriod] = useState("2026-07");
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [stage, setStage] = useState(-1);
  const [stageError, setStageError] = useState<number | null>(null);
  const stages = ["Menghubungkan ke Olsera", "Memeriksa Kategori Penjualan", "Memeriksa Inventori", "Memeriksa Neraca, Laba Rugi & Arus Kas", "Memeriksa semua akun Buku Besar", "Menyusun hasil"];
  const validate = async () => { setBusy(true); setResult(null); setStageError(null); const merged: Record<string, any> = {}; try { for (let i = 0; i < stages.length; i++) { setStage(i); if (i === 0 || i === 5) continue; const section = i === 1 ? "category" : i === 2 ? "inventory" : "financial"; const response = await fetch(`/api/audit/olsera-validation?period=${period}&section=${section}`, { cache: "no-store" }); const body = await response.json(); Object.assign(merged, body); if (!response.ok || body[section]?.status === "Gagal Dicek") setStageError(i); } setStage(5); setResult(merged); setCheckedAt(merged.checkedAt ?? new Date().toISOString()); } catch { setStageError(stage < 0 ? 0 : stage); } finally { setBusy(false); } };
  const status = (key: string, fallback: ValidationStatus): ValidationStatus => result?.[key]?.status ?? fallback;

  const [autoFixBusy, setAutoFixBusy] = useState(false);
  const [autoFixStage, setAutoFixStage] = useState(-1);
  const [autoFixSourceErrors, setAutoFixSourceErrors] = useState<string[]>([]);
  const autoFixStages = ["Memeriksa masalah", "Memulihkan Kategori", "Memulihkan Inventori", "Memulihkan Financial", "Memvalidasi ulang", "Selesai"];
  const autoFixSemua = async () => {
    if (!window.confirm("Auto Fix Semua akan menjalankan re-fetch/rebuild resmi untuk Kategori, Inventori, dan Financial yang masih bermasalah pada periode ini. Data existing tidak ditimpa paksa — hanya dipulihkan dari source Olsera.")) return;
    setAutoFixBusy(true); setAutoFixStage(0); setAutoFixSourceErrors([]);
    const start = `${period}-01`, end = periodEndClient(period);
    const errors: string[] = [];
    try {
      setAutoFixStage(0);
      for (let i = 0; i < AUTO_FIX_SOURCES.length; i++) {
        const { source, label, needsRepairStatus } = AUTO_FIX_SOURCES[i];
        setAutoFixStage(i + 1);
        try {
          const checkRes = await fetch("/api/private/integration-monitor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, startDate: start, endDate: end, action: "check" }) });
          const checkBody = await checkRes.json();
          if (checkBody?.status === needsRepairStatus) {
            const repairRes = await fetch("/api/private/integration-monitor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, startDate: start, endDate: end, action: "repair" }) });
            const repairBody = await repairRes.json();
            if (repairBody?.status === "Gagal Dicek" || repairBody?.status === "MANUAL_REVIEW_REQUIRED" || repairBody?.status === "LOCKED") errors.push(`${label}: ${repairBody?.detail ?? repairBody?.status}`);
          }
        } catch {
          // Satu source gagal TIDAK menggagalkan seluruh Auto Fix — source
          // berikutnya tetap lanjut, source ini tetap tampil apa adanya
          // (Gagal Dicek/Selisih) setelah re-run validator di bawah.
          errors.push(`${label}: gagal dijalankan`);
        }
      }
      setAutoFixSourceErrors(errors);
      setAutoFixStage(4);
      await validate();
      setAutoFixStage(5);
    } finally { setAutoFixBusy(false); }
  };
  return (
    <section className="mt-6 rounded-xl border border-cyan-300/20 bg-cyan-950/20 p-4" aria-labelledby="olsera-validation-title">
      <div className="flex items-start gap-3">
        <FileSearch className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
        <div>
          <h2 id="olsera-validation-title" className="text-base font-semibold text-slate-100">Validasi Data Olsera</h2>
          <p className="mt-1 text-sm text-slate-400">Pusat diagnostic pembanding AYOSERA dengan source Olsera resmi. Tidak ada adjustment atau finalisasi otomatis.</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input aria-label="Periode validasi Olsera" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-100" />
        <button type="button" onClick={() => void validate()} disabled={busy || autoFixBusy || !period} className="rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">{busy ? "Sedang memeriksa data Olsera..." : "Validasi Sekarang"}</button>
        <button type="button" onClick={() => void autoFixSemua()} disabled={busy || autoFixBusy || !period} className="rounded-md border border-amber-300/40 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-200 disabled:opacity-50">{autoFixBusy ? "Auto Fix berjalan..." : "Auto Fix Semua"}</button>
        {checkedAt && <span className="text-xs text-slate-400">Terakhir dicek: {new Date(checkedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</span>}
      </div>
      {busy && <div className="mt-4 space-y-2 rounded-lg border border-white/10 bg-black/10 p-3">{stages.map((label, index) => <div key={label} className="flex items-center gap-2 text-xs">{stageError === index ? <CircleAlert className="h-4 w-4 text-rose-300" /> : stage > index ? <Check className="h-4 w-4 text-emerald-300" /> : stage === index ? <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> : <span className="h-4 w-4 rounded-full border border-white/20" />}<span className={stage === index ? "text-cyan-200" : stage > index ? "text-emerald-200" : stageError === index ? "text-rose-200" : "text-slate-500"}>{label}</span></div>)}</div>}
      {autoFixStage >= 0 && (
        <div className="mt-4 space-y-2 rounded-lg border border-amber-300/20 bg-amber-950/10 p-3">
          {autoFixStages.map((label, index) => (
            <div key={label} className="flex items-center gap-2 text-xs">
              {autoFixStage > index ? <Check className="h-4 w-4 text-emerald-300" /> : autoFixStage === index && autoFixBusy ? <Loader2 className="h-4 w-4 animate-spin text-amber-300" /> : autoFixStage === index ? <Check className="h-4 w-4 text-emerald-300" /> : <span className="h-4 w-4 rounded-full border border-white/20" />}
              <span className={autoFixStage === index ? "text-amber-200" : autoFixStage > index ? "text-emerald-200" : "text-slate-500"}>{label}</span>
            </div>
          ))}
          {autoFixSourceErrors.length > 0 && (
            <div className="mt-1 space-y-0.5 border-t border-amber-300/10 pt-2">
              {autoFixSourceErrors.map((line) => <p key={line} className="text-xs text-rose-300">{line} — tetap tampil apa adanya, source lain tetap lanjut diproses.</p>)}
            </div>
          )}
        </div>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">1. Kategori Penjualan</h3>
          <ValidationRow title="Periode dan kategori" detail={result?.category ? `AYOSERA ${fmt(result.category.ayosera?.qty)} qty / Rp ${fmt(result.category.ayosera?.total)} · Olsera Live ${fmt(result.category.olseraLive?.qty)} qty / Rp ${fmt(result.category.olseraLive?.total)} · Delta qty ${fmtDelta(result.category.delta?.qty)} / nominal ${fmtDelta(result.category.delta?.total)}` : "Tekan Validasi Sekarang untuk mengambil API Olsera live."} status={status("category", "Data Belum Lengkap")} />
          <FailureReason section={result?.category} />
          <DetailList items={result?.category?.differences} />
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">2. Inventori</h3>
          <ValidationRow title="API stockmovement live" detail={result?.inventory ? `${result.inventory.matching ?? 0} / ${result.inventory.checked ?? 0} stored item Cocok · ${result.inventory.liveItems ?? 0} item live · ${result.inventory.differences?.length ?? 0} Selisih${result.inventory.reason ? ` · ${result.inventory.reason}` : ""}` : "Tekan Validasi Sekarang untuk mengambil API Olsera live."} status={status("inventory", "Data Belum Lengkap")} />
          <FailureReason section={result?.inventory} />
          <DetailList items={result?.inventory?.differences} />
          <p className="mt-2 text-xs text-slate-400">BA Stock Opname tetap diagnostic terpisah: tidak menjadi satu-satunya pembanding.</p>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">3. Laporan Keuangan</h3>
          <ValidationRow title="Neraca, Laba Rugi, Arus Kas" detail="Dibandingkan dengan snapshot AYOSERA menggunakan response API live." status={result?.financial ? (result.financial.status === "Cocok" ? "Cocok" : result.financial.status) : "Data Belum Lengkap"} />
          <FailureReason section={result?.financial} />
          <TotalsTable title={`Neraca — ${result?.financial?.balanceSheet?.status ?? "Data Belum Lengkap"}`} totals={result?.financial?.balanceSheet?.totals} />
          <TotalsTable title={`Laba Rugi — ${result?.financial?.profitLoss?.status ?? "Data Belum Lengkap"}`} totals={result?.financial?.profitLoss?.totals} />
          <TotalsTable title={`Arus Kas — ${result?.financial?.cashFlow?.status ?? "Data Belum Lengkap"}`} totals={result?.financial?.cashFlow?.totals} />
          <ValidationRow title="Buku Besar" detail={result?.financial?.ledgerAccounts ? `${result.financial.ledgerAccounts.checked} akun dicek dari API live, ${result.financial.ledgerAccounts.matching} cocok.` : "Semua akun dicek saat validasi live."} status={result?.financial?.ledgerSummary?.status ?? "Data Belum Lengkap"} />
          <LedgerMismatchTable checked={result?.financial?.ledgerAccounts?.checked} differences={result?.financial?.ledgerAccounts?.differences} />
        </div>
      </div>

    </section>
  );
}
