"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";

const BTN_SM = "rd-chip cursor-pointer select-none border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";
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
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={BTN_SM} onClick={onAddRow} title="Tambah baris baru di akhir">
          + Baris
        </button>
        <button type="button" className={BTN_SM} onClick={onDeleteRow} disabled={!hasSelection} title="Hapus baris yang dipilih">
          Hapus
        </button>
        <button type="button" className={BTN_SM} onClick={onDuplicateRow} disabled={!hasSelection} title="Duplikat baris yang dipilih">
          Duplikat
        </button>
        <button type="button" className={BTN_SM} onClick={onClearAll} title="Kosongkan seluruh data (perlu konfirmasi)">
          Kosongkan
        </button>
        <button type="button" className={BTN_SM} onClick={() => void handlePasteButton()} title="Tempel data dari clipboard — Ctrl+V pada sel juga bisa">
          Tempel Data
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
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={BTN} onClick={onValidate} disabled={validating}>
          {validating ? "Memeriksa..." : "Periksa Data"}
        </button>
        <button type="button" className={BTN} onClick={onPreviewXml}>
          Preview XML
        </button>
        <button type="button" className={BTN} onClick={onDownloadXml}>
          Unduh XML
        </button>
        <Button type="button" className={PRIMARY_BTN} onClick={onSaveDraft} disabled={saving}>
          {saving ? "Menyimpan..." : "Simpan Draft"}
        </Button>
      </div>
    </div>
  );
}
