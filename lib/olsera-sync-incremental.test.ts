// Test unit mode incremental syncOlseraSalesByCategory (lib/olsera-sync.ts):
// hari dengan 50 order, 45 sudah tersimpan dengan nominal Order List yang sama
// (di-skip), 5 baru/berubah (ditarik) -> HANYA 5 request Close Order Detail.
// Pola mocking modul SAMA dengan lib/cron-olsera-financial.test.ts (node:test
// module mocking); API Olsera dipalsukan lewat mock global fetch.
// Jalankan: npm run test:olsera-sync-incremental
import assert from "node:assert/strict";
import { test, mock, before } from "node:test";

process.env.OLSERA_INTERNAL_STORE_ID = "324175";

const DATE = "2026-09-02";
const ORDER_COUNT = 50;
const orderTotal = (id: number) => 1000 * id;

// ---- Fake koleksi MongoDB (in-memory, hanya method yang dipakai sync) ----
type Doc = Record<string, unknown>;
const itemsUpdateManyMock = mock.fn(async (_filter: Doc, _update: Doc) => ({ modifiedCount: 0 }));
const itemsDeleteManyMock = mock.fn(async (_filter: Doc) => ({ deletedCount: 0 }));
const itemsBulkWriteMock = mock.fn(async (_ops: unknown[]) => ({ ok: 1 }));
const categoryBulkWriteMock = mock.fn(async (_ops: unknown[]) => ({ ok: 1 }));
let storedItems: Doc[] = [];
const fakeCollections = {
  olseraOrderItems: {
    find: (_filter: Doc, _options?: Doc) => ({ toArray: async () => storedItems }),
    bulkWrite: itemsBulkWriteMock,
    updateMany: itemsUpdateManyMock,
    deleteMany: itemsDeleteManyMock,
  },
  olseraSalesByCategory: { bulkWrite: categoryBulkWriteMock, deleteMany: async () => ({ deletedCount: 0 }) },
  olseraSalesCorrections: { find: () => ({ toArray: async () => [] }) },
  olseraSyncedDays: { find: () => ({ toArray: async () => [] }), updateOne: async () => ({}) },
  olseraSyncLog: { insertOne: async () => ({}) },
  olseraSyncState: { findOne: async () => null, updateOne: async () => ({}) },
  olseraProductCache: { updateOne: async () => ({}) },
};
mock.module("@/lib/mongodb", {
  namedExports: {
    withMongo: async <T>(handler: () => Promise<T>) => handler(),
    collections: async () => fakeCollections,
  },
});
mock.module("@/lib/olsera", { namedExports: { getAccessToken: async () => ({ token: "test-token" }) } });
mock.module("@/lib/olsera-resolver-context", { namedExports: { loadResolverContext: async () => ({ ctx: {}, cacheHit: true }) } });
mock.module("@/lib/olsera-category-resolver", {
  namedExports: {
    emptyResolutionStats: () => ({}),
    normalizeKlasifikasi: (value: string) => value,
    normalizeName: (value: string) => value,
    tallyResolution: () => undefined,
    resolveItemCategory: () => ({ status: "resolved", method: "product-id", category: "MINUMAN", categoryId: null, resolvedProductId: 7, resolvedVariantId: null, reason: null }),
  },
});

// ---- Fake API Olsera lewat global fetch ----
let detailRequests: number[] = [];
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  if (url.pathname.endsWith("/order/closeorder/detail")) {
    const id = Number(url.searchParams.get("id"));
    detailRequests.push(id);
    return jsonResponse({ data: { order_no: `INV-${id}`, order_time: `${DATE} 10:00:00`, orderitems: [{ id: id * 100, product_id: 7, product_name: "Es Teh", qty: 1, amount: orderTotal(id), cost_amount: 100, discount: 0 }] } });
  }
  if (url.pathname.endsWith("/order/closeorder")) {
    return jsonResponse({ data: Array.from({ length: ORDER_COUNT }, (_, i) => ({ id: i + 1, total_amount: String(orderTotal(i + 1)) })), meta: { last_page: 1 } });
  }
  if (url.pathname.endsWith("/order/openorder")) return new Response("not found", { status: 404 });
  throw new Error(`fetch tak terduga: ${url.pathname}`);
});

let syncOlseraSalesByCategory: typeof import("./olsera-sync.ts").syncOlseraSalesByCategory;
before(async () => {
  ({ syncOlseraSalesByCategory } = await import("./olsera-sync.ts"));
});

