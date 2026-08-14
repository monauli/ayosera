// Test untuk lib/reconciliation-berita-acara-ui.ts (V7): fungsi MURNI yang
// menjembatani hasil analisis OCR ke kartu/field UI di
// app/reconciliation/page.tsx. Test di sini SENGAJA memakai
// lib/reconciliation-berita-acara-parser.ts SUNGGUHAN (bukan mock) supaya
// skenario Maret/April benar-benar melewati parser real, persis seperti yang
// akan dilihat user di production — inilah yang membedakan test ini dari
// reconciliation-berita-acara-client-ocr.test.ts (yang mock tesseract.js
// total dan tidak pernah menyentuh bug CSP V7 di lib/csp.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { parseBeritaAcaraText, matchBeritaAcaraToSystemDifference } from "./reconciliation-berita-acara-parser.ts";
import {
  formatRupiah,
  formatSignedRupiah,
  resolveBeritaAcaraPreviewKind,
  buildBeritaAcaraCards,
  computeAutoFinalAgreedAmount,
  nextReasonAfterAnalysis,
  canSaveBeritaAcaraFinalization,
  canLockAfterSave,
  MATCH_STATUS_TONE,
  formatPeriodLockHistoryLine,
  isHistoryEntryVisible,
  resolveBeritaAcaraVerifiedComponent,
  hasSavedBeritaAcaraAnalysis,
  restoreBeritaAcaraAnalysisFromLock,
} from "./reconciliation-berita-acara-ui.ts";

test("formatRupiah/formatSignedRupiah: format Indonesia, tanda eksplisit untuk nilai positif", () => {
  assert.equal(formatRupiah(740_000), "Rp740.000");
  assert.equal(formatSignedRupiah(740_000), "+Rp740.000");
  assert.equal(formatSignedRupiah(-739_999), "-Rp739.999");
  assert.equal(formatSignedRupiah(0), "Rp0");
});

test("resolveBeritaAcaraPreviewKind: pdf/gambar/tidak didukung (Goal 2/3)", () => {
  assert.equal(resolveBeritaAcaraPreviewKind("application/pdf"), "pdf");
  assert.equal(resolveBeritaAcaraPreviewKind("image/jpeg"), "image");
  assert.equal(resolveBeritaAcaraPreviewKind("image/jpg"), "image");
  assert.equal(resolveBeritaAcaraPreviewKind("image/png"), "image");
  assert.equal(resolveBeritaAcaraPreviewKind("text/plain"), "unsupported");
  assert.equal(resolveBeritaAcaraPreviewKind(null), "unsupported");
  assert.equal(resolveBeritaAcaraPreviewKind(undefined), "unsupported");
});

test("MATCH_STATUS_TONE reuse skema warna recon-badge yang sudah ada (ok/warn/danger) — bukan warna baru", () => {
  assert.equal(MATCH_STATUS_TONE.COCOK, "ok");
  assert.equal(MATCH_STATUS_TONE.TIDAK_COCOK, "danger");
  assert.equal(MATCH_STATUS_TONE.PERLU_REVIEW, "warn");
});

// ---------------------------------------------------------------------------
// Skenario Maret/April (Goal 5) — teks noisy identik dengan yang dipakai
// reconciliation-berita-acara-client-ocr.test.ts, dipiped lewat parser real
// lalu lewat buildBeritaAcaraCards/computeAutoFinalAgreedAmount/
// nextReasonAfterAnalysis MURNI milik modul ini — inilah "regresi yang
// seharusnya menangkap bug V7" untuk lapisan mapping-ke-UI (lapisan
// CSP/network dicek terpisah di lib/csp.test.ts).
// ---------------------------------------------------------------------------
const MARET_OCR_TEXT =
  "BERITA  ACARA REKONSILIASI OMZET\n\n" +
  "Pada   bulan Maret terjadi PENAMBAHAN pendapatan  sebesar Rp740.000\n" +
  "disebabkan pembayaran   di muka diterima pada bulan Maret,\n" +
  "dan diakui sebagai pendapatan bulan Maret.\n\n" +
  "Ditandatangani oleh Supervisor Operasional.";

