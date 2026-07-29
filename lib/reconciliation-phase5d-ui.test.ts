import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const page = here("../app/reconciliation/page.tsx");
const model = here("../app/api/reconciliation/findings-ui/route.ts");

// Sejak "Rekonsiliasi Omzet AYOSERA" (engine ledger 40001/40004, lihat
// lib/reconciliation-omzet-ledger.ts), halaman ini TIDAK LAGI memakai
// kategori/POS Olsera maupun breakdown per-hari (mismatchedDays) — ledger
// buku besar tidak tersusun per-hari/per-transaksi (satu jurnal AYO bisa
// mencakup beberapa hari sekaligus, lihat data produksi nyata), jadi
// perbandingan yang bermakna adalah level bulan (lihat docs README/laporan
// implementasi). Status bertambah satu: "Selisih Terjelaskan" (HANYA lewat
// bukti jurnal nyata tersimpan eksplisit, bukan tolerance otomatis).
test("halaman UI rekonsiliasi Omzet AYOSERA per bulan, dengan state loading/error/empty dan mobile list", () => {
  assert.match(page, /Rekonsiliasi Omzet AYOSERA/); assert.match(page, /\/api\/reconciliation\/court-revenue/);
  assert.match(page, /recon-skeleton/); assert.match(page, /Belum ada data/); assert.match(page, /recon-mobile-list/);
});
test("tabel bulanan menampilkan omzet AYO, omzet Olsera (40001+40004), selisih, status, dan tombol detail", () => {
  assert.match(page, />Omzet AYO</); assert.match(page, />Omzet Olsera \(40001\+40004\)</); assert.match(page, />Selisih</);
  assert.match(page, />Status</); assert.match(page, /Detail <ChevronRight/);
});
test("status Cocok\\/Selisih Terjelaskan\\/Perlu Dicek\\/Bulan Berjalan — tanpa Impact, Confidence, Reason Code, Audit Log, Feature Flag, Readiness lama", () => {
  assert.match(page, /Cocok/); assert.match(page, /Selisih Terjelaskan/); assert.match(page, /Perlu Dicek/); assert.match(page, /Bulan Berjalan/);
  assert.doesNotMatch(page, /[Ii]mpact/); assert.doesNotMatch(page, /[Cc]onfidence/); assert.doesNotMatch(page, /[Rr]eason ?[Cc]ode/);
  assert.doesNotMatch(page, /Buat keputusan|Ganti keputusan|Revoke/); assert.doesNotMatch(page, /[Aa]udit ?[Ll]og|Audit trail/);
  assert.doesNotMatch(page, /[Ff]eature ?[Ff]lag/); assert.doesNotMatch(page, /[Rr]eadiness/);
});
test("detail bulan menampilkan pecahan akun 40001/40004, verifikasi reklasifikasi 21003, total final, selisih, dan penyebab status — tanpa kategori/POS lama", () => {
  assert.match(page, /Jumlah booking AYO eligible/); assert.match(page, /Total Omzet Olsera final \(40001\+40004\)/);
  assert.match(page, /Verifikasi reklasifikasi 40004/); assert.match(page, /Penyebab status/);
  assert.doesNotMatch(page, /resolvedCategoryName|categoryResolutionStatus|classifyCategoryForCourtRevenue/);
  assert.doesNotMatch(page, /mismatchedDays/);
});
test("read model menjalankan filter, pagination, priority impact dan aggregate di MongoDB", () => {
  assert.match(model, /requireModule\("rekonsiliasi"\)/); assert.match(model, /\$facet/); assert.match(model, /\$lookup/);
  assert.match(model, /impactRank: 1, updatedAt: -1/); assert.match(model, /\$skip/); assert.match(model, /escapeRegex/);
});