function storedItem(orderId: number, total: number): Doc {
  return { _id: orderId * 100, date: DATE, orderNo: `INV-${orderId}`, orderId, orderTotal: total, qty: 1, amount: orderTotal(orderId), costAmount: 100, resolvedCategoryName: "MINUMAN", syncedAt: new Date(0) };
}
function resetAll() {
  detailRequests = [];
  itemsUpdateManyMock.mock.resetCalls();
  itemsDeleteManyMock.mock.resetCalls();
  itemsBulkWriteMock.mock.resetCalls();
  categoryBulkWriteMock.mock.resetCalls();
}

test("incremental: 50 order, 45 tersimpan sama persis -> HANYA 5 request detail, 45 di-skip tapi tetap masuk agregat kategori & tidak dihapus", async () => {
  resetAll();
  storedItems = [
    ...Array.from({ length: 45 }, (_, i) => storedItem(i + 1, orderTotal(i + 1))), // 1..45 sama persis
    storedItem(46, 999), // nominal berubah
    storedItem(47, 1), // nominal berubah
    // 48..50 belum tersimpan
  ];

  const result = await syncOlseraSalesByCategory(DATE, DATE, { force: true, incremental: true });

  assert.equal(result.status, "success");
  assert.equal(result.expectedOrderCount, ORDER_COUNT);
  assert.equal(result.processedOrderCount, ORDER_COUNT, "skipped dihitung processed — hari tetap dianggap tuntas");
  assert.equal(result.skippedOrderCount, 45);
  assert.deepEqual([...detailRequests].sort((a, b) => a - b), [46, 47, 48, 49, 50], "cuma 5 order yang kena request detail, bukan 50");

  // Item 5 order yang ditarik di-upsert; 45 order yang di-skip disegarkan syncedAt-nya (tidak ikut terhapus).
  assert.equal(itemsBulkWriteMock.mock.callCount(), 1);
  assert.equal((itemsBulkWriteMock.mock.calls[0].arguments[0] as unknown[]).length, 5);
  assert.equal(itemsUpdateManyMock.mock.callCount(), 1);
  const [touchFilter] = itemsUpdateManyMock.mock.calls[0].arguments as [{ date: string; orderId: { $in: number[] } }, Doc];
  assert.equal(touchFilter.date, DATE);
  assert.equal(touchFilter.orderId.$in.length, 45);
  assert.equal(itemsDeleteManyMock.mock.callCount(), 1, "pembersihan order void tetap jalan");

  // Agregat kategori = 45 order tersimpan + 5 order ditarik = seluruh 50 order.
  const ops = categoryBulkWriteMock.mock.calls[0].arguments[0] as Array<{ updateOne: { filter: { category: string }; update: { $set: { qty: number; totalAmount: number } } } }>;
  const minuman = ops.find((op) => op.updateOne.filter.category === "MINUMAN")!;
  const expectedTotal = Array.from({ length: ORDER_COUNT }, (_, i) => orderTotal(i + 1)).reduce((sum, value) => sum + value, 0);
  assert.equal(minuman.updateOne.update.$set.qty, ORDER_COUNT);
  assert.equal(minuman.updateOne.update.$set.totalAmount, expectedTotal);
});

test("incremental: dokumen lama tanpa orderId/orderTotal tidak bisa dibandingkan -> order-nya ditarik ulang (sekali), bukan di-skip diam-diam", async () => {
  resetAll();
  storedItems = Array.from({ length: ORDER_COUNT }, (_, i) => {
    const doc = storedItem(i + 1, orderTotal(i + 1));
    delete doc.orderId;
    delete doc.orderTotal;
    return doc;
  });

  const result = await syncOlseraSalesByCategory(DATE, DATE, { force: true, incremental: true });

  assert.equal(result.skippedOrderCount, 0);
  assert.equal(detailRequests.length, ORDER_COUNT);
  assert.equal(itemsUpdateManyMock.mock.callCount(), 0);
});

test("default (tanpa incremental, mis. audit H-1 / manual): tetap tarik ulang PENUH 50 order walau semuanya sudah tersimpan sama persis", async () => {
  resetAll();
  storedItems = Array.from({ length: ORDER_COUNT }, (_, i) => storedItem(i + 1, orderTotal(i + 1)));

  const result = await syncOlseraSalesByCategory(DATE, DATE, { force: true });

  assert.equal(result.status, "success");
  assert.equal(result.skippedOrderCount, 0);
  assert.equal(detailRequests.length, ORDER_COUNT, "safety-net penuh tidak boleh ikut incremental");
  assert.equal(itemsUpdateManyMock.mock.callCount(), 0);
});
