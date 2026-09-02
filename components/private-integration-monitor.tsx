"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Lock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type TokenHealthStatus = "AKTIF" | "AKAN_KEDALUWARSA" | "KEDALUWARSA" | "UNAUTHORIZED" | "TIDAK_DIKONFIGURASI" | "TEMPORARY" | "MANUAL_IMPORT_REQUIRED";
type Health = { source: string; label: string; status: TokenHealthStatus; expiresAt: string | null; remainingDays: number | null; checkedAt: string; lastError: string | null; lastValidSource: string | null };
type AyoTokenHealth = {
  status: "ACTIVE" | "EXPIRING_SOON" | "EXPIRED" | "EXPIRY_UNKNOWN" | "MANUAL_IMPORT_REQUIRED" | "INVALID" | "UNAVAILABLE";
  label: string;
  expiresAt: string | null;
  expirySource: "jwt" | "unknown";
  remainingDays: number | null;
  importedAt: string | null;
  lastSuccessfulCheck: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  recommendation: string;
};
type ModuleHealth = {
  module: string;
  label: string;
  status: "TERHUBUNG" | "BERMASALAH" | "BELUM_ADA_DATA";
  issue: "AKSES_API_BERMASALAH" | "TIMEOUT" | "TIDAK_BISA_TERHUBUNG" | "SERVER_SUMBER_BERMASALAH" | "DATA_TIDAK_VALID" | null;
  lastSuccessfulSyncAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};
type ConnectionHealth = {
  ayo: { booking: ModuleHealth; paymentEvents: ModuleHealth };
  olsera: { sales: ModuleHealth; inventory: ModuleHealth; financial: ModuleHealth; overall: { status: "TERHUBUNG" | "PERLU_DICEK"; problemModules: string[] } };
};
const CONNECTION_STATUS_LABEL: Record<ModuleHealth["status"], string> = { TERHUBUNG: "Terhubung", BERMASALAH: "Bermasalah", BELUM_ADA_DATA: "Belum Ada Data" };
const CONNECTION_ISSUE_LABEL: Record<NonNullable<ModuleHealth["issue"]>, string> = {
  AKSES_API_BERMASALAH: "Akses API Bermasalah",
  TIMEOUT: "Timeout",
  TIDAK_BISA_TERHUBUNG: "Tidak Bisa Terhubung",
  SERVER_SUMBER_BERMASALAH: "Server Sumber Bermasalah",
  DATA_TIDAK_VALID: "Data Tidak Valid",
};
const CONNECTION_STATUS_COLOR: Record<ModuleHealth["status"], string> = {
  TERHUBUNG: "text-emerald-300",
  BERMASALAH: "text-rose-300",
  BELUM_ADA_DATA: "text-slate-400",
};
function ConnectionHealthCard({ item }: { item: ModuleHealth }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <b className="text-sm text-slate-100">{item.label}</b>
        <span className={`text-xs font-semibold ${CONNECTION_STATUS_COLOR[item.status]}`}>{CONNECTION_STATUS_LABEL[item.status]}</span>
      </div>
      <p className="mt-2 text-xs text-slate-400">Terakhir berhasil: {item.lastSuccessfulSyncAt ? jakartaDateTime(item.lastSuccessfulSyncAt) : "Belum ada"}</p>
      {item.status === "BERMASALAH" && (
        <p className="mt-1 text-xs text-rose-300">
          Masalah terakhir: {item.issue ? CONNECTION_ISSUE_LABEL[item.issue] : "Tidak diketahui"}
          {item.lastError ? ` — ${item.lastError}` : ""}
        </p>
      )}
    </div>
  );
}

