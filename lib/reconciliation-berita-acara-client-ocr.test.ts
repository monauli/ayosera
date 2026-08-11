// Test untuk lib/reconciliation-berita-acara-client-ocr.ts (ekstraksi teks
// BROWSER-SIDE, termasuk OCR PDF hasil scan lewat canvas). pdfjs-dist dan
// tesseract.js DI-MOCK (sama seperti lib/reconciliation-berita-acara-ocr.test.ts)
// supaya deterministik/cepat dan TIDAK menjalankan OCR sungguhan. Tidak ada
// DOM (jsdom) di proyek ini (lihat lib/logout-flow.test.ts) — canvas
// di-inject via ClientOcrDeps.createCanvas dengan objek tiruan minimal yang
// memenuhi interface yang dipakai modul (getContext/width/height), gaya yang
// sama dengan "no render infra" di seluruh test suite proyek ini.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import test, { before, mock } from "node:test";

type FakePage = { text: string; renderCalls: number };

const pages: FakePage[] = [{ text: "", renderCalls: 0 }];
let pdfPageCount = 1;
let recognizeCalls: unknown[] = [];
let recognizeResults: Array<{ text: string; confidence: number }> = [];
let terminateCalls = 0;
let ocrShouldFail = false;

mock.module("pdfjs-dist", {
  namedExports: {
    GlobalWorkerOptions: {} as { workerSrc: string },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pdfPageCount,
        async getPage(i: number) {
          const p = pages[i - 1] ?? { text: "", renderCalls: 0 };
          return {
            async getTextContent() {
              return { items: [{ str: p.text }] };
            },
            getViewport({ scale }: { scale: number }) {
              return { width: 100 * scale, height: 140 * scale };
            },
            render({ canvasContext }: { canvasContext: unknown }) {
              p.renderCalls += 1;
              assert.ok(canvasContext, "render harus menerima context canvas");
              return { promise: Promise.resolve() };
            },
          };
        },
      }),
      async destroy() {},
    }),
  },
});

mock.module("tesseract.js", {
  namedExports: {
    createWorker: mock.fn(async () => ({
      async recognize(input: unknown) {
        recognizeCalls.push(input);
        if (ocrShouldFail) throw new Error("OCR engine crash (simulasi)");
        const next = recognizeResults[recognizeCalls.length - 1] ?? recognizeResults.at(-1) ?? { text: "", confidence: 0 };
        return { data: { text: next.text, confidence: next.confidence } };
      },
      async terminate() {
        terminateCalls += 1;
      },
    })),
  },
});

let extractBeritaAcaraTextClient!: typeof import("./reconciliation-berita-acara-client-ocr.ts").extractBeritaAcaraTextClient;
let mergeOcrPages!: typeof import("./reconciliation-berita-acara-client-ocr.ts").mergeOcrPages;
let averageConfidence!: typeof import("./reconciliation-berita-acara-client-ocr.ts").averageConfidence;
let TESSERACT_ASSET_OPTIONS!: typeof import("./reconciliation-berita-acara-client-ocr.ts").TESSERACT_ASSET_OPTIONS;
let parseBeritaAcaraText!: typeof import("./reconciliation-berita-acara-parser.ts").parseBeritaAcaraText;
let matchBeritaAcaraToSystemDifference!: typeof import("./reconciliation-berita-acara-parser.ts").matchBeritaAcaraToSystemDifference;
before(async () => {
  ({ extractBeritaAcaraTextClient, mergeOcrPages, averageConfidence, TESSERACT_ASSET_OPTIONS } = await import("./reconciliation-berita-acara-client-ocr.ts"));
  ({ parseBeritaAcaraText, matchBeritaAcaraToSystemDifference } = await import("./reconciliation-berita-acara-parser.ts"));
});

function fakeFile(name: string, type: string, content = "x"): File {
  return new File([content], name, { type });
}

function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({}) as unknown as CanvasRenderingContext2D,
  } as unknown as HTMLCanvasElement;
  return canvas;
}

test("mergeOcrPages: gabung antar halaman, bersihkan spasi/baris ganda artefak OCR", () => {
  const merged = mergeOcrPages(["Halaman  satu   teks", "", "Halaman\n\n\n\ndua"]);
  assert.equal(merged, "Halaman satu teks\n\nHalaman\n\ndua");
});

test("averageConfidence: rerata benar, array kosong -> 0 (bukan NaN)", () => {
  assert.equal(averageConfidence([0.8, 0.6]), 0.7);
  assert.equal(averageConfidence([]), 0);
});

