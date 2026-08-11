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
  docsToBackwardAnchors,
  docsToForwardAnchors,
  fetchRawSalesActivityByMonth,
  ensureMonthlySnapshotChain,
  runBackwardBackfillMonth,
  runForwardBackfillMonth,
  type EntityFilter,
  type MinimalMovementReadCollection,
  type MonthlySnapshotRepo,
  type RawSalesActivityFetcher,
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

test("backfillBackwardRange: produk BARU tanpa anchor bulan berikutnya TAPI ada baris stockmovement bulan ini -> direcover TANPA butuh order-item evidence (kasus nyata RAKET PADEL ADIDAS 2026 MATCH Februari 2026)", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-02-01": [
      { product_id: 111246035, product_name: "RAKET PADEL ADIDAS 2026 MATCH", product_group_name: "RAKET PADEL", beginning_qty: 0, sum_incoming_qty: 4, sum_return_qty: 0, sum_sales_qty: 0, sum_outgoing_qty: 0, sisa: 4 },
    ],
  });
  const catalog = [
    product({ _id: "1:100:0", productId: 100, storeId: 1, name: "PRODUK A", category: "GROUP" }),
    product({ _id: "1:111246035:0", productId: 111246035, storeId: 1, name: "RAKET PADEL ADIDAS 2026 MATCH", category: "RAKET PADEL" }),
  ];
  const matchingContext = buildMatchingContext(catalog, []);
  // Tidak ada dokumen Maret utk 111246035 (belum eksis sbg anchor), dan earliestByProductId KOSONG utk productId ini
  // (mensimulasikan: tidak pernah ada olsera_order_items) — membuktikan recovery TIDAK bergantung pada bukti order-item.
  const repo = createFakeRepo([seedMayDoc()]);
  const summaries = await backfillBackwardRange({
    fromInclusive: { year: 2026, month: 2 },
    toInclusive: { year: 2026, month: 2 },
    storeId: 1,
    matchingContext,
    repo,
    earliestByProductId: new Map(), // KOSONG utk 111246035 — tidak ada bukti order-item apa pun
  });
  assert.ok(summaries.every((s) => s.ok));
  const feb = await repo.findMonth(1, 2026, 2);
  const adidas = feb.find((d) => d.productId === 111246035)!;
  assert.ok(adidas, "produk baru harus direcover walau tidak ada bukti order-item");
  assert.equal(adidas.openingQty, 0);
  assert.equal(adidas.incomingQty, 4);
  assert.equal(adidas.closingQty, 4);
  assert.equal(adidas.source, "stockmovement-backward");
});

test("backfillBackwardRange: produk yang TIDAK ada di catalogById (identity tidak dapat diresolusi/ambiguous) -> tidak pernah muncul di 'matched' sehingga tidak direcover otomatis (tetap manual review)", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-03-01": [
      // Baris ini merujuk productId yang TIDAK ada di catalog manapun -> attachMovementsToProducts akan menandainya unmatched/ambiguous, bukan masuk ke 'matched'.
      { product_id: 999999999, product_name: "PRODUK TIDAK DIKENAL", product_group_name: "LAINNYA", beginning_qty: 1, sum_incoming_qty: 1, sum_return_qty: 0, sum_sales_qty: 1, sum_outgoing_qty: 0, sisa: 1 },
    ],
  });
  const matchingContext = matchingContextForOneProduct(); // hanya mengenal productId 100
  const repo = createFakeRepo([seedMayDoc()]);
  await backfillBackwardRange({
    fromInclusive: { year: 2026, month: 3 },
    toInclusive: { year: 2026, month: 3 },
    storeId: 1,
    matchingContext,
    repo,
    earliestByProductId: new Map(),
  });
  const march = await repo.findMonth(1, 2026, 3);
  assert.equal(march.some((d) => d.productId === 999999999), false); // tidak pernah dipaksakan masuk
});

test("backfillBackwardRange: fetch stockmovement API GAGAL -> tidak ada dokumen ditulis sama sekali utk bulan itu (fail-safe, bukan 0 ditebak)", async (t) => {
  process.env.OLSERA_APP_ID = "test-app-id";
  process.env.OLSERA_SECRET_KEY = "test-secret";
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/token")) return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
    return new Response("Internal Server Error", { status: 500 });
  });
  const matchingContext = matchingContextForOneProduct();
  const repo = createFakeRepo([seedMayDoc()]);
  const summaries = await backfillBackwardRange({
    fromInclusive: { year: 2026, month: 4 },
    toInclusive: { year: 2026, month: 4 },
    storeId: 1,
    matchingContext,
    repo,
    earliestByProductId: new Map([[100, "2026-01-01"]]),
  });
  assert.ok(summaries.every((s) => !s.ok)); // gagal, ditandai eksplisit, bukan diam-diam sukses dgn 0 entity
  const april = await repo.findMonth(1, 2026, 4);
  assert.equal(april.length, 0);
});

// ---- Fitur ODEA: rebuild historis identity-change terverifikasi + --product-id scoped ----

