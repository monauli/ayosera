"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Lock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Health = { source: string; label: string; status: string; expiresAt: string | null; remainingDays: number | null; checkedAt: string; lastError: string | null; lastValidSource: string | null };
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

// Phase 2: "AYO Booking" adalah satu-satunya source lama; "Kategori
// Penjualan" (source API "olsera", TIDAK diganti — sudah ada gap
// check/repair order+item level lewat compareOlseraSalesGap, hanya label UI
// yang disesuaikan), "Inventori", dan "Financial" adalah recovery baru
// (Phase 3-5). "ayo-payment-events" tetap didukung backend (endpoint lain
// masih memakainya) tapi sengaja tidak lagi dipilih dari dropdown ini.
const sources = ["ayo-booking", "olsera", "olsera-inventory", "olsera-financial"] as const;
type GapSource = (typeof sources)[number];
const label: Record<GapSource, string> = { "ayo-booking": "AYO Booking", olsera: "Kategori Penjualan", "olsera-inventory": "Inventori", "olsera-financial": "Financial" };
// Sumber yang dibandingkan per PERIODE bulan (Phase 3-5) vs date-range bebas
// (AYO Booking, existing behavior TIDAK diubah — Phase 7).
const isPeriodSource = (source: GapSource) => source === "olsera-inventory" || source === "olsera-financial";
const validatorSection: Partial<Record<GapSource, "category" | "inventory" | "financial">> = { olsera: "category", "olsera-inventory": "inventory", "olsera-financial": "financial" };
// Phase 7: "Tutup Gap" (AYO Booking, existing) tetap istilah lama. Untuk
// Kategori/Inventori/Financial dipakai "Pulihkan Data" — action-nya SELALU
// re-fetch/rebuild dari source Olsera resmi (lihat repairInventoryGap/
// repairFinancialGap di route.ts), TIDAK PERNAH storedValue = liveValue.
const recoverLabel = (source: GapSource) => (source === "ayo-booking" ? "Tutup Gap" : "Pulihkan Data");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
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

// Bedakan setiap kegagalan supaya panel tidak diam-diam menghilang — akun tanpa
// modul "audit" harus melihat alasannya, bukan panel kosong yang terlihat seperti bug.
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; health: Health[]; ayoMobileToken: AyoTokenHealth | null; connectionHealth: ConnectionHealth | null }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "error" };

