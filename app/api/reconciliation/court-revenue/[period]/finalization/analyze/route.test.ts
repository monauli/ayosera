// Test route .../finalization/analyze — semua dependency (auth, ledger,
// lock lib, OCR) di-mock lewat --experimental-test-module-mocks sebelum
// route diimpor. TIDAK PERNAH melakukan fetch jaringan atau OCR sungguhan.
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

process.env.OLSERA_INTERNAL_STORE_ID = "1";

let supervisorRejects = false;
mock.module("@/lib/auth", {
  namedExports: {
    requireSupervisor: mock.fn(async () => {
      if (supervisorRejects) throw new Response(JSON.stringify({ error: "Supervisor access required" }), { status: 403 });
      return { id: "supervisor-1", role: "supervisor" as const, allowedModules: [] as string[] };
    }),
  },
});

let ledgerDifference = 740_000;
mock.module("@/lib/reconciliation-omzet-ledger", {
  namedExports: {
    loadOmzetLedgerMonthDetail: mock.fn(async () => ({ ayo: { revenue: 1_000_000, count: 1 }, olseraTotal: 1_000_000 + ledgerDifference, differenceRevenue: ledgerDifference })),
  },
});

let lockAttachment: { url: string; mimeType: string; fileName: string } | null = { url: "https://blob.example/ba.pdf", mimeType: "application/pdf", fileName: "ba.pdf" };
mock.module("@/lib/reconciliation-omzet-period-lock", {
  namedExports: {
    getOmzetPeriodLock: mock.fn(async () => (lockAttachment ? { attachment: lockAttachment } : null)),
  },
});

let ocrText = "Berita Acara PENAMBAHAN Rp740.000. Alasan: advance payment received in March recognized as March revenue";
let ocrConfidence = 1;
let ocrThrows = false;
mock.module("@/lib/reconciliation-berita-acara-ocr", {
  namedExports: {
    extractBeritaAcaraText: mock.fn(async () => {
      if (ocrThrows) throw new Error("boom");
      return { text: ocrText, confidence: ocrConfidence, source: "pdf-text-layer" as const };
    }),
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;

let POST!: typeof import("./route.ts").POST;
before(async () => {
  ({ POST } = await import("./route.ts"));
});

function ctx(period = "2026-03") {
  return { params: Promise.resolve({ period }) };
}

test.beforeEach(() => {
  supervisorRejects = false;
  ledgerDifference = 740_000;
  lockAttachment = { url: "https://blob.example/ba.pdf", mimeType: "application/pdf", fileName: "ba.pdf" };
  ocrText = "Berita Acara PENAMBAHAN Rp740.000. Alasan: advance payment received in March recognized as March revenue";
  ocrConfidence = 1;
  ocrThrows = false;
});

test.after(() => {
  globalThis.fetch = realFetch;
});

test("Maret: PENAMBAHAN Rp740.000 vs systemDifference +740000 -> COCOK", async () => {
  const res = await POST(new Request("http://localhost"), ctx("2026-03"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { matchStatus: string; nominal: number; direction: string } };
  assert.equal(body.data.matchStatus, "COCOK");
  assert.equal(body.data.nominal, 740_000);
  assert.equal(body.data.direction, "PENAMBAHAN");
});

test("April: PENGURANGAN Rp740.000 vs systemDifference -739999 -> COCOK (toleransi Rp1)", async () => {
  ledgerDifference = -739_999;
  ocrText = "Berita Acara PENGURANGAN Rp740.000. Alasan: koreksi pengakuan pendapatan advance payment.";
  const res = await POST(new Request("http://localhost"), ctx("2026-04"));
  const body = (await res.json()) as { data: { matchStatus: string } };
  assert.equal(body.data.matchStatus, "COCOK");
});

test("belum ada attachment -> 404", async () => {
  lockAttachment = null;
  const res = await POST(new Request("http://localhost"), ctx());
  assert.equal(res.status, 404);
});

test("non-supervisor -> 403", async () => {
  supervisorRejects = true;
  const res = await POST(new Request("http://localhost"), ctx());
  assert.equal(res.status, 403);
});

test("OCR gagal -> 200 dengan parseStatus/matchStatus PERLU_REVIEW (bukan blokir total)", async () => {
  ocrThrows = true;
  const res = await POST(new Request("http://localhost"), ctx());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { parseStatus: string; matchStatus: string } };
  assert.equal(body.data.parseStatus, "PERLU_REVIEW");
  assert.equal(body.data.matchStatus, "PERLU_REVIEW");
});

test("confidence OCR rendah -> PERLU_REVIEW walau teks lengkap", async () => {
  ocrConfidence = 0.1;
  const res = await POST(new Request("http://localhost"), ctx());
  const body = (await res.json()) as { data: { parseStatus: string; matchStatus: string } };
  assert.equal(body.data.parseStatus, "PERLU_REVIEW");
  assert.equal(body.data.matchStatus, "PERLU_REVIEW");
});