const APRIL_OCR_TEXT =
  "BERITA  ACARA REKONSILIASI OMZET\n\n" +
  "Pada bulan April dilakukan PENGURANGAN pendapatan sebesar   Rp740.000\n" +
  "karena sudah diakui sebagai pendapatan pada bulan  Maret sehingga\n" +
  "dikurangkan dari pendapatan penggunaan lapangan bulan April.\n\n" +
  "Ditandatangani oleh Supervisor Operasional.";

test("Maret end-to-end: parser real -> kartu benar (Selisih Sistem +Rp740.000 bertanda, Nominal BA Rp740.000 TANPA tanda, COCOK/ok)", () => {
  const parsed = parseBeritaAcaraText(MARET_OCR_TEXT, 0.9);
  assert.equal(parsed.status, "OK");
  const systemDifference = 740_000;
  const matchStatus = matchBeritaAcaraToSystemDifference(systemDifference, parsed);
  const cards = buildBeritaAcaraCards({ systemDifference, nominal: parsed.nominal, direction: parsed.direction, matchStatus });
  assert.equal(cards.selisihSistemLabel, "+Rp740.000", "Selisih Sistem TETAP bertanda arah");
  assert.equal(cards.nominalBeritaAcaraLabel, "Rp740.000", "V9: Nominal Berita Acara TIDAK bertanda, walau direction PENAMBAHAN");
  assert.equal(cards.matchLabel, "COCOK");
  assert.equal(cards.matchTone, "ok");
});

// V12 CRITICAL FIX: test ini SEBELUMNYA mengharapkan olseraTotal + 740.000
// (197.855.000 + 740.000 = 198.595.000) — itu PERSIS formula BUGGY yang
// menyebabkan bug produksi Rp199.335.000 (lihat komentar panjang di
// computeAutoFinalAgreedAmount, lib/reconciliation-berita-acara-ui.ts).
// originalOlseraAmount di sini diperbaiki jadi nilai Olsera SUNGGUHAN
// (198.595.000, bukan AYO 197.855.000 yang salah dipakai sebelumnya) —
// hasil auto-fill sekarang = originalOlseraAmount APA ADANYA, tanpa
// aritmetika BA tambahan.
test("Maret end-to-end: nominal final auto = originalOlseraAmount APA ADANYA (198.595.000), BA TIDAK diterapkan sebagai adjustment kedua (V12 fix — bug produksi Rp199.335.000)", () => {
  const parsed = parseBeritaAcaraText(MARET_OCR_TEXT, 0.9);
  const matchStatus = matchBeritaAcaraToSystemDifference(740_000, parsed);
  const finalAmount = computeAutoFinalAgreedAmount({ originalOlseraAmount: 198_595_000, analysis: { matchStatus, nominal: parsed.nominal, direction: parsed.direction } });
  assert.equal(finalAmount, 198_595_000);
  assert.notEqual(finalAmount, 199_335_000, "regresi ke bug double-count produksi asli");
});

test("Maret end-to-end: alasan auto-fill berasal dari teks dokumen sungguhan (bukan dikarang/hardcode)", () => {
  const parsed = parseBeritaAcaraText(MARET_OCR_TEXT, 0.9);
  const reason = nextReasonAfterAnalysis({ current: "", userEdited: false, parsedReason: parsed.reason });
  assert.match(reason, /pembayaran/i);
  assert.match(reason, /Maret/);
});

test("April end-to-end: parser real -> kartu benar (Nominal BA Rp740.000 TANPA tanda meski PENGURANGAN, selisih sistem -739.999 bertanda, COCOK dalam toleransi Rp1)", () => {
  const parsed = parseBeritaAcaraText(APRIL_OCR_TEXT, 0.9);
  assert.equal(parsed.status, "OK");
  assert.equal(parsed.direction, "PENGURANGAN");
  const systemDifference = -739_999;
  const matchStatus = matchBeritaAcaraToSystemDifference(systemDifference, parsed);
  const cards = buildBeritaAcaraCards({ systemDifference, nominal: parsed.nominal, direction: parsed.direction, matchStatus });
  assert.equal(cards.selisihSistemLabel, "-Rp739.999", "Selisih Sistem TETAP bertanda arah");
  assert.equal(cards.nominalBeritaAcaraLabel, "Rp740.000", "V9: Nominal Berita Acara TIDAK bertanda '-', walau direction PENGURANGAN");
  assert.equal(cards.matchLabel, "COCOK");
  assert.equal(cards.matchTone, "ok");
  assert.equal(matchStatus, "COCOK", "direction PENGURANGAN TETAP dipakai INTERNAL untuk pencocokan, hanya label yang tidak bertanda");
});