// Phase 8: ringkasan compact per source — TIDAK PERNAH JSON.stringify hasil
// mentah ke user. Dua kelompok bentuk hasil: identity-diff (AYO Booking,
// Kategori Penjualan — compareAyoGap/compareOlseraSalesGap) vs
// validator-shaped (Inventori/Financial — sama persis dengan section
// GET /api/audit/olsera-validation, lihat lib/olsera-validation-sections.ts).
const gapStatusColor: Record<string, string> = {
  SYNCED: "text-emerald-300", REPAIRED: "text-emerald-300", Cocok: "text-emerald-300",
  GAP_FOUND: "text-amber-300", Selisih: "text-amber-300", "Data Belum Lengkap": "text-amber-300",
  SOURCE_INCOMPLETE: "text-rose-300", "Gagal Dicek": "text-rose-300", TOKEN_ERROR: "text-rose-300",
  DUPLICATE_FOUND: "text-amber-300", MANUAL_REVIEW_REQUIRED: "text-amber-300", LOCKED: "text-rose-300",
};
function fmtNum(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("id-ID") : "-";
}
function DiffRows({ items, render }: { items: unknown[] | undefined; render: (item: any) => string }) {
  if (!items?.length) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {items.slice(0, 8).map((item, index) => <p key={index} className="text-xs text-slate-400">• {render(item)}</p>)}
      {items.length > 8 && <p className="text-xs text-slate-500">+{items.length - 8} lainnya</p>}
    </div>
  );
}
function IdentityGapSummary({ result }: { result: Record<string, any> }) {
  const missingOrders = Number(result.missingOrderCount ?? result.missingLocalCount ?? 0);
  const hasItemBreakdown = result.missingItemCount != null;
  const conflicts = Number(result.conflictOrderCount ?? result.conflictCount ?? 0) + Number(result.conflictItemCount ?? 0);
  const duplicates = Number(result.duplicateOrderIdentityCount ?? result.duplicateIdentityCount ?? 0) + Number(result.duplicateItemIdentityCount ?? 0);
  const repaired = Number(result.repaired ?? 0);
  return (
    <>
      <p className="text-xs text-slate-300">{hasItemBreakdown ? `Order hilang: ${missingOrders} · Item hilang: ${fmtNum(result.missingItemCount)}` : `Record hilang: ${missingOrders}`}</p>
      {conflicts > 0 && <p className="text-xs text-amber-300">Konflik/mismatch data: {conflicts}</p>}
      {duplicates > 0 && <p className="text-xs text-amber-300">Identity duplikat: {duplicates}</p>}
      {repaired > 0 && <p className="text-xs text-emerald-300">Dipulihkan (insert-only, tidak menimpa): {repaired}</p>}
      {result.error && <p className="text-xs text-rose-300">{String(result.error)}</p>}
    </>
  );
}
function InventoryGapSummary({ result }: { result: Record<string, any> }) {
  if (result.status === "Gagal Dicek") return <p className="text-xs text-rose-300">{result.detail}{result.code ? ` (${result.code})` : ""}</p>;
  return (
    <>
      <p className="text-xs text-slate-300">{fmtNum(result.matching)} / {fmtNum(result.checked)} produk Cocok · {fmtNum(result.liveItems)} item live · {fmtNum(result.differences?.length ?? 0)} Selisih</p>
      {result.reason && <p className="text-xs text-amber-300">{result.reason}</p>}
      <DiffRows items={result.differences} render={(d) => `${d.product}: AYOSERA ${fmtNum(d.ayosera)} vs Olsera ${fmtNum(d.olseraLive)} (delta ${d.delta == null ? "-" : d.delta > 0 ? `+${d.delta}` : d.delta})`} />
      {Number(result.repaired ?? 0) > 0 && <p className="mt-1 text-xs text-emerald-300">Snapshot dipulihkan (rebuild resmi, bukan overwrite manual): {result.repaired} dokumen.</p>}
    </>
  );
}
function FinancialGapSummary({ result }: { result: Record<string, any> }) {
  if (result.status === "Gagal Dicek") return <p className="text-xs text-rose-300">{result.detail}{result.code ? ` (${result.code})` : ""}</p>;
  const reportRows = (["balanceSheet", "profitLoss", "cashFlow"] as const).map((key) => ({ key, label: key === "balanceSheet" ? "Neraca" : key === "profitLoss" ? "Laba Rugi" : "Arus Kas", status: result[key]?.status ?? "Data Belum Lengkap" }));
  return (
    <>
      <div className="text-xs text-slate-300">{reportRows.map((r) => <span key={r.key} className="mr-3">{r.label}: <b className={gapStatusColor[r.status] ?? ""}>{r.status}</b></span>)}</div>
      <p className="mt-1 text-xs text-slate-300">Buku Besar: {fmtNum(result.ledgerAccounts?.matching)} / {fmtNum(result.ledgerAccounts?.checked)} akun Cocok</p>
      <DiffRows items={result.ledgerAccounts?.differences} render={(d) => `${d.accountCode}${d.name ? ` (${d.name})` : ""} mismatch`} />
      {Number(result.repaired ?? 0) > 0 && <p className="mt-1 text-xs text-emerald-300">Akun disinkronkan ulang: {result.repaired}.</p>}
    </>
  );
}
function GapResultSummary({ source, result }: { source: GapSource; result: Record<string, any> | null }) {
  if (!result) return null;
  const status = String(result.status ?? "-");
  return (
    <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3">
      <p className="text-xs font-semibold">Status: <span className={gapStatusColor[status] ?? "text-slate-200"}>{status}</span></p>
      <div className="mt-1">
        {isPeriodSource(source)
          ? source === "olsera-inventory" ? <InventoryGapSummary result={result} /> : <FinancialGapSummary result={result} />
          : <IdentityGapSummary result={result} />}
      </div>
    </div>
  );
}
function RevalidateSummary({ result }: { result: Record<string, any> | null }) {
  if (!result) return null;
  const status = String(result.status ?? "-");
  return (
    <div className="mt-3 rounded-md border border-cyan-300/20 bg-cyan-950/10 p-3">
      <p className="text-xs font-semibold text-cyan-200">Hasil validator setelah recovery: <span className={gapStatusColor[status] ?? "text-slate-200"}>{status}</span></p>
      {status === "Gagal Dicek" && result.detail && <p className="mt-1 text-xs text-rose-300">{result.detail}{result.code ? ` (${result.code})` : ""}</p>}
      {status === "Selisih" && <p className="mt-1 text-xs text-amber-300">Masih ada selisih nyata setelah recovery — TIDAK dipaksa Cocok, tinjau detail di tab Validasi Data Olsera.</p>}
    </div>
  );
}

