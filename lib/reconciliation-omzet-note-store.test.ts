import assert from "node:assert/strict";
import test from "node:test";
import type { OlseraOmzetReconciliationAuditLogDocument, OlseraOmzetReconciliationNoteV2Document } from "./mongodb.ts";
import {
  generateNoteId,
  getCurrentOmzetNote,
  getOmzetNoteHistory,
  lockOmzetPeriod,
  OmzetNoteError,
  submitOmzetExplanation,
  writeOmzetAuditLog,
  type OmzetNoteContext,
} from "./reconciliation-omzet-note-store.ts";

function matches(value: Record<string, unknown>, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, expected]) => value[key] === expected);
}
function cursor<T extends Record<string, unknown>>(source: T[]) {
  let values = [...source];
  return {
    sort(spec: Record<string, 1 | -1>) {
      const [key, direction] = Object.entries(spec)[0];
      values.sort((a, b) => (((a[key] as Date)?.valueOf?.() ?? String(a[key])) > ((b[key] as Date)?.valueOf?.() ?? String(b[key])) ? -direction : direction));
      return this;
    },
    async toArray() {
      return values;
    },
  };
}
function fixture(): { context: OmzetNoteContext; notes: OlseraOmzetReconciliationNoteV2Document[]; audit: OlseraOmzetReconciliationAuditLogDocument[] } {
  const notes: OlseraOmzetReconciliationNoteV2Document[] = [];
  const audit: OlseraOmzetReconciliationAuditLogDocument[] = [];
  return {
    notes,
    audit,
    context: {
      notes: {
        find(filter) {
          return cursor(notes.filter((item) => matches(item as unknown as Record<string, unknown>, filter)) as unknown as Record<string, unknown>[]) as never;
        },
        async findOne(filter) {
          return notes.find((item) => matches(item as unknown as Record<string, unknown>, filter)) ?? null;
        },
        async insertOne(document) {
          if (notes.some((item) => item._id === document._id)) throw { code: 11000 };
          notes.push(structuredClone(document));
        },
        async updateOne(filter, update) {
          const item = notes.find((entry) => matches(entry as unknown as Record<string, unknown>, filter));
          if (!item) return { matchedCount: 0 };
          Object.assign(item, (update.$set ?? {}) as object);
          return { matchedCount: 1 };
        },
      },
      auditLog: {
        async insertOne(document) {
          audit.push(document);
        },
      },
    },
  };
}
function input(overrides: Partial<Parameters<typeof submitOmzetExplanation>[0]> = {}) {
  return {
    storeId: 1,
    period: "2026-06",
    evidenceType: "shifted-period" as const,
    description: "Transaksi bergeser dari Mei ke Juni.",
    explainedAmount: 150_000,
    currentDifferenceRevenue: 150_000,
    actor: "admin-1",
    idempotencyKey: "request-1",
    ...overrides,
  };
}

test("generateNoteId deterministik dan berbeda untuk idempotencyKey berbeda", () => {
  const base = { storeId: 1, period: "2026-06", actor: "admin-1", idempotencyKey: "request-1" };
  assert.equal(generateNoteId(base), generateNoteId(base));
  assert.notEqual(generateNoteId(base), generateNoteId({ ...base, idempotencyKey: "request-2" }));
  assert.match(generateNoteId(base), /^note:v1:[0-9a-f]{32}$/);
});

test("submit pertama kali membuat dokumen isCurrent:true tanpa previousNoteId, plus audit SUBMIT_EXPLANATION", async () => {
  const f = fixture();
  const result = await submitOmzetExplanation(input(), f.context);
  assert.equal(result.idempotent, false);
  assert.equal(result.note.isCurrent, true);
  assert.equal(result.note.previousNoteId, null);
  assert.equal(result.note.locked, false);
  assert.equal(f.notes.length, 1);
  assert.equal(f.audit.length, 1);
  assert.equal(f.audit[0].action, "SUBMIT_EXPLANATION");
  assert.equal(f.audit[0].noteId, result.note._id);
});

test("submit revisi men-supersede current lama dan menautkan previousNoteId", async () => {
  const f = fixture();
  const first = await submitOmzetExplanation(input(), f.context);
  const second = await submitOmzetExplanation(
    input({ idempotencyKey: "request-2", description: "Revisi: ternyata koreksi, bukan pergeseran.", evidenceType: "correction" }),
    f.context,
  );
  assert.equal(f.notes.length, 2);
  assert.equal(f.notes.filter((n) => n.isCurrent).length, 1);
  const oldDoc = f.notes.find((n) => n._id === first.note._id)!;
  assert.equal(oldDoc.isCurrent, false);
  assert.equal(oldDoc.supersededBy, second.note._id);
  assert.notEqual(oldDoc.supersededAt, null);
  assert.equal(second.note.previousNoteId, first.note._id);
  assert.equal(f.audit.some((a) => a.action === "SUPERSEDE_EXPLANATION" && a.previousNoteId === first.note._id), true);
  assert.equal((await getOmzetNoteHistory(1, "2026-06", f.context)).length, 2);
  assert.equal((await getCurrentOmzetNote(1, "2026-06", f.context))?._id, second.note._id);
});

test("submit idempotent: idempotencyKey sama tidak membuat dokumen baru", async () => {
  const f = fixture();
  const first = await submitOmzetExplanation(input(), f.context);
  const repeat = await submitOmzetExplanation(input(), f.context);
  assert.equal(repeat.idempotent, true);
  assert.equal(repeat.note._id, first.note._id);
  assert.equal(f.notes.length, 1);
  assert.equal(f.audit.length, 1);
});

