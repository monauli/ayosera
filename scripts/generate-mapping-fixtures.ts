// Generate fixture token untuk lib/mapping-parser.test.ts dari PDF ASLI di
// tmp/fixtures/ dan doc export/ (keduanya gitignored, jadi tokennya yang
// di-commit — pola sama dengan lib/__fixtures__/inventory-ba-juli-2026-real-items.json).
//
// Jalankan: npx tsx scripts/generate-mapping-fixtures.ts
//
// CATATAN JALUR SCAN: di browser, extractScanTokens() merender halaman PDF ke
// canvas pada SCAN_RENDER_SCALE (≈302 DPI) lalu OCR. Node tidak punya canvas
// (node-canvas tidak terpasang), jadi generator ini meng-OCR GAMBAR TERTANAM
// di dalam PDF secara langsung. Untuk kelas dokumen ini keduanya setara:
// halaman PDF hasil scan ISINYA persis satu gambar JPEG full-page beresolusi
// 2480x3507 (A4 @300 DPI), jadi render 302 DPI mereproduksi gambar yang sama
// tanpa penskalaan berarti. Bedanya cuma resampling pdf.js.
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { PDFDocument, PDFRawStream, PDFName } from "pdf-lib";
import { createWorker } from "tesseract.js";
import { flattenOcrWords, ocrRowTolerance, DIGITAL_ROW_TOLERANCE, type MappingToken, type TesseractBlockLike } from "../lib/mapping-parser";

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

/** Tarik gambar JPEG full-page yang tertanam di PDF hasil scan, apa adanya. */
function embeddedJpegPages(bytes: Buffer): Promise<Uint8Array[]> {
  return PDFDocument.load(bytes, { ignoreEncryption: true }).then((doc) => {
    const images: Uint8Array[] = [];
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      if (!String(object.dict.get(PDFName.of("Filter"))).includes("DCTDecode")) continue;
      images.push(object.contents);
    }
    return images;
  });
}

async function fromScannedPdf(path: string, name: string): Promise<void> {
  const images = await embeddedJpegPages(readFileSync(path));
  const worker = await createWorker("ind+eng", undefined, { langPath: "public/tesseract/lang", gzip: false });
  try {
    const tokens: MappingToken[] = [];
    const tolerances: number[] = [];
    for (const [index, image] of images.entries()) {
      const { data } = await worker.recognize(Buffer.from(image), {}, { text: false, blocks: true });
      const blocks = data.blocks as TesseractBlockLike[] | null;
      tokens.push(...flattenOcrWords(blocks, index + 1));
      tolerances.push(ocrRowTolerance(blocks));
    }
    tolerances.sort((a, b) => a - b);
    write(name, { source: path, rowTolerance: tolerances[tolerances.length >> 1] ?? 1, tokens });
  } finally {
    await worker.terminate();
  }
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
