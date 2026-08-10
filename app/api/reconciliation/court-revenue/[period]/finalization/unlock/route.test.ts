// Route-level test untuk POST .../finalization/unlock. Pola sama seperti
// ../upload/route.test.ts: requireSupervisor() dan unlockOmzetPeriodFinalization
// di-mock lewat --experimental-test-module-mocks SEBELUM route diimpor, jadi
// TIDAK PERNAH menyentuh MongoDB sungguhan. OmzetPeriodLockError TETAP
// implementasi ASLI supaya pemetaan status code (400/409) sungguhan yang diuji.
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";
import { OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock.ts";

process.env.OLSERA_INTERNAL_STORE_ID = "1";

const unlockedDoc = {
  status: "unlocked" as const,
  version: 4,
  attachment: { fileName: "berita-acara.pdf", mimeType: "application/pdf", size: 3, url: "https://blob.vercel-storage.com/x", uploadedAt: new Date(), uploadedBy: "supervisor-1" },
  history: [{ action: "lock", actor: "supervisor-1", timestamp: new Date(), reason: "Pembulatan", before: {}, after: {} }, { action: "unlock", actor: "supervisor-1", timestamp: new Date(), reason: "Perlu koreksi", before: {}, after: {} }],
};
const unlockMock = mock.fn(async (input: { reason: unknown }) => {
  if (typeof input.reason !== "string" || !input.reason.trim()) throw new OmzetPeriodLockError("Alasan buka kunci wajib diisi.");
  return unlockedDoc;
});
mock.module("@/lib/reconciliation-omzet-period-lock", { namedExports: { unlockOmzetPeriodFinalization: unlockMock, OmzetPeriodLockError } });

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
    request: new Request(`http://localhost/api/reconciliation/court-revenue/${period}/finalization/unlock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    ctx: { params: Promise.resolve({ period }) },
  };
}

test.beforeEach(() => {
  supervisorRejects = false;
  unlockMock.mock.resetCalls();
});

test("supervisor dengan alasan valid -> 200, memanggil unlockOmzetPeriodFinalization", async () => {
  const { request, ctx } = req({ version: 3, reason: "Perlu koreksi nominal" });
  const res = await POST(request, ctx);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: typeof unlockedDoc };
  assert.equal(body.data.status, "unlocked");
  assert.equal(unlockMock.mock.callCount(), 1);
});

test("non-supervisor ditolak -> 403, TIDAK memanggil unlock lib", async () => {
  supervisorRejects = true;
  const { request, ctx } = req({ version: 3, reason: "Perlu koreksi" });
  const res = await POST(request, ctx);
  assert.equal(res.status, 403);
  assert.equal(unlockMock.mock.callCount(), 0);
});

test("alasan kosong -> 400", async () => {
  const { request, ctx } = req({ version: 3, reason: "   " });
  const res = await POST(request, ctx);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /[Aa]lasan/);
});

test("format periode tidak valid -> 400, TIDAK memanggil unlock lib", async () => {
  const { request, ctx } = req({ version: 3, reason: "Alasan" }, "2026-6");
  const res = await POST(request, ctx);
  assert.equal(res.status, 400);
  assert.equal(unlockMock.mock.callCount(), 0);
});
