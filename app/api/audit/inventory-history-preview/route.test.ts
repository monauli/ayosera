// Route-level test untuk GET /api/audit/inventory-history-preview (Phase 4/5/6).
// Membuktikan: YONEX & ODEA ROSE preview query KEDUA id (old+new/canonical) dan
// mengekspos evidence per id secara terpisah (tidak sekadar newId); ODEA RED
// tidak pernah tergabung ke alias ROSE; ODEA ROSE Feb (opening96/sales30/
// closing130) tetap INCONSISTENT dengan unresolvedGap +64 eksplisit TIDAK
// proven; ODEA ROSE Jul (21+24-11-2=32) tetap CONSISTENT. Semua dependency
// di-mock via --experimental-test-module-mocks, TIDAK PERNAH menyentuh Mongo.
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

function collectionStub(rows: unknown[]) {
  return { find: () => ({ project: () => ({ toArray: async () => rows }) }) };
}

const YONEX_OLD = 106743815;
const YONEX_NEW = 118420650;
const ROSE_OLD = 106817649;
const ROSE_CANONICAL = 116138490;
const RED_ID = 119043265;

let snapshotRows: Array<Record<string, unknown>> = [];
let movementRows: Array<Record<string, unknown>> = [];
let salesRows: Array<Record<string, unknown>> = [];
let aliasRows: Array<Record<string, unknown>> = [];
let opnameRows: Array<Record<string, unknown>> = [];

mock.module("@/lib/auth", { namedExports: { requireModule: mock.fn(async () => ({ id: "u1", role: "user" as const, allowedModules: ["audit"] })) } });
mock.module("@/lib/mongodb", {
  namedExports: {
    withMongo: async (handler: () => Promise<unknown>) => handler(),
    collections: async () => ({
      olseraInventoryMonthlySnapshots: collectionStub(snapshotRows),
      olseraInventoryMovements: collectionStub(movementRows),
      olseraOrderItems: collectionStub(salesRows),
      olseraProductAliases: collectionStub(aliasRows),
      inventoryStockOpnameReconciliations: collectionStub(opnameRows),
    }),
  },
});

let GET!: typeof import("./route.ts").GET;
before(async () => {
  ({ GET } = await import("./route.ts"));
});

test.beforeEach(() => {
  snapshotRows = [];
  movementRows = [];
  salesRows = [];
  aliasRows = [];
  opnameRows = [];
});

test("YONEX: identitySources melaporkan oldId dan newId terpisah, bukan hanya newId", async () => {
  snapshotRows = [{ productId: YONEX_NEW, variantId: null, productName: "YONEX SHORTS MEN", year: 2026, month: 4, openingQty: 8, incomingQty: 0, returnQty: 0, salesQty: 2, outgoingQty: 0, closingQty: 6 }];
  const res = await GET();
  const body = (await res.json()) as { identitySources: Array<{ key: string; sources: Array<{ productId: number; snapshotPeriods: string[] }> }> };
  const yonex = body.identitySources.find((t) => t.key === "yonex")!;
  assert.equal(yonex.sources.length, 2);
  const oldSource = yonex.sources.find((s) => s.productId === YONEX_OLD)!;
  const newSource = yonex.sources.find((s) => s.productId === YONEX_NEW)!;
  assert.deepEqual(oldSource.snapshotPeriods, [], "oldId tanpa snapshot dokumen harus terlihat eksplisit kosong, bukan disembunyikan");
  assert.deepEqual(newSource.snapshotPeriods, ["2026-04"]);
});

test("ODEA ROSE: identitySources melaporkan oldId dan canonicalId terpisah", async () => {
  snapshotRows = [{ productId: ROSE_CANONICAL, variantId: null, productName: "ODEA ROSE", year: 2026, month: 2, openingQty: 96, incomingQty: 0, returnQty: 0, salesQty: 30, outgoingQty: 0, closingQty: 130 }];
  aliasRows = [{ oldProductId: ROSE_OLD, newProductId: ROSE_CANONICAL, confidence: "verified" }];
  const res = await GET();
  const body = (await res.json()) as { identitySources: Array<{ key: string; sources: Array<{ productId: number }>; verifiedAliases: Array<{ oldProductId: number; newProductId: number }> }> };
  const rose = body.identitySources.find((t) => t.key === "odea-rose")!;
  assert.deepEqual(rose.sources.map((s) => s.productId).sort(), [ROSE_OLD, ROSE_CANONICAL].sort());
  assert.equal(rose.verifiedAliases.length, 1);
  assert.equal(rose.verifiedAliases[0].oldProductId, ROSE_OLD);
});

test("ODEA RED tetap terpisah — tidak pernah masuk verifiedAliases ROSE", async () => {
  aliasRows = [{ oldProductId: ROSE_OLD, newProductId: ROSE_CANONICAL, confidence: "verified" }];
  const res = await GET();
  const body = (await res.json()) as { identitySources: Array<{ key: string; sources: Array<{ productId: number }>; verifiedAliases: unknown[] }> };
  const red = body.identitySources.find((t) => t.key === "odea-red")!;
  assert.deepEqual(red.sources.map((s) => s.productId), [RED_ID]);
  assert.equal(red.verifiedAliases.length, 0, "alias ROSE tidak boleh terhitung sebagai alias RED");
});

test("ODEA ROSE Feb (opening96/sales30/closing130): INCONSISTENT dengan unresolvedGap +64, bukan proven adjustment", async () => {
  snapshotRows = [{ productId: ROSE_CANONICAL, variantId: null, productName: "ODEA ROSE", year: 2026, month: 2, openingQty: 96, incomingQty: 0, returnQty: 0, salesQty: 30, outgoingQty: 0, closingQty: 130 }];
  const res = await GET();
  const body = (await res.json()) as { products: Array<{ period: string; classification: string; expectedClosing: number; unresolvedGap: number | null }> };
  const feb = body.products.find((p) => p.period === "2026-02")!;
  assert.equal(feb.classification, "INCONSISTENT");
  assert.equal(feb.expectedClosing, 66);
  assert.equal(feb.unresolvedGap, 64);
});

test("ODEA ROSE Jul (21+24-11-2=32): tetap CONSISTENT, unresolvedGap null", async () => {
  snapshotRows = [{ productId: ROSE_CANONICAL, variantId: null, productName: "ODEA ROSE", year: 2026, month: 7, openingQty: 21, incomingQty: 24, returnQty: 0, salesQty: 11, outgoingQty: 2, closingQty: 32 }];
  const res = await GET();
  const body = (await res.json()) as { products: Array<{ period: string; classification: string; expectedClosing: number; unresolvedGap: number | null }> };
  const jul = body.products.find((p) => p.period === "2026-07")!;
  assert.equal(jul.classification, "CONSISTENT");
  assert.equal(jul.expectedClosing, 32);
  assert.equal(jul.unresolvedGap, null);
});
