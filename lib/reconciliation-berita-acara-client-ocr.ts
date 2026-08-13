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

// Aset runtime tesseract.js (worker script, mesin OCR WASM, data bahasa)
// DI-HOSTING SENDIRI sebagai file statis yang di-commit langsung di
// public/tesseract/ (worker.min.js disalin apa adanya dari
// node_modules/tesseract.js/dist/; tesseract-core-lstm.wasm.js disalin apa
// adanya dari node_modules/tesseract.js-core/; lang/{ind,eng}.traineddata
// diunduh satu kali dari mirror npm resmi tesseract.js lalu DI-DEKOMPRES —
// lihat ROOT CAUSE V8 di bawah untuk alasan tidak lagi disimpan sebagai
// .gz) alih-alih dibiarkan fetch ke CDN itu setiap kali OCR jalan di browser
// pengguna. Proyek ini tidak punya konvensi postinstall/build-time
// asset-fetch (tidak ada public/ sebelumnya) — commit langsung sebagai file
// statis dipilih supaya build tetap deterministik tanpa panggilan jaringan
// tambahan saat `next build`/deploy Vercel. Ini menghapus kebutuhan CSP
// connect-src mengizinkan origin eksternal apa pun untuk OCR — lihat
// lib/csp.ts. corePath SENGAJA menunjuk satu file .js spesifik (bukan
// direktori) supaya tesseract.js TIDAK menjalankan deteksi fitur SIMD
// (paket wasm-feature-detect) yang biasanya memilih salah satu dari 3
// varian core (base/simd/relaxed-simd) — kita hanya vendor varian dasar
// non-SIMD, LSTM-only (oem default tesseract.js, sama seperti sebelum
// perubahan ini: createWorker() di bawah tidak pernah mengirim oem eksplisit)
// yang jalan di SEMUA browser modern, demi ukuran repo yang wajar. Ini TIDAK
// mengubah akurasi/mesin OCR — hanya bisa sedikit lebih lambat di browser
// yang sebenarnya mendukung WASM SIMD (Chrome/Firefox/Safari versi baru).
// workerBlobURL TIDAK diubah dari default tesseract.js (true) — mekanisme
// spawn worker (Blob + new Worker(blobURL)) persis sama dengan yang sudah
// terverifikasi jalan di production (V7), hanya path aset di dalamnya yang
// sekarang same-origin, bukan CDN.
//
// ROOT CAUSE V8 (OCR production tetap "Tidak terbaca" walau CSP/self-host
// V7 sudah benar — DITEMUKAN via real-browser reproduction, BUKAN tebakan):
// permintaan `fetch()` tesseract.js ke *.traineddata.gz (dipicu dari dalam
// Worker, lihat worker-script di node_modules/tesseract.js) DI-HIJACK oleh
// ekstensi browser download-manager pihak ketiga (terverifikasi: "IDM
// Advanced Integration" / Internet Download Manager — SANGAT umum terpasang
// di PC Windows Indonesia, sering bundel/bajakan) yang mencegat request
// berdasarkan EKSTENSI URL yang cocok pola "file yang bisa diunduh" (.gz,
// .bin, arsip pada umumnya) — respons asli (200, body gzip berisi data
// bahasa) tidak pernah sampai ke halaman; fetch() menerima respons sintetis
// 204 kosong ("Intercepted by the IDM Advanced Integration") alih-alih. Ini
// membuat tesseract.js gagal memuat SEMUA bahasa ("Tesseract couldn't load
// any languages!") dan gagal itu tidak pernah ter-reject dengan rapi
// (unhandled rejection di dalam worker) — hasilnya panggilan OCR
// menggantung/gagal diam-diam, `analysis` tidak pernah ke-set, dan UI jatuh
// ke fallback "Dokumen belum dapat dibaca otomatis" / status PERLU_REVIEW.
// Diverifikasi presisi via reproduksi langsung (Playwright + Chromium
// sungguhan menghadap `next build && next start`, BUKAN mock): mengganti
// HANYA ekstensi URL dari `.traineddata.gz` -> `.traineddata` (byte sama,
// server sama, satu-satunya variabel adalah ekstensi) membuat request lolos
// normal (200, bytes lengkap) — membuktikan ekstensi URL persis penyebabnya,
// bukan CSP/worker/CORS/ukuran file (yang semuanya sudah benar sejak V7).
// PERBAIKAN: matikan kompresi transport tesseract.js sendiri (`gzip: false`
// di bawah) supaya URL yang benar-benar di-fetch browser adalah
// `<lang>.traineddata` (TANPA `.gz`) — file bahasa di public/tesseract/lang/
// sekarang disimpan APA ADANYA (sudah didekompres), bukan lagi `.gz`. Next.js
// tetap mengompresi transfer secara transparan lewat Content-Encoding: gzip
// bila browser mendukung (sama seperti worker.min.js/*.wasm.js — lihat
// header respons `content-encoding: gzip` untuk aset itu), jadi TIDAK ada
// biaya bandwidth tambahan sungguhan; yang berubah murni ekstensi di URL
// supaya tidak lagi cocok pola ekstensi "unduhan" yang dicegat ekstensi
// pihak ketiga semacam itu.
export const TESSERACT_ASSET_OPTIONS = {
  workerPath: "/tesseract/worker.min.js",
  corePath: "/tesseract/tesseract-core-lstm.wasm.js",
  langPath: "/tesseract/lang",
  gzip: false,
} as const;

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

