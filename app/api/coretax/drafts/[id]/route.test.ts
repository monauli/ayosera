// PATCH /api/coretax/drafts/[id]: request.json() melempar SyntaxError untuk
// body kosong/malformed — sebelum perbaikan ini, error itu jatuh ke catch
// generik dan dibalas HTTP 500 ("Gagal menyimpan draft.") alih-alih 400 yang
// semestinya untuk kesalahan client. Semua dependency (auth + mongo + draft
// store) di-mock lewat node:test --experimental-test-module-mocks (pola sama
// app/api/reconciliation/court-revenue/[period]/attachment/route.test.ts)
// supaya PATCH bisa dipanggil langsung dengan Request asli.
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

const requireModuleMock = mock.fn(async () => ({ id: "user-1", role: "user" as const, allowedModules: ["coretax"] }));
mock.module("@/lib/auth", { namedExports: { requireModule: requireModuleMock } });

mock.module("@/lib/mongodb", {
  namedExports: {
    collections: mock.fn(async () => ({ coretaxDrafts: {} })),
    withMongo: mock.fn(async (handler: () => Promise<unknown>) => handler()),
  },
});

const updateCoretaxDraftMock = mock.fn(async (_collection: unknown, id: string, input: Record<string, unknown>) => {
  if (id === "missing") return null;
  return { _id: id, moduleId: "bpu", tin: "", taxPeriodMonth: null, taxPeriodYear: null, rows: [], rowCount: 0, validRowCount: 0, invalidRowCount: 0, createdBy: "u", createdAt: new Date(), updatedAt: new Date(), name: "Draft", ...input };
});
mock.module("@/lib/coretax/draft-store", {
  namedExports: {
    updateCoretaxDraft: updateCoretaxDraftMock,
    getCoretaxDraft: mock.fn(),
    deleteCoretaxDraft: mock.fn(),
  },
});

let PATCH!: typeof import("./route.ts").PATCH;
before(async () => {
  ({ PATCH } = await import("./route.ts"));
});

function req(body?: string) {
  return new Request("http://localhost/api/coretax/drafts/draft-1", {
    method: "PATCH",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body,
  });
}
function ctx(id = "draft-1") {
  return { params: Promise.resolve({ id }) };
}

test.beforeEach(() => {
  updateCoretaxDraftMock.mock.resetCalls();
});

test("PATCH body kosong -> 400, bukan 500", async () => {
  const res = await PATCH(req(""), ctx());
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Data permintaan tidak valid.");
  assert.equal(updateCoretaxDraftMock.mock.callCount(), 0, "tidak boleh sampai menyentuh DB untuk body kosong");
});

test("PATCH JSON malformed -> 400, bukan 500", async () => {
  const res = await PATCH(req("{ nama tanpa quote: oops"), ctx());
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Data permintaan tidak valid.");
});

test("PATCH payload valid tetap berhasil (perilaku existing tidak berubah)", async () => {
  const res = await PATCH(req(JSON.stringify({ name: "Draft Baru", tin: "123" })), ctx());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { draft: { name: string; tin: string } };
  assert.equal(body.draft.name, "Draft Baru");
  assert.equal(body.draft.tin, "123");
  assert.equal(updateCoretaxDraftMock.mock.callCount(), 1);
});

test("PATCH draft tidak ditemukan -> 404 (perilaku existing tidak berubah)", async () => {
  const res = await PATCH(req(JSON.stringify({ name: "X" })), ctx("missing"));
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Draft tidak ditemukan.");
});

test("PATCH schema tidak valid (mis. status enum salah) -> 400 (perilaku existing tidak berubah)", async () => {
  const res = await PATCH(req(JSON.stringify({ rows: [{ rowId: "r1", values: {}, status: "not-a-status", errors: [] }] })), ctx());
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Data draft tidak valid.");
});
