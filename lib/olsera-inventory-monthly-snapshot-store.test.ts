// Test unit orkestrasi backfill ledger stok bulanan
// (lib/olsera-inventory-monthly-snapshot-store.ts) memakai REPO PALSU
// in-memory (bukan Mongo asli) + fetch di-mock (bukan Open API asli) —
// mencakup: backfill mundur berantai, backfill maju berantai, idempotensi
// (jalan dua kali = hasil identik, bukan akumulasi), carry-forward tanpa
// movement, produk belum eksis dihentikan mundur, ensureMonthlySnapshotChain
// (sudah ada -> tidak fetch ulang; belum ada -> backfill on-demand; tidak
// ada anchor -> error, bukan fabrikasi).
// Jalankan: node --no-warnings --experimental-strip-types --test lib/olsera-inventory-monthly-snapshot-store.test.ts
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { InventoryProductInput } from "./olsera-inventory-monthly-core.ts";
import { buildMatchingContext, type MatchingContext } from "./olsera-inventory-monthly-snapshot-core.ts";
import {
  backfillBackwardRange,
  backfillForwardRange,
  docsToForwardAnchors,
  ensureMonthlySnapshotChain,
  runForwardBackfillMonth,
  type MonthlySnapshotRepo,
} from "./olsera-inventory-monthly-snapshot-store.ts";
import type { OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";

function product(overrides: Partial<InventoryProductInput>): InventoryProductInput {
  return {
    _id: "1:100:0",
    productId: 100,
    variantId: null,
    sku: null,
    barcode: null,
    name: "PRODUK A",
    variantName: null,
    category: "GROUP",
    subCategory: null,
    uom: null,
    storeId: 1,
    storeName: "Toko",
    active: true,
    trackInventory: true,
    sellPrice: 10000,
    buyPrice: 5000,
    lastBuyPrice: 5000,
    stockQty: 10,
    holdQty: 0,
    lowStockAlert: null,
    isOutStock: false,
    modifiedTime: null,
    stockSyncTime: null,
    ...overrides,
  };
}

function createFakeRepo(seed: OlseraInventoryMonthlySnapshotDocument[] = []): MonthlySnapshotRepo & { all(): OlseraInventoryMonthlySnapshotDocument[] } {
  const docs = new Map<string, OlseraInventoryMonthlySnapshotDocument>();
  for (const doc of seed) docs.set(doc._id, doc);
  return {
    async upsertMany(newDocs) {
      for (const doc of newDocs) {
        const existing = docs.get(doc._id);
        docs.set(doc._id, existing ? { ...doc, createdAt: existing.createdAt } : doc);
      }
    },
    async findMonth(storeId, year, month) {
      return [...docs.values()].filter((d) => d.storeId === storeId && d.year === year && d.month === month);
    },
    all() {
      return [...docs.values()];
    },
  };
}

function seedJuneDoc(): OlseraInventoryMonthlySnapshotDocument {
  const now = new Date("2026-07-01T00:00:00Z");
  return {
    _id: "1:2026:06:100:0",
    storeId: 1,
    year: 2026,
    month: 6,
    snapshotDate: "2026-06-30",
    productId: 100,
    variantId: null,
    canonicalProductId: null,
    productName: "PRODUK A",
    productSku: null,
    groupName: "GROUP",
    openingQty: 45,
    incomingQty: 24,
    returnQty: 0,
    salesQty: 46,
    outgoingQty: 2,
    closingQty: 21,
    source: "baseline-file",
    status: "complete",
    diagnostics: [],
    createdAt: now,
    updatedAt: now,
  };
}

function seedMayDoc(): OlseraInventoryMonthlySnapshotDocument {
  const now = new Date("2026-07-01T00:00:00Z");
  return {
    _id: "1:2026:05:100:0",
    storeId: 1,
    year: 2026,
    month: 5,
    snapshotDate: "2026-05-31",
    productId: 100,
    variantId: null,
    canonicalProductId: null,
    productName: "PRODUK A",
    productSku: null,
    groupName: "GROUP",
    openingQty: null,
    incomingQty: null,
    returnQty: null,
    salesQty: null,
    outgoingQty: null,
    closingQty: 45,
    source: "baseline-file",
    status: "boundary-only",
    diagnostics: [],
    createdAt: now,
    updatedAt: now,
  };
}

function matchingContextForOneProduct(): MatchingContext {
  const catalog = [product({ _id: "1:100:0", productId: 100, storeId: 1, name: "PRODUK A", category: "GROUP" })];
  return buildMatchingContext(catalog, []);
}

function mockFetchStockmovementByMonth(t: TestContext, dataByStartDate: Record<string, unknown[]>) {
  process.env.OLSERA_APP_ID = "test-app-id";
  process.env.OLSERA_SECRET_KEY = "test-secret";
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/token")) return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
    const startDate = new URL(url).searchParams.get("start_date") ?? "";
    const data = dataByStartDate[startDate] ?? [];
    return new Response(JSON.stringify({ data, meta: { current_page: 1, last_page: 1 } }), { status: 200 });
  });
}

