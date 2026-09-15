import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("browser PDF parsers use the compatibility PDF.js build", () => {
  for (const file of ["lib/mapping-parser.ts", "lib/reconciliation-berita-acara-client-ocr.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /import\("pdfjs-dist\/legacy\/build\/pdf\.mjs"\)/, file);
    assert.doesNotMatch(source, /import\("pdfjs-dist"\)/, file);
    assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs/, file);
  }
});
