import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, ChevronDown, FileSpreadsheet, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Menu Export halaman Inventori Olsera. Mengikuti pola dropdown Export
// Transaksi AYO yang sudah diperbaiki: dirender lewat portal ke document.body
// dengan position:fixed sehingga bebas dari stacking context / clipping parent
// card & tabel. Semua handler dan endpoint export tetap milik pemanggil —
// komponen ini presentasi + posisi saja.
const MENU_WIDTH = 320;
const MENU_EST_HEIGHT = 220;

const ITEM_BTN =
  "flex w-full items-start gap-3 rounded-md px-2 py-2 text-left text-[13px] text-slate-200 transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";

export function InventoryExportMenu({
  open,
  onOpenChange,
  exporting,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exporting: boolean;
  items: { label: string; detail: string; onClick: () => void }[];
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
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={exporting}
        onClick={() => onOpenChange(!open)}
        className="rounded-lg bg-rose-600 font-medium text-white shadow-sm transition-colors hover:bg-rose-500 active:bg-rose-700"
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
              aria-label="Pilihan export inventori"
              style={style}
              className="rd-panel z-[9999] rounded-lg p-1.5"
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={ITEM_BTN}
                  onClick={() => {
                    onOpenChange(false);
                    item.onClick();
                  }}
                >
                  <span className="mt-0.5 shrink-0 rounded-md border border-white/10 bg-white/5 p-1.5 text-slate-300">
                    <FileSpreadsheet className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">{item.label}</span>
                    <span className="block text-[11px] font-normal text-slate-500">{item.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