export function PrivateIntegrationMonitor() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [source, setSource] = useState<GapSource>("ayo-booking"); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [busy, setBusy] = useState(false); const [result, setResult] = useState<Record<string, unknown> | null>(null);
  // Phase 6: hasil auto-revalidate (GET validator) setelah recovery
  // Kategori/Inventori/Financial — null untuk AYO Booking (tidak tervalidasi
  // lewat validator Olsera) atau sebelum recovery dijalankan.
  const [revalidateResult, setRevalidateResult] = useState<Record<string, unknown> | null>(null);
  // Progress = stage nyata yang benar-benar di-await, BUKAN timer palsu.
  // "check": 1 stage (POST check). "repair" pada source dengan validator: 2
  // stage (POST repair lalu GET validator) — "menyimpan hasil sync" terjadi
  // DI DALAM request repair itu sendiri di server, tidak bisa diamati sebagai
  // stage client-side terpisah tanpa membuatnya palsu.
  const [flowStage, setFlowStage] = useState(-1);
  const [flowAction, setFlowAction] = useState<"check" | "repair">("check");
  const flowStagesFor = (action: "check" | "repair", withValidator: boolean) =>
    action === "check" ? ["Memeriksa gap", "Selesai"] : withValidator ? ["Memeriksa & mengambil ulang data", "Memvalidasi ulang", "Selesai"] : ["Memeriksa & mengambil ulang data", "Selesai"];
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
  useEffect(() => { const end = today(); const date = new Date(`${end}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 29); setFrom(date.toISOString().slice(0, 10)); setTo(end); void load(); }, []);
  const audit = async (action: "check" | "repair") => {
    const recoveryMessage: Record<GapSource, string> = {
      "ayo-booking": "Tutup hanya data yang terdeteksi hilang pada audit terakhir. Data existing tidak akan dihapus atau ditimpa.",
      olsera: "Tutup hanya order dan item yang terdeteksi hilang pada audit terakhir. Data existing tidak akan dihapus atau ditimpa.",
      "olsera-inventory": "Pulihkan Data akan menjalankan rebuild snapshot bulanan resmi (self-healing, tidak membuat movement palsu) untuk periode ini. Data existing tidak dihapus, dan bulan historis yang sudah final tetap dilindungi.",
      "olsera-financial": "Pulihkan Data akan menjalankan sinkronisasi ulang Neraca/Laba Rugi/Arus Kas/Buku Besar resmi untuk periode ini. Snapshot lama tidak dihapus sebelum data baru berhasil diambil (upsert per akun/report).",
    };
    const message = recoveryMessage[source];
    if (action === "repair" && !window.confirm(message)) return;
    const section = validatorSection[source];
    const withValidator = action === "repair" && Boolean(section);
    setBusy(true); setResult(null); setRevalidateResult(null); setFlowStage(0); setFlowAction(action);
    try {
      const res = await fetch("/api/private/integration-monitor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, startDate: from, endDate: to, action }) });
      const body = await res.json();
      setResult(body);
      // Phase 6: recovery Kategori/Inventori/Financial selalu diikuti auto-run
      // validator periode yang sama — hasil akhir yang tampil adalah hasil
      // validator (Cocok/Selisih/Data Belum Lengkap/Gagal Dicek), bukan
      // diasumsikan Cocok hanya karena recovery selesai tanpa error.
      if (withValidator && section) {
        setFlowStage(1);
        const period = from.slice(0, 7);
        const vres = await fetch(`/api/audit/olsera-validation?period=${period}&section=${section}`, { cache: "no-store" });
        const vbody = await vres.json();
        setRevalidateResult(vbody?.[section] ?? null);
      }
      setFlowStage(withValidator ? 2 : 1);
    } finally { setBusy(false); }
  };

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
        <Button type="button" variant="outline" onClick={() => void load()} disabled={busy}>
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
          {otherHealth.map((item) => (
            <div key={item.source} className="rounded-lg border border-white/10 bg-black/10 p-3">
              <div className="flex items-center justify-between gap-2">
                <b className="text-sm text-slate-100">{item.label}</b>
                <span className="text-xs font-semibold text-cyan-200">{item.status}</span>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                {item.expiresAt ? `Kedaluwarsa: ${new Date(item.expiresAt).toLocaleDateString("id-ID")} (${item.remainingDays} hari)` : "Expiry tidak diketahui"}
              </p>
              <p className="text-xs text-slate-500">Sumber valid: {item.lastValidSource ?? "Belum ada"}</p>
              {item.lastError && <p className="text-xs text-rose-300">{item.lastError}</p>}
            </div>
          ))}
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

      <div className="mt-4 border-t border-white/10 pt-4">
        <h3 className="text-sm font-semibold text-slate-100">Cek &amp; Tutup Gap Data</h3>
        <p className="mt-1 text-xs text-slate-400">Recovery per source: {label[source]} — action selalu re-fetch/rebuild dari Olsera resmi, tidak pernah memaksa angka jadi cocok.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <select aria-label="Sumber audit" value={source} onChange={(e) => { setSource(e.target.value as GapSource); setResult(null); setRevalidateResult(null); setFlowStage(-1); }} className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-100">
            {sources.map((value) => (
              <option key={value} value={value}>{label[value]}</option>
            ))}
          </select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} disabled={busy} />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} disabled={busy} />
          <div className="flex gap-2">
            <Button type="button" onClick={() => void audit("check")} disabled={busy || !from || !to}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}Cek Gap
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void audit("repair")}
              disabled={busy || (isPeriodSource(source) ? (result as { status?: string } | null)?.status !== "Selisih" : (result as { status?: string } | null)?.status !== "GAP_FOUND")}
            >
              {recoverLabel(source)}
            </Button>
          </div>
        </div>
        {isPeriodSource(source) && <p className="mt-1 text-xs text-slate-500">Tanggal awal dan akhir harus berada di bulan kalender yang sama (dibandingkan sebagai satu periode, bukan rentang bebas).</p>}
        {flowStage >= 0 && (() => {
          const stages = flowStagesFor(flowAction, Boolean(validatorSection[source]));
          return (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              {stages.map((label_, index) => (
                <span key={label_} className={index === flowStage ? "text-cyan-200" : index < flowStage ? "text-emerald-300" : ""}>{label_}{index < stages.length - 1 ? " →" : ""}</span>
              ))}
            </div>
          );
        })()}
        <GapResultSummary source={source} result={result as Record<string, any> | null} />
        <RevalidateSummary result={revalidateResult as Record<string, any> | null} />
      </div>
    </section>
  );
}