test("April end-to-end: alasan auto-fill menyebut Maret dan April dari teks dokumen sungguhan", () => {
  const parsed = parseBeritaAcaraText(APRIL_OCR_TEXT, 0.9);
  const reason = nextReasonAfterAnalysis({ current: "", userEdited: false, parsedReason: parsed.reason });
  assert.match(reason, /Maret/);
  assert.match(reason, /April/);
});

// ---------------------------------------------------------------------------
// Goal 6/CRITICAL + test wajib #13: edit manual user tidak pernah ditimpa.
// ---------------------------------------------------------------------------
test("nextReasonAfterAnalysis: analisis pertama mengisi field kosong", () => {
  assert.equal(nextReasonAfterAnalysis({ current: "", userEdited: false, parsedReason: "Alasan dari dokumen" }), "Alasan dari dokumen");
});
test("nextReasonAfterAnalysis: user SUDAH mengedit manual -> re-analisis TIDAK PERNAH menimpa", () => {
  assert.equal(nextReasonAfterAnalysis({ current: "Alasan yang ditulis user sendiri", userEdited: true, parsedReason: "Hasil OCR baru yang berbeda" }), "Alasan yang ditulis user sendiri");
});
test("nextReasonAfterAnalysis: belum diedit user, re-analisis dari upload ulang tetap boleh update", () => {
  assert.equal(nextReasonAfterAnalysis({ current: "Hasil OCR lama", userEdited: false, parsedReason: "Hasil OCR baru yang lebih akurat" }), "Hasil OCR baru yang lebih akurat");
});
test("nextReasonAfterAnalysis: OCR gagal (parsedReason null) tidak menghapus apa pun yang sudah ada", () => {
  assert.equal(nextReasonAfterAnalysis({ current: "isian manual user", userEdited: false, parsedReason: null }), "isian manual user");
});

// ---------------------------------------------------------------------------
// Goal 7: COCOK saja yang auto-isi nominal final; TIDAK_COCOK/PERLU_REVIEW/
// tanpa analisis TIDAK PERNAH menebak.
// ---------------------------------------------------------------------------
test("computeAutoFinalAgreedAmount: null saat belum ada analisis (fallback manual, Goal 10)", () => {
  assert.equal(computeAutoFinalAgreedAmount({ originalOlseraAmount: 100, analysis: null }), null);
});
test("computeAutoFinalAgreedAmount: null saat TIDAK_COCOK (tidak pernah menebak nominal saat mismatch)", () => {
  assert.equal(computeAutoFinalAgreedAmount({ originalOlseraAmount: 100, analysis: { matchStatus: "TIDAK_COCOK", nominal: 50, direction: "PENAMBAHAN" } }), null);
});
test("computeAutoFinalAgreedAmount: null saat PERLU_REVIEW", () => {
  assert.equal(computeAutoFinalAgreedAmount({ originalOlseraAmount: 100, analysis: { matchStatus: "PERLU_REVIEW", nominal: null, direction: null } }), null);
});
// ---------------------------------------------------------------------------
// V12 CRITICAL FIX: root cause produksi Rp199.335.000 (Maret) — formula LAMA
// menambahkan/mengurangkan nominal BA LAGI di atas originalOlseraAmount yang
// SUDAH mengandung selisih itu (double count). Fix: hasil COCOK SELALU =
// originalOlseraAmount apa adanya, terlepas dari direction — nominal/
// direction hanya GATE "ada bukti valid", bukan lagi dipakai untuk
// aritmetika. Test lama di bawah ini SEBELUMNYA mengharapkan
// originalOlseraAmount dikurangi (perilaku BUGGY) — sudah diperbarui untuk
// mengunci perilaku BENAR supaya regresi tidak mungkin kembali.
// ---------------------------------------------------------------------------
test("computeAutoFinalAgreedAmount: V12 FIX — COCOK TIDAK PERNAH menerapkan adjustment kedua; hasil = originalOlseraAmount apa adanya untuk PENAMBAHAN maupun PENGURANGAN", () => {
  assert.equal(computeAutoFinalAgreedAmount({ originalOlseraAmount: 100_000_000, analysis: { matchStatus: "COCOK", nominal: 740_000, direction: "PENAMBAHAN" } }), 100_000_000);
  assert.equal(computeAutoFinalAgreedAmount({ originalOlseraAmount: 100_000_000, analysis: { matchStatus: "COCOK", nominal: 740_000, direction: "PENGURANGAN" } }), 100_000_000);
});