const jakartaDateTime = (value: string) => new Date(value).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" });
const AYO_TOKEN_STATUS_COLOR: Record<AyoTokenHealth["status"], string> = {
  ACTIVE: "text-emerald-300",
  EXPIRING_SOON: "text-amber-300",
  EXPIRED: "text-rose-300",
  EXPIRY_UNKNOWN: "text-slate-300",
  MANUAL_IMPORT_REQUIRED: "text-amber-300",
  INVALID: "text-rose-300",
  UNAVAILABLE: "text-slate-400",
};
// Status Indonesia dari classifyTokenHealth() (lib/private-integration-monitor.ts) — pola sama
// dengan AYO_TOKEN_STATUS_COLOR di atas, key set beda karena sumbernya beda fungsi/bahasa.
const TOKEN_HEALTH_STATUS_COLOR: Record<TokenHealthStatus, string> = {
  AKTIF: "text-cyan-200",
  AKAN_KEDALUWARSA: "text-amber-300",
  KEDALUWARSA: "text-rose-300",
  UNAUTHORIZED: "text-rose-300",
  TIDAK_DIKONFIGURASI: "text-slate-400",
  TEMPORARY: "text-slate-300",
  MANUAL_IMPORT_REQUIRED: "text-amber-300",
};

// Bedakan setiap kegagalan supaya panel tidak diam-diam menghilang — akun tanpa
// modul "audit" harus melihat alasannya, bukan panel kosong yang terlihat seperti bug.
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; health: Health[]; ayoMobileToken: AyoTokenHealth | null; connectionHealth: ConnectionHealth | null }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "error" };

