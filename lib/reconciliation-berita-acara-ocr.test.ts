// Test untuk lib/reconciliation-berita-acara-ocr.ts. pdfjs-dist dan
// tesseract.js DI-MOCK (--experimental-test-module-mocks) supaya test tetap
// cepat/deterministik dan TIDAK menjalankan OCR sungguhan (yang berat) di
// setiap test run — perilaku pemilihan jalur (text-layer vs OCR vs
// unsupported-scanned-pdf) yang diuji di sini, bukan akurasi mesin OCR itu
// sendiri.
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

const fakePdfText = "Berita Acara PENAMBAHAN Rp740.000 alasan advance payment";
let pdfPageCount = 1;
let pdfTextPerPage: string[] = [fakePdfText];

mock.module("pdfjs-dist/legacy/build/pdf.mjs", {
  namedExports: {
    GlobalWorkerOptions: {} as { workerSrc: string },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pdfPageCount,
        async getPage(i: number) {
          return { async getTextContent() { return { items: [{ str: pdfTextPerPage[i - 1] ?? "" }] }; } };
        },
      }),
      async destroy() {},
    }),
  },
});

let ocrResult = { data: { text: "PENGURANGAN Rp500.000 alasan koreksi", confidence: 92 } };
mock.module("tesseract.js", {
  namedExports: {
    recognize: mock.fn(async () => ocrResult),
  },
});

let extractBeritaAcaraText!: typeof import("./reconciliation-berita-acara-ocr.ts").extractBeritaAcaraText;
before(async () => {
  ({ extractBeritaAcaraText } = await import("./reconciliation-berita-acara-ocr.ts"));
});

test("PDF dengan text layer -> dibaca via pdfjs-dist, confidence 1, source pdf-text-layer", async () => {
  pdfTextPerPage = [fakePdfText];
  pdfPageCount = 1;
  const result = await extractBeritaAcaraText({ buffer: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" });
  assert.equal(result.source, "pdf-text-layer");
  assert.equal(result.confidence, 1);
  assert.match(result.text, /Rp740\.000/);
});

test("PDF hasil scan (text layer kosong) -> dilaporkan jujur sebagai pdf-scanned-unsupported, confidence 0", async () => {
  pdfTextPerPage = [""];
  pdfPageCount = 1;
  const result = await extractBeritaAcaraText({ buffer: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" });
  assert.equal(result.source, "pdf-scanned-unsupported");
  assert.equal(result.confidence, 0);
  assert.equal(result.text, "");
});

test("JPG/PNG -> OCR via tesseract.js, confidence dari hasil OCR (skala 0..1)", async () => {
  ocrResult = { data: { text: "PENGURANGAN Rp500.000 alasan koreksi", confidence: 92 } };
  const result = await extractBeritaAcaraText({ buffer: new Uint8Array([255, 216, 255]), mimeType: "image/jpeg" });
  assert.equal(result.source, "image-ocr");
  assert.equal(result.confidence, 0.92);
  assert.match(result.text, /PENGURANGAN Rp500\.000/);

  const pngResult = await extractBeritaAcaraText({ buffer: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" });
  assert.equal(pngResult.source, "image-ocr");
});

test("tipe file tidak dikenal -> unsupported, tidak melempar", async () => {
  const result = await extractBeritaAcaraText({ buffer: new Uint8Array([1]), mimeType: "text/plain" });
  assert.equal(result.source, "pdf-scanned-unsupported");
  assert.equal(result.text, "");
});
