// Route-level test untuk POST .../finalization/reset (V12).
// Pola sama seperti ../hide-history-entry/route.test.ts: requireSupervisor()
// dan resetOmzetPeriodFinalization di-mock lewat --experimental-test-module-mocks
// SEBELUM route diimpor, jadi TIDAK PERNAH menyentuh MongoDB sungguhan.
// actor id fixture SENGAJA bukan ObjectId valid ("supervisor-1") supaya
// attachActorDisplayNames (lib/reconciliation-actor-display.ts) short-circuit
// tanpa perlu mock terpisah.
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";
import { OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock.ts";

process.env.OLSERA_INTERNAL_STORE_ID = "1";

const resetDoc = {
  status: "draft" as const,
  version: 5,
  attachment: null,
  verifiedMatchStatus: null,
  beritaAcaraNominal: null,
  beritaAcaraDirection: null,
  finalAgreedAmount: null,
  adjustmentAmount: null,
  adjustmentReason: null,
  history: [
    { action: "upload", actor: "supervisor-1", timestamp: new Date(), reason: null, before: {}, after: {}, hiddenAt: new Date(), hiddenBy: "supervisor-1" },
    { action: "reset", actor: "supervisor-1", timestamp: new Date(), reason: null, before: {}, after: {}, hiddenAt: null, hiddenBy: null },
  ],
};
const resetMock = mock.fn(async (input: { expectedVersion: unknown }) => {
  if (input.expectedVersion === 999) throw new OmzetPeriodLockError("Konflik reset finalisasi; muat ulang lalu coba lagi.", "CONFLICT");
  if (input.expectedVersion === 404) throw new OmzetPeriodLockError("Periode tidak ditemukan.", "NOT_FOUND");
  if (input.expectedVersion === 423) throw new OmzetPeriodLockError("Periode terkunci; buka kunci terlebih dahulu sebelum reset.", "LOCKED");
  return resetDoc;
});
mock.module("@/lib/reconciliation-omzet-period-lock", { namedExports: { resetOmzetPeriodFinalization: resetMock, OmzetPeriodLockError } });

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
    request: new Request(`http://localhost/api/reconciliation/court-revenue/${period}/finalization/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    ctx: { params: Promise.resolve({ period }) },
  };
}

test.beforeEach(() => {
  supervisorRejects = false;
  resetMock.mock.resetCalls();
});

test("test wajib #19: supervisor dengan version valid -> 200, active state kosong, memanggil resetOmzetPeriodFinalization", async () => {
  const { request, ctx } = req({ version: 2 });
  const res = await POST(request, ctx);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: typeof resetDoc };
  assert.equal(body.data.status, "draft");
  assert.equal(body.data.attachment, null);
  assert.equal(body.data.verifiedMatchStatus, null);
  assert.equal(body.data.beritaAcaraNominal, null);
  assert.equal(body.data.beritaAcaraDirection, null);
  assert.equal(body.data.finalAgreedAmount, null);
  assert.equal(body.data.adjustmentReason, null);
  assert.equal(resetMock.mock.callCount(), 1);
});

test("test wajib #19: non-supervisor ditolak -> 403, TIDAK memanggil reset lib", async () => {
  supervisorRejects = true;
  const { request, ctx } = req({ version: 2 });
  const res = await POST(request, ctx);
  assert.equal(res.status, 403);
  assert.equal(resetMock.mock.callCount(), 0);
});

test("response tidak pernah menyertakan raw actor id sebagai satu-satunya identitas — history[].actorName selalu ada", async () => {
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

test("periode tidak ditemukan -> 404", async () => {
  const { request, ctx } = req({ version: 404 });
  const res = await POST(request, ctx);
  assert.equal(res.status, 404);
});

test("periode sedang locked -> 423, harus buka kunci dulu", async () => {
  const { request, ctx } = req({ version: 423 });
  const res = await POST(request, ctx);
  assert.equal(res.status, 423);
});

test("format periode tidak valid -> 400, TIDAK memanggil reset lib", async () => {
  const { request, ctx } = req({ version: 2 }, "2026-6");
  const res = await POST(request, ctx);
  assert.equal(res.status, 400);
  assert.equal(resetMock.mock.callCount(), 0);
});
