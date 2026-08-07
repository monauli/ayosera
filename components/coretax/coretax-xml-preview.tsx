"use client";

import { useState } from "react";
import { Copy, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CoretaxXmlPreview({
  open,
  onClose,
  title,
  tin,
  rowCount,
  validRowCount,
  fileName,
  xml,
  onDownload,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  tin: string;
  rowCount: number;
  validRowCount: number;
  fileName: string;
  xml: string;
  onDownload: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Preview XML">
      <div className="rd-panel flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-base font-semibold text-slate-100">Preview XML — {title}</p>
            <p className="mt-1 text-xs text-slate-500">
              TIN {tin || "-"} · {rowCount} baris · {validRowCount} baris valid · {fileName}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-slate-100" aria-label="Tutup">
            <X className="h-4 w-4" />
          </button>
        </div>
        <textarea
          readOnly
          value={xml}
          className="rd-input h-[50vh] flex-1 resize-none whitespace-pre font-mono text-xs leading-relaxed"
          aria-label="Isi XML"
        />
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(xml).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            <Copy className="h-4 w-4" /> {copied ? "Tersalin" : "Salin XML"}
          </Button>
          <Button type="button" className="rounded-lg bg-rose-600 text-white hover:bg-rose-500" onClick={onDownload}>
            <Download className="h-4 w-4" /> Unduh XML
          </Button>
        </div>
      </div>
    </div>
  );
}
