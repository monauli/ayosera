"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, DatabaseZap, Eye, EyeOff, LockKeyhole, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readInitialThemeMode, THEME_MODE_STORAGE_KEY, type ThemeMode } from "@/lib/theme-mode";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Default "light" SENGAJA hardcode (sama persis di server maupun render
  // klien pertama, mencegah hydration mismatch) — nilai sesungguhnya dibaca
  // dari localStorage di effect mount di bawah (lihat lib/theme-mode.ts).
  const [mode, setMode] = useState<ThemeMode>("light");
  // Sebelum hydration, handler onSubmit React belum terpasang: submit apa pun
  // (klik tombol / Enter di input) akan jatuh ke submit form NATIVE dan — karena
  // form tanpa method default GET — mengirim email & password sebagai query
  // string yang tercatat di history browser, log akses, dan header Referer.
  // Tombol dinonaktifkan sampai mount menutup celah itu; `method="post"` adalah
  // lapisan kedua supaya kredensial tetap tidak pernah muncul di URL.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setMode(readInitialThemeMode());
    setHydrated(true);
  }, []);

  function toggleMode() {
    const next: ThemeMode = mode === "dark" ? "light" : "dark";
    setMode(next);
    document.documentElement.setAttribute("data-mode", next);
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, next);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        setError("Email atau password tidak valid.");
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("Tidak dapat terhubung ke server. Silakan coba lagi.");
    } finally {
      setLoading(false);
    }
  }

  const dark = mode === "dark";
  return (
    <main className={`min-h-screen px-4 py-6 transition-colors sm:px-6 sm:py-10 ${dark ? "bg-[#0b0c0f] text-slate-100" : "bg-[#f8f7f5] text-slate-900"}`}>
      <button
        type="button"
        onClick={toggleMode}
        aria-label={dark ? "Gunakan Light Mode" : "Gunakan Dark Mode"}
        className={`fixed right-5 top-5 z-10 rounded-full border p-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 ${dark ? "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10" : "border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"}`}
      >
        {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>

      <div className={`mx-auto grid min-h-[calc(100vh-3rem)] w-full max-w-[1000px] overflow-hidden rounded-3xl border shadow-2xl sm:min-h-[620px] lg:grid-cols-2 ${dark ? "border-white/10 bg-[#121419] shadow-black/40" : "border-slate-200 bg-white shadow-slate-200/70"}`}>
        <section className="flex items-center p-7 sm:p-12">
          <div className="mx-auto w-full max-w-[390px]">
            <div className="mb-10 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"><DatabaseZap className="h-5 w-5" /></div>
              <div><p className={`text-[15px] font-bold tracking-wide ${dark ? "text-white" : "text-slate-900"}`}>AYOSERA</p><p className={`text-xs ${dark ? "text-slate-400" : "text-slate-500"}`}>Super App Transaksi</p></div>
            </div>
            <h1 className={`text-3xl font-bold tracking-tight ${dark ? "text-white" : "text-slate-900"}`}>Masuk ke Ayosera</h1>
            <p className={`mt-3 text-sm leading-6 ${dark ? "text-slate-400" : "text-slate-500"}`}>Kelola transaksi AYO, penjualan Olsera, dan inventori dalam satu dashboard.</p>

            <form className="mt-8 space-y-5" method="post" onSubmit={handleSubmit}>
              <div><label htmlFor="email" className={`mb-2 block text-sm font-medium ${dark ? "text-slate-200" : "text-slate-700"}`}>Email</label><Input id="email" name="email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} className={`h-12 ${dark ? "border-white/10 bg-white/5 text-white" : "border-slate-200 bg-white text-slate-900"}`} /></div>
              <div><label htmlFor="password" className={`mb-2 block text-sm font-medium ${dark ? "text-slate-200" : "text-slate-700"}`}>Password</label><div className="relative"><LockKeyhole className={`pointer-events-none absolute left-3 top-3.5 h-4 w-4 ${dark ? "text-slate-500" : "text-slate-400"}`} /><Input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className={`h-12 pl-10 pr-11 ${dark ? "border-white/10 bg-white/5 text-white" : "border-slate-200 bg-white text-slate-900"}`} /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"} className={`absolute right-3 top-3.5 ${dark ? "text-slate-400 hover:text-white" : "text-slate-500 hover:text-slate-900"}`}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></div>
              {error && <p role="alert" aria-live="polite" className={`rounded-lg px-3 py-2.5 text-xs ${dark ? "bg-rose-500/10 text-rose-300" : "bg-rose-50 text-rose-700"}`}>{error}</p>}
              <Button type="submit" disabled={loading || !hydrated} className="h-12 w-full bg-rose-600 text-sm font-semibold text-white hover:bg-rose-700">{loading ? "Memproses..." : "Masuk"}<ArrowRight className="ml-2 h-4 w-4" /></Button>
            </form>
          </div>
        </section>

        <aside className={`relative hidden overflow-hidden p-10 lg:flex lg:flex-col lg:justify-end ${dark ? "bg-[#191b21]" : "bg-rose-50"}`}>
          <div className={`absolute inset-0 opacity-40 ${dark ? "bg-[linear-gradient(rgba(255,255,255,.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.06)_1px,transparent_1px)]" : "bg-[linear-gradient(rgba(190,24,93,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(190,24,93,.08)_1px,transparent_1px)]"}`} style={{ backgroundSize: "34px 34px" }} />
          <div className="relative"><div className={`mb-6 inline-flex rounded-full px-3 py-1 text-xs font-medium ${dark ? "bg-white/10 text-rose-200" : "bg-white text-rose-700"}`}>AYOSERA OPERATIONS</div><h2 className={`max-w-sm text-3xl font-bold leading-tight ${dark ? "text-white" : "text-slate-900"}`}>Operasional dalam satu tampilan</h2><p className={`mt-4 max-w-sm text-sm leading-6 ${dark ? "text-slate-400" : "text-slate-600"}`}>Pantau transaksi, penjualan, inventori, dan sinkronisasi secara real-time.</p><div className="mt-8 space-y-3">{["Transaksi AYO", "Penjualan Olsera", "Inventori Terintegrasi"].map((item) => <div key={item} className={`flex items-center gap-3 text-sm ${dark ? "text-slate-200" : "text-slate-700"}`}><CheckCircle2 className="h-4 w-4 text-rose-600" />{item}</div>)}</div></div>
        </aside>
      </div>
    </main>
  );
}
