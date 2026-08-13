"use client";

import { AlertTriangle, FileSearch } from "lucide-react";
import { useState } from "react";

type ValidationStatus = "Cocok" | "Selisih" | "Data Belum Lengkap" | "Belum Bisa Diverifikasi";

const statusClass: Record<ValidationStatus, string> = {
  Cocok: "text-emerald-300",
  Selisih: "text-rose-300",
  "Data Belum Lengkap": "text-amber-300",
  "Belum Bisa Diverifikasi": "text-slate-300",
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

export function OlseraValidationPanel() {
  const [period, setPeriod] = useState("2026-07");
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const validate = async () => { setBusy(true); try { const response = await fetch(`/api/audit/olsera-validation?period=${period}`, { cache: "no-store" }); const body = await response.json(); setResult(body); setCheckedAt(body.checkedAt ?? new Date().toISOString()); } finally { setBusy(false); } };
  const status = (key: string, fallback: ValidationStatus): ValidationStatus => result?.[key]?.status ?? fallback;
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
        <button type="button" onClick={() => void validate()} disabled={busy || !period} className="rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">{busy ? "Sedang memeriksa data Olsera..." : "Validasi Sekarang"}</button>
        {checkedAt && <span className="text-xs text-slate-400">Terakhir dicek: {new Date(checkedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</span>}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">1. Kategori Penjualan</h3>
          <ValidationRow title="Periode dan kategori" detail={result?.category ? `AYOSERA ${result.category.ayosera?.qty ?? "-"} qty / Olsera Live ${result.category.olseraLive?.qty ?? "-"} qty` : "Tekan Validasi Sekarang untuk mengambil API Olsera live."} status={status("category", "Data Belum Lengkap")} />
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">2. Inventori</h3>
          <ValidationRow title="API stockmovement live" detail={result?.inventory ? `${result.inventory.matching ?? 0} / ${result.inventory.checked ?? 0} item Cocok` : "Tekan Validasi Sekarang untuk mengambil stockmovement live."} status={status("inventory", "Data Belum Lengkap")} />
          <p className="mt-2 text-xs text-slate-400">BA Stock Opname tetap diagnostic terpisah: tidak menjadi satu-satunya pembanding.</p>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">3. Laporan Keuangan</h3>
          <ValidationRow title="Neraca, Laba Rugi, Arus Kas" detail="Dibandingkan dengan snapshot AYOSERA menggunakan response API live." status={result?.financial ? (result.financial.status === "Cocok" ? "Cocok" : result.financial.status) : "Data Belum Lengkap"} />
          <ValidationRow title="Buku Besar" detail={result?.financial?.ledgerAccounts ? `${result.financial.ledgerAccounts.checked} akun dicek dari API live.` : "Semua akun dicek saat validasi live."} status={result?.financial?.ledgerSummary?.status ?? "Data Belum Lengkap"} />
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300/20 bg-amber-950/10 p-3 text-xs text-amber-200">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>“Belum Bisa Diverifikasi” bukan PASS. Detail perbedaan inventori tetap tersedia di checker Berita Acara dan tidak difinalisasi otomatis.</span>
      </div>
    </section>
  );
}