type PdfTextItemLike = { str?: unknown; transform?: unknown };

/**
 * ROOT CAUSE (BA Juli 2026, 0 item terekstrak): pdf.js `getTextContent()`
 * mengembalikan item teks sebagai stream DATAR (tidak ada newline antar
 * baris tabel) — sebelumnya kode ini menggabungkan SEMUA item pada satu
 * halaman dengan satu spasi (`.join(" ")`), sehingga seluruh tabel (header +
 * 7 baris produk) menjadi SATU baris teks raksasa. `lib/inventory-ba-parser.ts`
 * mem-parse item PER BARIS (`raw.split("\n")`) — periode/cutoff tetap
 * terbaca (regex-nya menyapu seluruh teks), tapi regex baris produk tidak
 * pernah cocok karena baris fisik tabel tidak pernah terpisah `\n`.
 *
 * FIX GENERIK (bukan hardcode nama produk): setiap item teks pdf.js
 * menyertakan `transform` (matriks posisi); `transform[5]` adalah koordinat
 * Y baseline dan `transform[4]` adalah koordinat X. Kita kelompokkan item
 * yang Y-nya berdekatan (toleransi kecil, mengakomodasi sedikit jitter antar
 * karakter dalam satu baris cetak) sebagai SATU baris tabel, urutkan item
 * dalam baris tersebut berdasarkan X (kiri ke kanan), lalu gabungkan
 * antar-baris dengan `\n`. Ini berlaku untuk tabel APA PUN (jumlah kolom,
 * lebar kolom, spasi tidak konsisten) — tidak bergantung pada isi/nama
 * produk tertentu. Bila suatu PDF tidak menyertakan `transform` yang valid
 * (mis. mock test lama / edge-case pdf.js), fallback ke perilaku lama
 * (`.join(" ")`) supaya tidak regresi.
 */