test("submit dengan Idempotency-Key sama tapi isi berbeda ditolak CONFLICT", async () => {
  const f = fixture();
  await submitOmzetExplanation(input(), f.context);
  await assert.rejects(
    () => submitOmzetExplanation(input({ description: "Isi berbeda dari request pertama." }), f.context),
    (error: unknown) => error instanceof OmzetNoteError && error.code === "CONFLICT",
  );
});

test("submit ditolak bila explainedAmount tidak sama dengan currentDifferenceRevenue", async () => {
  const f = fixture();
  await assert.rejects(
    () => submitOmzetExplanation(input({ explainedAmount: 100_000, currentDifferenceRevenue: 150_000 }), f.context),
    (error: unknown) => error instanceof OmzetNoteError && error.code === "VALIDATION",
  );
  assert.equal(f.notes.length, 0);
});

test("submit ditolak bila periode sudah dikunci", async () => {
  const f = fixture();
  await submitOmzetExplanation(input(), f.context);
  await lockOmzetPeriod({ storeId: 1, period: "2026-06", actor: "admin-1", currentDifferenceRevenue: 150_000 }, f.context);
  await assert.rejects(
    () => submitOmzetExplanation(input({ idempotencyKey: "request-after-lock" }), f.context),
    (error: unknown) => error instanceof OmzetNoteError && error.code === "INVALID_TRANSITION",
  );
  assert.equal(f.notes.length, 1);
});

test("lock berhasil: set locked/lockedBy/lockedAt dan tulis audit LOCK", async () => {
  const f = fixture();
  const submitted = await submitOmzetExplanation(input(), f.context);
  const result = await lockOmzetPeriod({ storeId: 1, period: "2026-06", actor: "supervisor-1", currentDifferenceRevenue: 150_000 }, f.context);
  assert.equal(result.note.locked, true);
  assert.equal(result.note.lockedBy, "supervisor-1");
  assert.notEqual(result.note.lockedAt, null);
  const stored = f.notes.find((n) => n._id === submitted.note._id)!;
  assert.equal(stored.locked, true);
  assert.equal(stored.lockedBy, "supervisor-1");
  assert.equal(f.audit.some((a) => a.action === "LOCK" && a.noteId === submitted.note._id), true);
});

test("lock ditolak bila belum ada penjelasan (isCurrent:true) untuk periode ini", async () => {
  const f = fixture();
  await assert.rejects(
    () => lockOmzetPeriod({ storeId: 1, period: "2026-06", actor: "supervisor-1", currentDifferenceRevenue: 150_000 }, f.context),
    (error: unknown) => error instanceof OmzetNoteError && error.code === "NOT_FOUND",
  );
});

test("lock ditolak bila periode sudah dikunci sebelumnya", async () => {
  const f = fixture();
  await submitOmzetExplanation(input(), f.context);
  await lockOmzetPeriod({ storeId: 1, period: "2026-06", actor: "supervisor-1", currentDifferenceRevenue: 150_000 }, f.context);
  await assert.rejects(
    () => lockOmzetPeriod({ storeId: 1, period: "2026-06", actor: "supervisor-2", currentDifferenceRevenue: 150_000 }, f.context),
    (error: unknown) => error instanceof OmzetNoteError && error.code === "INVALID_TRANSITION",
  );
  assert.equal(f.audit.filter((a) => a.action === "LOCK").length, 1);
});

test("lock ditolak bila explainedAmount sudah tidak sesuai currentDifferenceRevenue", async () => {
  const f = fixture();
  await submitOmzetExplanation(input(), f.context);
  await assert.rejects(
    () => lockOmzetPeriod({ storeId: 1, period: "2026-06", actor: "supervisor-1", currentDifferenceRevenue: 999_999 }, f.context),
    (error: unknown) => error instanceof OmzetNoteError && error.code === "VALIDATION",
  );
  const stored = f.notes[0];
  assert.equal(stored.locked, false);
});

test("getCurrentOmzetNote mengembalikan null bila belum ada penjelasan", async () => {
  const f = fixture();
  assert.equal(await getCurrentOmzetNote(1, "2026-06", f.context), null);
});

test("writeOmzetAuditLog menulis entri insertOne apa adanya", async () => {
  const f = fixture();
  await writeOmzetAuditLog(
    { storeId: 1, period: "2026-06", action: "SUBMIT_EXPLANATION", actor: "admin-1", noteId: "note:v1:abc", previousNoteId: null, detail: {} },
    f.context,
  );
  assert.equal(f.audit.length, 1);
  assert.equal(f.audit[0].action, "SUBMIT_EXPLANATION");
  assert.match(f.audit[0]._id, /^omzet-audit:v1:/);
});

test("validasi menolak storeId/period/evidenceType tidak valid", async () => {
  const f = fixture();
  await assert.rejects(() => submitOmzetExplanation(input({ storeId: 0 }), f.context), (error: unknown) => error instanceof OmzetNoteError && error.code === "VALIDATION");
  await assert.rejects(() => submitOmzetExplanation(input({ period: "2026/06" }), f.context), (error: unknown) => error instanceof OmzetNoteError && error.code === "VALIDATION");
  await assert.rejects(() => submitOmzetExplanation(input({ evidenceType: "unknown" as never }), f.context), (error: unknown) => error instanceof OmzetNoteError && error.code === "VALIDATION");
  await assert.rejects(() => submitOmzetExplanation(input({ description: "" }), f.context), (error: unknown) => error instanceof OmzetNoteError && error.code === "VALIDATION");
});
