// Pola sama seperti ../explanation/route.test.ts — source-inspection, bukan
// invoke handler langsung (lihat komentar di file itu untuk alasan). Perilaku
// bisnis lockOmzetPeriod sudah diuji penuh di lib/reconciliation-omzet-note-store.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

test("hanya POST yang diekspor — tidak ada GET/DELETE terpisah (status locked terbaca lewat GET .../explanation)", () => {
  assert.match(source, /export async function POST/);
  assert.doesNotMatch(source, /export async function GET/);
  assert.doesNotMatch(source, /export async function DELETE/);
});

test("POST mewajibkan requireSupervisor()", () => {
  const matches = source.match(/requireSupervisor\(\)/g) ?? [];
  assert.equal(matches.length, 1);
});

test("POST menghitung differenceRevenue terkini lalu memanggil lockOmzetPeriod dengan currentDifferenceRevenue", () => {
  assert.match(source, /loadOmzetLedgerMonthDetail\(period\)/);
  assert.match(source, /lockOmzetPeriod\(/);
  assert.match(source, /currentDifferenceRevenue:\s*current\.differenceRevenue/);
});

test("error OmzetNoteError ditangani lewat omzetNoteErrorResponse (helper sama dengan explanation route, mapping konsisten)", () => {
  assert.match(source, /error instanceof OmzetNoteError/);
  assert.match(source, /omzetNoteErrorResponse\(error\)/);
});

test("TIDAK ADA jalur unlock (fungsi/handler/import) di file ini — 'unlock' hanya boleh muncul di komentar dokumentasi yang menjelaskan ketiadaannya", () => {
  assert.doesNotMatch(source, /unlockOmzetPeriod|export\s+(async\s+)?function\s+\w*[Uu]nlock|import[^;]*[Uu]nlock/);
});

test("response sukses membawa note lengkap lewat toOmzetNoteResponse (locked/lockedBy/lockedAt ikut terbawa)", () => {
  assert.match(source, /toOmzetNoteResponse\(result\.note\)/);
});
