// Ekstraksi teks BROWSER-SIDE untuk Berita Acara (PDF/JPG/PNG), termasuk PDF
// hasil scan (image-only) yang TIDAK bisa dibaca oleh
// lib/reconciliation-berita-acara-ocr.ts (server) karena rasterisasi
// PDF -> bitmap butuh binary native (mis. @napi-rs/canvas) yang dilarang di
// Vercel serverless. Di BROWSER, Canvas API native (HTMLCanvasElement)
// tersedia gratis tanpa binary tambahan apa pun — jadi PDF hasil scan
// dirender ke <canvas> di sini, lalu di-OCR dengan tesseract.js (build WASM
// browser). Semua proses lokal di perangkat pengguna; TIDAK PERNAH memanggil
// layanan OCR/AI eksternal berbayar.
//
// Kontrak hasil SAMA dengan modul server (lib/reconciliation-berita-acara-ocr.ts):
// { text, confidence, source } lalu diparse oleh SATU-SATUNYA sumber
// kebenaran parsing: lib/reconciliation-berita-acara-parser.ts. Modul ini
// TIDAK PERNAH memparse nominal/arah/alasan sendiri — hanya menghasilkan teks.
//
// Dijalankan sequential per halaman (bukan Promise.all) dan yield ke event
// loop di antara halaman supaya main thread (UI) tidak freeze selama OCR.
import { parseBeritaAcaraText, matchBeritaAcaraToSystemDifference, type BeritaAcaraDirection, type BeritaAcaraParseStatus, type BeritaAcaraMatchStatus } from "./reconciliation-berita-acara-parser";

export type BeritaAcaraClientOcrSource = "pdf-text-layer" | "pdf-scanned-ocr" | "image-ocr" | "unsupported";

export type BeritaAcaraClientOcrResult = {
  text: string;
  confidence: number; // 0..1. 1.0 untuk text-layer PDF (deterministik, bukan OCR).
  source: BeritaAcaraClientOcrSource;
};

export type OnOcrStatus = (status: string) => void;

const MAX_OCR_PAGES = 3;
// Ambang sama dengan lib/reconciliation-berita-acara-ocr.ts: text layer PDF
// hasil scan biasanya kosong/nyaris kosong.
const MIN_TEXT_LAYER_LENGTH = 20;
// Skala render halaman PDF -> canvas. PDF.js memakai basis 72 DPI, jadi
// scale 2.2 setara ~158 DPI — cukup untuk OCR dokumen teks standar tanpa
// bitmap raksasa yang memperlambat/menge-freeze browser.
const RENDER_SCALE = 2.2;
export const STATUS_READING = "Membaca berita acara...";