function odeaSeedJuneDoc(): OlseraInventoryMonthlySnapshotDocument {
  const now = new Date("2026-07-01T00:00:00Z");
  return {
    _id: "1:2026:06:116138490:0",
    storeId: 1,
    year: 2026,
    month: 6,
    snapshotDate: "2026-06-30",
    productId: 116138490,
    variantId: null,
    canonicalProductId: null,
    productName: "BOLA PADEL ODEA ROSE",
    productSku: null,
    groupName: "BOLA PADEL",
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

function yonexSeedJuneDoc(): OlseraInventoryMonthlySnapshotDocument {
  const now = new Date("2026-07-01T00:00:00Z");
  return {
    _id: "1:2026:06:118420650:0",
    storeId: 1,
    year: 2026,
    month: 6,
    snapshotDate: "2026-06-30",
    productId: 118420650,
    variantId: null,
    canonicalProductId: null,
    productName: "YONEX SHORTS MEN # SM-J035-2906-RW1-S duplicate",
    productSku: null,
    groupName: "CELANA PRIA",
    openingQty: 4,
    incomingQty: 0,
    returnQty: 0,
    salesQty: 3,
    outgoingQty: 0,
    closingQty: 1,
    source: "baseline-file",
    status: "complete",
    diagnostics: [],
    createdAt: now,
    updatedAt: now,
  };
}

function redSeedJuneDoc(): OlseraInventoryMonthlySnapshotDocument {
  const now = new Date("2026-07-01T00:00:00Z");
  return {
    _id: "1:2026:06:119043265:0",
    storeId: 1,
    year: 2026,
    month: 6,
    snapshotDate: "2026-06-30",
    productId: 119043265,
    variantId: null,
    canonicalProductId: null,
    productName: "BOLA PADEL ODEA RED",
    productSku: null,
    groupName: "BOLA PADEL",
    openingQty: 32,
    incomingQty: 0,
    returnQty: 0,
    salesQty: 0,
    outgoingQty: 0,
    closingQty: 32,
    source: "baseline-file",
    status: "complete",
    diagnostics: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** rawSalesActivityFetcher palsu — beberapa entity sekaligus, per bulan (YYYY-MM), key format sama seperti fetchRawSalesActivityByMonth. */
function makeMultiLedgerFetcher(storeId: number, byMonthThenProductId: Record<string, Record<number, number>>): RawSalesActivityFetcher {
  return async (start) => {
    const ym = start.slice(0, 7);
    const byProduct = byMonthThenProductId[ym] ?? {};
    const map = new Map<string, number>();
    for (const [productId, qty] of Object.entries(byProduct)) map.set(`${storeId}:${productId}:0`, qty);
    return map;
  };
}

function odeaThreeProductMatchingContext(): MatchingContext {
  const catalog = [
    product({ _id: "1:116138490:0", productId: 116138490, storeId: 1, name: "BOLA PADEL ODEA ROSE", category: "BOLA PADEL" }),
    product({ _id: "1:118420650:0", productId: 118420650, storeId: 1, name: "YONEX SHORTS MEN # SM-J035-2906-RW1-S duplicate", category: "CELANA PRIA" }),
    product({ _id: "1:119043265:0", productId: 119043265, storeId: 1, name: "BOLA PADEL ODEA RED", category: "BOLA PADEL" }),
  ];
  const aliases = [
    { oldProductId: 106817649, oldVariantId: null, newProductId: 116138490, newVariantId: null, confidence: "verified" as const }, // ODEA lama -> ROSE (verified, kasus nyata)
    { oldProductId: 106743815, oldVariantId: null, newProductId: 118420650, newVariantId: null, confidence: "verified" as const }, // Yonex lama -> duplicate (verified, kasus nyata, PRE-EXISTING sebelum fitur ini)
    // RED (119043265) SENGAJA tidak punya alias apa pun — harus tetap terpisah.
  ];
  return buildMatchingContext(catalog, aliases);
}

test("backfillBackwardRange: ODEA regresi persis (Feb=30, Mar=36, Apr=51, May=55, Jun tidak berubah=46) — end-to-end lewat orkestrasi penuh, bukan hanya fungsi murni", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-06-01": [{ product_id: 116138490, product_name: "BOLA PADEL ODEA ROSE", product_group_name: "BOLA PADEL", beginning_qty: 45, sum_incoming_qty: 24, sum_return_qty: 0, sum_sales_qty: 46, sum_outgoing_qty: 2, sisa: 21 }],
    "2026-05-01": [{ product_id: 116138490, product_name: "BOLA PADEL ODEA ROSE", product_group_name: "BOLA PADEL", beginning_qty: 0, sum_incoming_qty: 57, sum_return_qty: 0, sum_sales_qty: 12, sum_outgoing_qty: 0, sisa: 45 }],
    // Feb/Mar/Apr: TIDAK ADA baris official API sama sekali (carry-forward) — persis kondisi nyata sebelum fix.
  });
  const catalog = [product({ _id: "1:116138490:0", productId: 116138490, storeId: 1, name: "BOLA PADEL ODEA ROSE", category: "BOLA PADEL" })];
  const matchingContext = buildMatchingContext(catalog, [{ oldProductId: 106817649, oldVariantId: null, newProductId: 116138490, newVariantId: null, confidence: "verified" }]);
  const repo = createFakeRepo([odeaSeedJuneDoc()]);
  const rawSalesActivityFetcher = makeMultiLedgerFetcher(1, {
    "2026-02": { 116138490: 30 },
    "2026-03": { 116138490: 36 },
    "2026-04": { 116138490: 51 },
    "2026-05": { 116138490: 55 },
    "2026-06": { 116138490: 46 }, // sama dengan hasil resmi -> tidak override
  });

  const summaries = await backfillBackwardRange({
    fromInclusive: { year: 2026, month: 6 },
    toInclusive: { year: 2026, month: 2 },
    storeId: 1,
    matchingContext,
    repo,
    earliestByProductId: new Map([[116138490, "2026-01-01"]]),
    rawSalesActivityFetcher,
  });
  assert.ok(summaries.every((s) => s.ok));

  const feb = (await repo.findMonth(1, 2026, 2))[0];
  const mar = (await repo.findMonth(1, 2026, 3))[0];
  const apr = (await repo.findMonth(1, 2026, 4))[0];
  const may = (await repo.findMonth(1, 2026, 5))[0];
  const jun = (await repo.findMonth(1, 2026, 6))[0];

  assert.equal(feb.salesQty, 30);
  assert.equal(mar.salesQty, 36);
  assert.equal(apr.salesQty, 51);
  assert.equal(may.salesQty, 55); // override dari ledger, resmi (12) TIDAK dipakai lagi
  assert.equal(jun.salesQty, 46); // TIDAK berubah — ledger (46) tidak lebih besar dari resmi (46)

  // Chain opening/closing tetap dihitung via formula existing, bukan hardcode — cek konsistensi berantai.
  assert.equal(apr.closingQty, may.openingQty); // April closing = Mei opening (rantai N -> N-1)
  assert.equal(mar.closingQty, apr.openingQty);
  assert.equal(feb.closingQty, mar.openingQty);

  // Status: bukan hardcode "complete" — hasil natural dari guard (verified + override berhasil).
  assert.equal(feb.status, "complete");
  assert.equal(mar.status, "complete");
  assert.equal(apr.status, "complete");
  assert.equal(may.status, "complete");

  // Idempotent — jalankan ulang persis sama menghasilkan angka identik (bukan akumulasi/double-count).
  const repo2 = createFakeRepo([odeaSeedJuneDoc()]);
  await backfillBackwardRange({ fromInclusive: { year: 2026, month: 6 }, toInclusive: { year: 2026, month: 2 }, storeId: 1, matchingContext, repo: repo2, earliestByProductId: new Map([[116138490, "2026-01-01"]]), rawSalesActivityFetcher });
  const feb2 = (await repo2.findMonth(1, 2026, 2))[0];
  assert.equal(feb2.salesQty, feb.salesQty);
  assert.equal(feb2.openingQty, feb.openingQty);
});

test("backfillBackwardRange DENGAN --product-id (entityFilter) SCOPED ke ODEA: Yonex (verified alias-nya SENDIRI) 100% TIDAK TERSENTUH walau ledgernya juga lebih besar dari source resmi", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-06-01": [
      { product_id: 116138490, product_name: "BOLA PADEL ODEA ROSE", product_group_name: "BOLA PADEL", beginning_qty: 45, sum_incoming_qty: 24, sum_return_qty: 0, sum_sales_qty: 46, sum_outgoing_qty: 2, sisa: 21 },
      { product_id: 118420650, product_name: "YONEX SHORTS MEN # SM-J035-2906-RW1-S duplicate", product_group_name: "CELANA PRIA", beginning_qty: 4, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 3, sum_outgoing_qty: 0, sisa: 1 },
    ],
    // Mei-Feb: TIDAK ADA baris official utk keduanya (carry-forward keduanya).
  });
  const matchingContext = odeaThreeProductMatchingContext();
  const yonexSeed = yonexSeedJuneDoc();
  const redSeed = redSeedJuneDoc();
  const repo = createFakeRepo([odeaSeedJuneDoc(), yonexSeed, redSeed]);
  // Yonex JUGA punya ledger lebih besar dari source resmi (0) di Feb — kalau isolasi bocor, Yonex akan ikut berubah.
  const rawSalesActivityFetcher = makeMultiLedgerFetcher(1, {
    "2026-02": { 116138490: 30, 118420650: 99, 119043265: 999 },
    "2026-03": { 116138490: 36, 118420650: 99 },
    "2026-04": { 116138490: 51, 118420650: 99 },
    "2026-05": { 116138490: 55, 118420650: 99 },
  });
  const entityFilter: EntityFilter = { productId: 116138490, variantId: null };

  const summaries = await backfillBackwardRange({
    fromInclusive: { year: 2026, month: 6 },
    toInclusive: { year: 2026, month: 2 },
    storeId: 1,
    matchingContext,
    repo,
    earliestByProductId: new Map([
      [116138490, "2026-01-01"],
      [118420650, "2026-01-01"],
      [119043265, "2026-01-01"],
    ]),
    rawSalesActivityFetcher,
    entityFilter,
  });
  assert.ok(summaries.every((s) => s.ok));

  // ODEA berubah seperti diharapkan.
  const febOdea = (await repo.findMonth(1, 2026, 2)).find((d) => d.productId === 116138490)!;
  assert.equal(febOdea.salesQty, 30);

  // Yonex TIDAK PERNAH ditulis ulang untuk bulan manapun dalam rentang — dokumen Feb/Mar/Apr/Mei untuk
  // productId 118420650 TIDAK ADA SAMA SEKALI (tidak pernah di-upsert), dan dokumen Juni (seed awal)
  // deep-equal PERSIS dengan sebelum rebuild dijalankan (byte-identik, termasuk createdAt/updatedAt).
  for (const month of [2, 3, 4, 5]) {
    const yonexDocs = (await repo.findMonth(1, 2026, month)).filter((d) => d.productId === 118420650);
    assert.equal(yonexDocs.length, 0, `Yonex TIDAK BOLEH punya dokumen ${month} — entityFilter harus mengisolasi total`);
  }
  const yonexJuneAfter = (await repo.findMonth(1, 2026, 6)).find((d) => d.productId === 118420650)!;
  assert.deepEqual(yonexJuneAfter, yonexSeed); // byte-identik dengan sebelum rebuild — TIDAK disentuh sama sekali

  // ODEA RED juga sama sekali tidak tersentuh (tidak ada alias DAN di luar scope entityFilter — dua lapis proteksi).
  for (const month of [2, 3, 4, 5]) {
    const redDocs = (await repo.findMonth(1, 2026, month)).filter((d) => d.productId === 119043265);
    assert.equal(redDocs.length, 0);
  }
  const redJuneAfter = (await repo.findMonth(1, 2026, 6)).find((d) => d.productId === 119043265)!;
  assert.deepEqual(redJuneAfter, redSeed);
});

