"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSearch, FileUp, Loader2, LockKeyhole, Moon, Paperclip, Printer, RefreshCw, Save, Search, Sun, Unlock, X } from "lucide-react";
import { visibleInventoryRows } from "@/lib/olsera-inventory-ui";
import { analyzeInventoryBaFile } from "@/lib/inventory-ba-client";
import { normalizeInventoryBaName } from "@/lib/inventory-ba-parser";
import {
  BA_UNREAD_MESSAGE,
  canApplyBaOmittedAssumedMatch,
  evaluateBaRow,
  isBaParseUnread,
  isDateWithinPeriod,
  matchBaItemToCatalog,
  shouldBlockFinalizeForBaRows,
  shouldBlockFinalizeForUnreadBa,
  type BaRowStatus,
  type CatalogRow,
} from "@/lib/inventory-ba-finalize-guard";
import { readInitialThemeMode, THEME_MODE_STORAGE_KEY, type ThemeMode } from "@/lib/theme-mode";

type OpnameStatus = "BELUM_DIISI" | "COCOK" | "PERLU_DICEK" | "BUTUH_ADJUST_MANUAL";

type Row = {
  productId: number;
  variantId: number | null;
  productName: string;
  productSku: string | null;
  category: string;
  openingQty: number | null;
  incomingQty: number | null;
  returnQty: number | null;
  salesQty: number | null;
  outgoingQty: number | null;
  snapshotClosingQty: number | null;
  formulaClosingQty: number | null;
  systemClosingQty: number | null;
  systemClosingSource?: "API_CUTOFF" | "CARRY_FORWARD" | null;
  systemClosingSourcePeriod?: string | null;
  formulaMismatch: boolean;
  snapshotStatus: "complete" | "boundary-only" | "incomplete";
  snapshotDiagnostics: string[];
  reference?: { kind: "available" | "identity-changed" | "invalid-previous"; qty?: number; label: string } | null;
  manualAdjust: boolean;
  physicalQty: number | null;
  differenceQty: number | null;
  status: OpnameStatus;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  evidenceSource?: "BA_INPUT" | "BA_OMITTED_ASSUMED_MATCH" | null;
};

type Summary = {
  totalProduk: number;
  cocok: number;
  perluDicek: number;
  belumDiisi: number;
  butuhAdjustManual: number;
  totalSelisihPositif: number;
  totalSelisihNegatif: number;
};

// cutoffDate/startDate/endDate: HANYA terisi bila query pakai cutoff tanggal BA
// (lihat lib/inventory-stock-opname-store.ts:loadInventoryOpnameCutoff) — kosong
// (undefined) berarti Stok Akhir Sistem masih basis snapshot akhir bulan (perilaku lama).
type Attachment = { url: string; fileName: string; mimeType: string; size: number; uploadedBy?: string; uploadedAt?: string };
type LockState = { status: "LOCKED" | "UNLOCKED"; cutoff: string | null; cutoffDate: string | null; lockedBy: string | null; lockedAt: string | null; attachment: Attachment | null };
type MonthlyLockState = { status: "locked" | "unlocked"; lockedBy: string | null; lockedAt: string | null; history: unknown[] } | null;
type Completeness = { movementProducts: number; catalogOnlyCandidates: number; verifiedForPeriod: number; unverified: number; totalUniverse: number; pass: boolean };
type LoadResult = { storeId: number; year: number; month: number; rows: Row[]; summary: Summary; cutoffDate?: string; startDate?: string; endDate?: string; lock: LockState | null; monthlyLock?: MonthlyLockState; completeness?: Completeness; uploadHistory?: Attachment[] };
type User = { id: string; role: "supervisor" | "user"; allowedModules: string[] };
type Edit = { physicalQty: number | null; note: string | null };

const STATUS_LABEL: Record<OpnameStatus, string> = {
  BELUM_DIISI: "Belum Diisi",
  COCOK: "Cocok",
  PERLU_DICEK: "Perlu Dicek",
  BUTUH_ADJUST_MANUAL: "Butuh Adjust Manual",
};
const STATUS_TONE: Record<OpnameStatus, "ok" | "warn" | "danger" | "neutral"> = {
  BELUM_DIISI: "neutral",
  COCOK: "ok",
  PERLU_DICEK: "warn",
  BUTUH_ADJUST_MANUAL: "danger",
};
const STATUS_FILTERS: Array<{ value: "ALL" | OpnameStatus; label: string }> = [
  { value: "ALL", label: "Semua" },
  { value: "COCOK", label: "Cocok" },
  { value: "PERLU_DICEK", label: "Perlu Dicek" },
  { value: "BELUM_DIISI", label: "Belum Diisi" },
  { value: "BUTUH_ADJUST_MANUAL", label: "Butuh Adjust Manual" },
];

const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

/** "2026-03-04" -> "04 Mar 2026". Nilai kosong/tidak terbaca dikembalikan apa adanya supaya tidak pernah menampilkan tanggal tebakan. */
function formatIsoDateID(value: string | null | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value ?? "-";
  const [year, month, day] = value.split("-");
  return `${day} ${MONTH_NAMES[Number(month) - 1]?.slice(0, 3) ?? month} ${year}`;
}

function formatCarryForwardPeriod(value: string): string {
  const [year, month] = value.split("-").map(Number);
  return `${MONTH_NAMES[month - 1] ?? value} ${year}`;
}

function currentJakartaYearMonth(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" }).format(new Date());
  const [year, month] = parts.split("-").map(Number);
  return { year, month };
}

function rowKey(productId: number, variantId: number | null): string {
  return `${productId}:${variantId ?? 0}`;
}

function formatQty(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("id-ID").format(value);
}

function formatSignedQty(value: number | null): string {
  if (value === null) return "—";
  const formatted = new Intl.NumberFormat("id-ID").format(Math.abs(value));
  return value > 0 ? `+${formatted}` : value < 0 ? `-${formatted}` : formatted;
}

