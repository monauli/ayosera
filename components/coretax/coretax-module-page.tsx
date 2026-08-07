"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CoretaxGrid } from "./coretax-grid";
import { CoretaxToolbar } from "./coretax-toolbar";
import { CoretaxValidationSummary } from "./coretax-validation-summary";
import { CoretaxXmlPreview } from "./coretax-xml-preview";
import { coretaxModule, emptyCoretaxRowValues } from "@/lib/coretax/modules";
import { parsePastedRows } from "@/lib/coretax/paste-parser";
import { validateCoretaxRow, isRowBlank, canExportCoretaxRows } from "@/lib/coretax/validation";
import { coretaxFileName, generateCoretaxXml } from "@/lib/coretax/xml-generator";
import {
  clearRangeValues,
  fillDownValues,
  fillRightValues,
  normalizeRange,
  rangeCellCount,
  rangeToTsv,
  type CellPos,
  type NavDirection,
  type SelectionRange,
} from "@/lib/coretax/grid-selection";
import type { CoretaxModuleId, CoretaxRow } from "@/lib/coretax/types";

type User = { id: string; role: "supervisor" | "user"; allowedModules: string[] };
type DraftListItem = { _id: string; name: string; updatedAt: string; rowCount: number; validRowCount: number; invalidRowCount: number };
type DraftDetail = DraftListItem & { tin: string; taxPeriodMonth: string | null; taxPeriodYear: string | null; rows: CoretaxRow[]; createdAt: string };

const MAX_HISTORY = 50;

