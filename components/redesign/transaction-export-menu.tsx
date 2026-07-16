import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Menu Export minimalis untuk halaman Transaksi AYO. Dirender lewat portal ke
// document.body dengan position:fixed sehingga bebas dari stacking context /
// clipping parent card & tabel. Semua handler, state tanggal, dan endpoint
// export tetap milik app/page.tsx — komponen ini presentasi + posisi saja.
const MENU_WIDTH = 256;
const MENU_EST_HEIGHT = 330;

const ITEM_BTN =
  "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-slate-200 transition-colors hover:bg-white/10 disabled:pointer-events-none disabled:opacity-50";
const ROW_LABEL = "px-2 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500";
const ROW_INPUT =
  "rd-input h-8 min-w-0 flex-1 cursor-pointer px-2 text-xs";
const ROW_GO =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-200 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-50";

export function TransactionExportMenu({
  open,
  onOpenChange,
  exporting,
  dateRangeInvalid,
  filterDetail,
  exportDate,
  onExportDateChange,
  exportStart,
  onExportStartChange,
  exportEnd,
  onExportEndChange,
  exportMonth,
  onExportMonthChange,
  onExportFilter,
  onExportHarian,
  onExportRange,
  onExportBulanan,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exporting: boolean;
  dateRangeInvalid: boolean;
  filterDetail: string;
  exportDate: string;
  onExportDateChange: (value: string) => void;
  exportStart: string;
  onExportStartChange: (value: string) => void;
  exportEnd: string;
  onExportEndChange: (value: string) => void;
  exportMonth: string;
  onExportMonthChange: (value: string) => void;
  onExportFilter: () => void;
  onExportHarian: () => void;
  onExportRange: () => void;
  onExportBulanan: () => void;
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

  return (
    <>
      <Button
        ref={triggerRef}
        variant="outline"
        size="icon"
        onClick={() => onOpenChange(!open)}
        disabled={exporting}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Menu ekspor Excel"
        className="h-11 w-11 border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 hover:text-white"
      >
        {exporting ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowDownToLine className="h-5 w-5" />}
      </Button>
      {open &&
        style &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[9998]" onClick={() => onOpenChange(false)} aria-hidden="true" />
            <div
              role="menu"
              aria-label="Pilihan ekspor Excel"
              style={style}
              className="rd-panel z-[9999] rounded-lg p-1.5"
            >
              <button
                type="button"
                role="menuitem"
                className={ITEM_BTN}
                onClick={onExportFilter}
                disabled={exporting || dateRangeInvalid}
              >
                <ArrowDownToLine className="h-4 w-4 shrink-0 text-slate-400" />
                <span className="min-w-0">
                  <span className="block">Ekspor Sesuai Filter</span>
                  <span className="block truncate text-[11px] font-normal text-slate-500">{filterDetail}</span>
                </span>
              </button>

              <div className="mx-1 my-1 border-t border-white/10" />

              <p className={ROW_LABEL}>Harian</p>
              <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-1">
                <input
                  type="date"
                  aria-label="Tanggal ekspor harian"
                  value={exportDate}
                  className={ROW_INPUT}
                  onClick={(event) => event.currentTarget.showPicker?.()}
                  onChange={(event) => onExportDateChange(event.target.value)}
                />
                <button
                  type="button"
                  className={ROW_GO}
                  onClick={onExportHarian}
                  disabled={exporting || !exportDate}
                  aria-label="Unduh ekspor harian"
                  title="Unduh"
                >
                  <ArrowDownToLine className="h-4 w-4" />
                </button>
              </div>

              <p className={ROW_LABEL}>Rentang Tanggal</p>
              <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-1">
                <input
                  type="date"
                  aria-label="Tanggal awal ekspor range"
                  value={exportStart}
                  className={ROW_INPUT}
                  onClick={(event) => event.currentTarget.showPicker?.()}
                  onChange={(event) => onExportStartChange(event.target.value)}
                />
                <input
                  type="date"
                  aria-label="Tanggal akhir ekspor range"
                  value={exportEnd}
                  className={ROW_INPUT}
                  onClick={(event) => event.currentTarget.showPicker?.()}
                  onChange={(event) => onExportEndChange(event.target.value)}
                />
                <button
                  type="button"
                  className={ROW_GO}
                  onClick={onExportRange}
                  disabled={exporting || !exportStart || !exportEnd}
                  aria-label="Unduh ekspor range"
                  title="Unduh"
                >
                  <ArrowDownToLine className="h-4 w-4" />
                </button>
              </div>

              <p className={ROW_LABEL}>Bulanan</p>
              <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-1">
                <input
                  type="month"
                  aria-label="Bulan ekspor"
                  value={exportMonth}
                  className={ROW_INPUT}
                  onClick={(event) => event.currentTarget.showPicker?.()}
                  onChange={(event) => onExportMonthChange(event.target.value)}
                />
                <button
                  type="button"
                  className={ROW_GO}
                  onClick={onExportBulanan}
                  disabled={exporting || !exportMonth}
                  aria-label="Unduh ekspor bulanan"
                  title="Unduh"
                >
                  <ArrowDownToLine className="h-4 w-4" />
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
