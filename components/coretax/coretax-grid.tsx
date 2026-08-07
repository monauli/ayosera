"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CoretaxFieldDef, CoretaxRow } from "@/lib/coretax/types";
import { REFERENCE_SETS } from "@/lib/coretax/references";
import {
  extendSelection,
  isInRange,
  jumpToDataEdge,
  moveCell,
  normalizeRange,
  type CellPos,
  type NavDirection,
  type SelectionRange,
} from "@/lib/coretax/grid-selection";

export type CoretaxCellPosition = CellPos;

const MIN_COL_WIDTH = 120;
const DEFAULT_COL_WIDTH = 160;

function displayValue(field: CoretaxFieldDef, raw: string): string {
  if (field.type === "select" && raw) {
    const option = (REFERENCE_SETS[field.referenceKey ?? ""] ?? []).find((o) => o.value === raw);
    if (option) return `${option.value} — ${option.display}`;
  }
  return raw;
}

/**
 * Grid seperti Excel — active cell + range selection dikelola parent
 * (coretax-module-page.tsx), komponen ini murni render + terjemahkan
 * event DOM (klik/drag/keyboard/paste/copy) jadi callback murni.
 * Sel TIDAK selalu dalam mode edit: klik hanya memilih, edit dimulai lewat
 * double-click / Enter / mengetik langsung (lihat handleCellKeyDown).
 */
