import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Regresi Task 5: 7 route Laporan Keuangan memanggil `await guard()` DI LUAR
 * blok try. `requireModule` melempar sebuah Response 401/403 (bukan Error),
 * jadi lemparan itu tidak pernah tertangkap dan Next membalas HTTP 500 untuk
 * setiap permintaan tanpa sesi — 5xx pada route utama, dan alasan sebenarnya
 * (tidak login) tersembunyi.
 *
 * Ditemukan lewat sapuan anonim seluruh route di scripts/e2e-audit.ts; test ini
 * menjaga bentuk perbaikannya tanpa perlu server berjalan.
 */
const ROUTES = [
  "accounts",
  "balance-sheet",
  "cash-flow",
  "ledger-detail",
  "ledger-summary",
  "profit-loss",
  "status",
];

function routeSource(name: string) {
  return readFileSync(path.join(process.cwd(), "app", "api", "olsera", "financial", name, "route.ts"), "utf8");
}

for (const name of ROUTES) {
  test(`app/api/olsera/financial/${name}: guard() dipanggil di dalam try dan errornya ditangani`, () => {
    const source = routeSource(name);
    assert.equal(
      /\)\s*\{\s*await guard\(\);/.test(source),
      false,
      "await guard() di luar try membuat Response 401/403 yang dilempar berubah jadi HTTP 500",
    );
    assert.match(source, /try\s*\{\s*await guard\(\);/, "guard() harus berada di dalam blok try");
    assert.match(source, /catch\s*\([^)]*\)\s*\{[\s\S]*errorJson\(/, "error dari guard() harus diteruskan ke errorJson");
  });
}

test("errorJson meneruskan Response auth apa adanya, tidak membungkusnya jadi upstream-error", () => {
  const source = readFileSync(path.join(process.cwd(), "app", "api", "olsera", "financial", "_shared.ts"), "utf8");
  assert.match(
    source,
    /errorJson = \(e: unknown\) => \(e instanceof Response \? e : json\(safeError\(e\)\)\)/,
    "tanpa cabang ini, penolakan auth 401/403 berubah jadi HTTP 200 'Server Olsera sedang bermasalah'",
  );
});
