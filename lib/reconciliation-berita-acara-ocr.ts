// Ekstraksi teks mentah dari file Berita Acara (PDF/JPG/JPEG/PNG) untuk
// dipakai lib/reconciliation-berita-acara-parser.ts. SEMUA proses lokal
// (WASM/pure-JS), TIDAK PERNAH memanggil layanan OCR/AI eksternal.
//
// Dukungan yang SUNGGUH diimplementasikan:
//  - PDF dengan text layer (bukan hasil scan)  -> pdfjs-dist, akurat.
//  - JPG/JPEG/PNG hasil scan/foto              -> tesseract.js (OCR WASM).
//
// Dukungan yang JUJUR TIDAK diimplementasikan:
//  - PDF hasil scan/gambar (tanpa text layer). Merender halaman PDF ke
//    bitmap butuh implementasi canvas; satu-satunya opsi pure-JS/WASM yang
//    viable (mis. @napi-rs/canvas, skia-canvas) adalah BINARY NATIF — dilarang
//    oleh batasan tugas ini untuk Vercel serverless. Tanpa itu, pdfjs-dist
//    tidak bisa rasterisasi halaman jadi bitmap untuk di-OCR. Untuk kasus
//    ini fungsi mengembalikan confidence 0 dan teks kosong -> parser akan
//    menghasilkan status PERLU_REVIEW (BUKAN tebakan/klaim palsu).
import "server-only";

export type BeritaAcaraOcrSource = "pdf-text-layer" | "image-ocr" | "pdf-scanned-unsupported";

export type BeritaAcaraOcrResult = {
  text: string;
  confidence: number; // 0..1. 1.0 untuk text-layer PDF (deterministik, bukan OCR).
  source: BeritaAcaraOcrSource;
};

const MAX_PAGES = 3;

async function extractPdfTextLayer(buffer: Uint8Array): Promise<{ text: string; pageCount: number }> {
  // Legacy build dipakai karena tidak butuh DOM (jalan di Node serverless).
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Tidak ada worker terpisah dibutuhkan untuk parsing teks di Node —
  // matikan worker supaya tidak mencoba spawn worker thread di runtime serverless.
  pdfjs.GlobalWorkerOptions.workerSrc = "";
  const loadingTask = pdfjs.getDocument({ data: buffer, useWorkerFetch: false, disableFontFace: true });
  const doc = await loadingTask.promise;
  const pageCount = doc.numPages;
  const pagesToRead = Math.min(pageCount, MAX_PAGES);
  const parts: string[] = [];
  for (let i = 1; i <= pagesToRead; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
    parts.push(pageText);
  }
  await loadingTask.destroy();
  return { text: parts.join("\n"), pageCount };
}

async function ocrImage(buffer: Uint8Array): Promise<{ text: string; confidence: number }> {
  const { recognize } = await import("tesseract.js");
  const result = await recognize(Buffer.from(buffer), "ind+eng");
  // tesseract.js confidence ada dalam skala 0-100.
  const confidence = Math.max(0, Math.min(1, (result.data.confidence ?? 0) / 100));
  return { text: result.data.text ?? "", confidence };
}

/**
 * Ekstrak teks mentah dari file Berita Acara. `buffer` dibatasi caller ke
 * maksimal 10MB (validateOmzetPeriodLockAttachment); hanya beberapa halaman
 * pertama PDF yang dibaca (MAX_PAGES).
 */
export async function extractBeritaAcaraText(input: { buffer: Uint8Array; mimeType: string }): Promise<BeritaAcaraOcrResult> {
  const { buffer, mimeType } = input;
  if (mimeType === "application/pdf") {
    const { text } = await extractPdfTextLayer(buffer);
    const trimmed = text.trim();
    // Heuristik sederhana: text layer PDF hasil scan biasanya kosong atau
    // nyaris kosong (beberapa karakter noise). Ambang 20 karakter dipilih
    // karena BA rekonsiliasi selalu berisi kalimat, bukan cuma simbol.
    if (trimmed.length >= 20) {
      return { text: trimmed, confidence: 1, source: "pdf-text-layer" };
    }
    // PDF hasil scan (image-based) — rasterisasi halaman ke bitmap TIDAK
    // diimplementasikan di sini (lihat catatan file). Kembalikan hasil
    // jujur alih-alih klaim OCR yang tidak benar-benar dijalankan.
    return { text: "", confidence: 0, source: "pdf-scanned-unsupported" };
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg" || mimeType === "image/png") {
    const { text, confidence } = await ocrImage(buffer);
    return { text: text.trim(), confidence, source: "image-ocr" };
  }
  return { text: "", confidence: 0, source: "pdf-scanned-unsupported" };
}
