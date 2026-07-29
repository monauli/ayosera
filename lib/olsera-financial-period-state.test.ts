// Test lib/olsera-financial-period-state.ts — helper MURNI di balik perbaikan
// bug "pemilihan bulan Laporan Keuangan Olsera terkunci ke Februari 2026".
// Skenario di sini persis mengikuti requirement perbaikan bug (lihat pesan
// tugas): pindah Feb->Mar->Apr->Mei->Jun->Jul, perpindahan cepat antar bulan,
// response lama datang setelah response baru, reload dengan query period,
// bulan tanpa snapshot (tidak boleh diam-diam fallback), dan satu sumber
// kebenaran period untuk seluruh tab laporan.
import assert from "node:assert/strict";
import test from "node:test";
import {
  clampFinancialPeriod,
  FINANCIAL_PERIOD_QUERY_KEY,
  isValidPeriodFormat,
  readPeriodFromSearch,
  resolveInitialPeriod,
  shouldApplyPeriodResponse,
  writePeriodToSearch,
} from "./olsera-financial-period-state.ts";

const MIN_PERIOD = "2026-02";
const CURRENT_PERIOD = "2026-07"; // "sekarang" tetap (Juli) — persis skenario bug produksi.

// ---------------------------------------------------------------------------
// isValidPeriodFormat / clampFinancialPeriod
// ---------------------------------------------------------------------------
test("isValidPeriodFormat: hanya menerima YYYY-MM", () => {
  assert.equal(isValidPeriodFormat("2026-05"), true);
  assert.equal(isValidPeriodFormat("2026-5"), false);
  assert.equal(isValidPeriodFormat("2026/05"), false);
  assert.equal(isValidPeriodFormat(null), false);
  assert.equal(isValidPeriodFormat(undefined), false);
  assert.equal(isValidPeriodFormat(""), false);
});

test("clampFinancialPeriod: menjepit ke rentang [min, max], tidak pernah keluar batas", () => {
  assert.equal(clampFinancialPeriod("2025-11", MIN_PERIOD, CURRENT_PERIOD), MIN_PERIOD);
  assert.equal(clampFinancialPeriod("2027-01", MIN_PERIOD, CURRENT_PERIOD), CURRENT_PERIOD);
  assert.equal(clampFinancialPeriod("2026-05", MIN_PERIOD, CURRENT_PERIOD), "2026-05");
});

// ---------------------------------------------------------------------------
// Skenario 1: pindah Feb -> Mar -> Apr -> Mei -> Jun -> Jul secara berurutan
// ---------------------------------------------------------------------------
test("perpindahan berurutan Feb->Mar->Apr->Mei->Jun->Jul: setiap pilihan berlaku apa adanya, tidak pernah ditimpa balik", () => {
  const sequence = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
  let period = MIN_PERIOD;
  for (const next of sequence) {
    period = clampFinancialPeriod(next, MIN_PERIOD, CURRENT_PERIOD);
    assert.equal(period, next, `pindah ke ${next} harus berlaku persis, bukan balik ke Februari`);
  }
  assert.equal(period, "2026-07");
});

// ---------------------------------------------------------------------------
// Skenario 2 & 3: perpindahan cepat + response lama datang setelah response
// baru — disimulasikan sebagai urutan request/response tidak berurutan.
// ---------------------------------------------------------------------------
test("perpindahan cepat antar bulan: hanya response utk period AKTIF SAAT INI yang boleh diterapkan", () => {
  // Pengguna klik cepat Feb -> Mar -> Apr -> Mei sebelum satu pun response tiba.
  const requestedInOrder = ["2026-02", "2026-03", "2026-04", "2026-05"];
  const activePeriod = "2026-05"; // period aktif setelah seluruh klik cepat selesai
  const applicable = requestedInOrder.map((requested) => shouldApplyPeriodResponse(requested, activePeriod));
  assert.deepEqual(applicable, [false, false, false, true], "hanya request terakhir (Mei) yang responsnya boleh diterapkan");
});

test("response request lama datang SETELAH response baru: response lama tetap ditolak, tidak menimpa bulan terbaru", () => {
  // Urutan pengiriman: Maret dulu, lalu Juni. Tapi jaringan lambat -> response
  // Juni (baru) tiba LEBIH DULU, response Maret (lama) menyusul belakangan.
  let activePeriod = "2026-03";
  activePeriod = "2026-06"; // pengguna sudah pindah ke Juni sebelum response Maret tiba

  const juneResponseArrivesFirst = shouldApplyPeriodResponse("2026-06", activePeriod);
  assert.equal(juneResponseArrivesFirst, true, "response Juni (period aktif saat ini) diterapkan");

  const marchResponseArrivesLate = shouldApplyPeriodResponse("2026-03", activePeriod);
  assert.equal(marchResponseArrivesLate, false, "response Maret yang basi HARUS ditolak walau tiba belakangan");
});

