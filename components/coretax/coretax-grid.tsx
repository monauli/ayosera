"use client";

import { useCallback, useRef } from "react";
import type { CoretaxFieldDef, CoretaxRow } from "@/lib/coretax/types";
import { REFERENCE_SETS } from "@/lib/coretax/references";

export type CoretaxCellPosition = { row: number; col: number };

/**
 * Grid seperti Excel — SATU baris = SATU `<tr>`, kolom mengikuti
 * `config.fields` (urutan yang sama dipakai generator XML). Navigasi Tab
 * memakai urutan DOM natural (tabIndex bawaan, tidak dikustomisasi supaya
 * tetap dapat diprediksi browser); Enter dipindah manual ke baris berikutnya
 * pada kolom yang sama (default HTML tidak menyediakan ini).
 */
export function CoretaxGrid({
  fields,
  rows,
  onChangeCell,
  onCellBlur,
  onPasteAt,
  onSelect,
}: {
  fields: readonly CoretaxFieldDef[];
  rows: readonly CoretaxRow[];
  onChangeCell: (rowIndex: number, key: string, value: string) => void;
  onCellBlur: (rowIndex: number) => void;
  onPasteAt: (rowIndex: number, colIndex: number, text: string) => void;
  onSelect: (position: CoretaxCellPosition) => void;
}) {
  const cellRefs = useRef<Map<string, HTMLInputElement | HTMLSelectElement>>(new Map());
  const cellKey = (row: number, col: number) => `${row}:${col}`;

  const registerRef = useCallback((row: number, col: number, el: HTMLInputElement | HTMLSelectElement | null) => {
    const key = cellKey(row, col);
    if (el) cellRefs.current.set(key, el);
    else cellRefs.current.delete(key);
  }, []);

  function focusCell(row: number, col: number) {
    cellRefs.current.get(cellKey(row, col))?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent, rowIndex: number, colIndex: number) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (rowIndex + 1 < rows.length) focusCell(rowIndex + 1, colIndex);
    }
  }

  function handlePaste(event: React.ClipboardEvent, rowIndex: number, colIndex: number) {
    const text = event.clipboardData.getData("text");
    if (!text.includes("\t") && !text.includes("\n")) return; // paste satu sel: biarkan perilaku bawaan browser.
    event.preventDefault();
    onPasteAt(rowIndex, colIndex, text);
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="rd-table w-full text-sm" style={{ minWidth: `${64 + fields.length * 160}px` }}>
        <thead>
          <tr className="sticky top-0 z-10 bg-[var(--rd-table-head-bg,#1a1a1f)]">
            <th className="w-12 px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-400">#</th>
            {fields.map((f) => (
              <th key={f.key} className="whitespace-nowrap px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400" title={f.helpText}>
                {f.label}
                {f.required && <span className="ml-0.5 text-rose-400">*</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.rowId} className={row.status === "perlu-diperbaiki" ? "bg-rose-500/5" : undefined}>
              <td className="px-2 py-1 text-center text-xs text-slate-500">{rowIndex + 1}</td>
              {fields.map((field, colIndex) => {
                const error = row.errors.find((e) => e.field === field.key);
                const value = row.values[field.key] ?? "";
                const commonProps = {
                  onFocus: () => onSelect({ row: rowIndex, col: colIndex }),
                  onBlur: () => onCellBlur(rowIndex),
                  onKeyDown: (event: React.KeyboardEvent) => handleKeyDown(event, rowIndex, colIndex),
                  onPaste: (event: React.ClipboardEvent) => handlePaste(event, rowIndex, colIndex),
                  title: error?.message,
                  className: `w-full min-w-[140px] rounded-md border bg-transparent px-2 py-1 text-[13px] text-slate-100 outline-none focus:ring-2 focus:ring-rose-400 ${
                    error ? "border-rose-400/70 bg-rose-500/10" : "border-white/10"
                  }`,
                };
                return (
                  <td key={field.key} className="px-1.5 py-1">
                    {field.type === "select" ? (
                      <select
                        ref={(el) => registerRef(rowIndex, colIndex, el)}
                        value={value}
                        onChange={(event) => onChangeCell(rowIndex, field.key, event.target.value)}
                        {...commonProps}
                      >
                        <option value="">— pilih —</option>
                        {(REFERENCE_SETS[field.referenceKey ?? ""] ?? []).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.display}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        ref={(el) => registerRef(rowIndex, colIndex, el)}
                        type={field.type === "date" ? "date" : "text"}
                        inputMode={field.type === "number" || field.type === "month" || field.type === "year" ? "decimal" : "text"}
                        value={value}
                        onChange={(event) => onChangeCell(rowIndex, field.key, event.target.value)}
                        {...commonProps}
                      />
                    )}
                    {error && <span className="mt-0.5 block text-[11px] leading-tight text-rose-400">⚠ {error.message}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
