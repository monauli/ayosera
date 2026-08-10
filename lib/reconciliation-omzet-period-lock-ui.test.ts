import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/reconciliation/page.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const uploadRoute = readFileSync(new URL("../app/api/reconciliation/court-revenue/[period]/finalization/upload/route.ts", import.meta.url), "utf8");

test("finalization UI requires an attachment, preview, confirmation, and unlock reason", () => {
  assert.match(page, /Upload Berita Acara/);
  assert.match(page, /Preview Finalisasi/);
  assert.match(page, /Konfirmasi finalisasi periode/);
  assert.match(page, /Buka Kunci/);
  assert.match(page, /Alasan buka kunci/);
  assert.match(page, /Periode akan dapat diedit dan difinalisasi ulang\. Berita Acara dan histori sebelumnya tidak akan dihapus\./);
  assert.match(page, /PERIODE DIKUNCI/);
  assert.match(page, /Cocok â€” Terkunci/);
  assert.match(page, /Detail Penyesuaian/);
  assert.doesNotMatch(page, /\/court-revenue\/\$\{selectedPeriod\}\/lock/);
});

test("upload route enforces supervisor authorization and server-side validation", () => {
  assert.match(uploadRoute, /requireSupervisor/);
  assert.match(uploadRoute, /validateOmzetPeriodLockAttachment\(file\)/);
});

test("detail reconciliation stays compact: desktop 2+1 grid, accessible disclosures, and mobile single column", () => {
  assert.match(page, /className=\{`recon-sport-card\$\{wide \? " recon-sport-card-wide" : ""\}`\}/);
  assert.match(page, /title="COURT"/); assert.match(page, /title="PICKLEBALL"/); assert.match(page, /title="TOTAL GABUNGAN"/);
  assert.match(page, /Omzet AYO Court/); assert.match(page, /Olsera akun 40001/); assert.match(page, /Omzet AYO Pickleball/); assert.match(page, /Olsera akun 40004/); assert.match(page, /Selisih \(Olsera - AYO\)/); assert.match(page, /Status/);
  assert.match(page, /<CollapsibleSection title="Verifikasi Reklasifikasi">/);
  assert.match(page, /<CollapsibleSection title="Berita Acara dan Finalisasi">/);
  assert.match(page, /AYO Belum Terpetakan/);
  assert.match(page, /aria-expanded=\{open\}/); assert.match(page, /aria-controls=\{contentId\}/);
  assert.match(page, /recon-lock-summary/);
  assert.match(styles, /\.recon-sport-sections\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.recon-sport-card-wide\{grid-column:1 \/ -1\}/);
  assert.match(styles, /@media \(max-width:720px\)\{\.recon-sport-sections\{grid-template-columns:1fr!important\}/);
});
