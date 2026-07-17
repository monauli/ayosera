import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, ChevronDown, FileSpreadsheet, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Menu Export halaman Kategori Penjualan Olsera. Mengikuti pola dropdown
// Export Transaksi AYO yang sudah diperbaiki: dirender lewat portal ke
// document.body dengan position:fixed sehingga bebas dari stacking context /
// clipping parent card & tabel. Semua handler dan endpoint export tetap milik
// app/page.tsx — komponen ini presentasi + posisi saja.
const MENU_WIDTH = 320;
const MENU_EST_HEIGHT = 300;

const ITEM_BTN =
  "flex w-full items-start gap-3 rounded-md px-2 py-2 text-left text-[13px] text-slate-200 transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";
const ITEM_ICON =
  "mt-0.5 shrink-0 rounded-md border border-white/10 bg-white/5 p-1.5 text-slate-300";

export function OlseraExportMenu({
  open,
  onOpenChange,
  exporting,
  disabled,
  monthlyMode,
  monthLabel,
  onExportItems,
  onExportCategories,
  onExportOmsetKategori,
  onExportLabers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exporting: boolean;
  disabled: boolean;
  monthlyMode: boolean;
  monthLabel: string;
  onExportItems: () => void;
  onExportCategories: () => void;
  onExportOmsetKategori: () => void;
  onExportLabers: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  // Posisi: fixed tepat di bawah tombol, rata kanan; flip ke atas bila ruang
  // bawah kurang (collision sederhana). Dihitung ulang saat resize/scroll.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const openUp = window.innerHeight - rect.bottom < MENU_EST_HEIGHT && rect.top > MENU_EST_HEIGHT;
      const right = Math.max(12, window.innerWidth - rect.right);
      setStyle({
        position: "fixed",
        right,
        maxWidth: `calc(100vw - ${right + 12}px)`,
        width: MENU_WIDTH,
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + 8 }
          : { top: rect.bottom + 8 }),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  function runAndClose(handler: () => void) {
    onOpenChange(false);
    handler();
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        className="w-full rounded-lg bg-rose-600 font-medium text-white shadow-sm transition-colors hover:bg-rose-500 active:bg-rose-700 sm:w-auto"
      >
        {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
        {exporting ? "Mengekspor..." : "Export"}
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </Button>
      {open &&
        style &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[9998]" onClick={() => onOpenChange(false)} aria-hidden="true" />
            <div
              role="menu"
              aria-label="Pilihan export Olsera"
              style={style}
              className="rd-panel z-[9999] rounded-lg p-1.5"
            >
              {/* Ketiga export selalu tersedia; Omset Kategori memakai
                  bulan filter (mode bulanan) atau bulan startDate (mode rentang). */}
              <button type="button" role="menuitem" className={ITEM_BTN} onClick={() => runAndClose(onExportItems)}>
                <span className={ITEM_ICON}>
                  <FileSpreadsheet className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">Export Rincian Penjualan</span>
                  <span className="block text-[11px] font-normal text-slate-500">
                    Detail transaksi pada rentang tanggal aktif
                  </span>
                </span>
              </button>
              <button type="button" role="menuitem" className={ITEM_BTN} onClick={() => runAndClose(onExportCategories)}>
                <span className={ITEM_ICON}>
                  <FileSpreadsheet className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">Export Kategori Penjualan</span>
                  <span className="block text-[11px] font-normal text-slate-500">
                    Rincian item per kategori pada rentang tanggal aktif
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={ITEM_BTN}
                onClick={() => runAndClose(onExportOmsetKategori)}
              >
                <span className={ITEM_ICON}>
                  <FileSpreadsheet className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">Export Omset Kategori</span>
                  <span className="block text-[11px] font-normal text-slate-500">
                    Rekap omset kategori untuk bulan yang dipilih
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!monthlyMode}
                className={ITEM_BTN}
                onClick={() => runAndClose(onExportLabers)}
              >
                <span className={ITEM_ICON}>
                  <FileSpreadsheet className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">Export Pembagian Hasil LABERS</span>
                  <span className="block text-[11px] font-normal text-slate-500">
                    {monthlyMode
                      ? `Rekap penjualan LABERS & pembagian Padel/Labers bulan ${monthLabel}`
                      : "Pilih mode Bulanan"}
                  </span>
                </span>
              </button>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
