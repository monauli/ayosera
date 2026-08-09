// Test unit Phase 3D.1 — Connection Health Monitoring. Memakai data/log sync
// yang SUDAH ADA (di-mock in-memory di sini, tidak pernah menyentuh AYO/Olsera
// atau MongoDB sungguhan). Jalankan: npm run test:private-integration-monitor
import assert from "node:assert/strict";
import { test, mock, before } from "node:test";

class FakeCursor<T> {
  constructor(private rows: T[]) {}
  sort() { return this; }
  limit() { return this; }
  async next() { return this.rows[0] ?? null; }
}
class FakeCollection<T extends Record<string, unknown>> {
  constructor(private rows: T[]) {}
  find(filter: Partial<T> = {}) {
    const matches = this.rows.filter((row) =>
      Object.entries(filter).every(([key, value]) => {
        if (value && typeof value === "object" && "$in" in (value as Record<string, unknown>)) {
          return (value as { $in: unknown[] }).$in.includes(row[key]);
        }
        return row[key] === value;
      }),
    );
    return new FakeCursor(matches.slice().sort((a, b) => (b.startedAt as Date).getTime() - (a.startedAt as Date).getTime()));
  }
  async findOne(filter: Partial<T> & { _id?: unknown } = {}) {
    return this.rows.find((row) => Object.entries(filter).every(([key, value]) => row[key] === value)) ?? null;
  }
}

let fakeCollections: Record<string, FakeCollection<any> | undefined> = {};
mock.module("@/lib/mongodb", {
  namedExports: {
    withMongo: async (fn: () => Promise<unknown>) => fn(),
    collections: async () => fakeCollections,
  },
});

let classifyConnectionIssue: typeof import("./connection-health.ts").classifyConnectionIssue;
let buildModuleHealth: typeof import("./connection-health.ts").buildModuleHealth;
let summarizeOlseraHealth: typeof import("./connection-health.ts").summarizeOlseraHealth;
let getAyoBookingHealth: typeof import("./connection-health.ts").getAyoBookingHealth;
let getAyoPaymentEventsHealth: typeof import("./connection-health.ts").getAyoPaymentEventsHealth;
let getOlseraSalesHealth: typeof import("./connection-health.ts").getOlseraSalesHealth;
let getOlseraInventoryHealth: typeof import("./connection-health.ts").getOlseraInventoryHealth;
let getOlseraFinancialHealth: typeof import("./connection-health.ts").getOlseraFinancialHealth;

before(async () => {
  const mod = await import("./connection-health.ts");
  classifyConnectionIssue = mod.classifyConnectionIssue;
  buildModuleHealth = mod.buildModuleHealth;
  summarizeOlseraHealth = mod.summarizeOlseraHealth;
  getAyoBookingHealth = mod.getAyoBookingHealth;
  getAyoPaymentEventsHealth = mod.getAyoPaymentEventsHealth;
  getOlseraSalesHealth = mod.getOlseraSalesHealth;
  getOlseraInventoryHealth = mod.getOlseraInventoryHealth;
  getOlseraFinancialHealth = mod.getOlseraFinancialHealth;
});

const NOW = new Date("2026-08-09T10:00:00.000Z");

// --- classifyConnectionIssue -----------------------------------------------

test("classifyConnectionIssue: 401/403 -> AKSES_API_BERMASALAH", () => {
  assert.equal(classifyConnectionIssue("HTTP 401 untuk /product: ..."), "AKSES_API_BERMASALAH");
  assert.equal(classifyConnectionIssue("Forbidden"), "AKSES_API_BERMASALAH");
});

test("classifyConnectionIssue: timeout -> TIMEOUT", () => {
  assert.equal(classifyConnectionIssue("Timeout memanggil /product"), "TIMEOUT");
  assert.equal(classifyConnectionIssue("request timed out"), "TIMEOUT");
});

test("classifyConnectionIssue: network/DNS -> TIDAK_BISA_TERHUBUNG", () => {
  assert.equal(classifyConnectionIssue("Gagal terhubung ke Olsera saat memanggil /product: fetch failed"), "TIDAK_BISA_TERHUBUNG");
  assert.equal(classifyConnectionIssue("ENOTFOUND api-open.olsera.co.id"), "TIDAK_BISA_TERHUBUNG");
});