test("V12 REGRESSION test wajib #16 — Maret: AYO 197.855.000, Olsera 198.595.000, BA 740.000 PENAMBAHAN -> Nominal final = 198.595.000, BUKAN 199.335.000 (bug produksi asli)", () => {
  const result = computeAutoFinalAgreedAmount({ originalOlseraAmount: 198_595_000, analysis: { matchStatus: "COCOK", nominal: 740_000, direction: "PENAMBAHAN" } });
  assert.equal(result, 198_595_000);
  assert.notEqual(result, 199_335_000, "regresi ke bug double-count produksi asli");
});

test("V12 REGRESSION test wajib #16 — April: Olsera 241.390.000, BA 740.000 PENGURANGAN, toleransi ±Rp1 -> Nominal final = 241.390.000, TIDAK dikurangi lagi", () => {
  const result = computeAutoFinalAgreedAmount({ originalOlseraAmount: 241_390_000, analysis: { matchStatus: "COCOK", nominal: 740_000, direction: "PENGURANGAN" } });
  assert.equal(result, 241_390_000);
  assert.notEqual(result, 240_650_000, "240.650.000 = double-count arah PENGURANGAN, tidak boleh terjadi");
});

// ---------------------------------------------------------------------------
// Goal 8/9 + test wajib #14/#15: gating Simpan dan Kunci Periode.
// ---------------------------------------------------------------------------
test("canSaveBeritaAcaraFinalization: semua precondition lengkap -> true", () => {
  assert.equal(canSaveBeritaAcaraFinalization({ hasAttachment: true, busy: false, analysisLoading: false, reason: "alasan valid", finalAmount: "198595000" }), true);
});
test("canSaveBeritaAcaraFinalization: tanpa attachment -> false", () => {
  assert.equal(canSaveBeritaAcaraFinalization({ hasAttachment: false, busy: false, analysisLoading: false, reason: "alasan valid", finalAmount: "100" }), false);
});
test("canSaveBeritaAcaraFinalization: sedang analisis (OCR belum selesai) -> false", () => {
  assert.equal(canSaveBeritaAcaraFinalization({ hasAttachment: true, busy: false, analysisLoading: true, reason: "alasan valid", finalAmount: "100" }), false);
});
test("canSaveBeritaAcaraFinalization: alasan kosong -> false", () => {
  assert.equal(canSaveBeritaAcaraFinalization({ hasAttachment: true, busy: false, analysisLoading: false, reason: "   ", finalAmount: "100" }), false);
});
test("canSaveBeritaAcaraFinalization: nominal final bukan angka -> false", () => {
  assert.equal(canSaveBeritaAcaraFinalization({ hasAttachment: true, busy: false, analysisLoading: false, reason: "alasan", finalAmount: "abc" }), false);
});
test("canSaveBeritaAcaraFinalization: TETAP true walau matchStatus TIDAK_COCOK/PERLU_REVIEW (Goal 10: jangan blokir total, hanya Kunci yang ditahan)", () => {
  // canSaveBeritaAcaraFinalization sengaja tidak menerima matchStatus sama sekali.
  assert.equal(canSaveBeritaAcaraFinalization({ hasAttachment: true, busy: false, analysisLoading: false, reason: "diisi manual", finalAmount: "100" }), true);
});

test("canLockAfterSave: hanya aktif setelah Simpan sukses (hasPreview) dan bukan TIDAK_COCOK", () => {
  assert.equal(canLockAfterSave({ hasPreview: true, busy: false, matchStatus: "COCOK" }), true);
  assert.equal(canLockAfterSave({ hasPreview: false, busy: false, matchStatus: "COCOK" }), false, "belum Simpan -> Kunci tidak boleh aktif");
  assert.equal(canLockAfterSave({ hasPreview: true, busy: false, matchStatus: "TIDAK_COCOK" }), false);
  assert.equal(canLockAfterSave({ hasPreview: true, busy: false, matchStatus: "PERLU_REVIEW" }), true, "PERLU_REVIEW tidak memblokir total (Goal 10)");
  assert.equal(canLockAfterSave({ hasPreview: true, busy: true, matchStatus: "COCOK" }), false);
});

