import type { ReactNode } from "react";
import { Bell, LogOut, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";

// Header gelap Ayosera. Semua aksi (sync, logout) tetap memakai handler lama
// yang dikirim dari app/page.tsx — komponen ini tidak punya logic sendiri.
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
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold tracking-tight text-slate-50">{title}</h1>
          {description && <p className="hidden truncate text-sm text-slate-400 sm:block">{description}</p>}
        </div>
        <div className="hidden items-center gap-2 md:flex">
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
          variant="ghost"
          size="icon"
          aria-label="Notifikasi"
          className="text-slate-300 hover:bg-white/10 hover:text-white"
        >
          <Bell className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          onClick={onLogout}
          aria-label="Logout"
          title="Logout"
          className="text-slate-300 hover:bg-rose-500/15 hover:text-rose-300"
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:inline">Logout</span>
        </Button>
        {actions}
      </div>
    </header>
  );
}
