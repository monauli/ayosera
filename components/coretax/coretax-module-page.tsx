"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CoretaxGrid, type CoretaxCellPosition } from "./coretax-grid";
import { CoretaxToolbar } from "./coretax-toolbar";
import { CoretaxValidationSummary } from "./coretax-validation-summary";
import { CoretaxXmlPreview } from "./coretax-xml-preview";
import { coretaxModule, emptyCoretaxRowValues } from "@/lib/coretax/modules";
import { parsePastedRows } from "@/lib/coretax/paste-parser";
import { validateCoretaxRow, isRowBlank, canExportCoretaxRows } from "@/lib/coretax/validation";
import { coretaxFileName, generateCoretaxXml } from "@/lib/coretax/xml-generator";
import type { CoretaxModuleId, CoretaxRow } from "@/lib/coretax/types";

type User = { id: string; role: "supervisor" | "user"; allowedModules: string[] };
type DraftListItem = { _id: string; name: string; updatedAt: string; rowCount: number; validRowCount: number; invalidRowCount: number };
type DraftDetail = DraftListItem & { tin: string; taxPeriodMonth: string | null; taxPeriodYear: string | null; rows: CoretaxRow[]; createdAt: string };

function newRow(config: ReturnType<typeof coretaxModule>): CoretaxRow {
  return { rowId: crypto.randomUUID(), values: emptyCoretaxRowValues(config), status: "belum-diperiksa", errors: [] };
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
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
  const [selected, setSelected] = useState<CoretaxCellPosition | null>(null);
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [message, setMessage] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewXml, setPreviewXml] = useState("");
  const [undoStack, setUndoStack] = useState<CoretaxRow[][]>([]);

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

  function pushUndoSnapshot() {
    setUndoStack((stack) => [...stack.slice(-19), rows]);
  }

  function undo() {
    setUndoStack((stack) => {
      if (!stack.length) return stack;
      const previous = stack[stack.length - 1];
      setRows(previous);
      return stack.slice(0, -1);
    });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoStack]);

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

  function handleChangeCell(rowIndex: number, key: string, value: string) {
    setRows((current) => {
      const next = [...current];
      next[rowIndex] = { ...next[rowIndex], values: { ...next[rowIndex].values, [key]: value } };
      return next;
    });
  }

  function handleCellBlur(rowIndex: number) {
    setRows((current) => validateRowAt(rowIndex, current));
  }

  function handlePasteAt(rowIndex: number, colIndex: number, text: string) {
    pushUndoSnapshot();
    const parsed = parsePastedRows(text, config.fields, colIndex);
    setRows((current) => {
      const next = [...current];
      parsed.forEach((values, offset) => {
        const targetIndex = rowIndex + offset;
        while (next.length <= targetIndex) next.push(newRow(config));
        next[targetIndex] = { ...next[targetIndex], values: { ...next[targetIndex].values, ...values } };
      });
      let result = next;
      for (let i = rowIndex; i < rowIndex + parsed.length; i++) result = validateRowAt(i, result);
      return result;
    });
    setChecked(true);
  }

  function handleAddRow() {
    setRows((current) => [...current, newRow(config)]);
  }

  function handleDeleteRow() {
    if (!selected) return;
    pushUndoSnapshot();
    setRows((current) => current.filter((_, index) => index !== selected.row));
    setSelected(null);
  }

  function handleDuplicateRow() {
    if (!selected) return;
    pushUndoSnapshot();
    setRows((current) => {
      const source = current[selected.row];
      if (!source) return current;
      const clone: CoretaxRow = { rowId: crypto.randomUUID(), values: { ...source.values }, status: source.status, errors: [...source.errors] };
      const next = [...current];
      next.splice(selected.row + 1, 0, clone);
      return next;
    });
  }

  function handleClearAll() {
    if (!window.confirm("Kosongkan seluruh data pada draft ini?")) return;
    pushUndoSnapshot();
    setRows([newRow(config), newRow(config)]);
    setChecked(false);
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
    setLastSavedAt(draft.updatedAt);
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
    setLastSavedAt(null);
    setMessage("");
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

  function openPreview() {
    const validated = validateAllRows();
    const meaningful = validated.filter((r) => !isRowBlank(config, r.values));
    setPreviewXml(
      canExportCoretaxRows(true, meaningful)
        ? generateCoretaxXml(config, tin, meaningful)
        : `Masih ada ${meaningful.filter((r) => r.status !== "benar").length} baris yang perlu diperbaiki sebelum XML dapat diunduh.`,
    );
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

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6">
      <div className="mb-4">
        <a href="/coretax" className="text-sm text-slate-400 hover:text-slate-200">
          ← Kembali ke Coretax
        </a>
        <h1 className="mt-2 text-xl font-semibold text-slate-100">{config.title}</h1>
      </div>

      <div className="rd-card mb-4 rounded-2xl p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs text-slate-400">
            Nama Draft
            <input className="rd-input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-xs text-slate-400">
            NPWP/NIK Perusahaan (TIN)
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
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-slate-500">
          <span>Status Data: {checked ? (invalidCount > 0 ? "Perlu Diperbaiki" : "Benar") : "Belum Diperiksa"}</span>
          <span>Terakhir Disimpan: {formatDateTime(lastSavedAt) ?? "Belum pernah disimpan"}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
          <button type="button" onClick={startNewDraft} className="rd-chip cursor-pointer border-white/10 bg-white/5 px-3 py-1.5 text-slate-200 hover:bg-white/10">
            Draft Baru
          </button>
          <select
            className="rd-input h-9 max-w-[220px]"
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

      <div className="rd-card rounded-2xl p-5">
        <p className="mb-3 text-xs text-slate-500">Salin data dari Excel, klik sel pertama, lalu tekan Ctrl+V.</p>
        <div className="mb-3">
          <CoretaxToolbar
            onAddRow={handleAddRow}
            onDeleteRow={handleDeleteRow}
            onDuplicateRow={handleDuplicateRow}
            onClearAll={handleClearAll}
            onPasteFromClipboard={(text) => handlePasteAt(selected?.row ?? 0, selected?.col ?? 0, text)}
            onValidate={validateAllRows}
            onSaveDraft={() => void saveDraft()}
            onPreviewXml={openPreview}
            onDownloadXml={downloadXml}
            hasSelection={selected !== null}
            saving={saving}
            validating={validating}
          />
        </div>
        {message && (
          <p className="mb-3 text-sm text-slate-300" aria-live="polite">
            {message}
          </p>
        )}
        <div className="mb-3">
          <CoretaxValidationSummary rows={meaningfulRows} checked={checked} />
        </div>
        <CoretaxGrid
          fields={config.fields}
          rows={rows}
          onChangeCell={handleChangeCell}
          onCellBlur={handleCellBlur}
          onPasteAt={handlePasteAt}
          onSelect={setSelected}
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