export function CoretaxGrid({
  moduleId,
  fields,
  rows,
  selection,
  editingCell,
  editingInitialValue,
  onSelectionChange,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDeleteRange,
  onFillDown,
  onFillRight,
  onCopyRange,
  onPasteAt,
  onUndo,
  onRedo,
  onSelectAllToggle,
}: {
  moduleId: string;
  fields: readonly CoretaxFieldDef[];
  rows: readonly CoretaxRow[];
  selection: SelectionRange | null;
  editingCell: CellPos | null;
  editingInitialValue?: string;
  onSelectionChange: (range: SelectionRange) => void;
  onStartEdit: (pos: CellPos, initialValue?: string) => void;
  onCommitEdit: (pos: CellPos, value: string, moveAfter: NavDirection | null) => void;
  onCancelEdit: () => void;
  onDeleteRange: (range: SelectionRange) => void;
  onFillDown: (range: SelectionRange) => void;
  onFillRight: (range: SelectionRange) => void;
  onCopyRange: (range: SelectionRange) => void;
  onPasteAt: (pos: CellPos, text: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSelectAllToggle: () => void;
}) {
  const cellRefs = useRef<Map<string, HTMLElement>>(new Map());
  const cellKey = (row: number, col: number) => `${row}:${col}`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const resizeRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`coretax-col-widths:${moduleId}`);
      if (raw) setColWidths(JSON.parse(raw));
    } catch {
      // sessionStorage tidak tersedia (mis. private mode ketat) — abaikan, pakai lebar default.
    }
  }, [moduleId]);

  const registerRef = useCallback((row: number, col: number, el: HTMLElement | null) => {
    const key = cellKey(row, col);
    if (el) cellRefs.current.set(key, el);
    else cellRefs.current.delete(key);
  }, []);

  const focusCell = useCallback((row: number, col: number) => {
    const el = cellRefs.current.get(cellKey(row, col));
    el?.focus();
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  useEffect(() => {
    if (!editingCell && selection) focusCell(selection.focus.row, selection.focus.col);
  }, [selection, editingCell, focusCell]);

  const rowCount = rows.length;
  const colCount = fields.length;

  function isTypingInHeaderField(): boolean {
    const active = document.activeElement;
    return !!active && !active.closest("[data-coretax-grid]");
  }

  function handleGridKeyDown(event: React.KeyboardEvent) {
    if (isTypingInHeaderField()) return;
    if (!selection) return;
    const ctrlKey = event.ctrlKey || event.metaKey;

    if (editingCell) {
      // Mode edit: hanya Enter/Tab/Escape yang ditangani di sini — sisanya biarkan input bekerja normal.
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelEdit();
      }
      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const dir: NavDirection = event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : event.key === "ArrowLeft" ? "left" : "right";
      if (ctrlKey && event.shiftKey) {
        onSelectionChange(jumpToDataEdge(selection, dir, rows, fields, colCount));
      } else if (event.shiftKey) {
        onSelectionChange(extendSelection(selection, dir, rowCount, colCount));
      } else {
        const next = moveCell(selection.focus, dir, rowCount, colCount);
        onSelectionChange({ anchor: next, focus: next });
      }
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const next = moveCell(selection.focus, event.shiftKey ? "left" : "right", rowCount, colCount);
      onSelectionChange({ anchor: next, focus: next });
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        const next = moveCell(selection.focus, "up", rowCount, colCount);
        onSelectionChange({ anchor: next, focus: next });
      } else {
        onStartEdit(selection.focus);
      }
      return;
    }

    if (event.key === "F2") {
      event.preventDefault();
      onStartEdit(selection.focus);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      const next = { row: selection.focus.row, col: 0 };
      onSelectionChange({ anchor: next, focus: next });
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const next = { row: selection.focus.row, col: colCount - 1 };
      onSelectionChange({ anchor: next, focus: next });
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onDeleteRange(selection);
      return;
    }

    if (ctrlKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      onFillDown(selection);
      return;
    }
    if (ctrlKey && event.key.toLowerCase() === "r") {
      event.preventDefault();
      onFillRight(selection);
      return;
    }
    if (ctrlKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      onSelectAllToggle();
      return;
    }
    if (ctrlKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      onUndo();
      return;
    }
    if (ctrlKey && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) {
      event.preventDefault();
      onRedo();
      return;
    }
    if (ctrlKey && event.key.toLowerCase() === "c") {
      // Biarkan browser tetap mencoba copy DOM asli juga (tidak preventDefault) — onCopy handler di bawah yang menulis TSV eksplisit.
      onCopyRange(selection);
      return;
    }

    // Mengetik karakter langsung di sel aktif (bukan dropdown) -> mulai edit dengan karakter itu.
    if (event.key.length === 1 && !ctrlKey && !event.altKey) {
      const field = fields[selection.focus.col];
      if (field && field.type !== "select") {
        onStartEdit(selection.focus, event.key);
      } else if (field) {
        onStartEdit(selection.focus);
      }
    }
  }

  function handleCopy(event: React.ClipboardEvent) {
    if (isTypingInHeaderField() || !selection || editingCell) return;
    event.preventDefault();
    onCopyRange(selection);
  }

  function handlePaste(event: React.ClipboardEvent) {
    if (isTypingInHeaderField() || !selection || editingCell) return;
    const text = event.clipboardData.getData("text");
    if (!text) return;
    event.preventDefault();
    onPasteAt(selection.focus, text);
  }

  function handleMouseDownCell(row: number, col: number, event: React.MouseEvent) {
    if (editingCell) return;
    draggingRef.current = true;
    if (event.shiftKey && selection) {
      onSelectionChange({ anchor: selection.anchor, focus: { row, col } });
    } else {
      onSelectionChange({ anchor: { row, col }, focus: { row, col } });
    }
  }

  function handleMouseEnterCell(row: number, col: number) {
    if (!draggingRef.current || !selection) return;
    onSelectionChange({ anchor: selection.anchor, focus: { row, col } });
  }

  useEffect(() => {
    function stopDrag() {
      draggingRef.current = false;
    }
    window.addEventListener("mouseup", stopDrag);
    return () => window.removeEventListener("mouseup", stopDrag);
  }, []);

  function startResize(fieldKey: string, event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = { key: fieldKey, startX: event.clientX, startWidth: colWidths[fieldKey] ?? DEFAULT_COL_WIDTH };
    function onMove(moveEvent: MouseEvent) {
      const state = resizeRef.current;
      if (!state) return;
      const width = Math.max(MIN_COL_WIDTH, state.startWidth + (moveEvent.clientX - state.startX));
      setColWidths((prev) => ({ ...prev, [state.key]: width }));
    }
    function onUp() {
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setColWidths((prev) => {
        try {
          sessionStorage.setItem(`coretax-col-widths:${moduleId}`, JSON.stringify(prev));
        } catch {
          // abaikan bila sessionStorage tidak tersedia.
        }
        return prev;
      });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      ref={containerRef}
      data-coretax-grid="true"
      className="max-h-[70vh] overflow-auto rounded-xl border border-white/10"
      onKeyDown={handleGridKeyDown}
      onCopy={handleCopy}
      onPaste={handlePaste}
    >
      <table className="rd-table w-full text-sm" style={{ minWidth: `${48 + fields.reduce((sum, f) => sum + (colWidths[f.key] ?? DEFAULT_COL_WIDTH), 0)}px` }}>
        <thead>
          <tr className="sticky top-0 z-10" style={{ background: "rgb(var(--rd-panel-bg))" }}>
            <th className="sticky left-0 z-20 w-10 border-r border-white/10 px-1.5 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-400" style={{ background: "rgb(var(--rd-panel-bg))" }}>
              #
            </th>
            {fields.map((f) => (
              <th
                key={f.key}
                className="relative whitespace-nowrap px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                style={{ width: colWidths[f.key] ?? DEFAULT_COL_WIDTH, minWidth: MIN_COL_WIDTH }}
                title={f.helpText}
              >
                {f.label}
                {f.required && <span className="ml-0.5 text-rose-400">*</span>}
                <span
                  role="separator"
                  aria-orientation="vertical"
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-rose-400/30"
                  onMouseDown={(event) => startResize(f.key, event)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const rowHasError = row.status === "perlu-diperbaiki";
            return (
              <tr key={row.rowId} className={rowHasError ? "bg-rose-500/5" : undefined}>
                <td
                  className={`sticky left-0 z-[5] border-r border-white/10 px-1.5 py-1 text-center text-xs ${rowHasError ? "text-rose-400" : "text-slate-500"}`}
                  style={{ background: "rgb(var(--rd-panel-bg))" }}
                  aria-label={rowHasError ? `Baris ${rowIndex + 1}, ada kesalahan` : `Baris ${rowIndex + 1}`}
                >
                  {rowHasError && <span className="mr-0.5" aria-hidden="true">⚠</span>}
                  {rowIndex + 1}
                </td>
                {fields.map((field, colIndex) => {
                  const pos = { row: rowIndex, col: colIndex };
                  const error = row.errors.find((e) => e.field === field.key);
                  const value = row.values[field.key] ?? "";
                  const isActive = selection?.focus.row === rowIndex && selection?.focus.col === colIndex;
                  const isSelected = !!selection && isInRange(pos, selection);
                  const isEditing = editingCell?.row === rowIndex && editingCell?.col === colIndex;

                  return (
                    <td
                      key={field.key}
                      className={`relative border p-0 ${error ? "border-rose-400/60" : "border-transparent"}`}
                      style={{ width: colWidths[field.key] ?? DEFAULT_COL_WIDTH, minWidth: MIN_COL_WIDTH }}
                    >
                      {isEditing ? (
                        <CoretaxCellEditor
                          field={field}
                          value={editingInitialValue ?? value}
                          registerRef={(el) => registerRef(rowIndex, colIndex, el)}
                          onCommit={(next, moveAfter) => onCommitEdit(pos, next, moveAfter)}
                          onCancel={onCancelEdit}
                        />
                      ) : (
                        <div
                          ref={(el) => registerRef(rowIndex, colIndex, el)}
                          tabIndex={isActive ? 0 : -1}
                          role="gridcell"
                          aria-label={`Baris ${rowIndex + 1}, ${field.label}${error ? `, kesalahan: ${error.message}` : ""}`}
                          title={error?.message}
                          onMouseDown={(event) => handleMouseDownCell(rowIndex, colIndex, event)}
                          onMouseEnter={() => handleMouseEnterCell(rowIndex, colIndex)}
                          onDoubleClick={() => onStartEdit(pos)}
                          className={`min-h-[30px] cursor-cell truncate whitespace-nowrap px-2 py-1.5 text-[12.5px] outline-none ${
                            isActive ? "ring-2 ring-inset ring-rose-400" : isSelected ? "bg-rose-400/10" : ""
                          } ${error ? "bg-rose-500/10 text-rose-300" : "text-slate-100"}`}
                        >
                          {displayValue(field, value) || " "}
                        </div>
                      )}
                      {error && !isEditing && <span className="sr-only">{error.message}</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CoretaxCellEditor({
  field,
  value,
  registerRef,
  onCommit,
  onCancel,
}: {
  field: CoretaxFieldDef;
  value: string;
  registerRef: (el: HTMLInputElement | HTMLSelectElement | null) => void;
  onCommit: (value: string, moveAfter: NavDirection | null) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
    if (ref.current instanceof HTMLInputElement) ref.current.select();
  }, []);

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter") {
      event.preventDefault();
      onCommit(draft, event.shiftKey ? "up" : "down");
    } else if (event.key === "Tab") {
      event.preventDefault();
      onCommit(draft, event.shiftKey ? "left" : "right");
    }
    event.stopPropagation();
  }

  const commonProps = {
    onBlur: () => onCommit(draft, null),
    onKeyDown: handleKeyDown,
    className:
      "w-full min-h-[30px] rounded-none border-0 bg-transparent px-2 py-1.5 text-[12.5px] text-slate-100 outline-none ring-2 ring-inset ring-rose-500",
  };

  if (field.type === "select") {
    return (
      <select
        ref={(el) => {
          ref.current = el;
          registerRef(el);
        }}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        {...commonProps}
      >
        <option value="">— pilih —</option>
        {(REFERENCE_SETS[field.referenceKey ?? ""] ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.value} — {option.display}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      ref={(el) => {
        ref.current = el;
        registerRef(el);
      }}
      type={field.type === "date" ? "date" : "text"}
      inputMode={field.type === "number" || field.type === "month" || field.type === "year" ? "decimal" : "text"}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      {...commonProps}
    />
  );
}
