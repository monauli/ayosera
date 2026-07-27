// Verifikasi statis scripts/run-reconciliation-internal-olsera.ts (Phase 5B):
// default WAJIB dry-run, mode tulis WAJIB flag --write eksplisit + guard env
// ALLOW_RECONCILIATION_WRITE=1 (dan guard tambahan di production). Pola sama
// lib/reconciliation-api.test.ts (baca source, bukan menjalankan proses).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/run-reconciliation-internal-olsera.ts", import.meta.url));
const source = readFileSync(scriptPath, "utf8");
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts: Record<string, string> };

test("package.json: script 'reconciliation:internal' terdaftar dan menunjuk ke runner Phase 5B yang benar", () => {
  const command = packageJson.scripts["reconciliation:internal"];
  assert.ok(command, "package.json harus punya script 'reconciliation:internal'");
  assert.match(command, /scripts\/run-reconciliation-internal-olsera\.ts/);
  // File memakai "server-only" (lewat import lib/reconciliation-runner.ts) -> WAJIB tsx --conditions=react-server, bukan plain node.
  assert.match(command, /tsx --conditions=react-server/);
});

test("script: --help mencetak bantuan dan keluar TANPA membaca env/MongoDB (dicek sebelum dynamic import runner)", () => {
  assert.match(source, /rawArgs\.includes\("--help"\)/);
  const helpIndex = source.indexOf('rawArgs.includes("--help")');
  const dynamicImportIndex = source.indexOf('await import("../lib/reconciliation-runner.ts")');
  assert.ok(helpIndex > -1 && dynamicImportIndex > -1 && helpIndex < dynamicImportIndex, "--help harus dicek SEBELUM dynamic import runner/MongoDB");
});

test("script: default dryRun true (write hanya true bila flag --write eksplisit terlihat)", () => {
  assert.match(source, /dryRun:\s*!write/);
  assert.match(source, /let write = false/);
});

test("script: mode tulis wajib env ALLOW_RECONCILIATION_WRITE=1, ditolak bila tidak diset", () => {
  assert.match(source, /ALLOW_RECONCILIATION_WRITE/);
  assert.match(source, /!==\s*"1"/);
});

test("script: guard tambahan untuk NODE_ENV=production (ALLOW_RECONCILIATION_WRITE_PRODUCTION)", () => {
  assert.match(source, /ALLOW_RECONCILIATION_WRITE_PRODUCTION/);
  assert.match(source, /NODE_ENV === "production"/);
});

test("script: reconciliationType selalu INTERNAL_OLSERA (tidak menerima CROSS_SYSTEM dari argumen)", () => {
  assert.match(source, /reconciliationType:\s*"INTERNAL_OLSERA"/);
  assert.doesNotMatch(source, /CROSS_SYSTEM_COURT_REVENUE/);
});

test("script: domain divalidasi lewat isPhase5BDomain sebelum dipakai (tidak menerima domain sembarangan dari CLI)", () => {
  assert.match(source, /isPhase5BDomain\(d\)/);
});
