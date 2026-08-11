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

// ---------------------------------------------------------------------------
// V7: root cause fix regression — upload sukses harus otomatis memicu
// analisis (Goal 3), preview PDF/gambar harus dirender (Goal 2), dan hasil
// analisis harus benar-benar dipakai untuk auto-fill (Goal 6/7), bukan cuma
// disimpan ke state yang tidak pernah dibaca render. Ini melengkapi test
// EXECUTABLE di lib/reconciliation-berita-acara-ui.test.ts (logika murni)
// dan lib/csp.test.ts (root cause CSP sungguhan) — test string di sini
// mengunci WIRING-nya benar-benar terpasang di JSX/handler.
// ---------------------------------------------------------------------------
test("V7: upload sukses memicu analyzeFileClient otomatis TANPA klik kedua (Goal 3)", () => {
  assert.match(page, /setUploadSuccessMessage\("Berita Acara berhasil diunggah"\);\s*void analyzeFileClient\(uploadedFile\)/);
});

test("V7: preview Berita Acara (PDF via iframe, gambar via img) dirender begitu attachment ada, lepas dari status lock/OCR (Goal 2/10)", () => {
  assert.match(page, /\{finalization\?\.attachment && <BeritaAcaraPreview key=\{finalization\.attachment\.url\} attachment=\{finalization\.attachment\} \/>\}/);
  assert.match(page, /function BeritaAcaraPreview/);
  assert.match(page, /<iframe src=\{attachment\.url\}/);
  assert.match(page, /<img src=\{attachment\.url\}/);
  assert.match(page, />\s*Buka File/);
  assert.match(styles, /\.recon-ba-preview-frame-wrap/);
  assert.match(styles, /\.recon-ba-preview-image-wrap/);
});

// ---------------------------------------------------------------------------
// V8: metadata panjang dihapus, preview bisa minimize, "Riwayat Aktivitas"
// (bukan raw actor id) — lihat lib/reconciliation-actor-display.ts untuk
// resolusi id->nama server-side, lib/reconciliation-berita-acara-ui.ts untuk
// formatPeriodLockHistoryLine (kalimat manusiawi).
// ---------------------------------------------------------------------------

test("V8 Goal 1: metadata attachment mentah (nama file + ukuran + tanggal + raw actor id, dulu di atas preview) TIDAK LAGI dirender", () => {
  assert.doesNotMatch(page, /\{finalization\.attachment\.fileName\} \(\{Math\.ceil\(finalization\.attachment\.size/, "baris metadata lama masih ada");
  assert.doesNotMatch(page, /diunggah \{dateTimeLabel\(finalization\.attachment\.uploadedAt\)\} oleh \{finalization\.attachment\.uploadedBy\}/);
});

test("V8 Goal 2: Preview Berita Acara punya toggle minimize/expand (state lokal, reset ke terbuka lewat key={attachment.url} saat upload baru)", () => {
  assert.match(page, /const \[open, setOpen\] = useState\(true\);/);
  assert.match(page, /aria-expanded=\{open\}/);
  assert.match(page, /Minimize/);
  assert.match(page, /onClick=\{\(\) => setOpen\(\(value\) => !value\)\}/);
});

test("V8 Goal 3: label 'Riwayat Aktivitas' (bukan 'Riwayat audit'), memakai formatPeriodLockHistoryLine + actorName/lockedByName (bukan raw actor/lockedBy)", () => {
  assert.doesNotMatch(page, /Riwayat audit/i);
  assert.match(page, /Riwayat Aktivitas/);
  assert.match(page, /formatPeriodLockHistoryLine\(item\)/);
  assert.match(page, /\{finalization\.lockedByName\}/);
  assert.doesNotMatch(page, /Dikunci oleh \{finalization\.lockedBy\}/);
  // Alasan buka kunci ditampilkan di baris riwayat unlock.
  assert.match(page, /\{line\.reason && <small>Alasan: \{line\.reason\}<\/small>\}/);
});

test("V8: PeriodLock type membawa *Name yang sudah diresolve server (uploadedByName/lockedByName/unlockedByName/history[].actorName), bukan hanya raw id", () => {
  assert.match(page, /uploadedByName: string/);
  assert.match(page, /lockedByName: string/);
  assert.match(page, /unlockedByName: string/);
  assert.match(page, /actorName: string/);
});

test("V7: 3 kartu hasil (Selisih Sistem/Nominal Berita Acara/Hasil Pencocokan) dirender dari state `analysis`, reuse recon-badge (bukan warna baru) (Goal 4)", () => {
  assert.match(page, /\{analysis && <BeritaAcaraResultCards analysis=\{analysis\} \/>\}/);
  assert.match(page, /function BeritaAcaraResultCards/);
  assert.match(page, /Selisih Sistem/);
  assert.match(page, /Nominal Berita Acara/);
  assert.match(page, /Hasil Pencocokan/);
  assert.match(page, /recon-badge recon-badge-\$\{cards\.matchTone\}/);
});

test("V7: hasil analisis (nominal final + alasan) benar-benar diterapkan ke state lewat applyAnalysisResult, bukan cuma disimpan tanpa dipakai (Goal 6/7)", () => {
  assert.match(page, /const applyAnalysisResult = \(result: BeritaAcaraAnalysis, originalOlseraAmount: number\) => \{/);
  assert.match(page, /nextReasonAfterAnalysis\(\{ current, userEdited: reasonEditedByUser, parsedReason: result\.reason \}\)/);
  assert.match(page, /computeAutoFinalAgreedAmount\(\{ originalOlseraAmount, analysis: result \}\)/);
  assert.match(page, /applyAnalysisResult\(data\.data as BeritaAcaraAnalysis, originalOlseraAmount\)/);
  assert.match(page, /applyAnalysisResult\(result, detail\?\.olseraTotal \?\? 0\)/);
});

test("V7: edit manual alasan dilacak (reasonEditedByUser) dan direset saat dokumen/periode baru (Goal 6/CRITICAL)", () => {
  assert.match(page, /const \[reasonEditedByUser, setReasonEditedByUser\] = useState\(false\);/);
  assert.match(page, /setFinalReason\(event\.target\.value\); setReasonEditedByUser\(true\)/);
  assert.match(page, /setReasonEditedByUser\(false\);\s*try \{ const uploadedFile = finalFile;/);
  assert.match(page, /setReasonEditedByUser\(false\);\s*try \{\s*const response = await fetch\(`\/api\/reconciliation\/court-revenue\/\$\{period\}`/);
});

test("V7: gating Simpan/Kunci memakai fungsi murni yang bisa dites (canSaveBeritaAcaraFinalization/canLockAfterSave), bukan kondisi ad-hoc di JSX (Goal 8/9)", () => {
  assert.match(page, /disabled=\{!canSaveFinalization\}/);
  assert.match(page, /disabled=\{!canLockFinalization\}/);
  assert.match(page, /const canSaveFinalization = canSaveBeritaAcaraFinalization\(/);
  assert.match(page, /const canLockFinalization = canLockAfterSave\(/);
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
