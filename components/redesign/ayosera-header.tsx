import type { ReactNode } from "react";
import { Bell, LogOut, Menu, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

// Header Ayosera. Semua aksi (sync, logout) tetap memakai handler lama yang
// dikirim dari app/page.tsx — komponen ini tidak punya logic sendiri.
export function AyoseraHeader({
  title,
  description,
  onToggleSidebar,
  sidebarOpen,
  ayoStatus,
  olseraStatus,
  lastCheckpoint,
  actions,
  onLogout,
  mode,
  onToggleMode,
}: {
  title: string;
  description?: string;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  ayoStatus: string;
  /** Status sync Olsera bila datanya sudah dimuat halaman lama; null = sembunyikan chip. */
  olseraStatus: string | null;
  lastCheckpoint: string;
  /** Slot tombol aksi lama (mis. dropdown Sync AYO) — dirender apa adanya. */
  actions?: ReactNode;
  onLogout: () => void;
  mode: "dark" | "light";
  onToggleMode: () => void;
}) {
  return (
    <header className="rd-header sticky top-0 z-30">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleSidebar}
          aria-label="Buka/tutup navigasi"
          aria-expanded={sidebarOpen}
          className="text-slate-300 hover:bg-white/10 hover:text-white"
        >
          <Menu className="h-5 w-5" />
        </Button>
        {/* P0 fix: judul halaman (Dashboard AYO/Transaksi AYO/Monitoring
            Webhook AYO, dst.) sering kepotong di lebar desktop yang umum
            (mis. laptop 1280-1440px) — root cause: badge status ("AYO ...",
            "Olsera ...", "Sinkron terakhir: ...") tampil mulai md (768px),
            terlalu lebar bersamaan dengan tombol mode/notifikasi/logout +
            slot `actions` (mis. tombol "Sync AYO"), sehingga judul yang
            hanya punya flex-1 (tanpa lebar minimum terjamin) terdesak
            hingga nyaris tak terbaca meski layarnya "desktop". Fix: naikkan
            breakpoint badge status ke xl (1280px, hanya tampil saat memang
            ada ruang lega) DAN kunci lebar tombol mode/notifikasi/logout +
            actions dengan shrink-0 supaya distribusi ruang sisa selalu jatuh
            ke judul secara konsisten, bukan diperebutkan. */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold tracking-tight text-slate-50">{title}</h1>
          {description && <p className="hidden truncate text-sm text-slate-400 sm:block">{description}</p>}
        </div>
        <div className="hidden shrink-0 items-center gap-2 xl:flex">
          <span className={`rd-chip ${ayoStatus === "Gagal" ? "rd-chip-danger" : "rd-chip-ok"}`}>
            AYO {ayoStatus}
          </span>
          {olseraStatus && (
            <span className={`rd-chip ${olseraStatus === "failed" ? "rd-chip-danger" : "rd-chip-ok"}`}>
              Olsera {olseraStatus}
            </span>
          )}
          <span className="rd-chip">Sinkron terakhir: {lastCheckpoint}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onToggleMode}
          aria-label={mode === "dark" ? "Ganti ke Light Mode" : "Ganti ke Dark Mode"}
          title={mode === "dark" ? "Light Mode" : "Dark Mode"}
          className="shrink-0 text-slate-300 hover:bg-white/10 hover:text-white"
        >
          {mode === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Notifikasi"
          className="shrink-0 text-slate-300 hover:bg-white/10 hover:text-white"
        >
          <Bell className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          onClick={onLogout}
          aria-label="Logout"
          title="Logout"
          className="shrink-0 text-slate-300 hover:bg-rose-500/15 hover:text-rose-300"
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:inline">Logout</span>
        </Button>
        <div className="shrink-0">{actions}</div>
      </div>
    </header>
  );
}
