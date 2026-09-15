// Generate fixture token untuk lib/mapping-parser.test.ts dari PDF ASLI di
// tmp/fixtures/ dan doc export/ (keduanya gitignored, jadi tokennya yang
// di-commit — pola sama dengan lib/__fixtures__/inventory-ba-juli-2026-real-items.json).
//
// Jalankan: npx tsx scripts/generate-mapping-fixtures.ts
//
// CATATAN JALUR SCAN: generator ini menjalankan OCR di Chrome sungguhan dengan
// aset browser production yang sama (core LSTM non-SIMD, worker, dan bahasa).
// Ini memakai playwright-core yang sudah ada di devDependencies; tidak ada
// browser/dependency baru yang diunduh oleh generator.
import { createServer } from "node:http";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { extractEmbeddedJpegPages, flattenOcrWords, ocrRowTolerance, DIGITAL_ROW_TOLERANCE, type MappingToken, type TesseractBlockLike } from "../lib/mapping-parser";
import { TESSERACT_ASSET_OPTIONS } from "../lib/reconciliation-berita-acara-client-ocr";

const OUT_DIR = "lib/__fixtures__";

type Fixture = { source: string; rowTolerance: number; tokens: MappingToken[] };

function write(name: string, fixture: Fixture): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/${name}.json`, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`${OUT_DIR}/${name}.json  tokens=${fixture.tokens.length} rowTolerance=${fixture.rowTolerance}`);
}

async function fromDigitalPdf(path: string, name: string): Promise<void> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const tokens: MappingToken[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    const content = await (await doc.getPage(page)).getTextContent();
    for (const item of content.items as { str?: string; transform?: number[] }[]) {
      const text = item.str?.trim();
      if (!text || !item.transform) continue;
      // Y dibalik supaya membesar ke bawah, sama seperti extractDigitalTokens().
      tokens.push({ text, x: item.transform[4], y: -item.transform[5], page });
    }
  }
  write(name, { source: path, rowTolerance: DIGITAL_ROW_TOLERANCE, tokens });
}

type BrowserWorker = {
  recognize: (image: Blob, params: Record<string, never>, output: { text: boolean; blocks: boolean }) => Promise<{ data: { blocks: unknown } }>;
  terminate: () => Promise<void>;
};

type BrowserTesseract = {
  createWorker: (langs: string, oem: undefined, options: typeof TESSERACT_ASSET_OPTIONS) => Promise<BrowserWorker>;
};

/** Jalankan OCR lewat browser production, bukan worker Node yang auto-pilih SIMD. */
async function ocrInChrome(images: readonly Uint8Array[]): Promise<(TesseractBlockLike[] | null)[]> {
  const assets = new Map<string, { body: Buffer; contentType: string }>([
    ["/tesseract.js", { body: readFileSync("node_modules/tesseract.js/dist/tesseract.min.js"), contentType: "application/javascript" }],
    ["/tesseract/worker.min.js", { body: readFileSync("public/tesseract/worker.min.js"), contentType: "application/javascript" }],
    ["/tesseract/tesseract-core-lstm.wasm.js", { body: readFileSync("public/tesseract/tesseract-core-lstm.wasm.js"), contentType: "application/javascript" }],
    ["/tesseract/lang/ind.traineddata", { body: readFileSync("public/tesseract/lang/ind.traineddata"), contentType: "application/octet-stream" }],
    ["/tesseract/lang/eng.traineddata", { body: readFileSync("public/tesseract/lang/eng.traineddata"), contentType: "application/octet-stream" }],
    ...images.map((image, index) => [`/images/${index + 1}.jpg`, { body: Buffer.from(image), contentType: "image/jpeg" }] as const),
  ]);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><script src=\"/tesseract.js\"></script>");
      return;
    }
    const asset = assets.get(pathname);
    if (!asset) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": asset.contentType, "cache-control": "no-store" });
    response.end(asset.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server OCR lokal gagal mendapatkan port.");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "load" });
    const result = await page.evaluate(async ({ imageCount, assetOptions }) => {
      const tesseract = (window as unknown as { Tesseract: BrowserTesseract }).Tesseract;
      const worker = await tesseract.createWorker("ind+eng", undefined, assetOptions);
      try {
        const blocks: unknown[] = [];
        for (let index = 1; index <= imageCount; index++) {
          const response = await fetch(`/images/${index}.jpg`);
          if (!response.ok) throw new Error(`Gambar OCR ${index} gagal dimuat (${response.status}).`);
          const recognized = await worker.recognize(await response.blob(), {}, { text: true, blocks: true });
          blocks.push(recognized.data.blocks);
        }
        return blocks;
      } finally {
        await worker.terminate();
      }
    }, { imageCount: images.length, assetOptions: TESSERACT_ASSET_OPTIONS });
    return result as (TesseractBlockLike[] | null)[];
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function fromScannedPdf(path: string, name: string): Promise<void> {
  const pages = await extractEmbeddedJpegPages(new Uint8Array(readFileSync(path)));
  if (pages.some((page) => page === null)) throw new Error(`${path}: tidak semua halaman berupa JPEG full-page yang bisa dipakai fixture.`);
  const blocksByPage = await ocrInChrome(pages.map((page) => page!.data));
  const tokens: MappingToken[] = [];
  const tolerances: number[] = [];
  for (const [index, blocks] of blocksByPage.entries()) {
    tokens.push(...flattenOcrWords(blocks, index + 1));
    tolerances.push(ocrRowTolerance(blocks));
  }
  tolerances.sort((a, b) => a - b);
  write(name, { source: path, rowTolerance: tolerances[tolerances.length >> 1] ?? 1, tokens });
}

/** Model sheet Excel (label + tebal + nilai per kolom), lewat pembaca produksi. */
async function fromWorkbook(path: string, name: string): Promise<void> {
  const { readFinancialWorkbook } = await import("../lib/mapping-excel-parser");
  const sheets = await readFinancialWorkbook(readFileSync(path));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/${name}.json`, `${JSON.stringify({ source: path, sheets }, null, 1)}\n`);
  console.log(`${OUT_DIR}/${name}.json  sheets=${sheets.map((s) => `${s.name} (${s.kind}, ${s.rows.length} baris)`).join(", ")}`);
}

async function main(): Promise<void> {
  await fromScannedPdf("tmp/fixtures/Laporan Keuangan 0226.pdf", "mapping-laba-rugi-feb-2026-scan");
  await fromDigitalPdf("doc export/Laporan Laba Rugi-Mei-2026.pdf", "mapping-laba-rugi-mei-2026-digital");
  await fromWorkbook("tmp/fixtures/NEW - Laporan Keuangan Batam City Padel.xlsx", "mapping-laporan-keuangan-excel");
}

void main();