test("PDF dengan text layer -> dibaca langsung, TIDAK memanggil OCR/canvas sama sekali", async () => {
  pages[0] = { text: "Berita Acara PENAMBAHAN Rp740.000 pembayaran di muka diterima bulan Maret.", renderCalls: 0 };
  pdfPageCount = 1;
  recognizeCalls = [];
  const canvasCalls: number[] = [];
  const result = await extractBeritaAcaraTextClient(fakeFile("ba.pdf", "application/pdf"), {
    createCanvas: () => {
      canvasCalls.push(1);
      return fakeCanvas();
    },
  });
  assert.equal(result.source, "pdf-text-layer");
  assert.equal(result.confidence, 1);
  assert.match(result.text, /Rp740\.000/);
  assert.equal(canvasCalls.length, 0, "text-layer PDF tidak boleh merender canvas");
  assert.equal(recognizeCalls.length, 0, "text-layer PDF tidak boleh memanggil OCR");
});

test("PDF hasil scan (text layer kosong) -> rasterisasi canvas lalu OCR client-side, source pdf-scanned-ocr", async () => {
  pages[0] = { text: "", renderCalls: 0 };
  pdfPageCount = 1;
  recognizeCalls = [];
  recognizeResults = [{ text: "PENGURANGAN Rp740.000 sudah diakui sebagai pendapatan bulan Maret", confidence: 88 }];
  terminateCalls = 0;
  const statuses: string[] = [];
  const result = await extractBeritaAcaraTextClient(fakeFile("ba-scan.pdf", "application/pdf"), {
    createCanvas: fakeCanvas,
    onStatus: (s) => statuses.push(s),
  });
  assert.equal(result.source, "pdf-scanned-ocr");
  assert.match(result.text, /PENGURANGAN Rp740\.000/);
  assert.ok(result.confidence > 0 && result.confidence <= 1);
  assert.equal(pages[0].renderCalls, 1);
  assert.equal(terminateCalls, 1, "worker tesseract harus di-terminate setelah selesai");
  assert.ok(statuses.some((s) => s.includes("Membaca berita acara")));
});

test("PDF scan multi-halaman -> OCR sequential per halaman (maks 3), digabung berurutan", async () => {
  pages[0] = { text: "", renderCalls: 0 };
  pages[1] = { text: "", renderCalls: 0 };
  pages[2] = { text: "", renderCalls: 0 };
  pdfPageCount = 4; // harus dibatasi ke 3 halaman
  recognizeCalls = [];
  recognizeResults = [
    { text: "Halaman satu", confidence: 90 },
    { text: "Halaman dua", confidence: 80 },
    { text: "Halaman tiga", confidence: 70 },
  ];
  const result = await extractBeritaAcaraTextClient(fakeFile("multi.pdf", "application/pdf"), { createCanvas: fakeCanvas });
  assert.equal(recognizeCalls.length, 3, "maksimal 3 halaman diproses");
  assert.match(result.text, /Halaman satu/);
  assert.match(result.text, /Halaman dua/);
  assert.match(result.text, /Halaman tiga/);
  assert.ok(Math.abs(result.confidence - 0.8) < 1e-9);
});

test("OCR gagal total (semua halaman kosong) -> confidence 0, teks kosong (bukan tebakan)", async () => {
  pages[0] = { text: "", renderCalls: 0 };
  pdfPageCount = 1;
  recognizeCalls = [];
  recognizeResults = [{ text: "", confidence: 0 }];
  const result = await extractBeritaAcaraTextClient(fakeFile("blank.pdf", "application/pdf"), { createCanvas: fakeCanvas });
  assert.equal(result.text, "");
  assert.equal(result.confidence, 0);
  assert.equal(result.source, "pdf-scanned-ocr");
});

test("JPG/PNG -> OCR langsung via tesseract.js worker (tanpa pdfjs)", async () => {
  recognizeCalls = [];
  recognizeResults = [{ text: "PENAMBAHAN Rp740.000 pembayaran di muka Maret", confidence: 91 }];
  terminateCalls = 0;
  const result = await extractBeritaAcaraTextClient(fakeFile("ba.jpg", "image/jpeg"));
  assert.equal(result.source, "image-ocr");
  assert.equal(result.confidence, 0.91);
  assert.match(result.text, /PENAMBAHAN Rp740\.000/);
  assert.equal(terminateCalls, 1);

  recognizeResults = [{ text: "png ok", confidence: 50 }];
  const pngResult = await extractBeritaAcaraTextClient(fakeFile("ba.png", "image/png"));
  assert.equal(pngResult.source, "image-ocr");
});