test("classifyConnectionIssue: 5xx -> SERVER_SUMBER_BERMASALAH", () => {
  assert.equal(classifyConnectionIssue("HTTP 503 untuk /product: Service Unavailable"), "SERVER_SUMBER_BERMASALAH");
});

test("classifyConnectionIssue: respons rusak -> DATA_TIDAK_VALID", () => {
  assert.equal(classifyConnectionIssue("Respons tidak valid dari /product: Unexpected token < in JSON"), "DATA_TIDAK_VALID");
});

test("classifyConnectionIssue: tanpa error -> null", () => {
  assert.equal(classifyConnectionIssue(null), null);
  assert.equal(classifyConnectionIssue(""), null);
});

// --- buildModuleHealth -------------------------------------------------------

test("buildModuleHealth: tidak ada bukti sama sekali -> BELUM_ADA_DATA", () => {
  const result = buildModuleHealth("ayo-booking", "AYO Booking", { lastSuccessfulSyncAt: null, lastAttemptAt: null, lastError: null, now: NOW });
  assert.equal(result.status, "BELUM_ADA_DATA");
  assert.equal(result.issue, null);
});

test("buildModuleHealth: attempt terakhir sukses (tanpa error) -> TERHUBUNG", () => {
  const result = buildModuleHealth("ayo-booking", "AYO Booking", {
    lastSuccessfulSyncAt: new Date("2026-08-09T09:00:00Z"),
    lastAttemptAt: new Date("2026-08-09T09:00:00Z"),
    lastError: null,
    now: NOW,
  });
  assert.equal(result.status, "TERHUBUNG");
});

test("buildModuleHealth: attempt terakhir gagal setelah sukses sebelumnya -> BERMASALAH", () => {
  const result = buildModuleHealth("ayo-booking", "AYO Booking", {
    lastSuccessfulSyncAt: new Date("2026-08-08T09:00:00Z"),
    lastAttemptAt: new Date("2026-08-09T09:00:00Z"),
    lastError: "HTTP 401 untuk /bookings",
    now: NOW,
  });
  assert.equal(result.status, "BERMASALAH");
  assert.equal(result.issue, "AKSES_API_BERMASALAH");
});

test("buildModuleHealth: sukses lebih baru dari attempt gagal lama -> tetap TERHUBUNG (bukan riwayat error basi)", () => {
  const result = buildModuleHealth("ayo-booking", "AYO Booking", {
    lastSuccessfulSyncAt: new Date("2026-08-09T09:30:00Z"),
    lastAttemptAt: new Date("2026-08-09T09:00:00Z"),
    lastError: "HTTP 500 sementara kemarin",
    now: NOW,
  });
  assert.equal(result.status, "TERHUBUNG");
  assert.equal(result.lastError, null);
});

// --- Overall Olsera summary ---------------------------------------------

test("summarizeOlseraHealth: semua sehat -> TERHUBUNG", () => {
  const ok = buildModuleHealth("olsera-sales", "Sales", { lastSuccessfulSyncAt: NOW, lastAttemptAt: NOW, lastError: null, now: NOW });
  const result = summarizeOlseraHealth(ok, ok, ok);
  assert.equal(result.status, "TERHUBUNG");
  assert.deepEqual(result.problemModules, []);
});

test("summarizeOlseraHealth: satu modul bermasalah -> PERLU_DICEK dengan modul disebutkan", () => {
  const ok = buildModuleHealth("olsera-sales", "Sales", { lastSuccessfulSyncAt: NOW, lastAttemptAt: NOW, lastError: null, now: NOW });
  const bad = buildModuleHealth("olsera-inventory", "Inventory", {
    lastSuccessfulSyncAt: new Date("2026-08-01T00:00:00Z"),
    lastAttemptAt: NOW,
    lastError: "HTTP 401 untuk /product",
    now: NOW,
  });
  const result = summarizeOlseraHealth(ok, bad, ok);
  assert.equal(result.status, "PERLU_DICEK");
  assert.deepEqual(result.problemModules, ["olsera-inventory"]);
});