// ---- runForwardBackfillMonth / backfillForwardRange ----

test("backfillForwardRange: Juni -> Juli -> Agustus, closing berantai jadi opening bulan berikutnya", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-07-01": [
      { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 21, sum_incoming_qty: 5, sum_return_qty: 0, sum_sales_qty: 3, sum_outgoing_qty: 1, sisa: 22 },
    ],
    "2026-08-01": [
      { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 22, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 2, sum_outgoing_qty: 0, sisa: 20 },
    ],
  });
  const repo = createFakeRepo([seedJuneDoc()]);
  const matchingContext = matchingContextForOneProduct();
  const summaries = await backfillForwardRange({ fromInclusive: { year: 2026, month: 6 }, toInclusive: { year: 2026, month: 8 }, storeId: 1, matchingContext, repo });
  assert.equal(summaries.length, 2);
  assert.ok(summaries.every((s) => s.ok));

  const july = await repo.findMonth(1, 2026, 7);
  assert.equal(july[0].openingQty, 21);
  assert.equal(july[0].closingQty, 22);
  const august = await repo.findMonth(1, 2026, 8);
  assert.equal(august[0].openingQty, 22);
  assert.equal(august[0].closingQty, 20);
});

test("backfillForwardRange: bulan tanpa movement -> carry-forward, closing = opening", async (t) => {
  mockFetchStockmovementByMonth(t, {}); // semua bulan kosong
  const repo = createFakeRepo([seedJuneDoc()]);
  const matchingContext = matchingContextForOneProduct();
  await backfillForwardRange({ fromInclusive: { year: 2026, month: 6 }, toInclusive: { year: 2026, month: 7 }, storeId: 1, matchingContext, repo });
  const july = await repo.findMonth(1, 2026, 7);
  assert.equal(july[0].source, "carry-forward");
  assert.equal(july[0].openingQty, 21);
  assert.equal(july[0].closingQty, 21);
});

test("backfillForwardRange: idempotent — dijalankan dua kali menghasilkan dokumen identik (bukan akumulasi)", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-07-01": [
      { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 21, sum_incoming_qty: 5, sum_return_qty: 0, sum_sales_qty: 3, sum_outgoing_qty: 1, sisa: 22 },
    ],
  });
  const repo = createFakeRepo([seedJuneDoc()]);
  const matchingContext = matchingContextForOneProduct();
  await backfillForwardRange({ fromInclusive: { year: 2026, month: 6 }, toInclusive: { year: 2026, month: 7 }, storeId: 1, matchingContext, repo });
  const firstRun = await repo.findMonth(1, 2026, 7);
  const countAfterFirst = repo.all().length;

  await backfillForwardRange({ fromInclusive: { year: 2026, month: 6 }, toInclusive: { year: 2026, month: 7 }, storeId: 1, matchingContext, repo });
  const secondRun = await repo.findMonth(1, 2026, 7);
  const countAfterSecond = repo.all().length;

  assert.equal(countAfterFirst, countAfterSecond); // tidak ada dokumen baru/dobel
  assert.deepEqual(
    { opening: firstRun[0].openingQty, closing: firstRun[0].closingQty, source: firstRun[0].source },
    { opening: secondRun[0].openingQty, closing: secondRun[0].closingQty, source: secondRun[0].source },
  );
});

