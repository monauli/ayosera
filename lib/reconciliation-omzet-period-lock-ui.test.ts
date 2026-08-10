import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/reconciliation/page.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const uploadRoute = readFileSync(new URL("../app/api/reconciliation/court-revenue/[period]/finalization/upload/route.ts", import.meta.url), "utf8");

test("finalization UI requires an attachment, preview, confirmation, and unlock reason", () => {
  assert.match(page, /Upload File/);
  assert.match(page, /Pilih File/);
  assert.match(page, />Simpan</);
  // V6: tombol "Preview Finalisasi" user-facing dihapus total (relabel jadi
  // "Simpan" tanpa melemahkan precondition preview di backend — lihat
  // lib/reconciliation-omzet-period-lock.ts lockOmzetPeriodFinalization).
  assert.doesNotMatch(page, /Preview Finalisasi/);
  assert.doesNotMatch(page, /Upload Berita Acara/);
  assert.match(page, /Berita Acara berhasil diunggah/);
  assert.match(page, /Finalisasi berhasil disimpan\./);
  assert.match(page, /Konfirmasi finalisasi periode/);
  assert.match(page, /Buka Kunci/);
  assert.match(page, /Alasan buka kunci/);
  assert.match(page, /Periode akan dapat diedit dan difinalisasi ulang\. Berita Acara dan histori sebelumnya tidak akan dihapus\./);
  assert.match(page, /PERIODE DIKUNCI/);
  assert.match(page, /Cocok â€” Terkunci/);
  assert.match(page, /Detail Penyesuaian/);
  assert.doesNotMatch(page, /\/court-revenue\/\$\{selectedPeriod\}\/lock/);
});

// V5 regression: "Berita Acara dan Finalisasi" harus menampilkan kontrol
// upload/preview/lock TANPA menunggu attachment sudah ada dulu (bug produksi
// lama: input file, tombol Upload, Nominal final, Alasan penyesuaian, Preview
// Finalisasi, dan Kunci Periode semuanya bersarang di dalam kondisi yang
// mensyaratkan `finalization?.attachment` sudah truthy — sehingga mustahil
// diisi pertama kali karena attachment baru ada SETELAH upload). Sekarang
// gating hanya berdasar status "locked", bukan ada/tidaknya attachment.
test("V5: kontrol finalisasi (input file, upload, nominal, alasan, preview, kunci) muncul untuk periode BELUM terkunci walau belum ada attachment", () => {
  assert.doesNotMatch(page, /\{finalization\?\.attachment && finalization\?\.status !== "locked" && \(/, "root cause lama: gating salah mensyaratkan attachment sebelum menampilkan form upload");
  assert.match(page, /\{finalization\?\.status !== "locked" && \(/);
  assert.match(page, /type="file" accept="\.pdf,\.jpg,\.jpeg,\.png,application\/pdf,image\/jpeg,image\/png"/);
  assert.match(page, /Upload File/);
  assert.match(page, /Nominal final disepakati/);
  assert.match(page, /Alasan penyesuaian/);
  assert.match(page, />Simpan</);
  assert.match(page, />[\s\S]{0,30}Kunci Periode</);
});

// V5: wording lama yang tidak lagi akurat (alur sekarang pakai Berita Acara,
// bukan penjelasan manual bukti-jurnal) tidak boleh muncul lagi, diganti
// bahasa yang menyebut nominal selisih dalam format Rupiah.
test("V5: wording status selisih memakai 'menunggu verifikasi Berita Acara', bukan frasa lama 'bukti jurnal nyata'", () => {
  assert.doesNotMatch(page, /bukti jurnal nyata/);
  const ledger = readFileSync(new URL("./reconciliation-omzet-ledger.ts", import.meta.url), "utf8");
  assert.doesNotMatch(ledger, /belum terbukti dengan bukti jurnal nyata/);
  assert.match(ledger, /menunggu verifikasi Berita Acara/);
});

test("upload route enforces supervisor authorization and server-side validation", () => {
  assert.match(uploadRoute, /requireSupervisor/);
  assert.match(uploadRoute, /validateOmzetPeriodLockAttachment\(file\)/);
});

test("detail reconciliation stays compact: desktop 2+1 grid, accessible disclosures, and mobile single column", () => {
  assert.match(page, /className=\{`recon-sport-card\$\{wide \? " recon-sport-card-wide" : ""\}`\}/);
  assert.match(page, /title="COURT"/); assert.match(page, /title="PICKLEBALL"/); assert.match(page, /title="TOTAL GABUNGAN"/);
  assert.match(page, /Omzet AYO Court/); assert.match(page, /Olsera akun 40001/); assert.match(page, /Omzet AYO Pickleball/); assert.match(page, /Olsera akun 40004/); assert.match(page, /Selisih \(Olsera - AYO\)/); assert.match(page, /Status/);
  // V5: "Verifikasi Reklasifikasi" dihapus dari render UI (lihat
  // reconciliation-phase5d-ui.test.ts) — backend/data tetap ada, hanya tidak dirender.
  assert.doesNotMatch(page, /<CollapsibleSection title="Verifikasi Reklasifikasi">/);
  assert.match(page, /<CollapsibleSection title="Berita Acara dan Finalisasi">/);
  assert.match(page, /AYO Belum Terpetakan/);
  assert.match(page, /aria-expanded=\{open\}/); assert.match(page, /aria-controls=\{contentId\}/);
  assert.match(page, /recon-lock-summary/);
  assert.match(styles, /\.recon-sport-sections\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.recon-sport-card-wide\{grid-column:1 \/ -1\}/);
  assert.match(styles, /@media \(max-width:720px\)\{\.recon-sport-sections\{grid-template-columns:1fr!important\}/);
});