// --- Per-module DB readers (mocked collections) --------------------------

test("getAyoBookingHealth: healthy dari sync_logs existing", async () => {
  fakeCollections = {
    syncLogs: new FakeCollection([
      { type: "scheduled", status: "success", startedAt: new Date("2026-08-09T08:00:00Z"), errorMessage: undefined },
    ]),
  };
  const result = await getAyoBookingHealth(NOW);
  assert.equal(result.status, "TERHUBUNG");
});

test("getAyoBookingHealth: 401/403 -> BERMASALAH + AKSES_API_BERMASALAH", async () => {
  fakeCollections = {
    syncLogs: new FakeCollection([
      { type: "scheduled", status: "failed", startedAt: new Date("2026-08-09T09:00:00Z"), errorMessage: "AYO API request failed with status 401" },
      { type: "scheduled", status: "success", startedAt: new Date("2026-08-08T09:00:00Z"), errorMessage: undefined },
    ]),
  };
  const result = await getAyoBookingHealth(NOW);
  assert.equal(result.status, "BERMASALAH");
  assert.equal(result.issue, "AKSES_API_BERMASALAH");
});

test("getAyoBookingHealth: timeout -> BERMASALAH + TIMEOUT", async () => {
  fakeCollections = {
    syncLogs: new FakeCollection([
      { type: "scheduled", status: "failed", startedAt: new Date("2026-08-09T09:00:00Z"), errorMessage: "AYO API request timed out" },
    ]),
  };
  const result = await getAyoBookingHealth(NOW);
  assert.equal(result.status, "BERMASALAH");
  assert.equal(result.issue, "TIMEOUT");
});

test("getAyoBookingHealth: network/DNS -> BERMASALAH + TIDAK_BISA_TERHUBUNG", async () => {
  fakeCollections = {
    syncLogs: new FakeCollection([
      { type: "scheduled", status: "failed", startedAt: new Date("2026-08-09T09:00:00Z"), errorMessage: "fetch failed: ENOTFOUND api.ayo.co.id" },
    ]),
  };
  const result = await getAyoBookingHealth(NOW);
  assert.equal(result.status, "BERMASALAH");
  assert.equal(result.issue, "TIDAK_BISA_TERHUBUNG");
});

test("getAyoPaymentEventsHealth: token opaque tanpa bukti auth failure -> tidak pernah menyebut 'expired'/'Token Expired'", async () => {
  fakeCollections = {
    ayoPaymentEventSyncState: {
      async findOne() {
        return {
          lastSuccessfulSyncAt: new Date("2026-08-09T07:00:00Z"),
          lastAttemptAt: new Date("2026-08-09T07:00:00Z"),
          lastError: null,
        };
      },
    } as any,
  };
  const result = await getAyoPaymentEventsHealth(NOW);
  assert.equal(result.status, "TERHUBUNG");
  assert.doesNotMatch(JSON.stringify(result), /expired|kedaluwarsa/i);
});

test("getAyoPaymentEventsHealth: attempt terakhir gagal jaringan -> TIDAK_BISA_TERHUBUNG, bukan 'expired'", async () => {
  fakeCollections = {
    ayoPaymentEventSyncState: {
      async findOne() {
        return {
          lastSuccessfulSyncAt: new Date("2026-08-08T07:00:00Z"),
          lastAttemptAt: new Date("2026-08-09T07:00:00Z"),
          lastError: "fetch failed: ECONNREFUSED",
        };
      },
    } as any,
  };
  const result = await getAyoPaymentEventsHealth(NOW);
  assert.equal(result.status, "BERMASALAH");
  assert.equal(result.issue, "TIDAK_BISA_TERHUBUNG");
  assert.doesNotMatch(JSON.stringify(result), /expired|kedaluwarsa/i);
});

test("getOlseraSalesHealth: healthy dari olsera_sync_log existing", async () => {
  fakeCollections = {
    olseraSyncLog: new FakeCollection([
      { status: "success", startedAt: new Date("2026-08-09T06:00:00Z"), errorMessage: null },
    ]),
  };
  const result = await getOlseraSalesHealth(NOW);
  assert.equal(result.status, "TERHUBUNG");
});