// ---------------------------------------------------------------------------
// Test wajib #12: OCR gagal total -> PERLU_REVIEW + kartu tetap konsisten.
// ---------------------------------------------------------------------------
test("buildBeritaAcaraCards: nominal null (OCR gagal/ambigu) -> label 'Tidak terbaca', tone warn (PERLU_REVIEW)", () => {
  const cards = buildBeritaAcaraCards({ systemDifference: 740_000, nominal: null, direction: null, matchStatus: "PERLU_REVIEW" });
  assert.equal(cards.nominalBeritaAcaraLabel, "Tidak terbaca");
  assert.equal(cards.matchLabel, "PERLU REVIEW");
  assert.equal(cards.matchTone, "warn");
});

test("buildBeritaAcaraCards: arah berbeda -> COCOK, tone ok, meski nominal identik", () => {
  const parsed = parseBeritaAcaraText(MARET_OCR_TEXT, 0.9);
  const matchStatus = matchBeritaAcaraToSystemDifference(-740_000, parsed); // arah sistem berlawanan
  const cards = buildBeritaAcaraCards({ systemDifference: -740_000, nominal: parsed.nominal, direction: parsed.direction, matchStatus });
  assert.equal(matchStatus, "COCOK");
  assert.equal(cards.matchLabel, "COCOK");
  assert.equal(cards.matchTone, "ok");
});

// ---------------------------------------------------------------------------
// V8 Goal 3: formatPeriodLockHistoryLine — kalimat "Riwayat Aktivitas"
// manusiawi. actorName di sini SUDAH diresolve server (lihat
// lib/reconciliation-actor-display.ts) — fungsi ini murni memformat, TIDAK
// PERNAH menerima/mengembalikan raw actor id.
// ---------------------------------------------------------------------------
test("formatPeriodLockHistoryLine: upload -> 'Berita Acara diunggah oleh <nama>', tanpa alasan", () => {
  const line = formatPeriodLockHistoryLine({ action: "upload", actorName: "Simon", reason: null });
  assert.equal(line.summary, "Berita Acara diunggah oleh Simon");
  assert.equal(line.reason, null);
});

test("formatPeriodLockHistoryLine: preview (tombol Simpan) -> 'Finalisasi disimpan oleh <nama>'", () => {
  const line = formatPeriodLockHistoryLine({ action: "preview", actorName: "Simon", reason: "Penyesuaian pembulatan" });
  assert.equal(line.summary, "Finalisasi disimpan oleh Simon");
  assert.equal(line.reason, null, "reason preview/lock TIDAK ditampilkan di baris riwayat (sudah tampil di tempat lain di UI) — hanya unlock");
});

test("formatPeriodLockHistoryLine: lock -> 'Periode dikunci oleh <nama>'; relock -> 'Periode dikunci kembali oleh <nama>'", () => {
  assert.equal(formatPeriodLockHistoryLine({ action: "lock", actorName: "Supervisor", reason: "x" }).summary, "Periode dikunci oleh Supervisor");
  assert.equal(formatPeriodLockHistoryLine({ action: "relock", actorName: "Supervisor", reason: "x" }).summary, "Periode dikunci kembali oleh Supervisor");
});

test("formatPeriodLockHistoryLine: unlock -> 'Periode dibuka kembali oleh <nama>' DAN alasan buka kunci ditampilkan", () => {
  const line = formatPeriodLockHistoryLine({ action: "unlock", actorName: "Supervisor", reason: "Salah unggah dokumen" });
  assert.equal(line.summary, "Periode dibuka kembali oleh Supervisor");
  assert.equal(line.reason, "Salah unggah dokumen");
});

test("formatPeriodLockHistoryLine: actorName fallback 'User' (dari resolver, bukan di sini) tetap dirender apa adanya, bukan raw id", () => {
  const line = formatPeriodLockHistoryLine({ action: "upload", actorName: "User", reason: null });
  assert.equal(line.summary, "Berita Acara diunggah oleh User");
});