export function PrivateIntegrationMonitor() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const load = async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/private/integration-monitor", { cache: "no-store" });
      if (res.status === 401) { setState({ kind: "unauthenticated" }); return; }
      if (res.status === 403) { setState({ kind: "forbidden" }); return; }
      if (!res.ok) { setState({ kind: "error" }); return; }
      const data = await res.json();
      setState({ kind: "ready", health: Array.isArray(data.tokenHealth) ? data.tokenHealth : [], ayoMobileToken: data.ayoMobileToken ?? null, connectionHealth: data.connectionHealth ?? null });
    } catch { setState({ kind: "error" }); }
  };
  useEffect(() => { void load(); }, []);

  if (state.kind === "loading") {
    return (
      <section className="pim-panel mt-6 flex items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-950/20 p-4 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Memuat status integrasi...
      </section>
    );
  }

  if (state.kind === "unauthenticated") {
    return (
      <section className="pim-panel mt-6 flex items-start gap-3 rounded-xl border border-amber-300/20 bg-amber-950/10 p-4">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <p className="text-sm text-amber-200">Sesi login tidak ditemukan. Silakan login ulang untuk mengakses modul ini.</p>
      </section>
    );
  }

  if (state.kind === "forbidden") {
    return (
      <section className="pim-panel mt-6 flex items-start gap-3 rounded-xl border border-amber-300/20 bg-amber-950/10 p-4">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <div className="text-sm text-amber-200">
          <p>Akun ini belum memiliki akses ke modul Audit &amp; Sinkronisasi.</p>
          <p className="mt-1 text-amber-300/80">Hubungi supervisor untuk mengaktifkan modul ini lewat menu Pengguna.</p>
        </div>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className="pim-panel mt-6 flex items-start gap-3 rounded-xl border border-rose-300/20 bg-rose-950/10 p-4">
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

  const { health, ayoMobileToken, connectionHealth } = state;
  // AYO Mobile Token punya kartu khusus di bawah (lebih detail); jangan tampilkan dua kali di grid generik.
  const otherHealth = health.filter((item) => item.source !== "ayo-mobile");

  return (
    <section className="pim-panel mt-6 rounded-xl border border-cyan-300/20 bg-cyan-950/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Monitoring Integritas Data</h2>
          <p className="mt-1 text-sm text-slate-400">Hanya metadata aman; token dan credential tidak pernah ditampilkan.</p>
        </div>
        <Button type="button" variant="outline" onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" /> Periksa Sekarang
        </Button>
      </div>

      {ayoMobileToken && (
        <div className="mt-4 rounded-lg border border-white/10 bg-black/10 p-3">
          <div className="flex items-center justify-between gap-2">
            <b className="text-sm text-slate-100">AYO Mobile Token</b>
            <span className={`text-xs font-semibold ${AYO_TOKEN_STATUS_COLOR[ayoMobileToken.status]}`}>{ayoMobileToken.label}</span>
          </div>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-slate-400 sm:grid-cols-2">
            <div>
              <dt className="inline text-slate-500">Sumber validasi: </dt>
              <dd className="inline">{ayoMobileToken.expirySource === "jwt" ? "Klaim exp JWT" : "Tidak ada metadata resmi (token opaque)"}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Expiry: </dt>
              <dd className="inline">{ayoMobileToken.expiresAt ? `${new Date(ayoMobileToken.expiresAt).toLocaleDateString("id-ID")} (${ayoMobileToken.remainingDays} hari)` : "Tidak diketahui"}</dd>
            </div>
            {ayoMobileToken.importedAt && (
              <div>
                <dt className="inline text-slate-500">Imported at: </dt>
                <dd className="inline">{jakartaDateTime(ayoMobileToken.importedAt)}</dd>
              </div>
            )}
            <div>
              <dt className="inline text-slate-500">Last successful check: </dt>
              <dd className="inline">{ayoMobileToken.lastSuccessfulCheck ? jakartaDateTime(ayoMobileToken.lastSuccessfulCheck) : "Belum ada"}</dd>
            </div>
          </dl>
          {ayoMobileToken.lastError && <p className="mt-2 text-xs text-rose-300">Last error: {ayoMobileToken.lastError}</p>}
          <p className="mt-2 text-xs text-slate-400">{ayoMobileToken.recommendation}</p>
        </div>
      )}

      {otherHealth.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">Belum ada data status integrasi lainnya.</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {otherHealth.map((item) => {
            const isExpiringSoon = item.status === "AKAN_KEDALUWARSA";
            return (
              <div key={item.source} className={`rounded-lg border p-3 ${isExpiringSoon ? "border-amber-300/20 bg-amber-950/10" : "border-white/10 bg-black/10"}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    {isExpiringSoon && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
                    <b className="text-sm text-slate-100">{item.label}</b>
                  </div>
                  <span className={`text-xs font-semibold ${TOKEN_HEALTH_STATUS_COLOR[item.status]}`}>{item.status}</span>
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  {item.expiresAt ? `Kedaluwarsa: ${new Date(item.expiresAt).toLocaleDateString("id-ID")} (${item.remainingDays} hari)` : "Expiry tidak diketahui"}
                </p>
                <p className="text-xs text-slate-500">Sumber valid: {item.lastValidSource ?? "Belum ada"}</p>
                {item.lastError && <p className="text-xs text-rose-300">{item.lastError}</p>}
              </div>
            );
          })}
        </div>
      )}

      {connectionHealth && (
        <div className="mt-4 border-t border-white/10 pt-4">
          <h3 className="text-sm font-semibold text-slate-100">Kesehatan Koneksi</h3>
          <div className="mt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">AYO</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <ConnectionHealthCard item={connectionHealth.ayo.booking} />
              <ConnectionHealthCard item={connectionHealth.ayo.paymentEvents} />
            </div>
          </div>
          <div className="mt-4">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Olsera</p>
              <span className={`text-xs font-semibold ${connectionHealth.olsera.overall.status === "TERHUBUNG" ? "text-emerald-300" : "text-amber-300"}`}>
                {connectionHealth.olsera.overall.status === "TERHUBUNG" ? "Olsera: Terhubung" : `Olsera: Perlu Dicek (${connectionHealth.olsera.overall.problemModules.join(", ")})`}
              </span>
            </div>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <ConnectionHealthCard item={connectionHealth.olsera.sales} />
              <ConnectionHealthCard item={connectionHealth.olsera.inventory} />
              <ConnectionHealthCard item={connectionHealth.olsera.financial} />
            </div>
          </div>
        </div>
      )}

    </section>
  );
}