test("tipe file tidak dikenal -> unsupported, tidak melempar", async () => {
  const result = await extractBeritaAcaraTextClient(fakeFile("data.txt", "text/plain"));
  assert.equal(result.source, "unsupported");
  assert.equal(result.text, "");
});

// ---------------------------------------------------------------------------
// Hardening pasca-V7: createWorker() TIDAK LAGI dipanggil tanpa opsi (yang
// akan diam-diam fetch ke CDN default tesseract.js) — WAJIB selalu diberi
// corePath/langPath/workerPath same-origin. Test tesseract.js di atas
// di-mock TOTAL (tidak pernah benar-benar fetch), jadi ini murni mengecek
// WIRING pemanggilan (bukan bukti "jalan di browser sungguhan" — itu perlu
// verifikasi manual di browser nyata). Melengkapi blind spot yang sama
// seperti dijelaskan di komentar atas file test ini.
// ---------------------------------------------------------------------------

test("Hardening: createWorker() dipanggil dengan corePath/langPath/workerPath same-origin (bukan default CDN tesseract.js) untuk OCR PDF scan", async () => {
  pages[0] = { text: "", renderCalls: 0 };
  pdfPageCount = 1;
  recognizeCalls = [];
  recognizeResults = [{ text: "cek wiring", confidence: 80 }];
  const { createWorker } = await import("tesseract.js");
  const createWorkerMock = createWorker as unknown as { mock: { calls: Array<{ arguments: unknown[] }>; resetCalls: () => void } };
  createWorkerMock.mock.resetCalls();
  await extractBeritaAcaraTextClient(fakeFile("ba-scan.pdf", "application/pdf"), { createCanvas: fakeCanvas });
  assert.equal(createWorkerMock.mock.calls.length, 1);
  const [langs, , options] = createWorkerMock.mock.calls[0]!.arguments as [string, unknown, typeof TESSERACT_ASSET_OPTIONS];
  assert.equal(langs, "ind+eng");
  assert.deepEqual(options, TESSERACT_ASSET_OPTIONS);
  assert.ok(options.workerPath.startsWith("/tesseract/"), "workerPath harus same-origin (bukan https://cdn.jsdelivr.net)");
  assert.ok(options.corePath.startsWith("/tesseract/"), "corePath harus same-origin");
  assert.ok(options.langPath.startsWith("/tesseract/"), "langPath harus same-origin");
  assert.equal([options.workerPath, options.corePath, options.langPath].some((p) => p.includes("cdn.jsdelivr.net")), false);
});

test("Hardening: createWorker() dipanggil dengan opsi same-origin yang sama untuk OCR JPG/PNG langsung", async () => {
  recognizeCalls = [];
  recognizeResults = [{ text: "cek wiring image", confidence: 80 }];
  const { createWorker } = await import("tesseract.js");
  const createWorkerMock = createWorker as unknown as { mock: { calls: Array<{ arguments: unknown[] }>; resetCalls: () => void } };
  createWorkerMock.mock.resetCalls();
  await extractBeritaAcaraTextClient(fakeFile("ba.jpg", "image/jpeg"));
  assert.equal(createWorkerMock.mock.calls.length, 1);
  const [, , options] = createWorkerMock.mock.calls[0]!.arguments as [string, unknown, typeof TESSERACT_ASSET_OPTIONS];
  assert.deepEqual(options, TESSERACT_ASSET_OPTIONS);
});

// ---------------------------------------------------------------------------
// Hardening pasca-V7: verifikasi STRUKTURAL bahwa file yang ditunjuk
// TESSERACT_ASSET_OPTIONS benar-benar ada di public/tesseract/ dan bukan
// file kosong/rusak. Ini TIDAK membuktikan OCR jalan di browser sungguhan
// (tesseract.js di-mock total di file test ini) — hanya membuktikan aset
// yang di-vendor benar-benar ada, cukup besar untuk masuk akal jadi
// worker/wasm-core/traineddata sungguhan, dan konsisten dengan path yang
// dipakai createWorker(). Kompensasi blind spot "mock total" yang sama
// dengan alasan test CSP V7 ditambahkan.
// ---------------------------------------------------------------------------

