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
  assert.match(page, /nextReasonAfterAnalysis\(\{ current, userEdited: reasonEditedByUserRef\.current, parsedReason: result\.reason \}\)/);
  assert.match(page, /computeAutoFinalAgreedAmount\(\{ originalOlseraAmount, analysis: result \}\)/);
  assert.match(page, /applyAnalysisResult\(data\.data as BeritaAcaraAnalysis, originalOlseraAmount\)/);
  assert.match(page, /applyAnalysisResult\(result, detail\?\.olseraTotal \?\? 0\)/);
});

test("V7/V9: edit manual alasan dilacak (reasonEditedByUserRef) dan direset saat dokumen/periode baru (Goal 6/CRITICAL) — ref, bukan state (root cause V9)", () => {
  assert.match(page, /const reasonEditedByUserRef = useRef\(false\);/);
  assert.match(page, /setFinalReason\(event\.target\.value\); reasonEditedByUserRef\.current = true/);
  // Reset HARUS terjadi SEBELUM upload/OCR baru dimulai (siklus analisis baru).
  assert.match(page, /reasonEditedByUserRef\.current = false;\s*\n\s*try \{ const uploadedFile = finalFile;/);
  assert.match(page, /setFinalReason\(""\);[\s\S]{0,400}reasonEditedByUserRef\.current = false;/, "reset di openDetail harus ada sebelum analyzeAttachment dipanggil");
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

// ---------------------------------------------------------------------------
// V9 Goal ROOT CAUSE: reasonEditedByUser HARUS `useRef` (dibaca live di dalam
// closure async setelah OCR selesai), BUKAN `useState` (nilai basi lewat
// closure — root cause "alasan penyesuaian tetap kosong" V9, lihat komentar
// panjang di app/reconciliation/page.tsx tepat di atas deklarasinya). Kalau
// ini regresi balik ke useState, bug lama kembali: reset ke false via
// setReasonEditedByUser(false) di openDetail/uploadFinalAttachment tidak
// pernah terlihat oleh applyAnalysisResult yang closure-nya sudah terikat ke
// render sebelum reset itu di-flush.
// ---------------------------------------------------------------------------
test("V9 ROOT CAUSE: reasonEditedByUser adalah useRef (bukan useState) — mencegah closure basi yang membuat alasan auto-fill gagal", () => {
  assert.match(page, /const reasonEditedByUserRef = useRef\(false\);/);
  assert.doesNotMatch(page, /const \[reasonEditedByUser, setReasonEditedByUser\] = useState\(false\);/, "regresi ke useState -> closure basi, root cause V9 kembali");
  // Reset (openDetail, uploadFinalAttachment) dan tulis (onChange textarea)
  // HARUS langsung menulis .current (synchronous), bukan lewat setState.
  assert.match(page, /reasonEditedByUserRef\.current = false;/);
  assert.match(page, /reasonEditedByUserRef\.current = true;/);
  // applyAnalysisResult HARUS membaca .current (live), bukan variabel state basi.
  assert.match(page, /userEdited: reasonEditedByUserRef\.current, parsedReason: result\.reason/);
});

// ---------------------------------------------------------------------------
// V9 Goal 1: card "Nominal Berita Acara" TIDAK bertanda +/- (beda dari
// "Selisih Sistem" yang tetap bertanda) — lihat
// lib/reconciliation-berita-acara-ui.test.ts untuk test logika murninya;
// test di sini mengunci WIRING label kartu di JSX tidak berubah nama/urutan.
// ---------------------------------------------------------------------------
test("V9 Goal 1: kartu 'Nominal Berita Acara' memakai cards.nominalBeritaAcaraLabel (sumber kebenaran tunggal, tanpa tanda dihitung di lib)", () => {
  assert.match(page, /<span>Nominal Berita Acara<\/span>\s*<b>\{cards\.nominalBeritaAcaraLabel\}<\/b>/);
});

// ---------------------------------------------------------------------------
// V9 Goal 6: tombol Simpan HARUS mengirim finalReason (state textarea) apa
// adanya, dan refresh (openDetail) HARUS memuat ulang adjustmentReason dari
// server — memastikan alasan yang terlihat di textarea benar-benar yang
// tersimpan dan bertahan setelah reload.
// ---------------------------------------------------------------------------
test("V9 Goal 6: Simpan (previewFinalization) mengirim adjustmentReason: finalReason; openDetail memuat ulang adjustmentReason tersimpan setelah refresh", () => {
  assert.match(page, /adjustmentReason: finalReason/);
  assert.match(page, /setFinalReason\(data\.data\.periodLock\?\.adjustmentReason \?\?/);
});

// ---------------------------------------------------------------------------
// V10 Goal 1/2/7: status "Cocok karena Berita Acara" begitu Simpan sukses
// (tanpa menunggu Kunci Periode), icon/badge terpisah dari badge locked,
// beritaAcaraVerified diturunkan dari `finalization` (live, bukan snapshot
// detail) supaya update instan tanpa refetch.
// ---------------------------------------------------------------------------
test("V10 Goal 1/7: beritaAcaraVerified diturunkan dari finalization.status !== 'locked' && finalization.verifiedMatchStatus === 'COCOK' (live, update instan setelah Simpan)", () => {
  assert.match(page, /const beritaAcaraVerified = Boolean\(finalization && \(finalization\.status === "locked" \|\| finalization\.verifiedMatchStatus === "COCOK"\)\);/);
});

test("V10 Goal 2 / V11 Goal 6/7: badge 'Berita Acara' (BeritaAcaraVerifiedBadge, icon FileCheck) dirender di tabel utama TERPISAH dari badge 'Cocok — Terkunci' (locked tidak berubah), klik badge membuka preview (BUKAN Detail) HANYA saat attachment ada", () => {
  assert.match(page, /function BeritaAcaraVerifiedBadge\(\{ onClick \}: \{ onClick\?: \(event: MouseEvent\) => void \} = \{\}\)/);
  assert.match(page, /title="Selisih telah diverifikasi dengan Berita Acara — klik untuk preview dokumen"/);
  assert.match(page, /<FileCheck size=\{12\} \/> Berita Acara/);
  // Kedua baris tabel (desktop + mobile) memakai badge baru sebagai fallback SEBELUM LockBadge lama, TIDAK menggantikan badge locked yang sudah ada, DAN mensyaratkan attachment ada (Goal 7: jangan badge palsu) sebelum onClick dipasang.
  assert.match(page, /row\.periodLock\?\.status === "locked" \? <span className="recon-badge recon-badge-ok" title="Detail Penyesuaian"><Lock size=\{12\} \/> Cocok — Terkunci · Detail Penyesuaian<\/span> : row\.beritaAcaraVerified && row\.periodLock\?\.attachment \? <BeritaAcaraVerifiedBadge onClick=\{\(event\) => \{ event\.stopPropagation\(\); setQuickPreviewAttachment\(row\.periodLock!\.attachment\); \}\} \/> : row\.explanation\?\.locked && <LockBadge \/>/);
  assert.match(page, /row\.periodLock\?\.status === "locked" \? <span className="recon-badge recon-badge-ok" title="Detail Penyesuaian"><Lock size=\{12\} \/> Cocok — Terkunci<\/span> : row\.beritaAcaraVerified && row\.periodLock\?\.attachment \? <BeritaAcaraVerifiedBadge onClick=\{\(event\) => \{ event\.stopPropagation\(\); setQuickPreviewAttachment\(row\.periodLock!\.attachment\); \}\} \/> : row\.explanation\?\.locked && <LockBadge \/>/);
});

test("V10 Goal 3/9: status tabel utama memakai reconciliationOmzetUiStatus(row.status, row.differenceRevenue, row.beritaAcaraVerified) — selisih (row.differenceRevenue) TIDAK PERNAH ditimpa/dinolkan di sini", () => {
  assert.match(page, /reconciliationOmzetUiStatus\(row\.status, row\.differenceRevenue, row\.beritaAcaraVerified\)/);
  assert.doesNotMatch(page, /row\.differenceRevenue = 0/);
});

test("V10 Goal 6: wording detail 'menunggu verifikasi' -> 'telah diverifikasi' HANYA saat beritaAcaraVerified true, selisih asli (detail.differenceRevenue) tetap dipakai di kalimatnya", () => {
  assert.match(page, /\{beritaAcaraVerified \? `Selisih \$\{formatRupiah\(detail\.differenceRevenue\)\} telah diverifikasi dengan Berita Acara\.` : detail\.statusReason\}/);
});

test("V10 Goal 7: banner 'Cocok — Selisih telah diverifikasi' muncul begitu Simpan sukses (beritaAcaraVerified), TIDAK menunggu Kunci Periode (terpisah dari banner locked)", () => {
  assert.match(page, /\{beritaAcaraVerified && <p className="recon-lock-summary"><FileCheck size=\{14\} \/> Cocok — Selisih telah diverifikasi dengan Berita Acara\.<\/p>\}/);
});

test("V10 Goal 7: Simpan (previewFinalization) mengirim beritaAcaraNominal/beritaAcaraDirection dari hasil analisis OCR, dan me-refresh tabel utama (await refresh()) supaya status/icon langsung ter-update", () => {
  assert.match(page, /beritaAcaraNominal: analysis\?\.nominal \?\? null, beritaAcaraDirection: analysis\?\.direction \?\? null/);
  assert.match(page, /setFinalSaveMessage\("Finalisasi berhasil disimpan\."\);[\s\S]{0,300}await refresh\(\);/);
});

// ---------------------------------------------------------------------------
// V10 Goal 9-13: "Bersihkan Riwayat Upload" — supervisor-only, tombol kecil,
// confirmation persis sesuai instruksi, raw actor id TIDAK PERNAH dirender.
// ---------------------------------------------------------------------------
test("V10 Goal 9/13: tombol 'Bersihkan Riwayat Upload' HANYA muncul untuk supervisor DAN >1 entri upload, style recon-link (tidak dominan)", () => {
  assert.match(page, /\{supervisor && finalization\.history\.filter\(\(item\) => item\.action === "upload"\)\.length > 1 && \(/);
  assert.match(page, /<button type="button" className="recon-link" disabled=\{cleanupBusy\} onClick=\{\(\) => setShowCleanupConfirm\(true\)\}>\s*Bersihkan Riwayat Upload/);
});

test("V10 Goal 11: teks konfirmasi cleanup PERSIS sesuai instruksi (menyebut Simpan/Kunci/Buka Kunci tidak akan dihapus)", () => {
  assert.match(page, /Hapus riwayat upload lama\/duplikat\? Riwayat Simpan, Kunci, dan Buka Kunci tidak akan dihapus\./);
});

test("V10 Goal 9: cleanupUploadHistory memanggil endpoint cleanup-upload-history dengan version finalization saat ini", () => {
  assert.match(page, /const cleanupUploadHistory = async \(\) => \{/);
  assert.match(page, /finalizationRequest\("cleanup-upload-history", \{ method: "POST", headers: \{ "Content-Type": "application\/json" \}, body: JSON\.stringify\(\{ version: finalization\.version \}\) \}\)/);
});

test("V10: tombol cleanup TIDAK menampilkan raw actor id di mana pun — pola raw id lama ({item.actor}/{history.actor}) tidak ada", () => {
  assert.doesNotMatch(page, /\{item\.actor\}/);
  assert.doesNotMatch(page, /Bersihkan.*\{.*\.actor\}/);
});

// ---------------------------------------------------------------------------
// V11 Goal 1/2/12: kartu COURT/PICKLEBALL di detail drawer sekarang JUGA
// menerima finalStatus/beritaAcaraVerified dari componentVerified — bukan
// hanya TOTAL GABUNGAN seperti V10 — supaya tidak ada campuran TOTAL Cocok
// tapi PICKLEBALL Perlu Dicek untuk selisih yang sama yang sudah
// diverifikasi BA.
// ---------------------------------------------------------------------------
test("V11 Goal 1/2: componentVerified diturunkan dari resolveBeritaAcaraVerifiedComponent(detail.sportReconciliation, beritaAcaraVerified)", () => {
  assert.match(page, /const componentVerified = detail \? resolveBeritaAcaraVerifiedComponent\(detail\.sportReconciliation, beritaAcaraVerified\) : \{ court: false, pickleball: false \};/);
});

test("V11 Goal 1/2/12: kartu COURT dan PICKLEBALL memakai finalStatus/beritaAcaraVerified dari componentVerified (bukan hanya comparison.status mentah)", () => {
  assert.match(page, /<SportReconciliationCard title="COURT" ayoLabel="Omzet AYO Court" olseraLabel="Olsera akun 40001" comparison=\{detail\.sportReconciliation\.court\} finalStatus=\{componentVerified\.court \? "COCOK" : undefined\} beritaAcaraVerified=\{componentVerified\.court\} \/>/);
  assert.match(page, /<SportReconciliationCard title="PICKLEBALL" ayoLabel="Omzet AYO Pickleball" olseraLabel="Olsera akun 40004" comparison=\{detail\.sportReconciliation\.pickleball\} finalStatus=\{componentVerified\.pickleball \? "COCOK" : undefined\} beritaAcaraVerified=\{componentVerified\.pickleball\} \/>/);
});

test("V11: kartu TOTAL GABUNGAN juga mengirim beritaAcaraVerified={beritaAcaraVerified} ke SportReconciliationCard (badge 'Berita Acara' ikut tampil di kartu TOTAL, bukan hanya lewat banner terpisah)", () => {
  assert.match(page, /finalStatus=\{reconciliationOmzetUiStatus\(detail\.status, detail\.differenceRevenue, beritaAcaraVerified\)\}\s*beritaAcaraVerified=\{beritaAcaraVerified\}/);
});

test("V11: SportReconciliationCard merender BeritaAcaraVerifiedBadge (tanpa onClick) saat beritaAcaraVerified true DAN tidak locked — locked tetap prioritas seperti V10", () => {
  assert.match(page, /locked \? <span className="recon-badge recon-badge-ok"><Lock size=\{12\} \/> Cocok — Terkunci<\/span> : beritaAcaraVerified && <BeritaAcaraVerifiedBadge \/>/);
});

// ---------------------------------------------------------------------------
// V11 Goal 3/4/5: RESTORE LAST SAVED STATE — reopen detail TIDAK PERNAH
// menjalankan OCR ulang kalau hasil Simpan terakhir sudah tersimpan (root
// cause masalah #2 V11: server tidak bisa merasterisasi PDF hasil scan,
// sehingga re-analyze otomatis menimpa hasil COCOK tersimpan dengan
// PERLU_REVIEW/"Tidak terbaca" palsu).
// ---------------------------------------------------------------------------
test("V11 Goal 3/4/5: openDetail hydrate dari restoreBeritaAcaraAnalysisFromLock (via applyAnalysisResult) saat hasSavedBeritaAcaraAnalysis true, HANYA jalankan analyzeAttachment (OCR ulang) kalau belum pernah ada hasil tersimpan", () => {
  assert.match(page, /if \(hasSavedBeritaAcaraAnalysis\(data\.data\.periodLock\)\) \{\s*applyAnalysisResult\(restoreBeritaAcaraAnalysisFromLock\(data\.data\.periodLock, data\.data\.differenceRevenue\), data\.data\.olseraTotal\);\s*\} else \{\s*void analyzeAttachment\(period, data\.data\.olseraTotal\);\s*\}/);
});

// ---------------------------------------------------------------------------
// V11 Goal 6/7: badge Berita Acara di tabel utama clickable -> modal preview
// ringan (bukan Detail). Mobile card TIDAK LAGI <button> (supaya badge di
// dalamnya bisa jadi <button> sungguhan tanpa nested-button-in-button).
// ---------------------------------------------------------------------------
test("V11 Goal 6/7: BeritaAcaraQuickPreviewModal dirender top-level (terpisah dari drawer selectedPeriod), pakai resolveBeritaAcaraPreviewKind yang sama seperti BeritaAcaraPreview", () => {
  assert.match(page, /function BeritaAcaraQuickPreviewModal\(\{ attachment, onClose \}: \{ attachment: NonNullable<PeriodLock\["attachment"\]>; onClose: \(\) => void \}\)/);
  assert.match(page, /\{quickPreviewAttachment && <BeritaAcaraQuickPreviewModal attachment=\{quickPreviewAttachment\} onClose=\{\(\) => setQuickPreviewAttachment\(null\)\} \/>\}/);
  assert.match(page, /const kind = resolveBeritaAcaraPreviewKind\(attachment\.mimeType\);/);
});

test("V11 Goal 6: modal preview punya tombol 'Tutup' dan 'Buka File'", () => {
  assert.match(page, />\s*Tutup\s*</);
  assert.match(page, /<ExternalLink size=\{12\} \/> Buka File/);
});

test("V11 Goal 6: mobile card BUKAN <button> lagi (mencegah <button> BeritaAcaraVerifiedBadge nested di dalam <button> lain — invalid HTML) — pakai role=\"button\" + onKeyDown untuk tetap aksesibel via keyboard", () => {
  assert.doesNotMatch(page, /<button key=\{row\.period\} className="recon-mobile-card"/, "regresi ke <button> akan membuat badge BA di dalamnya jadi nested button (invalid)");
  assert.match(page, /role="button"\s*tabIndex=\{0\}\s*className="recon-mobile-card"/);
  assert.match(page, /onKeyDown=\{\(event\) => \{ if \(event\.key === "Enter" \|\| event\.key === " "\) \{ event\.preventDefault\(\); void openDetail\(row\.period\); \} \}\}/);
});

// ---------------------------------------------------------------------------
// V11 Goal 8-11: "×" per-item pada Riwayat Aktivitas — supervisor-only, soft
// delete (isHistoryEntryVisible menyaring render, TIDAK menghapus data),
// index yang dikirim ke backend HARUS index array mentah (originalIndex),
// bukan index tampilan yang sudah difilter/dibalik.
// ---------------------------------------------------------------------------
test("V11 Goal 8/9: daftar riwayat disaring lewat isHistoryEntryVisible SEBELUM reverse, originalIndex (bukan index tampilan) dikirim ke hideHistoryEntry", () => {
  assert.match(page, /\.map\(\(item, originalIndex\) => \(\{ item, originalIndex \}\)\)\s*\.filter\(\(\{ item \}\) => isHistoryEntryVisible\(item\)\)\s*\.slice\(\)\s*\.reverse\(\)/);
  assert.match(page, /onClick=\{\(\) => void hideHistoryEntry\(originalIndex\)\}/);
  assert.match(page, /onClick=\{\(\) => setHideConfirmIndex\(originalIndex\)\}/);
});

test("V11 Goal 8/10: icon × ('X' dari lucide-react) HANYA dirender untuk supervisor — normal user tidak melihatnya sama sekali", () => {
  assert.match(page, /\{supervisor &&\s*\(hideConfirmIndex === originalIndex \? \(/);
  assert.match(page, /<X size=\{12\} \/>/);
});

test("V11 Goal 8: hideHistoryEntry memanggil endpoint hide-history-entry dengan version DAN entryIndex, lalu reopen detail supaya persisten di UI", () => {
  assert.match(page, /const hideHistoryEntry = async \(entryIndex: number\) => \{/);
  assert.match(page, /finalizationRequest\("hide-history-entry", \{ method: "POST", headers: \{ "Content-Type": "application\/json" \}, body: JSON\.stringify\(\{ version: finalization\.version, entryIndex \}\) \}\)/);
  assert.match(page, /setHideConfirmIndex\(null\); if \(selectedPeriod\) await openDetail\(selectedPeriod\);/);
});

test("V11 Goal 9: TIDAK ADA hard-delete pola (mis. .filter/.splice menghapus entri history) dipicu oleh hide — hanya memanggil endpoint hide-history-entry lalu reopen (server yang soft-delete)", () => {
  assert.doesNotMatch(page, /history\.splice/);
  assert.doesNotMatch(page, /setFinalization\([\s\S]{0,80}history: finalization\.history\.filter/);
});

test("V11: hide TIDAK PERNAH menampilkan raw actor id — pola {item.actor} tidak dipakai di baris riwayat mana pun (masih actorName/formatPeriodLockHistoryLine seperti V8)", () => {
  assert.doesNotMatch(page, /\{item\.actor\}/);
});

// ---------------------------------------------------------------------------
// V12 masalah #6: counter "Riwayat Aktivitas (N)" HARUS menghitung HANYA
// history yang masih terlihat (isHistoryEntryVisible), bukan
// finalization.history.length mentah — sebelumnya bisa tertulis "(6)" walau
// hanya 1 item yang tampil.
// ---------------------------------------------------------------------------
test("V12 test wajib #18: counter Riwayat Aktivitas memakai finalization.history.filter(isHistoryEntryVisible).length, BUKAN finalization.history.length mentah", () => {
  assert.match(page, /<summary>Riwayat Aktivitas \(\{finalization\.history\.filter\(isHistoryEntryVisible\)\.length\}\)<\/summary>/);
  assert.doesNotMatch(page, /<summary>Riwayat Aktivitas \(\{finalization\.history\.length\}\)<\/summary>/, "regresi ke counter mentah yang menghitung entri hidden juga");
});

// ---------------------------------------------------------------------------
// V12 CRITICAL masalah #1: "Nominal final disepakati" double-count. Fix-nya
// murni di computeAutoFinalAgreedAmount (lib/reconciliation-berita-acara-ui.ts,
// diuji end-to-end di reconciliation-berita-acara-ui.test.ts) — test di sini
// mengunci WIRING page.tsx tidak menambahkan aritmetika BA sendiri di luar
// fungsi murni itu (mis. `finalAmount + analysis.nominal` langsung di JSX).
// ---------------------------------------------------------------------------
test("V12: page.tsx TIDAK PERNAH menghitung nominal final dengan aritmetika BA sendiri (mis. + analysis.nominal / - analysis.nominal langsung) — selalu lewat computeAutoFinalAgreedAmount", () => {
  assert.doesNotMatch(page, /originalOlseraAmount[\s\S]{0,10}[+-]\s*analysis/);
  assert.doesNotMatch(page, /olseraTotal[\s\S]{0,10}[+-]\s*(analysis|result)\.nominal/);
  assert.match(page, /computeAutoFinalAgreedAmount\(\{ originalOlseraAmount, analysis: result \}\)/);
});

// ---------------------------------------------------------------------------
// V12 Goal 8-13: "Reset Finalisasi" — supervisor-only, tautan kecil, teks
// konfirmasi PERSIS sesuai instruksi, handler memanggil endpoint reset lalu
// reopen+refresh supaya active state & badge tabel utama ikut ter-update.
// ---------------------------------------------------------------------------
test("V12: tombol 'Reset Finalisasi' HANYA muncul saat ada attachment atau hasil verifikasi, style recon-link (tidak dominan)", () => {
  assert.match(page, /\{\(finalization\?\.attachment \|\| finalization\?\.verifiedMatchStatus\) && \(/);
  assert.match(page, /<button type="button" className="recon-link" disabled=\{resetBusy\} onClick=\{\(\) => setShowResetConfirm\(true\)\}>\s*Reset Finalisasi/);
});

test("V12: teks konfirmasi reset PERSIS sesuai instruksi (menyebut Berita Acara/OCR/alasan/status dikosongkan, AYO/Olsera/audit tidak dihapus)", () => {
  assert.match(page, /Reset finalisasi periode ini\? Data aktif Berita Acara, hasil OCR, alasan, dan status finalisasi akan dikosongkan\. Data sumber AYO\/Olsera dan jejak audit tidak akan dihapus\./);
});

test("V12: resetFinalization memanggil endpoint 'reset' dengan version, lalu reopen (openDetail) DAN refresh() tabel utama", () => {
  assert.match(page, /const resetFinalization = async \(\) => \{/);
  assert.match(page, /finalizationRequest\("reset", \{ method: "POST", headers: \{ "Content-Type": "application\/json" \}, body: JSON\.stringify\(\{ version: finalization\.version \}\) \}\)/);
  assert.match(page, /setShowResetConfirm\(false\); if \(selectedPeriod\) \{ await openDetail\(selectedPeriod\); await refresh\(\); \}/);
});

test("V12: Reset Finalisasi berada di dalam CollapsibleSection 'Berita Acara dan Finalisasi' yang sudah supervisor-only (tidak ada gating supervisor terpisah/duplikat)", () => {
  assert.match(page, /\{supervisor && \(\s*<CollapsibleSection title="Berita Acara dan Finalisasi">/);
});