test("backfillBackwardRange TANPA --product-id (default, unscoped): Yonex verified DAN ledger-nya lebih besar dari source resmi -> IKUT berubah (bukti guard generik, BUKAN hardcode nama ODEA) — kontras dengan test scoped di atas", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-06-01": [
      { product_id: 118420650, product_name: "YONEX SHORTS MEN # SM-J035-2906-RW1-S duplicate", product_group_name: "CELANA PRIA", beginning_qty: 4, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 3, sum_outgoing_qty: 0, sisa: 1 },
    ],
  });
  const catalog = [product({ _id: "1:118420650:0", productId: 118420650, storeId: 1, name: "YONEX SHORTS MEN # SM-J035-2906-RW1-S duplicate", category: "CELANA PRIA" })];
  const matchingContext = buildMatchingContext(catalog, [{ oldProductId: 106743815, oldVariantId: null, newProductId: 118420650, newVariantId: null, confidence: "verified" }]);
  const repo = createFakeRepo([yonexSeedJuneDoc()]);
  const rawSalesActivityFetcher = makeMultiLedgerFetcher(1, { "2026-05": { 118420650: 7 } });

  await backfillBackwardRange({
    fromInclusive: { year: 2026, month: 6 },
    toInclusive: { year: 2026, month: 5 },
    storeId: 1,
    matchingContext,
    repo,
    earliestByProductId: new Map([[118420650, "2026-01-01"]]),
    rawSalesActivityFetcher,
  });
  const may = (await repo.findMonth(1, 2026, 5))[0];
  assert.equal(may.salesQty, 7); // guard-nya memang generik (bukan hardcode nama ODEA) — berlaku utk entity verified manapun
});