test("getOlseraSalesHealth: error terakhir -> BERMASALAH", async () => {
  fakeCollections = {
    olseraSyncLog: new FakeCollection([
      { status: "failed", startedAt: new Date("2026-08-09T06:00:00Z"), errorMessage: "HTTP 500 untuk /order" },
    ]),
  };
  const result = await getOlseraSalesHealth(NOW);
  assert.equal(result.status, "BERMASALAH");
  assert.equal(result.issue, "SERVER_SUMBER_BERMASALAH");
});

test("getOlseraInventoryHealth: 401/403 -> AKSES_API_BERMASALAH", async () => {
  fakeCollections = {
    olseraInventorySyncRuns: new FakeCollection([
      { status: "failed", startedAt: new Date("2026-08-09T06:00:00Z"), completedAt: null, errorMessage: "HTTP 403 untuk /product: Forbidden" },
    ]),
  };
  const result = await getOlseraInventoryHealth(NOW);
  assert.equal(result.status, "BERMASALAH");
  assert.equal(result.issue, "AKSES_API_BERMASALAH");
});

test("getOlseraInventoryHealth: timeout -> TIMEOUT", async () => {
  fakeCollections = {
    olseraInventorySyncRuns: new FakeCollection([
      { status: "failed", startedAt: new Date("2026-08-09T06:00:00Z"), completedAt: null, errorMessage: "Timeout memanggil /product" },
    ]),
  };
  const result = await getOlseraInventoryHealth(NOW);
  assert.equal(result.status, "BERMASALAH");
  assert.equal(result.issue, "TIMEOUT");
});

test("getOlseraInventoryHealth: network error -> TIDAK_BISA_TERHUBUNG", async () => {
  fakeCollections = {
    olseraInventorySyncRuns: new FakeCollection([
      { status: "failed", startedAt: new Date("2026-08-09T06:00:00Z"), completedAt: null, errorMessage: "Gagal terhubung ke Olsera saat memanggil /product: fetch failed" },
    ]),
  };
  const result = await getOlseraInventoryHealth(NOW);
  assert.equal(result.status, "BERMASALAH");
  assert.equal(result.issue, "TIDAK_BISA_TERHUBUNG");
});

test("getOlseraFinancialHealth: healthy dari olsera_financial_sync_logs existing", async () => {
  fakeCollections = {
    olseraFinancialSyncLogs: new FakeCollection([
      { status: "success", startedAt: new Date("2026-08-09T05:00:00Z"), completedAt: new Date("2026-08-09T05:05:00Z"), errorMessage: null },
    ]),
  };
  const result = await getOlseraFinancialHealth(NOW);
  assert.equal(result.status, "TERHUBUNG");
});

test("getOlseraFinancialHealth: error terakhir -> BERMASALAH", async () => {
  fakeCollections = {
    olseraFinancialSyncLogs: new FakeCollection([
      { status: "failed", startedAt: new Date("2026-08-09T05:00:00Z"), completedAt: null, errorMessage: "HTTP 401 untuk account/ledger2" },
    ]),
  };
  const result = await getOlseraFinancialHealth(NOW);
  assert.equal(result.status, "BERMASALAH");
  assert.equal(result.issue, "AKSES_API_BERMASALAH");
});

// --- Secrets never surface in module health output ------------------------

test("ModuleHealth tidak pernah membawa field token/secret/Authorization/Mongo URI", async () => {
  fakeCollections = {
    syncLogs: new FakeCollection([
      { type: "scheduled", status: "failed", startedAt: new Date("2026-08-09T09:00:00Z"), errorMessage: "HTTP 401 untuk /bookings: Authorization Bearer abc123secret" },
    ]),
  };
  const result = await getAyoBookingHealth(NOW);
  const keys = Object.keys(result);
  for (const forbidden of ["token", "secret", "privateKey", "mongoUri", "authorization"]) {
    assert.ok(!keys.some((k) => k.toLowerCase() === forbidden.toLowerCase()), `field ${forbidden} tidak boleh ada di ModuleHealth`);
  }
});