export function groupPdfTextItemsIntoLines(items: readonly PdfTextItemLike[]): string {
  const LINE_Y_TOLERANCE = 2.5;
  type Positioned = { str: string; x: number; y: number };
  const positioned: Positioned[] = [];
  let allHavePosition = true;
  for (const item of items) {
    const str = typeof item.str === "string" ? item.str : "";
    if (!str) continue;
    const t = item.transform;
    if (!Array.isArray(t) || t.length < 6 || typeof t[4] !== "number" || typeof t[5] !== "number") {
      allHavePosition = false;
      break;
    }
    positioned.push({ str, x: t[4], y: t[5] });
  }
  if (!allHavePosition || positioned.length === 0) {
    return items.map((item) => (typeof item.str === "string" ? item.str : "")).join(" ");
  }
  // pdf.js: Y makin besar = makin ke atas halaman -> urutkan turun (atas ke bawah), lalu X naik (kiri ke kanan).
  const sorted = [...positioned].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Positioned[][] = [];
  for (const p of sorted) {
    const currentLine = lines.at(-1);
    if (currentLine && Math.abs(currentLine[0].y - p.y) <= LINE_Y_TOLERANCE) {
      currentLine.push(p);
    } else {
      lines.push([p]);
    }
  }
  return lines
    .map((line) =>
      [...line]
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join(" "),
    )
    .join("\n");
}

export type PositionedPdfTextItem = { str: string; x: number; y: number };

/**
 * Ekstrak text item pdf.js MENTAH (str + posisi X/Y asli dari `transform`),
 * TANPA digabung jadi baris teks. Dipakai khusus oleh parser tabel BA Stock
 * Opname (lib/inventory-ba-table-parser.ts) yang merekonstruksi tabel secara
 * spasial — lihat AYOSERA-HANDOFF-LATEST.md untuk root cause kenapa parsing
 * lewat baris teks gabungan (groupPdfTextItemsIntoLines, dipakai flow BA
 * rekonsiliasi omzet lain) TERBUKTI salah untuk tabel ini. Mengembalikan
 * `null` bila ADA item tanpa koordinat valid (pemanggil WAJIB jatuh ke
 * fail-safe, bukan menebak layout dari urutan ekstraksi).
 */
export async function extractPdfTextLayerItems(doc: PdfDocumentProxy): Promise<PositionedPdfTextItem[] | null> {
  const pagesToRead = Math.min(doc.numPages, MAX_OCR_PAGES);
  const all: PositionedPdfTextItem[] = [];
  for (let i = 1; i <= pagesToRead; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items as PdfTextItemLike[]) {
      const str = typeof item.str === "string" ? item.str : "";
      if (!str) continue;
      const t = item.transform;
      if (!Array.isArray(t) || t.length < 6 || typeof t[4] !== "number" || typeof t[5] !== "number") return null;
      all.push({ str, x: t[4], y: t[5] });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return all;
}

/**
 * Buka file PDF di browser dan kembalikan text item MENTAH dengan posisi
 * (untuk parser tabel spasial), atau `null` bila text layer tidak ada/kosong
 * (mis. PDF hasil scan) atau item tidak menyertakan koordinat valid — dalam
 * kedua kasus itu, caller (lib/inventory-ba-client.ts) WAJIB jatuh ke
 * fail-safe eksplisit (inventoryBaParseFailure), TIDAK PERNAH memakai parser
 * baris teks lama sebagai fallback diam-diam.
 */
export async function extractInventoryBaPdfItems(file: File, onStatus: OnOcrStatus = () => {}): Promise<PositionedPdfTextItem[] | null> {
  if (file.type !== "application/pdf") return null;
  onStatus(STATUS_READING);
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const buffer = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data: buffer });
  try {
    const doc = await loadingTask.promise;
    const items = await extractPdfTextLayerItems(doc);
    if (!items) return null;
    const totalLength = items.reduce((sum, item) => sum + item.str.length, 0);
    if (totalLength < MIN_TEXT_LAYER_LENGTH) return null;
    return items;
  } finally {
    await loadingTask.destroy();
  }
}

async function extractPdfTextLayer(doc: PdfDocumentProxy): Promise<string> {
  const pagesToRead = Math.min(doc.numPages, MAX_OCR_PAGES);
  const parts: string[] = [];
  for (let i = 1; i <= pagesToRead; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(groupPdfTextItemsIntoLines(content.items as PdfTextItemLike[]));
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
  const worker = await createWorker("ind+eng", undefined, TESSERACT_ASSET_OPTIONS);
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
  const worker = await createWorker("ind+eng", undefined, TESSERACT_ASSET_OPTIONS);
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