test("backfillForwardRange: produk baru (ODEA RED) hanya muncul di bulan API benar-benar melaporkannya", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-07-01": [], // Juli: belum ada aktivitas ODEA RED
    "2026-08-01": [
      { product_id: 119043265, product_name: "BOLA PADEL ODEA RED", product_group_name: "BOLA PADEL", beginning_qty: 49, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 2, sum_outgoing_qty: 0, sisa: 47 },
    ],
  });
  const catalog = [
    product({ _id: "1:100:0", productId: 100, storeId: 1, name: "PRODUK A", category: "GROUP" }),
    product({ _id: "1:119043265:0", productId: 119043265, storeId: 1, name: "BOLA PADEL ODEA RED", category: "BOLA PADEL" }),
  ];
  const matchingContext = buildMatchingContext(catalog, []);
  const repo = createFakeRepo([seedJuneDoc()]);
  await backfillForwardRange({ fromInclusive: { year: 2026, month: 6 }, toInclusive: { year: 2026, month: 8 }, storeId: 1, matchingContext, repo });

  const july = await repo.findMonth(1, 2026, 7);
  assert.equal(july.some((d) => d.productId === 119043265), false); // belum eksis Juli

  const august = await repo.findMonth(1, 2026, 8);
  const odeaRed = august.find((d) => d.productId === 119043265)!;
  assert.ok(odeaRed);
  assert.equal(odeaRed.openingQty, 49);
  assert.equal(odeaRed.closingQty, 47);
});

// ---- backfillBackwardRange (earliestByProductId di-inject, tanpa Mongo) ----

test("backfillBackwardRange: Mei -> April, opening dihitung mundur jadi closing anchor bulan sebelumnya", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-05-01": [
      { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 40, sum_incoming_qty: 10, sum_return_qty: 0, sum_sales_qty: 4, sum_outgoing_qty: 1, sisa: 45 },
    ],
  });
  const repo = createFakeRepo([seedMayDoc()]);
  const matchingContext = matchingContextForOneProduct();
  const summaries = await backfillBackwardRange({
    fromInclusive: { year: 2026, month: 5 },
    toInclusive: { year: 2026, month: 4 },
    storeId: 1,
    matchingContext,
    repo,
    earliestByProductId: new Map([[100, "2026-01-01"]]),
  });
  assert.ok(summaries.every((s) => s.ok));
  const may = await repo.findMonth(1, 2026, 5);
  assert.equal(may[0].status, "complete"); // boundary-only jadi complete
  assert.equal(may[0].openingQty, 40);
  const april = await repo.findMonth(1, 2026, 4);
  assert.equal(april[0].closingQty, 40);
});

test("backfillBackwardRange: tanpa movement TAPI ada bukti eksistensi (order_items lama) -> carry-forward, tetap ditulis", async (t) => {
  mockFetchStockmovementByMonth(t, {});
  const repo = createFakeRepo([seedMayDoc()]);
  const matchingContext = matchingContextForOneProduct();
  await backfillBackwardRange({
    fromInclusive: { year: 2026, month: 5 },
    toInclusive: { year: 2026, month: 4 },
    storeId: 1,
    matchingContext,
    repo,
    earliestByProductId: new Map([[100, "2026-01-01"]]),
  });
  const april = await repo.findMonth(1, 2026, 4);
  assert.equal(april[0].source, "carry-forward");
  assert.equal(april[0].closingQty, 45);
});