// ---------------------------------------------------------------------------
// Skenario 4: reload halaman dengan query period di URL
// ---------------------------------------------------------------------------
test("readPeriodFromSearch: membaca period dari query string apa adanya", () => {
  assert.equal(readPeriodFromSearch("?financialPeriod=2026-05"), "2026-05");
  assert.equal(readPeriodFromSearch("?financialPeriod=2026-05&foo=bar"), "2026-05");
  assert.equal(readPeriodFromSearch(""), null);
  assert.equal(readPeriodFromSearch("?financialPeriod=bukan-period"), null, "format salah tidak dianggap valid");
});

test("writePeriodToSearch: menimpa/menambahkan period, mempertahankan param lain", () => {
  assert.equal(writePeriodToSearch("", "2026-05"), `${FINANCIAL_PERIOD_QUERY_KEY}=2026-05`);
  assert.equal(writePeriodToSearch(`?${FINANCIAL_PERIOD_QUERY_KEY}=2026-02&tab=ledger`, "2026-06"), `${FINANCIAL_PERIOD_QUERY_KEY}=2026-06&tab=ledger`);
});

test("resolveInitialPeriod: reload dengan query period -> period itu yang dipakai (bukan default/Februari)", () => {
  const resolved = resolveInitialPeriod({ periodFromUrl: "2026-06", currentPeriod: CURRENT_PERIOD, minPeriod: MIN_PERIOD });
  assert.equal(resolved, "2026-06");
});

test("resolveInitialPeriod: tanpa query URL -> default ke bulan berjalan (BUKAN Februari yang di-hardcode)", () => {
  const resolved = resolveInitialPeriod({ periodFromUrl: null, currentPeriod: CURRENT_PERIOD, minPeriod: MIN_PERIOD });
  assert.equal(resolved, CURRENT_PERIOD);
  assert.notEqual(resolved, "2026-02", "default TIDAK BOLEH hardcode ke Februari — harus ikut bulan berjalan");
});

test("resolveInitialPeriod: period dari URL di luar rentang tetap dijepit (mis. URL dimanipulasi manual)", () => {
  assert.equal(resolveInitialPeriod({ periodFromUrl: "2025-01", currentPeriod: CURRENT_PERIOD, minPeriod: MIN_PERIOD }), MIN_PERIOD);
  assert.equal(resolveInitialPeriod({ periodFromUrl: "2099-01", currentPeriod: CURRENT_PERIOD, minPeriod: MIN_PERIOD }), CURRENT_PERIOD);
});

// ---------------------------------------------------------------------------
// Skenario 5: bulan tanpa snapshot — TIDAK ADA jalur fallback diam-diam
// ---------------------------------------------------------------------------
test("resolveInitialPeriod: TIDAK menerima/menggunakan sinyal 'latestSyncedPeriod' atau 'hasData' dari server", () => {
  // Bukti struktural: fungsi ini murni dari (periodFromUrl, currentPeriod,
  // minPeriod) — bulan yang belum ada datanya (mis. April dipilih pengguna,
  // snapshot-nya kosong) TETAP dipertahankan sebagai period aktif; UI yang
  // menampilkan status "Belum ada data" (lihat snapshot.hasData di
  // components/olsera-financial-panel.tsx), bukan fungsi ini yang mengganti period.
  const requestedByUser = "2026-04";
  const resolved = resolveInitialPeriod({ periodFromUrl: requestedByUser, currentPeriod: CURRENT_PERIOD, minPeriod: MIN_PERIOD });
  assert.equal(resolved, requestedByUser, "period yang diminta pengguna dipertahankan meski (secara hipotetis) datanya kosong");
});

test("shouldApplyPeriodResponse: response utk bulan tanpa snapshot tetap diterapkan (agar UI bisa menampilkan status kosong yang benar)", () => {
  // Response server utk bulan kosong (hasData:false) TETAP harus diterapkan
  // ke state selama period-nya masih period aktif — supaya UI merender status
  // "Belum ada data" untuk bulan yang BENAR, bukan diam-diam pindah ke bulan lain.
  assert.equal(shouldApplyPeriodResponse("2026-04", "2026-04"), true);
});

// ---------------------------------------------------------------------------
// Skenario 6: satu sumber kebenaran period untuk seluruh tab laporan —
// dibuktikan secara struktural: SEMUA fungsi di modul ini bekerja pada satu
// nilai `period` string, tidak ada API "per tab" untuk resolve/apply period.
// (Di komponen, seluruh tab — Ringkasan/Arus Kas/Laba Rugi/Neraca/Buku Besar —
// dirender dari SATU state `snapshot` yang diisi oleh SATU state `period`;
// lihat components/olsera-financial-panel.tsx, tidak ada state period kedua.)
// ---------------------------------------------------------------------------
test("satu sumber kebenaran: URL query key period sama dipakai untuk baca maupun tulis (tidak ada key kedua/tersembunyi)", () => {
  const written = writePeriodToSearch("", "2026-05");
  const readBack = readPeriodFromSearch(`?${written}`);
  assert.equal(readBack, "2026-05", "apa yang ditulis harus bisa dibaca kembali persis — satu key, satu sumber kebenaran");
});
