import assert from "node:assert/strict";
import test from "node:test";
import { OmzetNoteError } from "@/lib/reconciliation-omzet-note-store";
import type { OlseraOmzetReconciliationNoteV2Document } from "@/lib/mongodb";
import { isOmzetEvidenceTypeValue, omzetNoteErrorResponse, resolveIdempotencyKey, toOmzetNoteResponse, validateAttachmentFields } from "./_shared.ts";

test("isOmzetEvidenceTypeValue menerima nilai valid, menolak lainnya", () => {
  assert.equal(isOmzetEvidenceTypeValue("shifted-period"), true);
  assert.equal(isOmzetEvidenceTypeValue("wrong-account"), true);
  assert.equal(isOmzetEvidenceTypeValue("tidak-ada-di-daftar"), false);
  assert.equal(isOmzetEvidenceTypeValue(123), false);
  assert.equal(isOmzetEvidenceTypeValue(undefined), false);
  assert.equal(isOmzetEvidenceTypeValue(null), false);
});

test("omzetNoteErrorResponse memetakan code ke status HTTP sesuai konvensi endpoint reconciliation lain (findings/resolution)", async () => {
  assert.equal(omzetNoteErrorResponse(new OmzetNoteError("x", "NOT_FOUND")).status, 404);
  assert.equal(omzetNoteErrorResponse(new OmzetNoteError("x", "CONFLICT")).status, 409);
  assert.equal(omzetNoteErrorResponse(new OmzetNoteError("x", "INVALID_TRANSITION")).status, 422);
  assert.equal(omzetNoteErrorResponse(new OmzetNoteError("x", "VALIDATION")).status, 400);
  const body = (await omzetNoteErrorResponse(new OmzetNoteError("pesan asli untuk user", "CONFLICT")).json()) as { error: string };
  assert.equal(body.error, "pesan asli untuk user");
});

function noteFixture(overrides: Partial<OlseraOmzetReconciliationNoteV2Document> = {}): OlseraOmzetReconciliationNoteV2Document {
  return {
    _id: "note:v1:abc123",
    storeId: 1,
    period: "2026-06",
    evidenceType: "correction",
    description: "Koreksi jurnal",
    explainedAmount: 500_000,
    attachmentUrl: null,
    attachmentFileName: null,
    isCurrent: true,
    supersededBy: null,
    supersededAt: null,
    previousNoteId: null,
    locked: false,
    lockedBy: null,
    lockedAt: null,
    createdBy: "supervisor-1",
    createdAt: new Date("2026-06-05T00:00:00Z"),
    updatedBy: "supervisor-1",
    updatedAt: new Date("2026-06-05T00:00:00Z"),
    ...overrides,
  };
}

test("toOmzetNoteResponse memetakan field note lengkap termasuk locked/lockedBy/lockedAt, TANPA membocorkan field internal skema", () => {
  const note = noteFixture({ locked: true, lockedBy: "supervisor-2", lockedAt: new Date("2026-06-10T00:00:00Z") });
  const mapped = toOmzetNoteResponse(note);
  assert.deepEqual(mapped, {
    evidenceType: "correction",
    description: "Koreksi jurnal",
    explainedAmount: 500_000,
    attachmentUrl: null,
    attachmentFileName: null,
    createdBy: "supervisor-1",
    createdAt: note.createdAt,
    updatedBy: "supervisor-1",
    updatedAt: note.updatedAt,
    locked: true,
    lockedBy: "supervisor-2",
    lockedAt: note.lockedAt,
  });
  for (const internalField of ["_id", "storeId", "period", "isCurrent", "supersededBy", "supersededAt", "previousNoteId"]) {
    assert.equal(internalField in mapped, false, `${internalField} adalah detail internal skema, tidak boleh bocor ke response API`);
  }
});

