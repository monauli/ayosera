// Route-level test untuk POST .../finalization/hide-history-entry (V11).
// Pola sama seperti ../cleanup-upload-history/route.test.ts: requireSupervisor()
// dan hideOmzetPeriodHistoryEntry di-mock lewat --experimental-test-module-mocks
// SEBELUM route diimpor, jadi TIDAK PERNAH menyentuh MongoDB sungguhan.
// actor id fixture SENGAJA bukan ObjectId valid ("supervisor-1") supaya
// attachActorDisplayNames (lib/reconciliation-actor-display.ts) short-circuit
// tanpa perlu mock terpisah.
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";
import { OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock.ts";

process.env.OLSERA_INTERNAL_STORE_ID = "1";

const hiddenDoc = {
  status: "draft" as const,
  version: 4,
  attachment: { fileName: "revisi.pdf", mimeType: "application/pdf", size: 3, url: "https://blob.vercel-storage.com/x", uploadedAt: new Date(), uploadedBy: "supervisor-1" },
  history: [
    { action: "upload", actor: "supervisor-1", timestamp: new Date(), reason: null, before: {}, after: { fileName: "lama.pdf" }, hiddenAt: new Date(), hiddenBy: "supervisor-1" },
    { action: "preview", actor: "supervisor-1", timestamp: new Date(), reason: "Pembulatan", before: {}, after: {}, hiddenAt: null, hiddenBy: null },
  ],
};
const hideMock = mock.fn(async (input: { expectedVersion: unknown; entryIndex: unknown }) => {
  if (input.expectedVersion !== 3) throw new OmzetPeriodLockError("Konflik menyembunyikan riwayat; muat ulang lalu coba lagi.", "CONFLICT");
  if (input.entryIndex !== 0) throw new OmzetPeriodLockError("Entri riwayat tidak ditemukan.", "NOT_FOUND");
  return hiddenDoc;
});
mock.module("@/lib/reconciliation-omzet-period-lock", { namedExports: { hideOmzetPeriodHistoryEntry: hideMock, OmzetPeriodLockError } });

let supervisorRejects = false;
const requireSupervisorMock = mock.fn(async () => {
  if (supervisorRejects) {
    throw new Response(JSON.stringify({ error: "Supervisor access required" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
  return { id: "supervisor-1", role: "supervisor" as const, allowedModules: [] as string[] };
});
mock.module("@/lib/auth", { namedExports: { requireSupervisor: requireSupervisorMock } });

let POST!: typeof import("./route.ts").POST;
before(async () => {
  ({ POST } = await import("./route.ts"));
});

function req(body: unknown, period = "2026-06") {
  return {
    request: new Request(`http://localhost/api/reconciliation/court-revenue/${period}/finalization/hide-history-entry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    ctx: { params: Promise.resolve({ period }) },
  };
}

test.beforeEach(() => {
  supervisorRejects = false;
  hideMock.mock.resetCalls();
});

test("test wajib #22/#25: supervisor dengan version+entryIndex valid -> 200, entri jadi hiddenAt terisi, entri lain tidak berubah", async () => {
  const { request, ctx } = req({ version: 3, entryIndex: 0 });
  const res = await POST(request, ctx);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: typeof hiddenDoc };
  assert.ok(body.data.history[0].hiddenAt, "entri index 0 harus hiddenAt terisi");
  assert.equal(body.data.history[1].hiddenAt, null, "entri lain tidak boleh ikut disembunyikan");
  assert.equal(hideMock.mock.callCount(), 1);
});

test("test wajib #23/#24: non-supervisor ditolak -> 403, TIDAK memanggil hide lib", async () => {
  supervisorRejects = true;
  const { request, ctx } = req({ version: 3, entryIndex: 0 });
  const res = await POST(request, ctx);
  assert.equal(res.status, 403);
  assert.equal(hideMock.mock.callCount(), 0);
});

test("test wajib #28: response tidak pernah menyertakan raw actor id sebagai satu-satunya identitas — history[].actorName selalu ada", async () => {
  const { request, ctx } = req({ version: 3, entryIndex: 0 });
  const res = await POST(request, ctx);
  const body = (await res.json()) as { data: { history: Array<{ actor: string; actorName?: string }> } };
  for (const entry of body.data.history) {
    assert.ok(entry.actorName, `history entry ${JSON.stringify(entry)} harus punya actorName`);
  }
});

test("versi konflik (data sudah berubah) -> 409", async () => {
  const { request, ctx } = req({ version: 999, entryIndex: 0 });
  const res = await POST(request, ctx);
  assert.equal(res.status, 409);
});

test("entryIndex tidak ditemukan -> 404", async () => {
  const { request, ctx } = req({ version: 3, entryIndex: 99 });
  const res = await POST(request, ctx);
  assert.equal(res.status, 404);
});

test("format periode tidak valid -> 400, TIDAK memanggil hide lib", async () => {
  const { request, ctx } = req({ version: 3, entryIndex: 0 }, "2026-6");
  const res = await POST(request, ctx);
  assert.equal(res.status, 400);
  assert.equal(hideMock.mock.callCount(), 0);
});
