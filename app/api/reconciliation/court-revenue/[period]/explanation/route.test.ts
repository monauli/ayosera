// Test route API (App Router) — SUMBER DIBACA & diperiksa lewat regex, BUKAN
// handler dipanggil langsung. Ini pola YANG SUDAH DIPAKAI di repo ini untuk
// route yang mewajibkan requireSupervisor()/next-headers cookies() (lihat
// lib/financial-route-auth-guard.test.ts, dan test terakhir di
// lib/reconciliation-manual-resolution.test.ts) — memanggil handler secara
// langsung di luar request context Next.js akan gagal di cookies()/session
// lookup, jadi wiring diverifikasi dari source. Perilaku BISNIS
// (submit/lock/idempotensi/dsb) sudah diuji penuh di level lib
// (lib/reconciliation-omzet-note-store.test.ts, 14 test) dan helper murni di
// _shared.test.ts (kolokasi dengan file ini) — file ini HANYA memverifikasi
// wiring HTTP: fungsi apa yang dipanggil, urutan, dan status code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

test("GET, POST, dan DELETE ketiganya mewajibkan requireSupervisor()", () => {
  const matches = source.match(/requireSupervisor\(\)/g) ?? [];
  assert.equal(matches.length, 3);
});

test("GET membaca skema BARU (getCurrentOmzetNote), bukan getOmzetExplanation skema lama", () => {
  assert.match(source, /getCurrentOmzetNote\(/);
  assert.doesNotMatch(source, /getOmzetExplanation\(/);
});

test("GET memetakan hasil lewat toOmzetNoteResponse (membawa locked/lockedBy/lockedAt)", () => {
  assert.match(source, /note \? toOmzetNoteResponse\(note\) : null/);
});

test("POST menghitung differenceRevenue terkini sebelum submit (loadOmzetLedgerMonthDetail)", () => {
  assert.match(source, /loadOmzetLedgerMonthDetail\(period\)/);
});

test("POST menolak selisih 0 dengan 409 SEBELUM memanggil submitOmzetExplanation", () => {
  const postIndex = source.indexOf("export async function POST");
  const postSource = source.slice(postIndex);
  const zeroCheckIndex = postSource.indexOf("differenceRevenue === 0");
  const submitIndex = postSource.indexOf("submitOmzetExplanation(");
  assert.notEqual(zeroCheckIndex, -1);
  assert.notEqual(submitIndex, -1);
  assert.ok(zeroCheckIndex < submitIndex, "cek selisih 0 harus terjadi sebelum submitOmzetExplanation dipanggil");
  assert.match(postSource.slice(zeroCheckIndex, zeroCheckIndex + 200), /status:\s*409/);
});

test("POST memakai submitOmzetExplanation dengan currentDifferenceRevenue, dan attachmentUrl/attachmentFileName hasil validateAttachmentFields (BUKAN hardcode null)", () => {
  assert.match(source, /submitOmzetExplanation\(/);
  assert.match(source, /currentDifferenceRevenue:\s*current\.differenceRevenue/);
  const submitIndex = source.indexOf("submitOmzetExplanation(");
  const submitCallSource = source.slice(submitIndex, submitIndex + 700);
  assert.match(submitCallSource, /attachmentUrl,/, "attachmentUrl harus diteruskan sebagai variabel (hasil validasi), bukan hardcode null");
  assert.match(submitCallSource, /attachmentFileName,/, "attachmentFileName harus diteruskan sebagai variabel (hasil validasi), bukan hardcode null");
  assert.doesNotMatch(submitCallSource, /attachmentUrl:\s*null/, "TIDAK boleh lagi hardcode null — itu bug yang diperbaiki (lihat 'Perbaikan Attachment di Endpoint Explanation' di tmp/ai-handoff.md)");
  assert.doesNotMatch(submitCallSource, /attachmentFileName:\s*null/);
  assert.doesNotMatch(source, /saveOmzetExplanation\(/, "TIDAK boleh lagi menulis ke skema lama");
});

test("POST membaca attachmentUrl/attachmentFileName mentah dari body lewat validateAttachmentFields, ditolak 400 SEBELUM submitOmzetExplanation bila salah satu kosong", () => {
  assert.match(source, /validateAttachmentFields\(\s*rawAttachmentUrl,\s*rawAttachmentFileName\s*\)/);
  const postIndex = source.indexOf("export async function POST");
  const postSource = source.slice(postIndex);
  const validateIndex = postSource.indexOf("validateAttachmentFields(");
  const submitIndex = postSource.indexOf("submitOmzetExplanation(");
  assert.notEqual(validateIndex, -1);
  assert.ok(validateIndex < submitIndex, "validasi pasangan attachment harus terjadi SEBELUM submitOmzetExplanation dipanggil");
  const validateBlock = postSource.slice(validateIndex, validateIndex + 300);
  assert.match(validateBlock, /!attachmentFields\.ok/);
  assert.match(validateBlock, /status:\s*400/);
});

test("POST menyertakan attachmentUrl ke resolveIdempotencyKey (submit dengan lampiran berbeda tidak boleh menabrak idempotencyKey submit lain)", () => {
  const idempotencyCallIndex = source.indexOf("resolveIdempotencyKey(");
  const idempotencyCallSource = source.slice(idempotencyCallIndex, idempotencyCallIndex + 300);
  assert.match(idempotencyCallSource, /attachmentUrl,/);
});

test("POST men-generate idempotencyKey lewat resolveIdempotencyKey (header client atau turunan konten)", () => {
  assert.match(source, /resolveIdempotencyKey\(/);
  assert.match(source, /idempotency-key/i);
});

test("POST menangani OmzetNoteError lewat omzetNoteErrorResponse (bukan status hardcode ad-hoc per-code)", () => {
  assert.match(source, /error instanceof OmzetNoteError/);
  assert.match(source, /omzetNoteErrorResponse\(error\)/);
});

test("DELETE dinonaktifkan: 410 Gone dengan pesan jujur, TIDAK memanggil deleteOmzetExplanation ATAU fungsi lain secara diam-diam", () => {
  const deleteIndex = source.indexOf("export async function DELETE");
  assert.notEqual(deleteIndex, -1, "handler DELETE harus tetap ada (dinonaktifkan, bukan dihapus)");
  const deleteSource = source.slice(deleteIndex);
  assert.match(deleteSource, /status:\s*410/);
  assert.match(deleteSource, /append-only/i);
  assert.doesNotMatch(source, /deleteOmzetExplanation\(/);
});

test("route ini TIDAK lagi mengimpor lib/reconciliation-omzet-explanation-store (skema lama) — hanya boleh disebut di komentar dokumentasi", () => {
  assert.doesNotMatch(source, /from\s+["'][^"']*reconciliation-omzet-explanation-store["']/);
});