test("backfillBackwardRange: ODEA RED (tidak punya alias sama sekali) TIDAK PERNAH ikut override walau ledgernya besar — alias ODEA->ROSE tidak 'bocor' ke RED", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-06-01": [{ product_id: 119043265, product_name: "BOLA PADEL ODEA RED", product_group_name: "BOLA PADEL", beginning_qty: 32, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 0, sum_outgoing_qty: 0, sisa: 32 }],
  });
  const catalog = [product({ _id: "1:119043265:0", productId: 119043265, storeId: 1, name: "BOLA PADEL ODEA RED", category: "BOLA PADEL" })];
  // TIDAK ADA alias untuk RED — sengaja kosong, mensimulasikan "alias lama->ROSE tidak mempengaruhi RED".
  const matchingContext = buildMatchingContext(catalog, [{ oldProductId: 106817649, oldVariantId: null, newProductId: 116138490, newVariantId: null, confidence: "verified" }]);
  const repo = createFakeRepo([redSeedJuneDoc()]);
  const rawSalesActivityFetcher = makeMultiLedgerFetcher(1, { "2026-05": { 119043265: 500 } }); // ledger besar, TAPI tidak boleh dipakai (tidak verified utk RED)

  await backfillBackwardRange({
    fromInclusive: { year: 2026, month: 6 },
    toInclusive: { year: 2026, month: 5 },
    storeId: 1,
    matchingContext,
    repo,
    earliestByProductId: new Map([[119043265, "2026-01-01"]]),
    rawSalesActivityFetcher,
  });
  const may = (await repo.findMonth(1, 2026, 5))[0];
  assert.equal(may.salesQty, 0); // carry-forward biasa, TIDAK di-override
  assert.equal(may.status, "incomplete"); // tetap ditandai kontradiktif seperti sebelum fitur ini (belum verified)
});