test("resolveIdempotencyKey: pakai header client bila ada (trim whitespace)", () => {
  const content = { storeId: 1, period: "2026-06", actor: "u1", evidenceType: "correction", description: "d", explainedAmount: 100, attachmentUrl: null };
  assert.equal(resolveIdempotencyKey("client-key-1", content), "client-key-1");
  assert.equal(resolveIdempotencyKey("  client-key-2  ", content), "client-key-2");
});

test("resolveIdempotencyKey: header kosong/whitespace diperlakukan sama seperti tidak ada header", () => {
  const content = { storeId: 1, period: "2026-06", actor: "u1", evidenceType: "correction", description: "d", explainedAmount: 100, attachmentUrl: null };
  assert.equal(resolveIdempotencyKey("   ", content), resolveIdempotencyKey(null, content));
  assert.equal(resolveIdempotencyKey("", content), resolveIdempotencyKey(null, content));
});

test("resolveIdempotencyKey: tanpa header, deterministik dari isi request — payload sama -> key sama, payload beda -> key beda", () => {
  const content = { storeId: 1, period: "2026-06", actor: "u1", evidenceType: "correction", description: "d", explainedAmount: 100, attachmentUrl: null };
  const a = resolveIdempotencyKey(null, content);
  const b = resolveIdempotencyKey(null, { ...content });
  assert.equal(a, b, "klik ganda dengan payload identik harus menghasilkan idempotencyKey yang sama (collapse jadi satu dokumen)");

  const differentDescription = resolveIdempotencyKey(null, { ...content, description: "beda" });
  const differentAmount = resolveIdempotencyKey(null, { ...content, explainedAmount: 200 });
  const differentActor = resolveIdempotencyKey(null, { ...content, actor: "u2" });
  const differentAttachment = resolveIdempotencyKey(null, { ...content, attachmentUrl: "https://blob.vercel-storage.com/a.pdf" });
  assert.notEqual(a, differentDescription);
  assert.notEqual(a, differentAmount);
  assert.notEqual(a, differentActor);
  assert.notEqual(a, differentAttachment, "submit dengan lampiran berbeda (evidenceType/description/explainedAmount sama) HARUS dapat idempotencyKey berbeda — kalau tidak, submitOmzetExplanation akan menabrak _id yang sama lalu ditolak CONFLICT saat attachmentUrl-nya ternyata beda");
});

test("validateAttachmentFields: keduanya kosong -> ok, attachmentUrl/attachmentFileName null (submit tanpa lampiran tetap jalan)", () => {
  const result = validateAttachmentFields(undefined, undefined);
  assert.deepEqual(result, { ok: true, attachmentUrl: null, attachmentFileName: null });
  assert.deepEqual(validateAttachmentFields(null, null), { ok: true, attachmentUrl: null, attachmentFileName: null });
  assert.deepEqual(validateAttachmentFields("", ""), { ok: true, attachmentUrl: null, attachmentFileName: null });
});

test("validateAttachmentFields: keduanya terisi -> ok, di-trim (submit dengan lampiran tersimpan benar)", () => {
  const result = validateAttachmentFields("  https://blob.vercel-storage.com/berita-acara.pdf  ", "  berita-acara.pdf  ");
  assert.deepEqual(result, { ok: true, attachmentUrl: "https://blob.vercel-storage.com/berita-acara.pdf", attachmentFileName: "berita-acara.pdf" });
});

test("validateAttachmentFields: hanya attachmentUrl terisi (attachmentFileName kosong) -> ditolak", () => {
  const result = validateAttachmentFields("https://blob.vercel-storage.com/berita-acara.pdf", undefined);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /harus diisi bersamaan/);
});

test("validateAttachmentFields: hanya attachmentFileName terisi (attachmentUrl kosong) -> ditolak", () => {
  const result = validateAttachmentFields(null, "berita-acara.pdf");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /harus diisi bersamaan/);
});

test("validateAttachmentFields: nilai bukan string (mis. angka) diperlakukan sebagai kosong, bukan dilempar mentah", () => {
  assert.deepEqual(validateAttachmentFields(123, undefined), { ok: true, attachmentUrl: null, attachmentFileName: null });
});