function StatusBadge({ status }: { status: OpnameStatus }) {
  return <span className={`recon-badge recon-badge-${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

export default function InventoryOpnamePage() {
  const initial = currentJakartaYearMonth();
  // Reuse tema global AYOSERA (localStorage key "ayo-mode", sama seperti
  // app/page.tsx dan app/reconciliation/page.tsx) — bukan mekanisme baru.
  const [mode, setMode] = useState<ThemeMode>("light");
  const [year, setYear] = useState(String(initial.year));
  const [month, setMonth] = useState(String(initial.month));
  // Cutoff tanggal BA (basis BARU rekonsiliasi — lihat AYOSERA-HANDOFF-LATEST.md).
  // Tahun/Bulan di atas TETAP dipakai sebagai filter pencarian BA, BUKAN lagi
  // sumber boundary Stok Akhir Sistem begitu cutoffDate dikonfirmasi & dipakai.
  const [cutoffDate, setCutoffDate] = useState("");
  // Awal periode BA — periode BA TIDAK selalu bulan kalender (BA Februari 2026
  // = 04 Feb s/d 04 Mar). Kosong = mode bulanan lama.
  const [startDate, setStartDate] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<LoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | OpnameStatus>("ALL");
  const [selected, setSelected] = useState<Row | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [baOnlyDifferencesConfirmed, setBaOnlyDifferencesConfirmed] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState("");
  const [unlockReason, setUnlockReason] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [monthlyLockBusy, setMonthlyLockBusy] = useState(false);
  const [readingBa, setReadingBa] = useState(false);
  const [baReadSummary, setBaReadSummary] = useState<{ periodStart: string | null; cutoffDate: string | null; found: number; autoCocok: number; perluDicek: number } | null>(null);
  // BUG PRODUKSI (BA Juli 2026, 0 item terbaca): upload berhasil TAPI parser
  // gagal menghasilkan baris apa pun -> WAJIB memblokir finalisasi dan TIDAK
  // BOLEH mengasumsikan seluruh katalog cocok. Lihat lib/inventory-ba-finalize-guard.ts.
  const [baItemsFound, setBaItemsFound] = useState<number | null>(null);
  const [baSourcedKeys, setBaSourcedKeys] = useState<Set<string>>(new Set());
  const baUnread = attachment !== null && baItemsFound !== null && isBaParseUnread({ uploadSucceeded: true, itemsFound: baItemsFound });
  // Hasil Pembacaan Berita Acara: baris BER-SUMBER LANGSUNG dari BA (bukan
  // seluruh katalog), dengan status per-baris hasil evaluateBaRow (dua cek
  // selisih + matching katalog). Dirender di atas tabel utama.
  const [baRows, setBaRows] = useState<
    Array<{ no: number; description: string; systemQty: number | null; ayoseraCutoffStock: number | null; physicalQty: number | null; differenceQty: number | null; matchedProductName: string | null; status: BaRowStatus }>
  >([]);
  const [baPeriod, setBaPeriod] = useState<{ periodStart: string | null; cutoffDate: string | null } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d?.user ?? null))
      .catch(() => setUser(null));
  }, []);
  useEffect(() => {
    const initialMode = readInitialThemeMode();
    setMode(initialMode);
    document.documentElement.setAttribute("data-mode", initialMode);
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, initialMode);
  }, []);

  const supervisor = Boolean(user);

  const seedEdits = (rows: Row[]) => {
    const next: Record<string, Edit> = {};
    for (const row of rows) next[rowKey(row.productId, row.variantId)] = { physicalQty: row.physicalQty, note: row.note };
    setEdits(next);
  };

  const load = async () => {
    setLoading(true);
    setError("");
    setSaveMessage("");
    setSaveError("");
    try {
      // cutoffDate HANYA dikirim setelah user secara eksplisit mencentang
      // konfirmasi (cutoffConfirmed) — sesuai aturan "cutoff WAJIB dikonfirmasi
      // user, bukan otomatis tanpa konfirmasi". Tanpa konfirmasi, query tetap
      // basis snapshot bulanan lama (backward compatible).
      const useCutoff = cutoffDate.trim() !== "";
      const useStart = useCutoff && startDate.trim() !== "";
      const url = `/api/reconciliation/inventory-opname?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}${useCutoff ? `&cutoffDate=${encodeURIComponent(cutoffDate.trim())}` : ""}${useStart ? `&startDate=${encodeURIComponent(startDate.trim())}` : ""}`;
      const response = await fetch(url, { cache: "no-store" });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Gagal memuat data rekonsiliasi inventori.");
      setData(result);
      setAttachment(result.lock?.attachment ?? attachment);
      seedEdits(result.rows);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memuat data rekonsiliasi inventori.");
      setData(null);
    } finally {
      setLoading(false);
    }
  };


  const uploadBa = async (file: File) => {
    setUploading(true);
    setFinalizeError("");
    setReadingBa(true);
    setBaItemsFound(null);
    setBaSourcedKeys(new Set());
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("year", year);
      form.set("month", month);
      const response = await fetch("/api/reconciliation/inventory-opname/upload", { method: "POST", body: form });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Gagal mengunggah Berita Acara.");
      setAttachment(result.data);
      const analysis = await analyzeInventoryBaFile(file, (status) => setSaveMessage(status));
      const parsed = analysis.parsed;
      if (parsed.periodStart) {
        const [parsedYear, parsedMonth] = parsed.periodStart.split("-");
        setYear(parsedYear);
        setMonth(String(Number(parsedMonth)));
      }
      if (parsed.cutoffDate) {
        setCutoffDate(parsed.cutoffDate);
      }
      setBaItemsFound(parsed.items.length);
      setBaPeriod({ periodStart: parsed.periodStart, cutoffDate: parsed.cutoffDate });

      // Stok Sistem AYOSERA @ Cutoff: tarik LANGSUNG dari endpoint cutoff yang
      // SAMA persis dengan tabel utama (lib/inventory-stock-opname-store.ts:
      // loadInventoryOpnameCutoff, end_date = cutoffDate BA PERSIS) — TIDAK
      // menunggu checkbox "Konfirmasi cutoff" (gate itu hanya melindungi
      // Stok Akhir Sistem TABEL UTAMA/finalisasi, bukan preview checker ini).
      // Kegagalan fetch ditandai eksplisit (cutoffQueryFailed) supaya baris
      // BA yang terdampak WAJIB Perlu Dicek, bukan diam-diam dianggap Cocok.
      let cutoffCatalogRows: Row[] | null = null;
      let cutoffQueryFailed = false;
      if (parsed.cutoffDate) {
        const cutoffYear = parsed.periodStart ? parsed.periodStart.split("-")[0] : year;
        const cutoffMonth = parsed.periodStart ? String(Number(parsed.periodStart.split("-")[1])) : month;
        try {
          const cutoffResponse = await fetch(`/api/reconciliation/inventory-opname?year=${encodeURIComponent(cutoffYear)}&month=${encodeURIComponent(cutoffMonth)}&cutoffDate=${encodeURIComponent(parsed.cutoffDate)}`, { cache: "no-store" });
          const cutoffResult = await cutoffResponse.json().catch(() => null);
          if (cutoffResponse.ok && cutoffResult?.rows) cutoffCatalogRows = cutoffResult.rows as Row[];
          else cutoffQueryFailed = true;
        } catch {
          cutoffQueryFailed = true;
        }
      }
      const catalogForMatch: CatalogRow[] = (cutoffCatalogRows ?? data?.rows ?? []).map((row) => ({ productId: row.productId, variantId: row.variantId, productName: row.productName, productSku: row.productSku }));
      const cutoffStockByKey = new Map<string, number | null>((cutoffCatalogRows ?? []).map((row) => [rowKey(row.productId, row.variantId), row.systemClosingQty]));

      let autoCocok = 0;
      let perluDicek = parsed.status === "PERLU_DICEK" && parsed.items.length === 0 ? 1 : 0;
      const sourcedKeys = new Set<string>();
      const nextBaRows: typeof baRows = [];
      if (data || cutoffCatalogRows) {
        const next = { ...edits };
        parsed.items.forEach((item, index) => {
          // Resolusi produk katalog DULU (matchBaItemToCatalog generik — SKU,
          // nama exact, suffix token tanpa prefix kategori, lalu fuzzy) supaya
          // CEK B bisa mengambil stok cutoff produk yang BENAR-BENAR cocok,
          // bukan pencocokan nama sederhana yang terpisah dari evaluateBaRow.
          const preMatch = matchBaItemToCatalog(item.description, catalogForMatch, normalizeInventoryBaName);
          const matchedRow = preMatch.kind === "MATCHED" ? preMatch.row : null;
          const systemStockAtCutoff = matchedRow ? (cutoffStockByKey.get(rowKey(matchedRow.productId, matchedRow.variantId)) ?? null) : null;
          const evaluation = evaluateBaRow(
            { description: item.description, systemQty: item.systemQty, physicalQty: item.physicalQty, differenceQty: item.differenceQty, arithmeticStatus: item.status },
            catalogForMatch,
            normalizeInventoryBaName,
            systemStockAtCutoff,
            { cutoffQueryFailed },
          );
          nextBaRows.push({
            no: index + 1,
            description: item.description,
            systemQty: item.systemQty,
            ayoseraCutoffStock: systemStockAtCutoff,
            physicalQty: item.physicalQty,
            differenceQty: item.differenceQty,
            matchedProductName: evaluation.matchedProduct?.productName ?? null,
            status: evaluation.status,
          });
          if (evaluation.matchedProduct) {
            const key = rowKey(evaluation.matchedProduct.productId, evaluation.matchedProduct.variantId);
            next[key] = { physicalQty: item.physicalQty, note: "Dibaca dari BA" };
            sourcedKeys.add(key);
            autoCocok++;
          } else {
            perluDicek++;
          }
        });
        setEdits(next);
      }
      setBaRows(nextBaRows);
      setBaSourcedKeys(sourcedKeys);
      setBaReadSummary({ periodStart: parsed.periodStart, cutoffDate: parsed.cutoffDate, found: parsed.items.length, autoCocok, perluDicek });
      setSaveMessage(
        parsed.items.length === 0
          ? BA_UNREAD_MESSAGE
          : "Berita Acara selesai dibaca.",
      );
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : "Gagal mengunggah Berita Acara.");
    } finally {
      setUploading(false);
      setReadingBa(false);
    }
  };

  // Batalkan hasil baca BA (salah baca/ingin ulang): reset semua state
  // turunan uploadBa, termasuk edits yang sudah diisi otomatis dari BA
  // ("Dibaca dari BA") kembali ke nilai tersimpan di server (seedEdits).
  // TIDAK ada request ke server — attachment yang sudah terlanjur diupload ke
  // blob storage tetap ada di sana (sama seperti "Ganti file"), tapi tidak
  // pernah tercatat ke database karena hanya dikirim saat finalize().
  const cancelBaRead = () => {
    setAttachment(null);
    setBaReadSummary(null);
    setBaItemsFound(null);
    setBaSourcedKeys(new Set());
    setBaRows([]);
    setBaPeriod(null);
    setFinalizeError("");
    setSaveMessage("");
    if (data) seedEdits(data.rows);
  };

  const finalize = async () => {
    if (!data || !attachment || !cutoffDate || !baOnlyDifferencesConfirmed) return;
    if (shouldBlockFinalizeForUnreadBa({ uploadSucceeded: true, itemsFound: baItemsFound ?? 0 }) && baItemsFound !== null) {
      setFinalizeError(BA_UNREAD_MESSAGE);
      return;
    }
    // Finalisasi WAJIB diblok bila ADA baris BA "Perlu Dicek"/"Tidak Ditemukan"
    // (jumlah baris terparse != baris resolvable), atau cutoff BUKAN di dalam
    // periode BA sendiri — tidak pernah auto-finalize/auto-lock/adjust Olsera.
    if (baRows.length > 0 && shouldBlockFinalizeForBaRows(baRows)) {
      setFinalizeError("Ada item Berita Acara berstatus Perlu Dicek atau Tidak Ditemukan. Selesaikan review sebelum finalisasi.");
      return;
    }
    if (baPeriod?.periodStart && baPeriod?.cutoffDate && !isDateWithinPeriod(cutoffDate, baPeriod.periodStart, baPeriod.cutoffDate)) {
      setFinalizeError("Cutoff yang dipilih berada di luar periode Berita Acara.");
      return;
    }
    setFinalizing(true);
    setFinalizeError("");
    try {
      const entries = data.rows.map((row) => {
        const edit = edits[rowKey(row.productId, row.variantId)] ?? { physicalQty: row.physicalQty, note: row.note };
        return { productId: row.productId, variantId: row.variantId, physicalQty: edit.physicalQty, note: edit.note };
      });
      // Rentang BA dikirim juga saat SIMPAN supaya angka yang tersimpan berasal
      // dari sumber yang SAMA dengan yang tampil di layar. Syaratnya identik
      // dengan pemuatan: hanya setelah cutoff dikonfirmasi user.
      const saveResponse = await fetch("/api/reconciliation/inventory-opname", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ year: Number(year), month: Number(month), entries, ...baRangePayload() }) });
      const saveResult = await saveResponse.json().catch(() => null);
      if (!saveResponse.ok) throw new Error(saveResult?.error || "Gagal menyimpan input Berita Acara sebelum finalisasi.");
      const response = await fetch("/api/reconciliation/inventory-opname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finalize", year: Number(year), month: Number(month), cutoff: cutoffDate, cutoffDate, ...(startDate.trim() !== "" ? { startDate: startDate.trim() } : {}), cutoffConfirmed: true, baOnlyDifferencesConfirmed, attachment }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Finalisasi gagal. Periksa kembali data checker.");
      setSaveMessage("Stock Opname berhasil dikunci.");
      await load();
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : "Finalisasi gagal.");
    } finally {
      setFinalizing(false);
    }
  };

  const unlock = async () => {
    if (!unlockReason.trim()) {
      setFinalizeError("Alasan buka kunci wajib diisi.");
      return;
    }
    setUnlocking(true);
    setFinalizeError("");
    try {
      const response = await fetch("/api/reconciliation/inventory-opname", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unlock", year: Number(year), month: Number(month), reason: unlockReason }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Gagal membuka kunci.");
      setUnlockReason("");
      setSaveMessage("Stock Opname berhasil dibuka kuncinya.");
      await load();
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : "Gagal membuka kunci.");
    } finally {
      setUnlocking(false);
    }
  };

  const lockPeriod = async () => {
    if (!data || liveSummary.perluDicek > 0 || liveSummary.butuhAdjustManual > 0) return;
    setMonthlyLockBusy(true); setFinalizeError("");
    try {
      const response = await fetch("/api/reconciliation/inventory-opname", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "lock-period", year: Number(year), month: Number(month) }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Periode belum dapat dikunci.");
      setSaveMessage("Periode inventori berhasil dikunci.");
      await load();
    } catch (e) { setFinalizeError(e instanceof Error ? e.message : "Periode belum dapat dikunci."); }
    finally { setMonthlyLockBusy(false); }
  };

  const unlockPeriod = async () => {
    const reason = window.prompt("Alasan buka kunci wajib diisi");
    if (!reason?.trim()) return;
    setMonthlyLockBusy(true); setFinalizeError("");
    try {
      const response = await fetch("/api/reconciliation/inventory-opname", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unlock-period", year: Number(year), month: Number(month), reason }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Gagal membuka kunci periode.");
      await load();
    } catch (e) { setFinalizeError(e instanceof Error ? e.message : "Gagal membuka kunci periode."); }
    finally { setMonthlyLockBusy(false); }
  };

  const setEdit = (row: Row, patch: Partial<Edit>) => {
    setEdits((prev) => {
      const key = rowKey(row.productId, row.variantId);
      const current = prev[key] ?? { physicalQty: row.physicalQty, note: row.note };
      return { ...prev, [key]: { ...current, ...patch } };
    });
  };

  const save = async () => {
    if (!data || !supervisor) return;
    setSaving(true);
    setSaveError("");
    setSaveMessage("");
    try {
      const entries = data.rows.map((row) => {
        const edit = edits[rowKey(row.productId, row.variantId)] ?? { physicalQty: row.physicalQty, note: row.note };
        return { productId: row.productId, variantId: row.variantId, physicalQty: edit.physicalQty, note: edit.note };
      });
      const response = await fetch("/api/reconciliation/inventory-opname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Rentang BA ikut dikirim: tombol "Simpan Semua" (simpan tanpa
        // finalisasi) adalah justru kasus yang dulu menyimpan angka akhir bulan
        // padahal layar menampilkan rentang BA.
        // attachment (bila ada, dari state client sejak upload asli) ikut
        // dikirim supaya "riwayat BA tersimpan" mencatat entri histori baru —
        // uploadedAt/uploadedBy TIDAK diubah di sini, tetap dari upload asli.
        body: JSON.stringify({ year: Number(year), month: Number(month), entries, ...baRangePayload(), ...(attachment ? { attachment } : {}) }),
      });
      const result = await response.json().catch(() => null);
      // Pesan guard periode BA (Tahap 3a) diteruskan APA ADANYA ke user —
      // ia menyebut BA mana yang menghalangi, jangan diganti pesan generik.
      if (!response.ok) throw new Error(result?.error || "Gagal menyimpan berita acara.");
      setData(result);
      seedEdits(result.rows);
      setSaveMessage("Berita acara tersimpan.");
      if (selected) {
        const updated = (result.rows as Row[]).find((r) => r.productId === selected.productId && r.variantId === selected.variantId);
        setSelected(updated ?? null);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Gagal menyimpan berita acara.");
    } finally {
      setSaving(false);
    }
  };

  const rowsWithEdits: Row[] = useMemo(() => {
    if (!data) return [];
    return data.rows.map((row) => {
      const edit = edits[rowKey(row.productId, row.variantId)];
      const physicalQty = edit?.physicalQty ?? row.physicalQty;
      // BA_OMITTED_ASSUMED_MATCH HANYA aktif setelah minimal 1 baris BERHASIL
      // diparse dari BA (lib/inventory-ba-finalize-guard.ts) — bukan sekadar
      // checkbox dicentang. Ini mencegah bug produksi: 0 item terbaca tapi
      // seluruh katalog diam-diam dianggap cocok.
      const canAssumeOmitted = canApplyBaOmittedAssumedMatch({ baOnlyDifferencesConfirmed, itemsFound: baItemsFound ?? 0 });
      if (canAssumeOmitted && physicalQty === null && row.systemClosingQty !== null && !row.manualAdjust) {
        return { ...row, physicalQty: row.systemClosingQty, differenceQty: 0, status: "COCOK" as OpnameStatus, evidenceSource: "BA_OMITTED_ASSUMED_MATCH" as const };
      }
      if (!edit) {
        return row.physicalQty === null && row.systemClosingQty !== null && !row.manualAdjust
          ? { ...row, status: "BELUM_DIISI" as OpnameStatus }
          : row;
      }
      const differenceQty = physicalQty === null || row.systemClosingQty === null ? null : physicalQty - row.systemClosingQty;
      const status: OpnameStatus = row.manualAdjust
        ? "BUTUH_ADJUST_MANUAL"
        : physicalQty === null
          ? "BELUM_DIISI"
          : row.systemClosingQty === null || physicalQty !== row.systemClosingQty
            ? "PERLU_DICEK"
            : "COCOK";
      return { ...row, physicalQty, note: edit.note, differenceQty, status };
    });
  }, [data, edits, baOnlyDifferencesConfirmed, baItemsFound]);

  // Checkbox "Tampilkan item tersembunyi" dihapus dari UI — perilaku
  // di-default-kan ke "tampilkan semua" supaya tidak ada baris yang diam-diam
  // hilang tanpa kontrol untuk memunculkannya kembali.
  const visibleRows = useMemo(() => visibleInventoryRows(rowsWithEdits, true), [rowsWithEdits]);

  const filteredRows = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return visibleRows.filter((row) => {
      if (statusFilter !== "ALL" && row.status !== statusFilter) return false;
      if (!keyword) return true;
      return row.productName.toLowerCase().includes(keyword) || (row.productSku ?? "").toLowerCase().includes(keyword);
    });
  }, [visibleRows, statusFilter, search]);

  const liveSummary: Summary = useMemo(() => {
    const summary: Summary = { totalProduk: rowsWithEdits.length, cocok: 0, perluDicek: 0, belumDiisi: 0, butuhAdjustManual: 0, totalSelisihPositif: 0, totalSelisihNegatif: 0 };
    for (const row of rowsWithEdits) {
      if (row.status === "COCOK") summary.cocok += 1;
      else if (row.status === "PERLU_DICEK") summary.perluDicek += 1;
      else if (row.status === "BELUM_DIISI") summary.belumDiisi += 1;
      else summary.butuhAdjustManual += 1;
      if (row.differenceQty !== null) {
        if (row.differenceQty > 0) summary.totalSelisihPositif += row.differenceQty;
        else if (row.differenceQty < 0) summary.totalSelisihNegatif += row.differenceQty;
      }
    }
    return summary;
  }, [rowsWithEdits]);

  const baBlocksFinalize = baRows.length > 0 && shouldBlockFinalizeForBaRows(baRows);
  const needsBa = liveSummary.perluDicek > 0 || liveSummary.butuhAdjustManual > 0;
  const completeness = data?.completeness;
  const isFebruaryHistoricalFinal = Number(year) === 2026 && Number(month) === 2;
  const februaryComparisonPass = !isFebruaryHistoricalFinal || Boolean(data && liveSummary.perluDicek === 0 && liveSummary.butuhAdjustManual === 0 && liveSummary.cocok === liveSummary.totalProduk);
  const periodReadyToLock = Boolean(data && data.monthlyLock?.status !== "locked" && (februaryComparisonPass && (isFebruaryHistoricalFinal || completeness?.pass === true)) && !needsBa && data.rows.length > 0);
  // Alur BA relevan bila masih ada selisih, atau sudah ada file/baris BA yang
  // dibaca. Februari 2026 TIDAK lagi dikecualikan: dulu isFebruaryHistoricalFinal
  // ikut mematikan alur ini karena periode itu dianggap final dari
  // FEBRUARY_HISTORICAL_SOURCE, padahal justru di sanalah BA fisik dibutuhkan
  // untuk memutuskan produk yang berbeda antara file sumber dan database.
  // Aman: jalur BA hanya menulis inventoryStockOpnameReconciliations, tidak
  // pernah menyentuh olsera_inventory_monthly_snapshots tempat data historis
  // Februari berada.
  // Panel BA tampil selama periode belum dikunci, meskipun belum ada selisih.
  // Rentang BA aktif hanya bila cutoff sudah dikonfirmasi user — syarat yang
  // sama dipakai pemuatan, penyimpanan, dan finalisasi.
  const rangeMode = cutoffDate.trim() !== "" && startDate.trim() !== "";
  // SATU tempat penentu apakah rentang BA ikut dikirim — dipakai muat, simpan,
  // dan finalisasi supaya ketiganya tidak pernah memakai basis berbeda.
  const baRangePayload = (): { cutoffDate?: string; startDate?: string } =>
    cutoffDate.trim() !== ""
      ? { cutoffDate: cutoffDate.trim(), ...(startDate.trim() !== "" ? { startDate: startDate.trim() } : {}) }
      : {};
  const baCutoffOutOfPeriod = Boolean(baPeriod?.periodStart && baPeriod?.cutoffDate && cutoffDate && !isDateWithinPeriod(cutoffDate, baPeriod.periodStart, baPeriod.cutoffDate));
  const baCocokCount = baRows.filter((r) => r.status === "COCOK").length;
  const baPerluDicekCount = baRows.filter((r) => r.status === "PERLU_DICEK").length;
  const baTidakDitemukanCount = baRows.filter((r) => r.status === "TIDAK_DITEMUKAN").length;
  // Bug: baris BA yang GAGAL dicocokkan ke katalog (matchedProductName null —
  // TIDAK_DITEMUKAN atau nama ambigu) tidak pernah masuk ke `edits`/rowsWithEdits
  // (lihat uploadBa: hanya evaluation.matchedProduct yang menulis ke `edits`),
  // sehingga selisihnya TIDAK PERNAH ikut terhitung di liveSummary walau
  // barisnya jelas tampil dengan Selisih BA != 0 di tabel "Hasil Pembacaan
  // Berita Acara". Baris matched (COCOK atau PERLU_DICEK karena systemQty/
  // aritmetika beda) SUDAH punya padanan baris katalog sendiri dan sudah ikut
  // liveSummary.perluDicek/butuhAdjustManual — menjumlahkan baPerluDicekCount
  // di sini akan menghitung dua kali. Hanya baris ORPHAN (tidak match) yang
  // perlu ditambahkan secara terpisah.
  const baUnmatchedCount = baRows.filter((r) => r.matchedProductName === null).length;
  const BA_ROW_STATUS_LABEL: Record<BaRowStatus, string> = { COCOK: "Cocok", PERLU_DICEK: "Perlu Dicek", TIDAK_DITEMUKAN: "Tidak Ditemukan" };
  const BA_ROW_STATUS_TONE: Record<BaRowStatus, "ok" | "warn" | "danger"> = { COCOK: "ok", PERLU_DICEK: "warn", TIDAK_DITEMUKAN: "danger" };

  if (user && !user.allowedModules.includes("rekonsiliasi") && user.role !== "supervisor") {
    return (
      <main className="recon-page">
        <p className="recon-empty">Akses ditolak. Hubungi supervisor untuk meminta modul Rekonsiliasi.</p>
      </main>
    );
  }

  return (
    <main className="recon-page">
      <header className="recon-header">
        <div>
          <a href="/reconciliation" className="recon-back">
            ← Kembali ke Rekonsiliasi
          </a>
          <h1>Rekonsiliasi Inventori dengan Berita Acara</h1>
          <p>Mencocokkan snapshot inventori bulanan Olsera dengan stok fisik hasil stock opname (input manual).</p>
        </div>
        <div style={{ display: "flex", gap: ".5rem" }}>
          {supervisor && data && (
            <button className="recon-button" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="spin" /> : <Save />} Simpan Semua
            </button>
          )}
          {data && (
            <button className="recon-button secondary" onClick={() => window.print()}>
              <Printer /> Cetak
            </button>
          )}
          <button
            type="button"
            className="recon-button secondary"
            aria-label={mode === "dark" ? "Ganti ke Light Mode" : "Ganti ke Dark Mode"}
            title={mode === "dark" ? "Light Mode" : "Dark Mode"}
            onClick={() =>
              setMode((current) => {
                const next: ThemeMode = current === "dark" ? "light" : "dark";
                document.documentElement.setAttribute("data-mode", next);
                window.localStorage.setItem(THEME_MODE_STORAGE_KEY, next);
                return next;
              })
            }
          >
            {mode === "dark" ? <Sun /> : <Moon />}
          </button>
        </div>
      </header>

      <section className="recon-filters" aria-label="Pilih periode">
        <label>
          Tahun
          {/* Saat rentang BA dipakai, Tahun/Bulan DITURUNKAN dari tanggal mulai —
              keduanya tetap ada karena merekalah kunci periode lock & dokumen BA. */}
          <input type="number" min={2000} max={2100} value={year} disabled={rangeMode} onChange={(e) => setYear(e.target.value)} />
        </label>
        <label>
          Bulan
          <select value={month} disabled={rangeMode} onChange={(e) => setMonth(e.target.value)}>
            {MONTH_NAMES.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {/* Pemilihan periode adalah filter DASAR halaman ini, bukan bagian alur
            Berita Acara — sebelumnya kedua field ini ikut digate showBaFlow,
            sehingga hilang total begitu semua stok cocok (needsBa false) DAN
            selalu hilang untuk Februari 2026 (isFebruaryHistoricalFinal), yaitu
            justru periode yang paling butuh rentang bebas. */}
        <>
          <label>
            Tanggal mulai BA (opsional)
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                const value = e.target.value;
                setStartDate(value);
                // Periode dokumen BA & lock mengikuti bulan tanggal MULAI.
                if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                  setYear(value.slice(0, 4));
                  setMonth(String(Number(value.slice(5, 7))));
                }
              }}
            />
          </label>
          <label>
            Cutoff tanggal BA (opsional)
            <input
              type="date"
              value={cutoffDate}
              min={startDate || undefined}
              onChange={(e) => {
                setCutoffDate(e.target.value);
              }}
            />
          </label>
        </>
        <label className="recon-check" style={{ alignSelf: "end" }}>
          <button className="recon-button secondary" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="spin" /> : <RefreshCw />} Tampilkan Data
          </button>
        </label>
      </section>

      {data?.cutoffDate && (
        <p className="recon-readonly" style={{ justifyContent: "center", textAlign: "center" }}>
          <strong>Periode BA: {formatIsoDateID(data.startDate)} — {formatIsoDateID(data.cutoffDate)}</strong>
          {" · "}Stok Akhir Sistem dihitung persis pada cutoff {data.cutoffDate} (bukan akhir bulan kalender) — jendela query {data.startDate} s/d {data.endDate}.
        </p>
      )}
      {!data?.cutoffDate && data && (
        <p className="recon-readonly">
          Periode: <strong>{MONTH_NAMES[Number(month) - 1]} {year}</strong> (bulan penuh) — isi Tanggal mulai dan Cutoff bila periode Berita Acara bukan bulan kalender.
        </p>
      )}

      <section className="recon-filters" aria-label="Ringkasan Rekonsiliasi Inventori">
        <div><strong>{liveSummary.cocok}/{liveSummary.totalProduk} Cocok</strong></div>
        {data?.monthlyLock?.status === "locked" ? <div className="recon-lock-summary"><LockKeyhole /> Terkunci · {data.monthlyLock.lockedBy ?? "Supervisor"} {supervisor && <button className="recon-button danger" disabled={monthlyLockBusy} onClick={() => void unlockPeriod()}><Unlock /> Buka Kunci</button>}</div> : <button className="recon-button" disabled={!supervisor || !periodReadyToLock || monthlyLockBusy} onClick={() => void lockPeriod()}>{monthlyLockBusy ? <Loader2 className="spin" /> : <LockKeyhole />} Kunci Periode</button>}
        {!periodReadyToLock && data?.monthlyLock?.status !== "locked" && <p className="recon-draft">{completeness && !completeness.pass ? `Belum dapat dikunci: masih ada ${completeness.unverified} produk katalog yang belum diverifikasi untuk ${MONTH_NAMES[Number(month) - 1]} ${year}.` : `${liveSummary.perluDicek + liveSummary.butuhAdjustManual + baUnmatchedCount} item masih memiliki selisih atau data belum valid.`}</p>}
        {data?.monthlyLock?.history?.length ? <details className="recon-history"><summary>Riwayat Lock / Unlock</summary><ul>{data.monthlyLock.history.map((item, index) => { const entry = item as { action?: string; actor?: string; reason?: string | null; at?: string; version?: number }; const accidental = isFebruaryHistoricalFinal && ((entry.action === "lock" && entry.actor === "ariamp@gmail.com" && entry.at?.startsWith("2026-08-14T11:42")) || (entry.action === "unlock" && entry.actor === "timunemas@ayo.local" && entry.at?.startsWith("2026-08-14T11:54"))); if (accidental) return null; return <li key={`${entry.at ?? "event"}-${index}`}><strong>{String(entry.action ?? "").toUpperCase()}</strong> · {entry.at ? new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(entry.at)) : "—"} · {entry.actor ?? "User"}{entry.reason ? ` · ${entry.reason}` : ""}{entry.version ? ` · v${entry.version}` : ""}</li>; })}</ul></details> : null}
      </section>

      {data?.monthlyLock?.status !== "locked" && <section className="recon-filters recon-finalization" aria-label="Penyelesaian Selisih dengan Berita Acara">
        <label>
          Berita Acara Stock Opname
          <input type="file" accept="application/pdf,image/jpeg,image/png" disabled={!supervisor || uploading || data?.lock?.status === "LOCKED"} onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadBa(file); e.currentTarget.value = ""; }} />
        </label>
        <div className="recon-finalization">
          {attachment ? <p className="recon-lock-summary"><CheckCircle2 /> {attachment.fileName} — Berhasil diupload</p> : <p className="recon-readonly">PDF/JPG/PNG, maksimal 4 MB.</p>}
          {readingBa && <p className="recon-readonly"><Loader2 className="spin" /> Membaca Berita Acara...</p>}
          {baReadSummary && <p className="recon-readonly">Periode BA: {baReadSummary.periodStart ?? "Perlu Dicek"} · Cutoff: {baReadSummary.cutoffDate ?? "Perlu Dicek"} · Item ditemukan: {baReadSummary.found} · Cocok otomatis: {baReadSummary.autoCocok} · Perlu Dicek: {baReadSummary.perluDicek}</p>}
          {attachment && data?.lock?.status !== "LOCKED" && <label className="recon-button secondary">Ganti file<input type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadBa(file); e.currentTarget.value = ""; }} /></label>}
          {attachment && data?.lock?.status !== "LOCKED" && <button type="button" className="recon-button secondary" disabled={!supervisor} onClick={() => cancelBaRead()}><X /> Batal</button>}
        </div>
        {data?.uploadHistory?.length ? <details className="recon-history"><summary>Riwayat BA ({data.uploadHistory.length})</summary><ul>{data.uploadHistory.map((entry, index) => <li key={`${entry.url}-${index}`}><a href={entry.url} target="_blank" rel="noreferrer" className="recon-link"><Paperclip size={12} /> {entry.fileName}</a> · {entry.uploadedAt ? new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(entry.uploadedAt)) : "—"} · {entry.uploadedBy ?? "—"}</li>)}</ul></details> : null}
        <label className="recon-check">
          <input type="checkbox" checked={baOnlyDifferencesConfirmed} disabled={!supervisor || data?.lock?.status === "LOCKED"} onChange={(e) => setBaOnlyDifferencesConfirmed(e.target.checked)} /> Berita Acara hanya mencantumkan item yang memiliki selisih
        </label>
        <div className="recon-finalization">
          {data?.lock?.status === "LOCKED" ? <>
            <p className="recon-lock-summary"><LockKeyhole /> Stock Opname Terkunci</p>
            <p className="recon-readonly">Cutoff: {data.lock.cutoffDate ?? data.lock.cutoff ?? "—"} · Difinalisasi oleh: {data.lock.lockedBy ?? "—"}{data.lock.lockedAt ? ` · ${new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(data.lock.lockedAt))}` : ""}</p>
            <p className="recon-readonly">File BA: {data.lock.attachment?.fileName ?? attachment?.fileName ?? "—"}</p>
            <p className="recon-readonly">Data pemeriksaan pada tanggal cutoff sudah dikunci. Transaksi inventori setelah tanggal tersebut tetap berjalan normal.</p>
            {supervisor && <><input value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} placeholder="Alasan buka kunci" /><button className="recon-button danger" onClick={() => void unlock()} disabled={unlocking}>{unlocking ? <Loader2 className="spin" /> : <Unlock />} Buka Kunci</button></>}
          </> : <button className="recon-button" onClick={() => void finalize()} disabled={!supervisor || !data || !attachment || !cutoffDate || !baOnlyDifferencesConfirmed || baUnread || baBlocksFinalize || baCutoffOutOfPeriod || liveSummary.perluDicek > 0 || liveSummary.butuhAdjustManual > 0 || finalizing}>{finalizing ? <Loader2 className="spin" /> : <FileUp />} Finalisasi Stock Opname</button>}
        </div>
      </section>}
      {baUnread && <p className="recon-draft"><AlertTriangle /> {BA_UNREAD_MESSAGE}</p>}
      {baBlocksFinalize && <p className="recon-draft"><AlertTriangle /> Ada item Berita Acara berstatus Perlu Dicek atau Tidak Ditemukan — selesaikan review sebelum finalisasi.</p>}
      {baCutoffOutOfPeriod && <p className="recon-draft"><AlertTriangle /> Cutoff yang dipilih berada di luar periode Berita Acara ({baPeriod?.periodStart} s/d {baPeriod?.cutoffDate}).</p>}
      {finalizeError && <p className="recon-draft"><AlertTriangle /> {finalizeError}</p>}

      {saveMessage && <p className="recon-readonly">{saveMessage}</p>}
      {saveError && <p className="recon-draft"><AlertTriangle /> {saveError}</p>}

      {baRows.length > 0 && (
        <section className="recon-ba-results" aria-label="Hasil Pembacaan Berita Acara">
          <h2 style={{ margin: 0 }}>Hasil Pembacaan Berita Acara</h2>
          <p className="recon-readonly">
            Periode BA: {baPeriod?.periodStart ?? "Perlu Dicek"} s/d {baPeriod?.cutoffDate ?? "Perlu Dicek"} · Cutoff: {baPeriod?.cutoffDate ?? "Perlu Dicek"} · Item ditemukan: {baRows.length} · Cocok: {baCocokCount} · Perlu Dicek: {baPerluDicekCount + baTidakDitemukanCount}
          </p>
          <div style={{ overflowX: "auto", width: "100%" }}>
            <table className="recon-table">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Nama Barang BA</th>
                  <th>Produk AYOSERA</th>
                  <th>Stok Sistem AYOSERA @{baPeriod?.cutoffDate ? ` ${new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Jakarta" }).format(new Date(`${baPeriod.cutoffDate}T00:00:00`))}` : " Cutoff"}</th>
                  <th>Stok Fisik Aktual</th>
                  <th>Selisih BA</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {baRows.map((row) => (
                  <tr key={row.no}>
                    <td>{row.no}</td>
                    <td>{row.description}</td>
                    <td>{row.matchedProductName ?? "—"}</td>
                    <td>{formatQty(row.ayoseraCutoffStock)}</td>
                    <td>{formatQty(row.physicalQty)}</td>
                    <td>{formatSignedQty(row.differenceQty)}</td>
                    <td>
                      <span className={`recon-badge recon-badge-${BA_ROW_STATUS_TONE[row.status]}`}>{BA_ROW_STATUS_LABEL[row.status]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {error ? (
        <section className="recon-empty">
          <p>{error}</p>
        </section>
      ) : !data ? (
        <section className="recon-empty">
          <FileSearch />
          <p>Pilih tahun & bulan, lalu klik &quot;Tampilkan Data&quot;.</p>
        </section>
      ) : (
        <>
          <div className="recon-print-area">
            {/* Hanya untuk cetak (@media print) — sengaja tidak dirender di
                layar, lihat .recon-print-header di globals.css. */}
            <div className="recon-print-header">
              <h1>Rekonsiliasi Inventori dengan Berita Acara</h1>
              <p>
                Periode: {data.cutoffDate ? `${formatIsoDateID(data.startDate)} - ${formatIsoDateID(data.cutoffDate)}` : `${MONTH_NAMES[Number(month) - 1]} ${year}`}
                {data.cutoffDate ? ` · Cutoff: ${formatIsoDateID(data.cutoffDate)}` : ""}
              </p>
              <p>Dicetak {new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date())}</p>
            </div>
          <section className="recon-cards">
            {([
              ["Total Produk", liveSummary.totalProduk],
              ["Cocok", liveSummary.cocok],
              ["Perlu Dicek", liveSummary.perluDicek],
              ["Belum Diisi", liveSummary.belumDiisi],
              ...(!isFebruaryHistoricalFinal ? [["Butuh Adjust Manual", liveSummary.butuhAdjustManual] as const] : []),
              ["Total Selisih Positif", formatSignedQty(liveSummary.totalSelisihPositif || 0)],
              ["Total Selisih Negatif", formatSignedQty(liveSummary.totalSelisihNegatif || 0)],
            ] as const).map(([label, value]) => (
              <div className="recon-card" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </section>

          <section className="recon-filters" aria-label="Filter produk">
            <label className="recon-keyword">
              Cari produk / SKU
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nama produk atau SKU" />
            </label>
            <label>
              Status
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "ALL" | OpnameStatus)}>
                {STATUS_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </section>

          {!filteredRows.length ? (
            <section className="recon-empty">
              <Search />
              <p>Tidak ada produk untuk filter ini.</p>
            </section>
          ) : (
            <section className="recon-table-wrap">
              <table className="recon-table recon-inventory-table">
                <thead>
                  <tr>
                    <th>No</th>
                    <th>Kategori</th>
                    <th>Produk</th>
                    <th>Varian</th>
                    <th>Stok Awal</th>
                    <th>Barang Masuk</th>
                    <th>Retur Masuk</th>
                    <th>Penjualan</th>
                    <th>Barang Keluar</th>
                    <th>Stok Akhir Sistem</th>
                    {/* Kolom inti halaman ini: tempat mengisi angka fisik dari BA.
                        Sebelumnya ikut digate showBaFlow, sehingga hilang untuk
                        seluruh Februari 2026 (isFebruaryHistoricalFinal) dan
                        setiap kali semua stok sudah cocok. */}
                    <th>Stok Berita Acara</th><th>Selisih</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row, index) => (
                    <tr key={rowKey(row.productId, row.variantId)}>
                      <td>{index + 1}</td>
                      <td>{row.category}</td>
                      <td>
                        <button className="recon-link" title={row.productName} onClick={() => setSelected(row)}>
                          {row.productName}
                        </button>
                        {baSourcedKeys.has(rowKey(row.productId, row.variantId)) && <span className="recon-badge recon-badge-ok" style={{ marginLeft: ".375rem" }}>Dibaca dari BA</span>}
                      </td>
                      <td>{row.variantId ?? "—"}</td>
                      <td>{formatQty(row.openingQty)}</td>
                      <td>{formatQty(row.incomingQty)}</td>
                      <td>{formatQty(row.returnQty)}</td>
                      <td>{formatQty(row.salesQty)}</td>
                      <td>{formatQty(row.outgoingQty)}</td>
                      <td>
                        {/* Baris produk stok diam tidak punya posisi stok pada
                            tanggal cutoff (API Olsera hanya mengembalikan produk
                            yang bergerak). Jangan tampilkan "—" polos: petugas
                            harus tahu kenapa kolom ini kosong dan bahwa barisnya
                            belum bisa difinalisasi. Satu badge SAJA di kolom ini
                            (bukan badge + baris terpisah di bawahnya) supaya
                            tinggi baris tetap sama dengan baris lain — angka
                            referensi (kalau ada) ikut di DALAM badge yang sama,
                            bukan elemen baru. */}
                        {row.systemClosingQty === null && row.snapshotStatus === "boundary-only" ? (
                          <span className="recon-badge recon-badge-warn" title={row.snapshotDiagnostics.at(-1) ?? "Carry-forward tidak diizinkan; perlu verifikasi manual."}>
                            Tidak diisi
                          </span>
                        ) : (
                          <span title={row.systemClosingSource === "CARRY_FORWARD" ? `Carry-forward dari closing ${formatCarryForwardPeriod(row.systemClosingSourcePeriod ?? "")} — produk tidak bergerak di periode ini` : undefined}>
                            {formatQty(row.systemClosingQty)}{row.systemClosingSource === "CARRY_FORWARD" && <small className="ml-1">(dari bulan lalu)</small>}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="recon-opname-cell">
                          <input
                            className="recon-opname-input"
                            type="number"
                            min="0"
                            disabled={!supervisor}
                            value={row.physicalQty ?? ""}
                            onChange={(e) => setEdit(row, { physicalQty: e.target.value === "" ? null : Number(e.target.value) })}
                          />
                          {supervisor && row.physicalQty !== null && (
                            <button className="recon-opname-clear" aria-label="Hapus nilai" onClick={() => setEdit(row, { physicalQty: null })}>
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                      <td>{formatSignedQty(row.differenceQty)}</td>
                      <td>
                        <StatusBadge status={row.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="recon-mobile-list">
                {filteredRows.map((row) => (
                  <button key={rowKey(row.productId, row.variantId)} className="recon-mobile-card" onClick={() => setSelected(row)}>
                    <div>
                      <strong>{row.productName}</strong>
                      <span>
                        Sistem {formatQty(row.systemClosingQty)} · BA {formatQty(row.physicalQty)}
                      </span>
                    </div>
                    <div>
                      <StatusBadge status={row.status} />
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
          </div>
        </>
      )}

      {selected && (
        <aside className="recon-drawer" role="dialog" aria-modal="true" aria-label="Detail produk">
          <div className="recon-drawer-head">
            <div>
              <p className="recon-eyebrow">Detail Produk</p>
              <h2>{selected.productName}</h2>
            </div>
            <button aria-label="Tutup detail" onClick={() => setSelected(null)}>
              <X />
            </button>
          </div>
          <div className="recon-drawer-body">
            {selected.manualAdjust && (
              <p className="recon-special">
                <AlertTriangle /> Produk ini butuh tinjauan manual (identitas/data snapshot belum pasti) — status tidak dipaksakan menjadi Cocok atau Perlu Dicek.
              </p>
            )}
            <section className="recon-detail-grid">
              <div>
                <span>Stok Awal</span>
                <b>{formatQty(selected.openingQty)}</b>
              </div>
              <div>
                <span>Barang Masuk</span>
                <b>{formatQty(selected.incomingQty)}</b>
              </div>
              <div>
                <span>Retur Masuk</span>
                <b>{formatQty(selected.returnQty)}</b>
              </div>
              <div>
                <span>Penjualan</span>
                <b>{formatQty(selected.salesQty)}</b>
              </div>
              <div>
                <span>Barang Keluar</span>
                <b>{formatQty(selected.outgoingQty)}</b>
              </div>
              <div>
                <span>Stok Akhir Sistem</span>
                <b>{formatQty(selected.systemClosingQty)}</b>
              </div>
              <div>
                <span>Stok Berita Acara</span>
                <b>{formatQty(selected.physicalQty)}</b>
              </div>
              <div>
                <span>Selisih</span>
                <b>{formatSignedQty(selected.differenceQty)}</b>
              </div>
              <div>
                <span>Status</span>
                <StatusBadge status={selected.status} />
              </div>
            </section>

            {selected.formulaMismatch && (
              <p className="recon-special">
                <AlertTriangle /> Rumus (Stok Awal + Masuk + Retur − Jual − Keluar) menghasilkan angka berbeda dari closingQty snapshot ({formatQty(selected.formulaClosingQty)}) — closingQty snapshot tetap dipakai sebagai Stok Akhir Sistem.
              </p>
            )}

            {/* Diagnostik Snapshot, Catatan Berita Acara, dan baris "Terakhir
                diperbarui oleh" dihilangkan dari TAMPILAN atas permintaan.
                Datanya TIDAK dihapus: `note`/`updatedBy`/`updatedAt` tetap
                tersimpan di dokumen BA dan tetap ditulis jalur simpan. */}
            {!supervisor && <p className="recon-readonly">Anda memiliki akses baca. Hanya supervisor dapat mengubah stok berita acara.</p>}
          </div>
        </aside>
      )}
    </main>
  );
}