test("scripts/backfill-monthly-snapshot.ts --product-id: productId tidak ditemukan di katalog -> gagal dengan pesan jelas (bukan silent no-op)", () => {
  const matchingContext = odeaThreeProductMatchingContext();
  const target = matchingContext.catalogProducts.find((p) => p.productId === 999999999);
  assert.equal(target, undefined); // validasi yang sama dipakai CLI (lihat scripts/backfill-monthly-snapshot.ts) sebelum rebuild dimulai
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
  // now dipin ke masa depan supaya September 2026 pasti "historical" (bukan
  // "future") terlepas kapan test ini benar-benar dijalankan — deterministik.
  const result = await ensureMonthlySnapshotChain({ year: 2026, month: 9, repo, matchingContext, now: new Date("2027-01-01T00:00:00Z") });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /anchor|bootstrap/i);
});

// ---- fetchRawSalesActivityByMonth (fake koleksi, tanpa Mongo asli) ----

type FakeMovementDoc = { _id: string; storeId: number | null; productId: number | null; variantId: number | null; date: string; qtyChange: number };

function createFakeMovementCollection(docs: FakeMovementDoc[]): MinimalMovementReadCollection {
  return {
    find(filter: Record<string, unknown>) {
      const storeFilter = filter.storeId as { $in: (number | null)[] } | undefined;
      const dateFilter = filter.date as { $gte: string; $lte: string } | undefined;
      const matched = docs.filter((d) => {
        if (storeFilter && !storeFilter.$in.includes(d.storeId)) return false;
        if (dateFilter && (d.date < dateFilter.$gte || d.date > dateFilter.$lte)) return false;
        return true;
      });
      return {
        project() {
          return { async toArray() { return matched as unknown as Record<string, unknown>[]; } };
        },
      };
    },
  };
}

test("fetchRawSalesActivityByMonth: storeId toko sendiri DAN storeId:null (legacy) ikut terhitung, storeId toko lain TIDAK (Known Case 37)", async () => {
  const collection = createFakeMovementCollection([
    { _id: "sale:1", storeId: 1, productId: 100, variantId: null, date: "2026-02-10", qtyChange: -3 },
    { _id: "sale:2", storeId: null, productId: 100, variantId: null, date: "2026-02-11", qtyChange: -2 }, // legacy belum distempel
    { _id: "sale:3", storeId: 999, productId: 100, variantId: null, date: "2026-02-12", qtyChange: -5 }, // toko lain — TIDAK boleh ikut
  ]);
  const map = await fetchRawSalesActivityByMonth(1, "2026-02-01", "2026-02-28", collection);
  assert.equal(map.get("1:100:0"), 5); // 3 + 2, BUKAN +5 dari toko lain
});

test("fetchRawSalesActivityByMonth: boundary akhir bulan — tanggal akhir bulan inklusif, tanggal 1 bulan berikutnya TIDAK ikut", async () => {
  const collection = createFakeMovementCollection([
    { _id: "sale:1", storeId: 1, productId: 100, variantId: null, date: "2026-02-28", qtyChange: -1 }, // akhir Februari — ikut
    { _id: "sale:2", storeId: 1, productId: 100, variantId: null, date: "2026-03-01", qtyChange: -9 }, // awal Maret — TIDAK boleh ikut
  ]);
  const map = await fetchRawSalesActivityByMonth(1, "2026-02-01", "2026-02-28", collection);
  assert.equal(map.get("1:100:0"), 1);
});

test("fetchRawSalesActivityByMonth: dua movement berbeda (_id beda) pada produk+bulan sama -> keduanya IKUT dijumlah (bukan duplicate, bukan double-count)", async () => {
  const collection = createFakeMovementCollection([
    { _id: "sale:1", storeId: 1, productId: 100, variantId: null, date: "2026-02-05", qtyChange: -1 },
    { _id: "sale:2", storeId: 1, productId: 100, variantId: null, date: "2026-02-06", qtyChange: -1 },
  ]);
  const map = await fetchRawSalesActivityByMonth(1, "2026-02-01", "2026-02-28", collection);
  assert.equal(map.get("1:100:0"), 2); // dua penjualan berbeda, bukan 1 (bukan dedup keliru)
});

test("fetchRawSalesActivityByMonth: variantId=0 literal tetap masuk key yang sama seperti variantId null (konsisten dgn seluruh pipeline)", async () => {
  const collection = createFakeMovementCollection([{ _id: "sale:1", storeId: 1, productId: 200, variantId: 0, date: "2026-02-05", qtyChange: -4 }]);
  const map = await fetchRawSalesActivityByMonth(1, "2026-02-01", "2026-02-28", collection);
  assert.equal(map.get("1:200:0"), 4);
});

test("fetchRawSalesActivityByMonth: productId null dilewati (tidak masuk key manapun, sudah ditangani jalur productId-null terpisah)", async () => {
  const collection = createFakeMovementCollection([{ _id: "sale:1", storeId: 1, productId: null, variantId: null, date: "2026-02-05", qtyChange: -1 }]);
  const map = await fetchRawSalesActivityByMonth(1, "2026-02-01", "2026-02-28", collection);
  assert.equal(map.size, 0);
});

// ---- runBackwardBackfillMonth dengan rawSalesActivityFetcher (opt-in) ----

