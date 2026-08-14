// Phase 1 (MASTER FIX FINAL): "Auto Fix Semua" di components/olsera-validation-panel.tsx.
// Source-text assertions (pola sama seperti lib/audit-sync-menu-ui.test.ts) —
// tidak ada jsdom/@testing-library di proyek ini, jadi pola ini menguji bahwa
// implementasi memang memanggil endpoint gap recovery yang SUDAH ADA
// (bukan logic baru paralel) dan tidak memakai fake timer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const panel = here("../components/olsera-validation-panel.tsx");

test("Auto Fix Semua reuse endpoint gap recovery existing (/api/private/integration-monitor), bukan jalur baru", () => {
  assert.match(panel, /const autoFixSemua = async \(\) => \{/);
  assert.match(panel, /fetch\("\/api\/private\/integration-monitor", \{ method: "POST"/);
});

test("Auto Fix Semua memproses Kategori, Inventori, Financial berurutan", () => {
  assert.match(panel, /source: "olsera" as const, label: "Kategori"/);
  assert.match(panel, /source: "olsera-inventory" as const, label: "Inventori"/);
  assert.match(panel, /source: "olsera-financial" as const, label: "Financial"/);
});

test("repair HANYA dipanggil bila Cek Gap segar menunjukkan mismatch (needsRepairStatus) — bukan selalu re-fetch buta", () => {
  assert.match(panel, /if \(checkBody\?\.status === needsRepairStatus\)/);
});

test("satu source gagal TIDAK menghentikan source berikutnya (try/catch per source di dalam loop)", () => {
  const fnBody = panel.slice(panel.indexOf("const autoFixSemua"), panel.indexOf("const autoFixSemua") + 2500);
  assert.match(fnBody, /for \(let i = 0; i < AUTO_FIX_SOURCES\.length; i\+\+\)/);
  assert.match(fnBody, /\} catch \{/);
});

test("Auto Fix Semua re-run validator ulang di akhir (Phase 6-style), bukan hanya recovery tanpa verifikasi", () => {
  const fnBody = panel.slice(panel.indexOf("const autoFixSemua"), panel.indexOf("const autoFixSemua") + 2500);
  assert.match(fnBody, /await validate\(\);/);
});

test("progress Auto Fix TIDAK memakai fake timer (tidak ada setTimeout/setInterval di dalam alurnya)", () => {
  const fnBody = panel.slice(panel.indexOf("const autoFixSemua"), panel.indexOf("const autoFixSemua") + 2500);
  assert.doesNotMatch(fnBody, /setTimeout|setInterval/);
});

test("Auto Fix Semua TIDAK PERNAH memaksa delta/status jadi Cocok — tidak ada assignment stored = live di panel ini", () => {
  assert.doesNotMatch(panel, /\.stored\s*=\s*.*\.live/i);
  assert.doesNotMatch(panel, /delta\s*=\s*0\b/);
});

test("tombol Auto Fix Semua ada di UI, disabled saat busy/autoFixBusy", () => {
  assert.match(panel, /"Auto Fix berjalan\.\.\." : "Auto Fix Semua"/);
  assert.match(panel, /disabled=\{busy \|\| autoFixBusy \|\| !period\}/);
});
