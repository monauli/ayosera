"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";

const BTN = "rd-chip cursor-pointer select-none border-white/10 bg-white/5 px-3 py-1.5 text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";
const PRIMARY_BTN = "rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50";

export function CoretaxToolbar({
  onAddRow,
  onDeleteRow,
  onDuplicateRow,
  onClearAll,
  onPasteFromClipboard,
  onValidate,
  onSaveDraft,
  onPreviewXml,
  onDownloadXml,
  hasSelection,
  saving,
  validating,
}: {
  onAddRow: () => void;
  onDeleteRow: () => void;
  onDuplicateRow: () => void;
  onClearAll: () => void;
  onPasteFromClipboard: (text: string) => void;
  onValidate: () => void;
  onSaveDraft: () => void;
  onPreviewXml: () => void;
  onDownloadXml: () => void;
  hasSelection: boolean;
  saving: boolean;
  validating: boolean;
}) {
  const pasteAreaRef = useRef<HTMLTextAreaElement | null>(null);

  async function handlePasteButton() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onPasteFromClipboard(text);
    } catch {
      // Sebagian browser menolak akses clipboard tanpa interaksi langsung —
      // fallback: fokuskan textarea tersembunyi supaya user bisa Ctrl+V manual.
      pasteAreaRef.current?.focus();
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={BTN} onClick={onAddRow}>
        Tambah Baris
      </button>
      <button type="button" className={BTN} onClick={onDeleteRow} disabled={!hasSelection}>
        Hapus Baris
      </button>
      <button type="button" className={BTN} onClick={onDuplicateRow} disabled={!hasSelection}>
        Duplikat Baris
      </button>
      <button type="button" className={BTN} onClick={onClearAll}>
        Kosongkan Data
      </button>
      <button type="button" className={BTN} onClick={() => void handlePasteButton()}>
        Tempel dari Excel
      </button>
      <textarea
        ref={pasteAreaRef}
        aria-hidden="true"
        className="pointer-events-none absolute h-px w-px opacity-0"
        onPaste={(event) => {
          event.preventDefault();
          onPasteFromClipboard(event.clipboardData.getData("text"));
        }}
      />
      <span className="mx-1 h-5 w-px bg-white/10" />
      <button type="button" className={BTN} onClick={onValidate} disabled={validating}>
        {validating ? "Memeriksa..." : "Periksa Data"}
      </button>
      <Button type="button" className={PRIMARY_BTN} onClick={onSaveDraft} disabled={saving}>
        {saving ? "Menyimpan..." : "Simpan Draft"}
      </Button>
      <button type="button" className={BTN} onClick={onPreviewXml}>
        Preview XML
      </button>
      <button type="button" className={BTN} onClick={onDownloadXml}>
        Unduh XML
      </button>
    </div>
  );
}