test("Hardening: aset tesseract.js yang di-vendor (worker script, core WASM, data bahasa ind+eng) benar-benar ada di public/tesseract/ dan tidak kosong", () => {
  const publicDir = path.join(process.cwd(), "public");
  const workerFile = path.join(publicDir, "tesseract", "worker.min.js");
  const coreFile = path.join(publicDir, "tesseract", "tesseract-core-lstm.wasm.js");
  // TANPA .gz — lihat ROOT CAUSE V8 di reconciliation-berita-acara-client-ocr.ts:
  // ekstensi .gz di URL di-hijack oleh ekstensi download-manager pihak ketiga
  // (terverifikasi: IDM Advanced Integration) di banyak PC Windows, membuat
  // fetch() tesseract.js menerima respons 204 kosong. File bahasa sekarang
  // disimpan APA ADANYA (sudah didekompres) supaya URL yang di-fetch browser
  // (`<lang>.traineddata`, lihat TESSERACT_ASSET_OPTIONS.gzip: false) tidak
  // lagi cocok pola ekstensi "unduhan" itu.
  const engLang = path.join(publicDir, "tesseract", "lang", "eng.traineddata");
  const indLang = path.join(publicDir, "tesseract", "lang", "ind.traineddata");

  for (const [label, file, minBytes] of [
    ["worker.min.js", workerFile, 10_000],
    ["tesseract-core-lstm.wasm.js (mesin OCR WASM LSTM-only)", coreFile, 1_000_000],
    ["lang/eng.traineddata", engLang, 500_000],
    ["lang/ind.traineddata", indLang, 200_000],
  ] as const) {
    assert.ok(existsSync(file), `${label} harus ada di ${file}`);
    const size = statSync(file).size;
    assert.ok(size >= minBytes, `${label} ukurannya ${size} byte, terlalu kecil untuk file sungguhan (min ${minBytes})`);
  }

  // Path di TESSERACT_ASSET_OPTIONS (dipakai createWorker) harus persis
  // konsisten dengan lokasi file di public/ (Next.js melayani public/X
  // di URL /X) — kalau salah satu berubah tanpa yang lain, OCR akan 404 diam-diam.
  assert.equal(TESSERACT_ASSET_OPTIONS.workerPath, "/tesseract/worker.min.js");
  assert.equal(TESSERACT_ASSET_OPTIONS.corePath, "/tesseract/tesseract-core-lstm.wasm.js");
  assert.equal(TESSERACT_ASSET_OPTIONS.langPath, "/tesseract/lang");

  // Regresi ROOT CAUSE V8: gzip HARUS false supaya tesseract.js meminta
  // "<lang>.traineddata" (bukan "<lang>.traineddata.gz") — lihat komentar
  // ROOT CAUSE V8 di reconciliation-berita-acara-client-ocr.ts. Kalau ini
  // ke-flip ke true/dihapus, URL kembali cocok pola ekstensi "unduhan" yang
  // di-hijack ekstensi browser download-manager pihak ketiga di production,
  // dan file .gz lang pack tidak lagi ada di public/tesseract/lang/ untuk
  // di-fetch.
  assert.equal(TESSERACT_ASSET_OPTIONS.gzip, false);
  assert.ok(!existsSync(path.join(publicDir, "tesseract", "lang", "ind.traineddata.gz")), "lang pack .gz TIDAK boleh ada lagi (lihat ROOT CAUSE V8) — hijack ekstensi download-manager memicu di file .gz, bukan .traineddata polos");
  assert.ok(!existsSync(path.join(publicDir, "tesseract", "lang", "eng.traineddata.gz")), "lang pack .gz TIDAK boleh ada lagi (lihat ROOT CAUSE V8)");
});

// ---------------------------------------------------------------------------
// Skenario end-to-end wajib: teks OCR noisy realistis -> parser -> matcher,
// memakai jalur browser (extractBeritaAcaraTextClient) lalu SATU-SATUNYA
// sumber kebenaran parsing (lib/reconciliation-berita-acara-parser.ts).
// ---------------------------------------------------------------------------

const MARET_NOISY_OCR_TEXT =
  "BERITA  ACARA REKONSILIASI OMZET\n\n" +
  "Pada   bulan Maret terjadi PENAMBAHAN pendapatan  sebesar Rp740.000\n" +
  "disebabkan pembayaran   di muka diterima pada bulan Maret,\n" +
  "dan diakui sebagai pendapatan bulan Maret.\n\n" +
  "Ditandatangani oleh Supervisor Operasional.";

const APRIL_NOISY_OCR_TEXT =
  "BERITA  ACARA REKONSILIASI OMZET\n\n" +
  "Pada bulan April dilakukan PENGURANGAN pendapatan sebesar   Rp740.000\n" +
  "karena sudah diakui sebagai pendapatan pada bulan  Maret sehingga\n" +
  "dikurangkan dari pendapatan penggunaan lapangan bulan April.\n\n" +
  "Ditandatangani oleh Supervisor Operasional.";

