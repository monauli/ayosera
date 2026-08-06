"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Lock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Health = { source: string; label: string; status: string; expiresAt: string | null; remainingDays: number | null; checkedAt: string; lastError: string | null; lastValidSource: string | null };
const sources = ["olsera", "ayo-booking", "ayo-payment-events"] as const;
const label: Record<(typeof sources)[number], string> = { olsera: "Olsera Sales", "ayo-booking": "AYO Booking", "ayo-payment-events": "AYO Payment Events" };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());

// Bedakan setiap kegagalan supaya panel tidak diam-diam menghilang — supervisor
// yang belum masuk allowlist AYOSERA_PRIVATE_TOOLS_USER_IDS harus melihat alasannya,
// bukan panel kosong yang terlihat seperti bug.
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; health: Health[] }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "error" };

export function PrivateIntegrationMonitor() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [source, setSource] = useState<(typeof sources)[number]>("ayo-booking"); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [busy, setBusy] = useState(false); const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const load = async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/private/integration-monitor", { cache: "no-store" });
      if (res.status === 401) { setState({ kind: "unauthenticated" }); return; }
      if (res.status === 403) { setState({ kind: "forbidden" }); return; }
      if (!res.ok) { setState({ kind: "error" }); return; }
      const data = await res.json();
      setState({ kind: "ready", health: Array.isArray(data.tokenHealth) ? data.tokenHealth : [] });
    } catch { setState({ kind: "error" }); }
  };
  useEffect(() => { const end = today(); const date = new Date(`${end}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 29); setFrom(date.toISOString().slice(0, 10)); setTo(end); void load(); }, []);
  const audit = async (action: "check" | "repair") => { const message = source === "olsera" ? "Tutup hanya order dan item yang terdeteksi hilang pada audit terakhir. Data existing tidak akan dihapus atau ditimpa." : "Tutup hanya data yang terdeteksi hilang pada audit terakhir. Data existing tidak akan dihapus atau ditimpa."; if (action === "repair" && !window.confirm(message)) return; setBusy(true); try { const res = await fetch("/api/private/integration-monitor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, startDate: from, endDate: to, action }) }); setResult(await res.json()); } finally { setBusy(false); } };

  if (state.kind === "loading") {
    return (
      <section className="mt-6 flex items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-950/20 p-4 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Memuat status integrasi...
      </section>
    );
  }

  if (state.kind === "unauthenticated") {
    return (
      <section className="mt-6 flex items-start gap-3 rounded-xl border border-amber-300/20 bg-amber-950/10 p-4">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <p className="text-sm text-amber-200">Sesi login tidak ditemukan. Silakan login ulang untuk mengakses modul ini.</p>
      </section>
    );
  }

  if (state.kind === "forbidden") {
    return (
      <section className="mt-6 flex items-start gap-3 rounded-xl border border-amber-300/20 bg-amber-950/10 p-4">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <div className="text-sm text-amber-200">
          <p>Akun supervisor ini belum diizinkan menggunakan Private Integration Tools.</p>
          <p className="mt-1 text-amber-300/80">Hubungi pengelola sistem untuk menambahkan user ID ke AYOSERA_PRIVATE_TOOLS_USER_IDS.</p>
        </div>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className="mt-6 flex items-start gap-3 rounded-xl border border-rose-300/20 bg-rose-950/10 p-4">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
        <div className="text-sm text-rose-200">
          <p>Gagal memuat status integrasi. Coba lagi beberapa saat lagi.</p>
          <Button type="button" variant="outline" className="mt-3" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" /> Coba Lagi
          </Button>
        </div>
      </section>
    );
  }

  const { health } = state;
  return <section className="mt-6 rounded-xl border border-cyan-300/20 bg-cyan-950/20 p-4"><div className="flex items-center justify-between gap-3"><div><h2 className="text-base font-semibold text-slate-100">Monitoring Integritas Data</h2><p className="mt-1 text-sm text-slate-400">Hanya metadata aman; token dan credential tidak pernah ditampilkan.</p></div><Button type="button" variant="outline" onClick={() => void load()} disabled={busy}><RefreshCw className="h-4 w-4" /> Periksa Sekarang</Button></div>{health.length === 0 ? <p className="mt-4 text-sm text-slate-400">Belum ada data status integrasi.</p> : <div className="mt-4 grid gap-3 sm:grid-cols-2">{health.map((item) => <div key={item.source} className="rounded-lg border border-white/10 bg-black/10 p-3"><div className="flex items-center justify-between gap-2"><b className="text-sm text-slate-100">{item.label}</b><span className="text-xs font-semibold text-cyan-200">{item.status}</span></div><p className="mt-2 text-xs text-slate-400">{item.expiresAt ? `Kedaluwarsa: ${new Date(item.expiresAt).toLocaleDateString("id-ID")} (${item.remainingDays} hari)` : "Expiry tidak diketahui"}</p><p className="text-xs text-slate-500">Sumber valid: {item.lastValidSource ?? "Belum ada"}</p>{item.lastError && <p className="text-xs text-rose-300">{item.lastError}</p>}</div>)}</div>}<div className="mt-4 border-t border-white/10 pt-4"><h3 className="text-sm font-semibold text-slate-100">Cek &amp; Tutup Gap Data</h3><div className="mt-3 grid gap-3 sm:grid-cols-4"><select aria-label="Sumber audit" value={source} onChange={(e) => setSource(e.target.value as typeof source)} className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-100">{sources.map((value) => <option key={value} value={value}>{label[value]}</option>)}</select><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} disabled={busy}/><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} disabled={busy}/><div className="flex gap-2"><Button type="button" onClick={() => void audit("check")} disabled={busy || !from || !to}>{busy && <Loader2 className="h-4 w-4 animate-spin"/>}Cek Gap</Button><Button type="button" variant="outline" onClick={() => void audit("repair")} disabled={busy || (result as { status?: string } | null)?.status !== "GAP_FOUND"}>Tutup Gap</Button></div></div>{result && <pre className="mt-3 overflow-auto rounded-md bg-black/20 p-3 text-xs text-slate-300">{JSON.stringify(result, null, 2)}</pre>}</div></section>;
}