test("runBackwardBackfillMonth: rawSalesActivityFetcher terpasang & ada kontradiksi -> dokumen ditulis dengan status 'incomplete' (bukan angka ditebak)", async (t) => {
  mockFetchStockmovementByMonth(t, {}); // stockmovement API kosong bulan ini (memicu carry-forward)
  const repo = createFakeRepo();
  const matchingContext = matchingContextForOneProduct();
  const anchors = docsToBackwardAnchors([{ ...seedMayDoc(), status: "complete", closingQty: 45 }]);
  const result = await runBackwardBackfillMonth({
    month: { year: 2026, month: 4 },
    storeId: 1,
    anchors,
    matchingContext,
    earliestByProductId: new Map([[100, "2026-01-01"]]),
    repo,
    rawSalesActivityFetcher: async () => new Map([["1:100:0", 51]]),
  });
  assert.equal(result.ok, true);
  const april = await repo.findMonth(1, 2026, 4);
  assert.equal(april[0].status, "incomplete");
  assert.equal(april[0].salesQty, 0); // TIDAK diisi/ditebak dari sumAbsQty
  assert.equal(april[0].closingQty, 45); // angka rantai TIDAK berubah
});

test("runBackwardBackfillMonth: TANPA rawSalesActivityFetcher (default, tidak diisi) -> status tetap 'complete' seperti sebelum perbaikan (regresi)", async (t) => {
  mockFetchStockmovementByMonth(t, {});
  const repo = createFakeRepo();
  const matchingContext = matchingContextForOneProduct();
  const anchors = docsToBackwardAnchors([{ ...seedMayDoc(), status: "complete", closingQty: 45 }]);
  const result = await runBackwardBackfillMonth({
    month: { year: 2026, month: 4 },
    storeId: 1,
    anchors,
    matchingContext,
    earliestByProductId: new Map([[100, "2026-01-01"]]),
    repo,
  });
  assert.equal(result.ok, true);
  const april = await repo.findMonth(1, 2026, 4);
  assert.equal(april[0].status, "complete");
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

// ---- Lifecycle bulanan baru: current selalu dinamis, historical dipercaya
// setelah finalisasi sekali, future ditolak — regresi bug Juli->Agustus
// (lihat tmp/ai-handoff.md "Inventory July-August Product Timing Audit").
// Fixture di bawah MURNI FIKTIF (bukan productId/nama produksi asli), hanya
// merepresentasikan bentuk kasus: opening 0, incoming 60, sales 1, closing 59.
// ----

test("current month SELALU dihitung ulang — produk baru yang dibuat di tengah bulan ikut masuk bulan yang sama (bukan bulan berikutnya)", async (t) => {
  const stockmovementByStartDate: Record<string, unknown[]> = {
    "2026-07-01": [
      { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 21, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 0, sum_outgoing_qty: 0, sisa: 21 },
    ],
  };
  mockFetchStockmovementByMonth(t, stockmovementByStartDate);
  const repo = createFakeRepo([seedJuneDoc()]);
  const catalogBefore = [product({ _id: "1:100:0", productId: 100, storeId: 1, name: "PRODUK A", category: "GROUP" })];
  const matchingContextBefore = buildMatchingContext(catalogBefore, []);

  // 21 Juli: dihitung pertama kali, produk baru belum ada di Olsera.
  const step1 = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext: matchingContextBefore, now: new Date("2026-07-21T00:00:00Z") });
  assert.equal(step1.ok, true);
  if (step1.ok) {
    assert.equal(step1.docs.length, 1);
    assert.equal(step1.docs[0].finalizedAt, null, "masih current — belum boleh dianggap final");
  }

  // 29 Juli: produk baru dibuat di Olsera + stok masuk 60 + 1 penjualan (bentuk kasus OVERGRIP ALPHA - ECO SOFT).
  stockmovementByStartDate["2026-07-01"] = [
    { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 21, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 0, sum_outgoing_qty: 0, sisa: 21 },
    { product_id: 900001, product_variant_id: 5001, product_name: "GRIP CONTOH", product_variant_name: "VARIAN A", product_group_name: "GRIP", beginning_qty: 0, sum_incoming_qty: 60, sum_return_qty: 0, sum_sales_qty: 1, sum_outgoing_qty: 0, sisa: 59 },
  ];
  const catalogAfter = [...catalogBefore, product({ _id: "1:900001:5001", productId: 900001, variantId: 5001, storeId: 1, name: "GRIP CONTOH", variantName: "VARIAN A", category: "GRIP" })];
  const matchingContextAfter = buildMatchingContext(catalogAfter, []);

  // 30 Juli: diminta lagi (masih current) — HARUS refresh, bukan return dokumen 21 Juli apa adanya.
  const step2 = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext: matchingContextAfter, now: new Date("2026-07-30T00:00:00Z") });
  assert.equal(step2.ok, true);
  if (step2.ok) {
    assert.equal(step2.docs.length, 2, "PRODUK A tetap ada, produk baru bertambah — bukan diganti/dihapus");
    const newProduct = step2.docs.find((d) => d.productId === 900001);
    assert.ok(newProduct, "produk baru yang dibuat di tengah bulan HARUS muncul di bulan yang sama (Juli)");
    assert.equal(newProduct!.openingQty, 0);
    assert.equal(newProduct!.incomingQty, 60);
    assert.equal(newProduct!.salesQty, 1);
    assert.equal(newProduct!.closingQty, 59);
  }
  const julyDocsFinal = await repo.findMonth(1, 2026, 7);
  assert.equal(julyDocsFinal.length, 2, "tidak boleh ada dokumen duplikat/menumpuk dari panggilan berulang");
});