function newRow(config: ReturnType<typeof coretaxModule>): CoretaxRow {
  return { rowId: crypto.randomUUID(), values: emptyCoretaxRowValues(config), status: "belum-diperiksa", errors: [] };
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

/** Kotak pembungkus seluruh sel yang berisi data — dipakai Ctrl+A tahap 1. */
function dataBoundingBox(rows: CoretaxRow[], fields: { key: string }[]) {
  let top = -1, bottom = -1, left = -1, right = -1;
  rows.forEach((row, r) => {
    fields.forEach((f, c) => {
      if ((row.values[f.key] ?? "").trim() !== "") {
        if (top === -1) top = r;
        bottom = r;
        if (left === -1 || c < left) left = c;
        if (right === -1 || c > right) right = c;
      }
    });
  });
  if (top === -1) return { top: 0, bottom: rows.length - 1, left: 0, right: fields.length - 1 };
  return { top, bottom, left, right };
}

export function CoretaxModulePage({ moduleId }: { moduleId: CoretaxModuleId }) {
  const config = useMemo(() => coretaxModule(moduleId), [moduleId]);

  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [name, setName] = useState("Draft Baru");
  const [tin, setTin] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [rows, setRows] = useState<CoretaxRow[]>(() => [newRow(config), newRow(config)]);
  const [checked, setChecked] = useState(false);
  const [everExported, setEverExported] = useState(false);
  const [selection, setSelection] = useState<SelectionRange | null>({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
  const [editingCell, setEditingCell] = useState<CellPos | null>(null);
  const [editingInitialValue, setEditingInitialValue] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [message, setMessage] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewXml, setPreviewXml] = useState("");
  const [past, setPast] = useState<CoretaxRow[][]>([]);
  const [future, setFuture] = useState<CoretaxRow[][]>([]);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUser(data?.user ?? null))
      .catch(() => setUser(null));
  }, []);

  const loadDrafts = useCallback(async () => {
    const response = await fetch(`/api/coretax/drafts?moduleId=${moduleId}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json().catch(() => null)) as { drafts?: DraftListItem[] } | null;
    setDrafts(data?.drafts ?? []);
  }, [moduleId]);

  useEffect(() => {
    void loadDrafts();
  }, [loadDrafts]);

  function pushHistory(snapshot: CoretaxRow[]) {
    setPast((stack) => [...stack.slice(-(MAX_HISTORY - 1)), snapshot]);
    setFuture([]);
  }

  function undo() {
    setPast((stack) => {
      if (!stack.length) return stack;
      const previous = stack[stack.length - 1];
      setFuture((f) => [rows, ...f].slice(0, MAX_HISTORY));
      setRows(previous);
      return stack.slice(0, -1);
    });
  }

  function redo() {
    setFuture((stack) => {
      if (!stack.length) return stack;
      const next = stack[0];
      setPast((p) => [...p, rows].slice(-MAX_HISTORY));
      setRows(next);
      return stack.slice(1);
    });
  }

  function validateRowAt(index: number, rowsInput: CoretaxRow[]): CoretaxRow[] {
    const next = [...rowsInput];
    const row = next[index];
    if (!row) return next;
    if (isRowBlank(config, row.values)) {
      next[index] = { ...row, status: "belum-diperiksa", errors: [] };
      return next;
    }
    const errors = validateCoretaxRow(config, row.values);
    next[index] = { ...row, status: errors.length ? "perlu-diperbaiki" : "benar", errors };
    return next;
  }

  function computeValidatedRows(rowsInput: CoretaxRow[]): CoretaxRow[] {
    let next = rowsInput;
    for (let i = 0; i < next.length; i++) next = validateRowAt(i, next);
    return next;
  }

  function validateAllRows() {
    setValidating(true);
    const validated = computeValidatedRows(rows);
    setRows(validated);
    setChecked(true);
    setValidating(false);
    return validated;
  }

  // ---- Grid interaction handlers ----

  function handleStartEdit(pos: CellPos, initialValue?: string) {
    setEditingCell(pos);
    setEditingInitialValue(initialValue);
    setSelection({ anchor: pos, focus: pos });
  }

  function handleCancelEdit() {
    setEditingCell(null);
    setEditingInitialValue(undefined);
  }

  function handleCommitEdit(pos: CellPos, value: string, moveAfter: NavDirection | null) {
    const field = config.fields[pos.col];
    if (field) {
      pushHistory(rows);
      setRows((current) => {
        const next = [...current];
        next[pos.row] = { ...next[pos.row], values: { ...next[pos.row].values, [field.key]: value } };
        return validateRowAt(pos.row, next);
      });
    }
    setEditingCell(null);
    setEditingInitialValue(undefined);
    if (moveAfter) {
      const next = moveCellClamped(pos, moveAfter);
      setSelection({ anchor: next, focus: next });
    } else {
      setSelection({ anchor: pos, focus: pos });
    }
  }

  function moveCellClamped(pos: CellPos, dir: NavDirection): CellPos {
    const rowCount = rows.length;
    const colCount = config.fields.length;
    const delta: Record<NavDirection, CellPos> = { up: { row: -1, col: 0 }, down: { row: 1, col: 0 }, left: { row: 0, col: -1 }, right: { row: 0, col: 1 } };
    const d = delta[dir];
    return {
      row: Math.min(Math.max(pos.row + d.row, 0), Math.max(rowCount - 1, 0)),
      col: Math.min(Math.max(pos.col + d.col, 0), Math.max(colCount - 1, 0)),
    };
  }

  function handlePasteAt(pos: CellPos, text: string) {
    pushHistory(rows);
    const parsed = parsePastedRows(text, config.fields, pos.col);
    let lastCol = pos.col;
    setRows((current) => {
      const next = [...current];
      parsed.forEach((values, offset) => {
        const targetIndex = pos.row + offset;
        while (next.length <= targetIndex) next.push(newRow(config));
        next[targetIndex] = { ...next[targetIndex], values: { ...next[targetIndex].values, ...values } };
        lastCol = Math.max(lastCol, pos.col + Object.keys(values).length - 1);
      });
      let result = next;
      for (let i = pos.row; i < pos.row + parsed.length; i++) result = validateRowAt(i, result);
      return result;
    });
    setChecked(true);
    if (parsed.length) {
      const endRow = pos.row + parsed.length - 1;
      setSelection({ anchor: pos, focus: { row: endRow, col: Math.min(lastCol, config.fields.length - 1) } });
    }
  }

  async function handleCopyRange(range: SelectionRange) {
    const tsv = rangeToTsv(range, rows, config.fields);
    try {
      await navigator.clipboard.writeText(tsv);
    } catch {
      // Clipboard API ditolak browser (butuh https/izin) — biarkan event `copy` bawaan browser yang menangani (sudah tidak di-preventDefault untuk kasus 1 sel).
    }
  }

  function handleDeleteRange(range: SelectionRange) {
    const cellCount = rangeCellCount(range);
    if (cellCount > 500 && !window.confirm(`Hapus isi ${cellCount} sel yang dipilih?`)) return;
    pushHistory(rows);
    const updates = clearRangeValues(range, config.fields);
    applyUpdates(updates);
  }

  function handleFillDown(range: SelectionRange) {
    pushHistory(rows);
    applyUpdates(fillDownValues(range, rows, config.fields));
  }

  function handleFillRight(range: SelectionRange) {
    pushHistory(rows);
    applyUpdates(fillRightValues(range, rows, config.fields));
  }

  function applyUpdates(updates: { row: number; col: number; value: string }[]) {
    if (!updates.length) return;
    const touchedRows = new Set(updates.map((u) => u.row));
    setRows((current) => {
      const next = [...current];
      for (const update of updates) {
        const field = config.fields[update.col];
        if (!field || !next[update.row]) continue;
        next[update.row] = { ...next[update.row], values: { ...next[update.row].values, [field.key]: update.value } };
      }
      let result = next;
      for (const r of touchedRows) result = validateRowAt(r, result);
      return result;
    });
  }

  function handleSelectAllToggle() {
    const box = dataBoundingBox(rows, config.fields);
    const current = selection ? normalizeRange(selection) : null;
    const isAtDataBox = current && current.top === box.top && current.bottom === box.bottom && current.left === box.left && current.right === box.right;
    if (isAtDataBox) {
      setSelection({ anchor: { row: 0, col: 0 }, focus: { row: rows.length - 1, col: config.fields.length - 1 } });
    } else {
      setSelection({ anchor: { row: box.top, col: box.left }, focus: { row: box.bottom, col: box.right } });
    }
  }

  function handleJumpToError(rowIndex: number, fieldKey: string) {
    const colIndex = config.fields.findIndex((f) => f.key === fieldKey);
    if (colIndex === -1) return;
    setSelection({ anchor: { row: rowIndex, col: colIndex }, focus: { row: rowIndex, col: colIndex } });
    setEditingCell(null);
  }

  function handleAddRow() {
    setRows((current) => [...current, newRow(config)]);
  }

  function handleDeleteRow() {
    if (!selection) return;
    const range = normalizeRange(selection);
    pushHistory(rows);
    setRows((current) => current.filter((_, index) => index < range.top || index > range.bottom));
    setSelection(null);
  }

  function handleDuplicateRow() {
    if (!selection) return;
    const range = normalizeRange(selection);
    pushHistory(rows);
    setRows((current) => {
      const clones = current.slice(range.top, range.bottom + 1).map((source) => ({
        rowId: crypto.randomUUID(),
        values: { ...source.values },
        status: source.status,
        errors: [...source.errors],
      }));
      const next = [...current];
      next.splice(range.bottom + 1, 0, ...clones);
      return next;
    });
  }

  function handleClearAll() {
    if (!window.confirm("Kosongkan seluruh data pada draft ini?")) return;
    pushHistory(rows);
    setRows([newRow(config), newRow(config)]);
    setChecked(false);
    setEverExported(false);
  }

  async function openDraft(id: string) {
    const response = await fetch(`/api/coretax/drafts/${id}`, { cache: "no-store" });
    if (!response.ok) {
      setMessage("Gagal membuka draft.");
      return;
    }
    const data = (await response.json().catch(() => null)) as { draft?: DraftDetail } | null;
    const draft = data?.draft;
    if (!draft) return;
    setDraftId(draft._id);
    setName(draft.name);
    setTin(draft.tin ?? "");
    setMonth(draft.taxPeriodMonth ?? "");
    setYear(draft.taxPeriodYear ?? "");
    setRows(draft.rows.length ? draft.rows : [newRow(config), newRow(config)]);
    setChecked(draft.rows.some((r) => r.status !== "belum-diperiksa"));
    setEverExported(false);
    setLastSavedAt(draft.updatedAt);
    setPast([]);
    setFuture([]);
    setMessage("Draft dibuka.");
  }

  function startNewDraft() {
    setDraftId(null);
    setName("Draft Baru");
    setTin("");
    setMonth("");
    setYear("");
    setRows([newRow(config), newRow(config)]);
    setChecked(false);
    setEverExported(false);
    setLastSavedAt(null);
    setMessage("");
    setPast([]);
    setFuture([]);
  }

  async function saveDraft() {
    setSaving(true);
    setMessage("");
    try {
      let id = draftId;
      if (!id) {
        const createResponse = await fetch("/api/coretax/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ moduleId, name: name.trim() || "Draft Baru" }),
        });
        const createData = await createResponse.json().catch(() => null);
        if (!createResponse.ok) throw new Error(createData?.error || "Gagal membuat draft.");
        id = createData.draft._id;
        setDraftId(id);
      }
      const patchResponse = await fetch(`/api/coretax/drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "Draft Baru", tin, taxPeriodMonth: month || null, taxPeriodYear: year || null, rows }),
      });
      const patchData = await patchResponse.json().catch(() => null);
      if (!patchResponse.ok) throw new Error(patchData?.error || "Gagal menyimpan draft.");
      setLastSavedAt(patchData.draft.updatedAt);
      setMessage("Draft tersimpan.");
      void loadDrafts();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Gagal menyimpan draft.");
    } finally {
      setSaving(false);
    }
  }

  async function renameDraft() {
    if (!draftId) return;
    const nextName = window.prompt("Nama draft baru:", name);
    if (!nextName || !nextName.trim()) return;
    setName(nextName.trim());
    await fetch(`/api/coretax/drafts/${draftId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nextName.trim() }),
    });
    void loadDrafts();
  }

  async function deleteDraft(id: string) {
    if (!window.confirm("Hapus draft ini? Tindakan tidak dapat dibatalkan.")) return;
    await fetch(`/api/coretax/drafts/${id}`, { method: "DELETE" });
    if (id === draftId) startNewDraft();
    void loadDrafts();
  }

  const meaningfulRows = rows.filter((r) => !isRowBlank(config, r.values));
  const invalidCount = meaningfulRows.filter((r) => r.status === "perlu-diperbaiki").length;
  const allBlank = meaningfulRows.length === 0;

  function openPreview() {
    const validated = validateAllRows();
    const meaningful = validated.filter((r) => !isRowBlank(config, r.values));
    const ok = canExportCoretaxRows(true, meaningful);
    setPreviewXml(
      ok
        ? generateCoretaxXml(config, tin, meaningful)
        : `Masih ada ${meaningful.filter((r) => r.status !== "benar").length} baris yang perlu diperbaiki sebelum XML dapat diunduh.`,
    );
    if (ok) setEverExported(true);
    setPreviewOpen(true);
  }

  function downloadXml() {
    const validated = validateAllRows();
    const meaningful = validated.filter((r) => !isRowBlank(config, r.values));
    if (!canExportCoretaxRows(true, meaningful)) {
      const remaining = meaningful.filter((r) => r.status !== "benar").length;
      setMessage(`Masih ada ${remaining} baris yang perlu diperbaiki sebelum XML dapat diunduh.`);
      return;
    }
    const xml = generateCoretaxXml(config, tin, meaningful);
    const fileName = coretaxFileName(config, { year, month }, name);
    const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setEverExported(true);
    setMessage("XML berhasil diunduh.");
  }

  const supervisor = user?.role === "supervisor";
  if (user === null) {
    if (typeof window !== "undefined") window.location.assign("/login");
    return null;
  }
  if (user && !user.allowedModules.includes("coretax") && !supervisor) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-sm text-slate-400">Akses ditolak. Hubungi supervisor untuk meminta modul Coretax.</p>
      </main>
    );
  }

  const statusLabel = !checked && allBlank ? "belum-ada-data" : !checked ? "belum-diperiksa" : invalidCount > 0 ? "perlu-diperbaiki" : everExported ? "siap-diunduh" : "benar";

  return (
    <main className="mx-auto max-w-full px-3 py-4 sm:px-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <a href="/coretax" className="text-sm text-slate-400 hover:text-slate-200">
          ← Kembali
        </a>
        <h1 className="text-lg font-semibold text-slate-100">{config.code}</h1>
        <span className="text-xs text-slate-500">— Siapkan data dan unduh XML untuk Coretax</span>
      </div>

      <div className="rd-card mb-3 rounded-xl p-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
          <label className="text-xs text-slate-400">
            Nama Draft
            <input className="rd-input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-xs text-slate-400">
            NPWP/NIK Perusahaan
            <input className="rd-input mt-1 w-full" value={tin} onChange={(e) => setTin(e.target.value)} placeholder="16 digit" />
          </label>
          {config.hasMonthlyPeriod ? (
            <>
              <label className="text-xs text-slate-400">
                Masa Pajak
                <input className="rd-input mt-1 w-full" value={month} onChange={(e) => setMonth(e.target.value)} placeholder="1-12" />
              </label>
              <label className="text-xs text-slate-400">
                Tahun Pajak
                <input className="rd-input mt-1 w-full" value={year} onChange={(e) => setYear(e.target.value)} placeholder="2026" />
              </label>
            </>
          ) : (
            <label className="text-xs text-slate-400">
              Tahun Pajak
              <input className="rd-input mt-1 w-full" value={year} onChange={(e) => setYear(e.target.value)} placeholder="2026" />
            </label>
          )}
          <div className="text-xs text-slate-500 lg:col-span-2">
            Terakhir Disimpan: {formatDateTime(lastSavedAt) ?? "Belum pernah disimpan"}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2">
          <button type="button" onClick={startNewDraft} className="rd-chip cursor-pointer border-white/10 bg-white/5 px-3 py-1.5 text-slate-200 hover:bg-white/10">
            Draft Baru
          </button>
          <select
            className="rd-input h-8 max-w-[220px]"
            value={draftId ?? ""}
            onChange={(e) => (e.target.value ? void openDraft(e.target.value) : startNewDraft())}
          >
            <option value="">Buka draft tersimpan…</option>
            {drafts.map((d) => (
              <option key={d._id} value={d._id}>
                {d.name} ({d.rowCount} baris)
              </option>
            ))}
          </select>
          {draftId && (
            <>
              <button type="button" onClick={renameDraft} className="rd-chip cursor-pointer border-white/10 bg-white/5 px-3 py-1.5 text-slate-200 hover:bg-white/10">
                Ganti Nama
              </button>
              <button
                type="button"
                onClick={() => void deleteDraft(draftId)}
                className="rd-chip cursor-pointer border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-rose-300 hover:bg-rose-500/20"
              >
                Hapus Draft
              </button>
            </>
          )}
        </div>
      </div>

      <div className="rd-card rounded-xl p-3">
        <div className="sticky top-0 z-30 -mx-3 -mt-3 mb-2 border-b border-white/10 bg-[rgb(var(--rd-panel-bg))]/95 px-3 py-2 backdrop-blur">
          <CoretaxToolbar
            onAddRow={handleAddRow}
            onDeleteRow={handleDeleteRow}
            onDuplicateRow={handleDuplicateRow}
            onClearAll={handleClearAll}
            onPasteFromClipboard={(text) => handlePasteAt(selection?.focus ?? { row: 0, col: 0 }, text)}
            onValidate={validateAllRows}
            onSaveDraft={() => void saveDraft()}
            onPreviewXml={openPreview}
            onDownloadXml={downloadXml}
            hasSelection={selection !== null}
            saving={saving}
            validating={validating}
          />
          <p className="mt-1.5 text-[11px] text-slate-500">
            Klik sel awal lalu Ctrl+V untuk tempel dari Excel · Ctrl+Shift+↓ pilih sampai bawah · Ctrl+D salin ke bawah
          </p>
        </div>
        {message && (
          <p className="mb-2 text-sm text-slate-300" aria-live="polite">
            {message}
          </p>
        )}
        <div className="mb-2">
          <CoretaxValidationSummary rows={meaningfulRows} checked={checked} statusLabel={statusLabel} fields={config.fields} onJumpToError={handleJumpToError} />
        </div>
        <CoretaxGrid
          moduleId={moduleId}
          fields={config.fields}
          rows={rows}
          selection={selection}
          editingCell={editingCell}
          editingInitialValue={editingInitialValue}
          onSelectionChange={setSelection}
          onStartEdit={handleStartEdit}
          onCommitEdit={handleCommitEdit}
          onCancelEdit={handleCancelEdit}
          onDeleteRange={handleDeleteRange}
          onFillDown={handleFillDown}
          onFillRight={handleFillRight}
          onCopyRange={(range) => void handleCopyRange(range)}
          onPasteAt={handlePasteAt}
          onUndo={undo}
          onRedo={redo}
          onSelectAllToggle={handleSelectAllToggle}
        />
      </div>

      <CoretaxXmlPreview
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={config.title}
        tin={tin}
        rowCount={meaningfulRows.length}
        validRowCount={meaningfulRows.filter((r) => r.status === "benar").length}
        fileName={coretaxFileName(config, { year, month }, name)}
        xml={previewXml}
        onDownload={downloadXml}
      />
    </main>
  );
}