/** Gabungkan teks OCR per halaman, bersihkan artefak spasi/baris ganda hasil OCR. */
export function mergeOcrPages(pages: string[]): string {
  return pages
    .map((page) => page.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/** Rerata confidence per halaman (0..1); array kosong -> 0 (bukan NaN/false-confidence). */
export function averageConfidence(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

type PdfjsModule = typeof import("pdfjs-dist");
type PdfDocumentProxy = Awaited<ReturnType<PdfjsModule["getDocument"]>>["promise"] extends Promise<infer T> ? T : never;

async function extractPdfTextLayer(doc: PdfDocumentProxy): Promise<string> {
  const pagesToRead = Math.min(doc.numPages, MAX_OCR_PAGES);
  const parts: string[] = [];
  for (let i = 1; i <= pagesToRead; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    // Yield ke event loop antar halaman supaya UI tidak freeze.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return parts.join("\n").trim();
}

export type ClientOcrDeps = {
  /** Dependency injection untuk test (tanpa DOM sungguhan di Node). Default: document.createElement("canvas"). */
  createCanvas?: () => HTMLCanvasElement;
  onStatus?: OnOcrStatus;
};

async function ocrScannedPdf(doc: PdfDocumentProxy, deps: Required<Pick<ClientOcrDeps, "createCanvas" | "onStatus">>): Promise<BeritaAcaraClientOcrResult> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("ind+eng");
  const pagesToRead = Math.min(doc.numPages, MAX_OCR_PAGES);
  const texts: string[] = [];
  const confidences: number[] = [];
  try {
    for (let i = 1; i <= pagesToRead; i++) {
      deps.onStatus(pagesToRead > 1 ? `${STATUS_READING} (halaman ${i}/${pagesToRead})` : STATUS_READING);
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = deps.createCanvas();
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context tidak tersedia di browser ini.");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      try {
        const result = await worker.recognize(canvas);
        texts.push(result.data.text ?? "");
        confidences.push(Math.max(0, Math.min(1, (result.data.confidence ?? 0) / 100)));
      } finally {
        // Lepas referensi bitmap canvas sesegera mungkin (memori halaman scan bisa besar).
        canvas.width = 0;
        canvas.height = 0;
      }
      // Sequential (bukan parallel) + yield antar halaman supaya main thread tidak freeze.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    await worker.terminate();
  }
  const text = mergeOcrPages(texts);
  const confidence = text ? averageConfidence(confidences) : 0;
  return { text, confidence, source: "pdf-scanned-ocr" };
}

async function ocrImage(file: File, deps: Required<Pick<ClientOcrDeps, "onStatus">>): Promise<BeritaAcaraClientOcrResult> {
  deps.onStatus(STATUS_READING);
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("ind+eng");
  try {
    const result = await worker.recognize(file);
    const confidence = Math.max(0, Math.min(1, (result.data.confidence ?? 0) / 100));
    return { text: (result.data.text ?? "").trim(), confidence, source: "image-ocr" };
  } finally {
    await worker.terminate();
  }
}

/**
 * Ekstrak teks mentah dari file Berita Acara di BROWSER. Untuk PDF: coba
 * text layer dulu (cepat, akurat); bila kosong/minim (PDF hasil scan),
 * rasterisasi ke <canvas> lalu OCR client-side. Untuk JPG/PNG: OCR langsung.
 * Kegagalan apa pun dilempar ke caller — caller HARUS jatuh ke status
 * PERLU REVIEW + fallback manual, TIDAK PERNAH menebak hasil.
 */
export async function extractBeritaAcaraTextClient(file: File, deps: ClientOcrDeps = {}): Promise<BeritaAcaraClientOcrResult> {
  const onStatus = deps.onStatus ?? (() => {});
  const createCanvas = deps.createCanvas ?? (() => document.createElement("canvas"));
  const mimeType = file.type;

  if (mimeType === "image/jpeg" || mimeType === "image/jpg" || mimeType === "image/png") {
    return ocrImage(file, { onStatus });
  }

  if (mimeType !== "application/pdf") {
    return { text: "", confidence: 0, source: "unsupported" };
  }

  onStatus(STATUS_READING);
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const buffer = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data: buffer });
  try {
    const doc = await loadingTask.promise;
    const textLayer = await extractPdfTextLayer(doc);
    if (textLayer.length >= MIN_TEXT_LAYER_LENGTH) {
      return { text: textLayer, confidence: 1, source: "pdf-text-layer" };
    }
    return await ocrScannedPdf(doc, { createCanvas, onStatus });
  } finally {
    await loadingTask.destroy();
  }
}

export type BeritaAcaraClientAnalysis = {
  systemDifference: number;
  nominal: number | null;
  direction: BeritaAcaraDirection | null;
  reason: string | null;
  parseStatus: BeritaAcaraParseStatus;
  matchStatus: BeritaAcaraMatchStatus;
  ocrSource: BeritaAcaraClientOcrSource;
};

/**
 * Ekstrak (browser) + parse (lib/reconciliation-berita-acara-parser.ts, satu-
 * satunya sumber kebenaran) + cocokkan terhadap selisih sistem berjalan,
 * dalam satu pemanggilan — dipakai UI persis setelah upload, saat File masih
 * ada di tangan. Kegagalan apa pun (OCR crash, PDF korup, dll.) dilempar ke
 * caller TANPA ditebak; caller wajib jatuh ke status PERLU REVIEW + fallback
 * isian manual, tidak pernah mengunci otomatis dari hasil yang gagal/minim.
 */
export async function analyzeBeritaAcaraFileClient(file: File, systemDifference: number, deps: ClientOcrDeps = {}): Promise<BeritaAcaraClientAnalysis> {
  const ocr = await extractBeritaAcaraTextClient(file, deps);
  const parsed = parseBeritaAcaraText(ocr.text, ocr.confidence);
  const matchStatus = parsed.status === "OK" ? matchBeritaAcaraToSystemDifference(systemDifference, parsed) : "PERLU_REVIEW";
  return {
    systemDifference,
    nominal: parsed.nominal,
    direction: parsed.direction,
    reason: parsed.reason,
    parseStatus: parsed.status,
    matchStatus,
    ocrSource: ocr.source,
  };
}