test("current month berulang (CURRENT -> CURRENT -> CURRENT) idempoten — tidak duplicate, hasil konsisten", async (t) => {
  mockFetchStockmovementByMonth(t, {
    "2026-07-01": [
      { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 21, sum_incoming_qty: 5, sum_return_qty: 0, sum_sales_qty: 3, sum_outgoing_qty: 1, sisa: 22 },
    ],
  });
  const repo = createFakeRepo([seedJuneDoc()]);
  const matchingContext = matchingContextForOneProduct();
  const now = new Date("2026-07-15T00:00:00Z");

  const r1 = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext, now });
  const r2 = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext, now });
  const r3 = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext, now });
  assert.ok(r1.ok && r2.ok && r3.ok);
  const all = repo.all().filter((d) => d.year === 2026 && d.month === 7);
  assert.equal(all.length, 1, "tidak boleh ada dokumen duplikat untuk productId+variantId yang sama");
  if (r1.ok && r3.ok) assert.deepEqual(r1.docs.map((d) => d.closingQty), r3.docs.map((d) => d.closingQty));
});

test("movement yang masuk terlambat pada bulan berjalan (purchase/return/sale/outgoing baru) ikut pada refresh berikutnya, tanpa rebuild manual", async (t) => {
  const stockmovementByStartDate: Record<string, unknown[]> = {
    "2026-07-01": [
      { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 21, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 0, sum_outgoing_qty: 0, sisa: 21 },
    ],
  };
  mockFetchStockmovementByMonth(t, stockmovementByStartDate);
  const repo = createFakeRepo([seedJuneDoc()]);
  const matchingContext = matchingContextForOneProduct();

  await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext, now: new Date("2026-07-10T00:00:00Z") });
  // Purchase (incoming) + sale baru masuk pertengahan bulan, terdeteksi Olsera belakangan.
  stockmovementByStartDate["2026-07-01"] = [
    { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 21, sum_incoming_qty: 10, sum_return_qty: 1, sum_sales_qty: 4, sum_outgoing_qty: 0, sisa: 28 },
  ];
  const result = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext, now: new Date("2026-07-25T00:00:00Z") });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.docs[0].incomingQty, 10);
    assert.equal(result.docs[0].returnQty, 1);
    assert.equal(result.docs[0].salesQty, 4);
    assert.equal(result.docs[0].closingQty, 28);
  }
});

test("bulan baru jadi historical & belum pernah difinalisasi -> dihitung ulang SATU KALI, lalu dipercaya (tidak fetch lagi)", async (t) => {
  let fetchCount = 0;
  process.env.OLSERA_APP_ID = "test-app-id";
  process.env.OLSERA_SECRET_KEY = "test-secret";
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/token")) return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
    fetchCount++;
    return new Response(JSON.stringify({ data: [], meta: { current_page: 1, last_page: 1 } }), { status: 200 });
  });
  // Dokumen Juli ditulis SAAT masih current (finalizedAt: null) — belum pernah difinalisasi.
  const staleJuly: OlseraInventoryMonthlySnapshotDocument = { ...seedJuneDoc(), _id: "1:2026:07:100:0", year: 2026, month: 7, finalizedAt: null };
  const repo = createFakeRepo([seedJuneDoc(), staleJuly]);
  const matchingContext = matchingContextForOneProduct();
  const now = new Date("2026-08-05T00:00:00Z"); // Juli sudah lewat, Agustus sekarang current.

  const r1 = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext, now });
  assert.equal(r1.ok, true);
  assert.equal(fetchCount, 1, "harus fetch sekali untuk finalisasi Juli yang belum pernah final");
  if (r1.ok) assert.notEqual(r1.docs[0].finalizedAt, null, "setelah finalisasi, finalizedAt harus terisi");

  const r2 = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext, now });
  assert.equal(r2.ok, true);
  assert.equal(fetchCount, 1, "panggilan kedua untuk bulan yang SUDAH final tidak boleh fetch lagi");
});

test("bulan historical yang SUDAH difinalisasi (finalizedAt Date) -> dipercaya langsung, tidak fetch API", async (t) => {
  let fetchCalled = false;
  process.env.OLSERA_APP_ID = "test-app-id";
  process.env.OLSERA_SECRET_KEY = "test-secret";
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });
  const finalizedJuly: OlseraInventoryMonthlySnapshotDocument = { ...seedJuneDoc(), _id: "1:2026:07:100:0", year: 2026, month: 7, finalizedAt: new Date("2026-08-01T00:00:00Z") };
  const repo = createFakeRepo([seedJuneDoc(), finalizedJuly]);
  const matchingContext = matchingContextForOneProduct();
  const result = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext, now: new Date("2026-08-05T00:00:00Z") });
  assert.equal(result.ok, true);
  assert.equal(fetchCalled, false);
});

