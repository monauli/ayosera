// Engine seleksi & navigasi grid seperti Excel — MURNI (tanpa DOM/React),
// dipakai components/coretax/coretax-grid.tsx. Semua fungsi menerima posisi
// & ukuran grid, mengembalikan posisi/range baru — tidak menyentuh state.
import { parsePastedRows } from "./paste-parser.ts";
import type { CoretaxFieldDef, CoretaxRow } from "./types.ts";

export type CellPos = { row: number; col: number };
export type SelectionRange = { anchor: CellPos; focus: CellPos };
export type NormalizedRange = { top: number; bottom: number; left: number; right: number };
export type NavDirection = "up" | "down" | "left" | "right";

export function normalizeRange(range: SelectionRange): NormalizedRange {
  return {
    top: Math.min(range.anchor.row, range.focus.row),
    bottom: Math.max(range.anchor.row, range.focus.row),
    left: Math.min(range.anchor.col, range.focus.col),
    right: Math.max(range.anchor.col, range.focus.col),
  };
}

export function isInRange(pos: CellPos, range: SelectionRange): boolean {
  const n = normalizeRange(range);
  return pos.row >= n.top && pos.row <= n.bottom && pos.col >= n.left && pos.col <= n.right;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Pindah satu sel (arrow/tab/shift+tab/enter/shift+enter), diclamp ke batas grid. */
export function moveCell(pos: CellPos, dir: NavDirection, rowCount: number, colCount: number): CellPos {
  const delta: Record<NavDirection, CellPos> = {
    up: { row: -1, col: 0 },
    down: { row: 1, col: 0 },
    left: { row: 0, col: -1 },
    right: { row: 0, col: 1 },
  };
  const d = delta[dir];
  return {
    row: clamp(pos.row + d.row, 0, Math.max(rowCount - 1, 0)),
    col: clamp(pos.col + d.col, 0, Math.max(colCount - 1, 0)),
  };
}

/** Shift+Arrow — perluas selection dari focus saat ini, anchor tetap. */
export function extendSelection(range: SelectionRange, dir: NavDirection, rowCount: number, colCount: number): SelectionRange {
  return { anchor: range.anchor, focus: moveCell(range.focus, dir, rowCount, colCount) };
}

function cellIsEmpty(rows: readonly CoretaxRow[], fields: readonly CoretaxFieldDef[], row: number, col: number): boolean {
  const field = fields[col];
  if (!field) return true;
  const value = rows[row]?.values[field.key];
  return !value || value.trim() === "";
}

/**
 * Ctrl+Shift+Arrow — meniru semantik Excel "loncat ke ujung blok data
 * berdekatan": bila sel sekarang berisi data, berhenti sebelum sel kosong
 * berikutnya (atau ujung grid bila semua terisi); bila sel sekarang kosong,
 * loncat ke sel berisi data pertama (atau ujung grid bila kosong semua).
 */
export function jumpToDataEdge(
  range: SelectionRange,
  dir: NavDirection,
  rows: readonly CoretaxRow[],
  fields: readonly CoretaxFieldDef[],
  colCount: number,
): SelectionRange {
  const rowCount = rows.length;
  const startEmpty = cellIsEmpty(rows, fields, range.focus.row, range.focus.col);
  let pos = range.focus;
  let prevEmpty = startEmpty;
  for (;;) {
    const next = moveCell(pos, dir, rowCount, colCount);
    if (next.row === pos.row && next.col === pos.col) break; // ujung grid
    const nextEmpty = cellIsEmpty(rows, fields, next.row, next.col);
    if (startEmpty) {
      // dari kosong: berhenti begitu ketemu sel berisi data.
      pos = next;
      if (!nextEmpty) break;
    } else {
      // dari berisi: berhenti SEBELUM sel kosong berikutnya.
      if (nextEmpty) break;
      pos = next;
    }
    prevEmpty = nextEmpty;
  }
  void prevEmpty;
  return { anchor: range.anchor, focus: pos };
}

/** TSV dari selected range — dipakai Ctrl+C. Nilai teks apa adanya (nol depan aman). */
export function rangeToTsv(range: SelectionRange, rows: readonly CoretaxRow[], fields: readonly CoretaxFieldDef[]): string {
  const n = normalizeRange(range);
  const lines: string[] = [];
  for (let r = n.top; r <= n.bottom; r++) {
    const cells: string[] = [];
    for (let c = n.left; c <= n.right; c++) {
      const field = fields[c];
      cells.push(field ? (rows[r]?.values[field.key] ?? "") : "");
    }
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

/** Bungkus parsePastedRows existing supaya dipakai konsisten dari grid (posisi mulai = focus cell). */
export function parseTsvForFill(text: string, fields: readonly CoretaxFieldDef[], startCol: number) {
  return parsePastedRows(text, fields, startCol);
}

export type CellUpdate = { row: number; col: number; value: string };

/** Ctrl+D — salin baris teratas range ke seluruh baris di bawahnya, per kolom. */
export function fillDownValues(range: SelectionRange, rows: readonly CoretaxRow[], fields: readonly CoretaxFieldDef[]): CellUpdate[] {
  const n = normalizeRange(range);
  const updates: CellUpdate[] = [];
  for (let c = n.left; c <= n.right; c++) {
    const field = fields[c];
    if (!field) continue;
    const sourceValue = rows[n.top]?.values[field.key] ?? "";
    for (let r = n.top + 1; r <= n.bottom; r++) updates.push({ row: r, col: c, value: sourceValue });
  }
  return updates;
}

/** Ctrl+R — salin kolom terkiri range ke seluruh kolom di kanannya, per baris. */
export function fillRightValues(range: SelectionRange, rows: readonly CoretaxRow[], fields: readonly CoretaxFieldDef[]): CellUpdate[] {
  const n = normalizeRange(range);
  const updates: CellUpdate[] = [];
  for (let r = n.top; r <= n.bottom; r++) {
    const sourceField = fields[n.left];
    const sourceValue = sourceField ? (rows[r]?.values[sourceField.key] ?? "") : "";
    for (let c = n.left + 1; c <= n.right; c++) {
      const field = fields[c];
      if (!field) continue;
      updates.push({ row: r, col: c, value: sourceValue });
    }
  }
  return updates;
}

/** Delete/Backspace — kosongkan seluruh sel dalam range (posisi tetap, tidak menghapus baris). */
export function clearRangeValues(range: SelectionRange, fields: readonly CoretaxFieldDef[]): CellUpdate[] {
  const n = normalizeRange(range);
  const updates: CellUpdate[] = [];
  for (let r = n.top; r <= n.bottom; r++) {
    for (let c = n.left; c <= n.right; c++) {
      if (!fields[c]) continue;
      updates.push({ row: r, col: c, value: "" });
    }
  }
  return updates;
}

export function rangeCellCount(range: SelectionRange): number {
  const n = normalizeRange(range);
  return (n.bottom - n.top + 1) * (n.right - n.left + 1);
}
