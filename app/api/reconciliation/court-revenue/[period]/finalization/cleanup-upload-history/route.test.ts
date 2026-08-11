// Route-level test untuk POST .../finalization/cleanup-upload-history (V10).
// Pola sama seperti ../unlock/route.test.ts: requireSupervisor() dan
// cleanupOmzetPeriodUploadHistory di-mock lewat --experimental-test-module-mocks
// SEBELUM route diimpor, jadi TIDAK PERNAH menyentuh MongoDB sungguhan.
// actor id fixture SENGAJA bukan ObjectId valid ("supervisor-1") supaya
// attachActorDisplayNames (lib/reconciliation-actor-display.ts) short-circuit
// tanpa perlu mock terpisah (persis pola ../unlock/route.test.ts).
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";
import { OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock.ts";

process.env.OLSERA_INTERNAL_STORE_ID = "1";

const cleanedDoc = {
  status: "draft" as const,
  version: 3,
  attachment: { fileName: "revisi.pdf", mimeType: "application/pdf", size: 3, url: "https://blob.vercel-storage.com/x", uploadedAt: new Date(), uploadedBy: "supervisor-1" },
  history: [
    { action: "upload", actor: "supervisor-1", timestamp: new Date(), reason: null, before: {}, after: { fileName: "revisi.pdf" } },
    { action: "preview", actor: "supervisor-1", timestamp: new Date(), reason: "Pembulatan", before: {}, after: {} },
  ],
};
const cleanupMock = mock.fn(async (input: { expectedVersion: unknown }) => {
  if (input.expectedVersion !== 2) throw new OmzetPeriodLockError("Konflik pembersihan riwayat; muat ulang lalu coba lagi.", "CONFLICT");
  return { lock: cleanedDoc, removedCount: 1 };
});
mock.module("@/lib/reconciliation-omzet-period-lock", { namedExports: { cleanupOmzetPeriodUploadHistory: cleanupMock, OmzetPeriodLockError } });

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
    request: new Request(`http://localhost/api/reconciliation/court-revenue/${period}/finalization/cleanup-upload-history`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    ctx: { params: Promise.resolve({ period }) },
  };
}

test.beforeEach(() => {
  supervisorRejects = false;
  cleanupMock.mock.resetCalls();
});

test("test wajib #10: supervisor dengan version valid -> 200, memanggil cleanupOmzetPeriodUploadHistory, mengembalikan removedCount", async () => {
  const { request, ctx } = req({ version: 2 });
  const res = await POST(request, ctx);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: typeof cleanedDoc; removedCount: number };
  assert.equal(body.removedCount, 1);
  assert.equal(body.data.history.filter((e) => e.action === "upload").length, 1);
  assert.equal(cleanupMock.mock.callCount(), 1);
});

test("test wajib #11: non-supervisor ditolak -> 403, TIDAK memanggil cleanup lib", async () => {
  supervisorRejects = true;
  const { request, ctx } = req({ version: 2 });
  const res = await POST(request, ctx);
  assert.equal(res.status, 403);
  assert.equal(cleanupMock.mock.callCount(), 0);
});

test("test wajib #18: response tidak pernah menyertakan raw actor id sebagai satu-satunya identitas — history[].actorName selalu ada", async () => {
  const { request, ctx } = req({ version: 2 });
  const res = await POST(request, ctx);
  const body = (await res.json()) as { data: { history: Array<{ actor: string; actorName?: string }> } };
  for (const entry of body.data.history) {
    assert.ok(entry.actorName, `history entry ${JSON.stringify(entry)} harus punya actorName`);
  }
});

test("versi konflik (data sudah berubah) -> 409", async () => {
  const { request, ctx } = req({ version: 999 });
  const res = await POST(request, ctx);
  assert.equal(res.status, 409);
});

test("format periode tidak valid -> 400, TIDAK memanggil cleanup lib", async () => {
  const { request, ctx } = req({ version: 2 }, "2026-6");
  const res = await POST(request, ctx);
  assert.equal(res.status, 400);
  assert.equal(cleanupMock.mock.callCount(), 0);
});