test("dokumen historical LEGACY tanpa field finalizedAt sama sekali -> dipercaya (backward compatible), tidak memicu hitung ulang massal", async (t) => {
  let fetchCalled = false;
  process.env.OLSERA_APP_ID = "test-app-id";
  process.env.OLSERA_SECRET_KEY = "test-secret";
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });
  const legacyJuly = seedJuneDoc(); // helper generik dipakai ulang sbg dokumen legacy (tanpa finalizedAt sama sekali)
  const repo = createFakeRepo([{ ...legacyJuly, _id: "1:2026:07:100:0", year: 2026, month: 7 }]);
  const matchingContext = matchingContextForOneProduct();
  const result = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext, now: new Date("2026-08-05T00:00:00Z") });
  assert.equal(result.ok, true);
  assert.equal(fetchCalled, false, "dokumen legacy TIDAK memicu fetch — hanya rebuild eksplisit (script terpisah) yang boleh membetulkannya");
});

test("finalisasi bulan sebelumnya terjadi SEBELUM dipakai sebagai opening bulan berjalan (cascade Juli stale -> Agustus current)", async (t) => {
  const stockmovementByStartDate: Record<string, unknown[]> = {
    "2026-07-01": [
      { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 21, sum_incoming_qty: 10, sum_return_qty: 0, sum_sales_qty: 4, sum_outgoing_qty: 0, sisa: 27 },
    ],
    "2026-08-01": [
      { product_id: 100, product_name: "PRODUK A", product_group_name: "GROUP", beginning_qty: 27, sum_incoming_qty: 0, sum_return_qty: 0, sum_sales_qty: 2, sum_outgoing_qty: 0, sisa: 25 },
    ],
  };
  mockFetchStockmovementByMonth(t, stockmovementByStartDate);
  // Juli belum pernah difinalisasi (mis. bug lama — dokumen lama closingQty=21, TIDAK mencerminkan incoming 10/sales 4 yang baru terbukti).
  const staleJuly: OlseraInventoryMonthlySnapshotDocument = { ...seedJuneDoc(), _id: "1:2026:07:100:0", year: 2026, month: 7, closingQty: 21, finalizedAt: null };
  const repo = createFakeRepo([seedJuneDoc(), staleJuly]);
  const matchingContext = matchingContextForOneProduct();

  const result = await ensureMonthlySnapshotChain({ year: 2026, month: 8, repo, matchingContext, now: new Date("2026-08-10T00:00:00Z") });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.docs[0].openingQty, 27, "opening Agustus HARUS memakai closing Juli yang SUDAH difinalisasi ulang (27), bukan closing lama yang stale (21)");

  const julyAfter = await repo.findMonth(1, 2026, 7);
  assert.equal(julyAfter[0].closingQty, 27);
  assert.notEqual(julyAfter[0].finalizedAt, null, "Juli sekarang sudah final");
});

test("future period ditolak — tidak pernah digenerate seolah sudah berjalan", async (t) => {
  const repo = createFakeRepo([seedJuneDoc()]);
  const matchingContext = matchingContextForOneProduct();
  const result = await ensureMonthlySnapshotChain({ year: 2026, month: 12, repo, matchingContext, now: new Date("2026-08-05T00:00:00Z") });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /belum dimulai/i);
});

test("source API gagal (401) saat refresh current -> TIDAK menimpa dokumen lama yang valid, error dikembalikan apa adanya", async (t) => {
  process.env.OLSERA_APP_ID = "test-app-id";
  process.env.OLSERA_SECRET_KEY = "test-secret";
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/token")) return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  });
  const existingJuly: OlseraInventoryMonthlySnapshotDocument = { ...seedJuneDoc(), _id: "1:2026:07:100:0", year: 2026, month: 7, closingQty: 21, finalizedAt: null };
  const repo = createFakeRepo([seedJuneDoc(), existingJuly]);
  const matchingContext = matchingContextForOneProduct();

  const result = await ensureMonthlySnapshotChain({ year: 2026, month: 7, repo, matchingContext, now: new Date("2026-07-20T00:00:00Z") });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /token|401/i);

  const julyAfterFailure = await repo.findMonth(1, 2026, 7);
  assert.equal(julyAfterFailure.length, 1);
  assert.equal(julyAfterFailure[0].closingQty, 21, "dokumen lama yang valid TIDAK BOLEH ditimpa/kosong akibat kegagalan fetch");
});

test("backward zone (<= Juni 2026) TIDAK terpengaruh — bulan historis lama tetap dipercaya langsung seperti sebelumnya", async (t) => {
  let fetchCalled = false;
  process.env.OLSERA_APP_ID = "test-app-id";
  process.env.OLSERA_SECRET_KEY = "test-secret";
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  });
  const repo = createFakeRepo([seedMayDoc()]);
  const matchingContext = matchingContextForOneProduct();
  const result = await ensureMonthlySnapshotChain({ year: 2026, month: 5, repo, matchingContext, now: new Date("2026-08-05T00:00:00Z") });
  assert.equal(result.ok, true);
  assert.equal(fetchCalled, false);
});
