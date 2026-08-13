"use client";

import { AlertTriangle, FileSearch } from "lucide-react";

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
  return (
    <section className="mt-6 rounded-xl border border-cyan-300/20 bg-cyan-950/20 p-4" aria-labelledby="olsera-validation-title">
      <div className="flex items-start gap-3">
        <FileSearch className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
        <div>
          <h2 id="olsera-validation-title" className="text-base font-semibold text-slate-100">Validasi Data Olsera</h2>
          <p className="mt-1 text-sm text-slate-400">Pusat diagnostic pembanding AYOSERA dengan source Olsera resmi. Tidak ada adjustment atau finalisasi otomatis.</p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">1. Kategori Penjualan</h3>
          <ValidationRow title="Per periode dan kategori" detail="Qty, nominal, dan total memerlukan official report/export Olsera independen." status="Belum Bisa Diverifikasi" />
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">2. Inventori</h3>
          <ValidationRow title="BA cutoff 16 Juli 2026" detail="7/7 item terbaca; 3 Cocok, 4 Perlu Dicek. Movement 17 Juli tidak masuk cutoff." status="Selisih" />
          <p className="mt-2 text-xs text-amber-300">Perlu Dicek — diagnostic sumber Olsera/BA; angka tidak diubah.</p>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">3. Laporan Keuangan</h3>
          <ValidationRow title="Neraca, Laba Rugi, Arus Kas" detail="Report tersinkron dan dapat diekspor; pembanding independen belum tersedia." status="Belum Bisa Diverifikasi" />
          <ValidationRow title="Buku Besar" detail="Pengecekan semua akun menunggu source detail pembanding resmi." status="Belum Bisa Diverifikasi" />
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300/20 bg-amber-950/10 p-3 text-xs text-amber-200">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>“Belum Bisa Diverifikasi” bukan PASS. Detail perbedaan inventori tetap tersedia di checker Berita Acara dan tidak difinalisasi otomatis.</span>
      </div>
    </section>
  );
}