// ---------------------------------------------------------------------------
// V9 Goal 1: "Nominal Berita Acara" SELALU nilai absolut tanpa tanda, TIDAK
// PEDULI direction — beda dengan "Selisih Sistem" yang tetap bertanda
// (formatSignedRupiah). direction TETAP dipakai internal (matchStatus di sini
// dihitung dari direction sungguhan lewat matchBeritaAcaraToSystemDifference
// di test end-to-end Maret/April di atas) — hanya representasi label yang
// berubah, bukan logikanya.
// ---------------------------------------------------------------------------
test("buildBeritaAcaraCards: nominalBeritaAcaraLabel TIDAK PERNAH berawalan '+'/'-' untuk PENAMBAHAN maupun PENGURANGAN", () => {
  const penambahan = buildBeritaAcaraCards({ systemDifference: 740_000, nominal: 740_000, direction: "PENAMBAHAN", matchStatus: "COCOK" });
  const pengurangan = buildBeritaAcaraCards({ systemDifference: -740_000, nominal: 740_000, direction: "PENGURANGAN", matchStatus: "COCOK" });
  assert.equal(penambahan.nominalBeritaAcaraLabel, "Rp740.000");
  assert.equal(pengurangan.nominalBeritaAcaraLabel, "Rp740.000");
  assert.equal(penambahan.nominalBeritaAcaraLabel, pengurangan.nominalBeritaAcaraLabel, "label kartu nominal harus identik terlepas dari direction");
});

test("buildBeritaAcaraCards: selisihSistemLabel TETAP bertanda (kontras dengan nominalBeritaAcaraLabel yang tidak bertanda)", () => {
  const positif = buildBeritaAcaraCards({ systemDifference: 740_000, nominal: 740_000, direction: "PENAMBAHAN", matchStatus: "COCOK" });
  const negatif = buildBeritaAcaraCards({ systemDifference: -739_999, nominal: 740_000, direction: "PENGURANGAN", matchStatus: "COCOK" });
  assert.equal(positif.selisihSistemLabel, "+Rp740.000");
  assert.equal(negatif.selisihSistemLabel, "-Rp739.999");
});

// ---------------------------------------------------------------------------
// V11 Goal 8-11: isHistoryEntryVisible — soft-delete per-item, dipakai
// menyaring render Riwayat Aktivitas TANPA menyentuh data mentah.
// ---------------------------------------------------------------------------
test("isHistoryEntryVisible: hiddenAt null -> visible; hiddenAt terisi (string ISO dari API atau Date) -> tersembunyi", () => {
  assert.equal(isHistoryEntryVisible({ hiddenAt: null }), true);
  assert.equal(isHistoryEntryVisible({ hiddenAt: "2026-08-11T00:00:00.000Z" }), false);
  assert.equal(isHistoryEntryVisible({ hiddenAt: new Date() }), false);
});

// ---------------------------------------------------------------------------
// V11 test wajib #1/#2/#6/#7: resolveBeritaAcaraVerifiedComponent — component
// (COURT/PICKLEBALL) ikut "Cocok + Berita Acara" HANYA saat ia SATU-SATUNYA
// yang PERLU_DICEK. Guard ambiguitas: dua-duanya PERLU_DICEK bersamaan ->
// TIDAK ditempelkan ke siapa pun (masih Perlu Dicek, tidak ditebak).
// ---------------------------------------------------------------------------
test("Maret: hanya PICKLEBALL PERLU_DICEK, COURT sudah COCOK sendiri -> BA ditempelkan HANYA ke pickleball", () => {
  const result = resolveBeritaAcaraVerifiedComponent({ court: { status: "COCOK" }, pickleball: { status: "PERLU_DICEK" } }, true);
  assert.deepEqual(result, { court: false, pickleball: true });
});

test("April (skenario simetris): hanya COURT PERLU_DICEK -> BA ditempelkan HANYA ke court", () => {
  const result = resolveBeritaAcaraVerifiedComponent({ court: { status: "PERLU_DICEK" }, pickleball: { status: "COCOK" } }, true);
  assert.deepEqual(result, { court: true, pickleball: false });
});

test("test wajib #7: dua component PERLU_DICEK bersamaan -> AMBIGU, tidak ditempelkan ke siapa pun (tetap Perlu Dicek keduanya)", () => {
  const result = resolveBeritaAcaraVerifiedComponent({ court: { status: "PERLU_DICEK" }, pickleball: { status: "PERLU_DICEK" } }, true);
  assert.deepEqual(result, { court: false, pickleball: false });
});