test("backfillBackwardRange: TANPA bukti eksistensi apa pun -> produk DIHENTIKAN, tidak ada dokumen ditulis utk bulan itu (tidak dipaksa)", async (t) => {
  mockFetchStockmovementByMonth(t, {}); // ODEA RED tidak pernah muncul di jendela manapun
  const repo = createFakeRepo([seedMayDoc()]);
  const matchingContext = matchingContextForOneProduct();
  await backfillBackwardRange({
    fromInclusive: { year: 2026, month: 5 },
    toInclusive: { year: 2026, month: 4 },
    storeId: 1,
    matchingContext,
    repo,
    earliestByProductId: new Map(), // tidak ada bukti apa pun utk productId 100
  });
  const april = await repo.findMonth(1, 2026, 4);
  assert.equal(april.length, 0);
});

// ---- docsToForwardAnchors ----

test("docsToForwardAnchors: dokumen dengan closingQty null dilewati (tidak jadi anchor palsu)", () => {
  const now = new Date();
  const docs: OlseraInventoryMonthlySnapshotDocument[] = [
    { ...seedJuneDoc(), closingQty: null },
  ];
  void now;
  const anchors = docsToForwardAnchors(docs);
  assert.equal(anchors.size, 0);
});

// ---- ensureMonthlySnapshotChain (zona maju — tidak butuh Mongo utk existence check) ----

test("ensureMonthlySnapshotChain: bulan target SUDAH ada -> dikembalikan langsung, TIDAK fetch stockmovement", async (t) => {
  let fetchCalled = false;
  process.env.OLSERA_APP_ID = "test-app-id";
  process.env.OLSERA_SECRET_KEY = "test-secret";
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });
  const repo = createFakeRepo([seedJuneDoc()]);
  const matchingContext = matchingContextForOneProduct();
  const result = await ensureMonthlySnapshotChain({ year: 2026, month: 6, repo, matchingContext });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.docs.length, 1);
  assert.equal(fetchCalled, false);
});

test("ensureMonthlySnapshotChain: bulan target BELUM ada (zona maju) -> backfill on-demand dari anchor terdekat", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-07-01": [
      { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 21, sum_incoming_qty: 5, sum_return_qty: 0, sum_sales_qty: 3, sum_outgoing_qty: 1, sisa: 22 },
    ],
  });
  const repo = createFakeRepo([seedJuneDoc()]);
  const matchingContext = matchingContextForOneProduct();
  const result = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.docs.length, 1);
    assert.equal(result.docs[0].openingQty, 21);
    assert.equal(result.docs[0].closingQty, 22);
  }
});

test("ensureMonthlySnapshotChain: tidak ada anchor sama sekali -> error, bukan fabrikasi angka", async (t) => {
  mockFetchStockmovementByMonth(t, {});
  const repo = createFakeRepo([]); // katalog kosong dari dokumen manapun
  const matchingContext = matchingContextForOneProduct();
  const result = await ensureMonthlySnapshotChain({ year: 2026, month: 9, repo, matchingContext });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /anchor|bootstrap/i);
});

test("runForwardBackfillMonth: baris stockmovement yang tidak cocok ke katalog manapun dilaporkan di unmatchedOrAmbiguous, tidak menggagalkan bulan lain", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-07-01": [
      { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 21, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 0, sum_outgoing_qty: 0, sisa: 21 },
      { product_id: 77777, product_name: "PRODUK TIDAK DIKENAL", product_group_name: "LAIN", beginning_qty: 1, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 0, sum_outgoing_qty: 0, sisa: 1 },
    ],
  });
  const repo = createFakeRepo();
  const matchingContext = matchingContextForOneProduct();
  const anchors = docsToForwardAnchors([seedJuneDoc()]);
  const result = await runForwardBackfillMonth({ month: { year: 2026, month: 7 }, storeId: 1, anchors, matchingContext, repo });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.docsWritten, 1); // hanya PRODUK A
    assert.equal(result.unmatchedOrAmbiguous.length, 1);
    assert.match(result.unmatchedOrAmbiguous[0].product, /TIDAK DIKENAL/);
  }
});