test("Maret: PDF scan noisy OCR -> nominal 740.000, PENAMBAHAN, alasan dari paragraf (tanpa label 'Alasan:'), COCOK dengan selisih sistem +740.000", async () => {
  pages[0] = { text: "", renderCalls: 0 };
  pdfPageCount = 1;
  recognizeCalls = [];
  recognizeResults = [{ text: MARET_NOISY_OCR_TEXT, confidence: 87 }];
  const ocr = await extractBeritaAcaraTextClient(fakeFile("ba-maret.pdf", "application/pdf"), { createCanvas: fakeCanvas });
  assert.equal(ocr.source, "pdf-scanned-ocr");

  const parsed = parseBeritaAcaraText(ocr.text, ocr.confidence);
  assert.equal(parsed.nominal, 740_000);
  assert.equal(parsed.direction, "PENAMBAHAN");
  assert.equal(parsed.status, "OK");
  assert.match(parsed.reason ?? "", /pembayaran/i);
  assert.match(parsed.reason ?? "", /Maret/);

  const matchStatus = matchBeritaAcaraToSystemDifference(740_000, parsed);
  assert.equal(matchStatus, "COCOK");
});

test("April: PDF scan noisy OCR -> nominal 740.000, PENGURANGAN, alasan dari paragraf, COCOK dengan selisih sistem -739.999 (toleransi Rp1)", async () => {
  pages[0] = { text: "", renderCalls: 0 };
  pdfPageCount = 1;
  recognizeCalls = [];
  recognizeResults = [{ text: APRIL_NOISY_OCR_TEXT, confidence: 84 }];
  const ocr = await extractBeritaAcaraTextClient(fakeFile("ba-april.pdf", "application/pdf"), { createCanvas: fakeCanvas });
  assert.equal(ocr.source, "pdf-scanned-ocr");

  const parsed = parseBeritaAcaraText(ocr.text, ocr.confidence);
  assert.equal(parsed.nominal, 740_000);
  assert.equal(parsed.direction, "PENGURANGAN");
  assert.equal(parsed.status, "OK");
  assert.match(parsed.reason ?? "", /Maret/);
  assert.match(parsed.reason ?? "", /April/);

  const matchStatus = matchBeritaAcaraToSystemDifference(-739_999, parsed);
  assert.equal(matchStatus, "COCOK");
});

test("arah BA berlawanan dengan tanda selisih sistem -> TIDAK_COCOK meski nominal identik", async () => {
  pages[0] = { text: "", renderCalls: 0 };
  pdfPageCount = 1;
  recognizeCalls = [];
  recognizeResults = [{ text: MARET_NOISY_OCR_TEXT, confidence: 87 }];
  const ocr = await extractBeritaAcaraTextClient(fakeFile("ba-maret.pdf", "application/pdf"), { createCanvas: fakeCanvas });
  const parsed = parseBeritaAcaraText(ocr.text, ocr.confidence);
  // Selisih sistem NEGATIF tapi BA bilang PENAMBAHAN -> arah salah.
  assert.equal(matchBeritaAcaraToSystemDifference(-740_000, parsed), "TIDAK_COCOK");
});

test("nominal BA berbeda > Rp1 dari selisih sistem -> TIDAK_COCOK", async () => {
  pages[0] = { text: "", renderCalls: 0 };
  pdfPageCount = 1;
  recognizeCalls = [];
  recognizeResults = [{ text: MARET_NOISY_OCR_TEXT, confidence: 87 }];
  const ocr = await extractBeritaAcaraTextClient(fakeFile("ba-maret.pdf", "application/pdf"), { createCanvas: fakeCanvas });
  const parsed = parseBeritaAcaraText(ocr.text, ocr.confidence);
  assert.equal(matchBeritaAcaraToSystemDifference(738_000, parsed), "TIDAK_COCOK");
});

test("OCR gagal (worker.recognize melempar error) -> tidak menebak hasil, error dipropagasi ke caller (UI jatuh ke PERLU REVIEW + fallback manual)", async () => {
  pages[0] = { text: "", renderCalls: 0 };
  pdfPageCount = 1;
  recognizeCalls = [];
  terminateCalls = 0;
  ocrShouldFail = true;
  try {
    await assert.rejects(() => extractBeritaAcaraTextClient(fakeFile("corrupt.pdf", "application/pdf"), { createCanvas: fakeCanvas }));
    assert.equal(terminateCalls, 1, "worker tetap di-terminate walau OCR gagal (tidak leak)");
  } finally {
    ocrShouldFail = false;
  }
});