test("test wajib #6: kedua component sudah COCOK sendiri (toleransi biasa) -> tidak perlu badge BA di component mana pun", () => {
  const result = resolveBeritaAcaraVerifiedComponent({ court: { status: "COCOK" }, pickleball: { status: "COCOK" } }, true);
  assert.deepEqual(result, { court: false, pickleball: false });
});

test("beritaAcaraVerified=false (belum Simpan/belum server-verified) -> tidak pernah menempelkan BA ke component apa pun, terlepas status masing-masing", () => {
  const result = resolveBeritaAcaraVerifiedComponent({ court: { status: "PERLU_DICEK" }, pickleball: { status: "COCOK" } }, false);
  assert.deepEqual(result, { court: false, pickleball: false });
});

// ---------------------------------------------------------------------------
// V11 test wajib #9-15: RESTORE LAST SAVED STATE — hasSavedBeritaAcaraAnalysis
// menentukan apakah reopen detail boleh melewati OCR ulang (analyzeAttachment
// di page.tsx) dan langsung hydrate dari lock tersimpan.
// ---------------------------------------------------------------------------
test("hasSavedBeritaAcaraAnalysis: lock null -> false (belum ada apa pun untuk direstore)", () => {
  assert.equal(hasSavedBeritaAcaraAnalysis(null), false);
});

test("hasSavedBeritaAcaraAnalysis: baru upload, belum pernah Simpan (verifiedMatchStatus/nominal/direction semua null) -> false, OCR baru boleh jalan", () => {
  assert.equal(hasSavedBeritaAcaraAnalysis({ verifiedMatchStatus: null, beritaAcaraNominal: null, beritaAcaraDirection: null, adjustmentReason: null }), false);
});

test("hasSavedBeritaAcaraAnalysis: sudah pernah Simpan dengan hasil COCOK -> true, TIDAK boleh OCR ulang", () => {
  assert.equal(hasSavedBeritaAcaraAnalysis({ verifiedMatchStatus: "COCOK", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENAMBAHAN", adjustmentReason: "Penyesuaian" }), true);
});

test("hasSavedBeritaAcaraAnalysis: sudah pernah Simpan tapi hasil PERLU_REVIEW (OCR gagal saat itu, tetap disimpan) -> true juga, reopen TIDAK mengulang OCR", () => {
  assert.equal(hasSavedBeritaAcaraAnalysis({ verifiedMatchStatus: "PERLU_REVIEW", beritaAcaraNominal: null, beritaAcaraDirection: null, adjustmentReason: "Diisi manual" }), true);
});

test("restoreBeritaAcaraAnalysisFromLock (Maret): hydrate persis dari lock tersimpan — nominal Rp740.000, PENAMBAHAN, COCOK, alasan tersimpan, TANPA OCR", () => {
  const restored = restoreBeritaAcaraAnalysisFromLock(
    { verifiedMatchStatus: "COCOK", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENAMBAHAN", adjustmentReason: "Pembayaran di muka diakui Maret" },
    740_000,
  );
  assert.deepEqual(restored, {
    systemDifference: 740_000,
    nominal: 740_000,
    direction: "PENAMBAHAN",
    reason: "Pembayaran di muka diakui Maret",
    parseStatus: "OK",
    matchStatus: "COCOK",
    ocrSource: "restored-from-database",
  });
});

test("restoreBeritaAcaraAnalysisFromLock (April): systemDifference dikirim eksplisit oleh caller (selisih periode SAAT INI), bukan diturunkan dari nominal BA", () => {
  const restored = restoreBeritaAcaraAnalysisFromLock(
    { verifiedMatchStatus: "COCOK", beritaAcaraNominal: 740_000, beritaAcaraDirection: "PENGURANGAN", adjustmentReason: "Sudah diakui bulan Maret" },
    -739_999,
  );
  assert.equal(restored.systemDifference, -739_999);
  assert.equal(restored.matchStatus, "COCOK");
});

test("restoreBeritaAcaraAnalysisFromLock: verifiedMatchStatus null (defensif, tidak seharusnya terjadi bila hasSavedBeritaAcaraAnalysis sudah true) -> fallback PERLU_REVIEW, tidak pernah melempar", () => {
  const restored = restoreBeritaAcaraAnalysisFromLock({ verifiedMatchStatus: null, beritaAcaraNominal: 740_000, beritaAcaraDirection: null, adjustmentReason: null }, 740_000);
  assert.equal(restored.matchStatus, "PERLU_REVIEW");
});
