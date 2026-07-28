import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const page = here("../app/reconciliation/page.tsx");
const model = here("../app/api/reconciliation/findings-ui/route.ts");

test("halaman UI rekonsiliasi disederhanakan menjadi Omset AYO vs Olsera per bulan, dengan state loading/error/empty dan mobile list", () => {
  assert.match(page, /Rekonsiliasi Omset AYO vs Olsera/); assert.match(page, /\/api\/reconciliation\/court-revenue/);
  assert.match(page, /recon-skeleton/); assert.match(page, /Belum ada data/); assert.match(page, /recon-mobile-list/);
});
test("tabel bulanan menampilkan omset AYO, omset Olsera, selisih, jumlah booking\\/transaksi, status, dan tombol detail", () => {
  assert.match(page, />Omset AYO</); assert.match(page, />Omset Olsera</); assert.match(page, />Selisih</);
  assert.match(page, />Booking AYO</); assert.match(page, />Transaksi Olsera</); assert.match(page, />Detail /);
});
test("status hanya Cocok\\/Perlu Dicek\\/Bulan Berjalan — tanpa Impact, Confidence, Reason Code, Manual Resolution, Audit Log, Feature Flag, Readiness", () => {
  assert.match(page, /Cocok/); assert.match(page, /Perlu Dicek/); assert.match(page, /Bulan Berjalan/);
  assert.doesNotMatch(page, /[Ii]mpact/); assert.doesNotMatch(page, /[Cc]onfidence/); assert.doesNotMatch(page, /[Rr]eason ?[Cc]ode/);
  assert.doesNotMatch(page, /[Mm]anual [Rr]esolution|Buat keputusan|Ganti keputusan|Revoke/); assert.doesNotMatch(page, /[Aa]udit ?[Ll]og|Audit trail/);
  assert.doesNotMatch(page, /[Ff]eature ?[Ff]lag/); assert.doesNotMatch(page, /[Rr]eadiness/);
});
test("detail bulan menampilkan total & jumlah transaksi kedua sisi, selisih nominal, dan tanggal yang perlu dicek jika tersedia", () => {
  assert.match(page, /Jumlah booking AYO/); assert.match(page, /Jumlah transaksi Olsera/); assert.match(page, /Selisih nominal/);
  assert.match(page, /Tanggal yang perlu dicek/); assert.match(page, /mismatchedDays/);
});
test("read model menjalankan filter, pagination, priority impact dan aggregate di MongoDB", () => {
  assert.match(model, /requireModule\("rekonsiliasi"\)/); assert.match(model, /\$facet/); assert.match(model, /\$lookup/);
  assert.match(model, /impactRank: 1, updatedAt: -1/); assert.match(model, /\$skip/); assert.match(model, /escapeRegex/);
});
