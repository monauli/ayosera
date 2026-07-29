// Test unit helper Inventori Olsera. Jalankan: npm run test:olsera-inventory
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMovementIdentityIndex,
  buildMovementNameIndex,
  buildNameIndex,
  buildPendingDates,
  computeConsistency,
  dateRangeList,
  flattenOlseraProduct,
  inventoryValueFor,
  isInventorySyncStale,
  normalizeItemName,
  planMovementReconciliation,
  planStaleClosure,
  selectMovementProduct,
  shouldStopCronLoop,
  stockStatusFor,
  summarizeInventory,
  toInventoryNumber,
  DEFAULT_LOW_STOCK_THRESHOLD,
  INVENTORY_BASELINE_DATE,
  INVENTORY_SYNC_STALE_MS,
  INVENTORY_SYNC_STALE_MINUTES,
  type InventoryProductInput,
} from "./olsera-inventory-core.ts";

function makeProduct(overrides: Partial<InventoryProductInput>): InventoryProductInput {
  return {
    _id: "324175:1:0",
    productId: 1,
    variantId: null,
    sku: "SKU-1",
    barcode: null,
    name: "PRODUK",
    variantName: null,
    category: "MINUMAN",
    subCategory: null,
    uom: "pcs",
    storeId: 324175,
    storeName: "BC PADEL CLUB",
    active: true,
    trackInventory: true,
    sellPrice: 10000,
    buyPrice: 4000,
    lastBuyPrice: 4000,
    stockQty: 10,
    holdQty: 0,
    lowStockAlert: null,
    isOutStock: false,
    modifiedTime: null,
    stockSyncTime: null,
    ...overrides,
  };
}

test("baseline tetap 1 Februari 2026", () => {
  assert.equal(INVENTORY_BASELINE_DATE, "2026-02-01");
});

test("toInventoryNumber: string desimal titik & string kosong", () => {
  assert.equal(toInventoryNumber("78585.42"), 78585.42);
  assert.equal(toInventoryNumber("0"), 0);
  assert.equal(toInventoryNumber(""), 0);
  assert.equal(toInventoryNumber(null), 0);
  assert.equal(toInventoryNumber(12), 12);
});

test("flatten: produk tanpa variant → satu baris dengan field lengkap", () => {
  const rows = flattenOlseraProduct({
    id: 118420650,
    name: "YONEX SHORTS",
    sku: "",
    klasifikasi: "CELANA PRIA",
    category_name: "Others",
    store_id: 324175,
    store_name: "BC PADEL CLUB",
    track_inventory: 1,
    has_variant: 0,
    published: 1,
    stock_qty: "3",
    hold_qty: "0",
    low_stock_alert: "0",
    buy_price: "78585.42",
    last_buy_price: "0.00",
    sell_price: "150000.00",
    sell_price_pos: "150000.00",
    is_out_stock: 0,
    barcode: null,
    uom: "",
    modified_time: "2026-07-03 09:47:51",
    stock_sync_time: "2026-07-03 09:47:51",
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row._id, "324175:118420650:0");
  assert.equal(row.variantId, null);
  assert.equal(row.sku, null); // sku kosong → null
  assert.equal(row.category, "CELANA PRIA");
  assert.equal(row.subCategory, "Others");
  assert.equal(row.stockQty, 3);
  assert.equal(row.buyPrice, 78585.42);
  assert.equal(row.sellPrice, 150000);
  assert.equal(row.lowStockAlert, null); // 0 → null (threshold default)
  assert.equal(row.trackInventory, true);
  assert.equal(row.active, true);
});

test("flatten: produk ber-variant → satu baris per variant dengan stok/harga variant", () => {
  const rows = flattenOlseraProduct({
    id: 113421321,
    name: "SEWA RAKET",
    sku: "RAKET",
    klasifikasi: "LABERS",
    store_id: 324175,
    track_inventory: 1,
    has_variant: 1,
    published: 1,
    low_stock_alert: "2",
    variants: [
      { id: 62562829, sku: "", name: "1 Jam,", stock_qty: 4, hold_qty: 0, buy_price: "1000.00", last_buy_price: "0.00", sell_price: "50000.00", sell_price_pos: "50000.00", status: "A", is_out_stock: 0, variant_barcode: null },
      { id: 62562830, sku: "RAKET-2", name: "2 Jam", stock_qty: 0, hold_qty: 0, buy_price: "0.00", sell_price: "90000.00", status: "A", is_out_stock: 1 },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]._id, "324175:113421321:62562829");
  assert.equal(rows[0].variantName, "1 Jam,");
  assert.equal(rows[0].sku, "RAKET"); // fallback ke sku produk
  assert.equal(rows[0].stockQty, 4);
  assert.equal(rows[0].buyPrice, 1000);
  assert.equal(rows[0].lowStockAlert, 2);
  assert.equal(rows[1].sku, "RAKET-2");
  assert.equal(rows[1].isOutStock, true);
});

test("flatten: produk tanpa kategori & tanpa harga modal tetap valid", () => {
  const rows = flattenOlseraProduct({ id: 5, name: "X", has_variant: 0, published: 0, klasifikasi: "" });
  assert.equal(rows[0].category, "(tanpa klasifikasi)");
  assert.equal(rows[0].buyPrice, 0);
  assert.equal(rows[0].active, false);
});

test("status stok: aman / hampir habis / habis / data tidak lengkap", () => {
  assert.equal(stockStatusFor(makeProduct({ stockQty: 10 })), "Aman");
  assert.equal(stockStatusFor(makeProduct({ stockQty: DEFAULT_LOW_STOCK_THRESHOLD })), "Hampir Habis");
  assert.equal(stockStatusFor(makeProduct({ stockQty: 0 })), "Habis");
  assert.equal(stockStatusFor(makeProduct({ stockQty: -2 })), "Habis"); // stok negatif = habis
  assert.equal(stockStatusFor(makeProduct({ trackInventory: false })), "Data Tidak Lengkap");
  // minimum stock Olsera dipakai bila tersedia
  assert.equal(stockStatusFor(makeProduct({ stockQty: 8, lowStockAlert: 10 })), "Hampir Habis");
  assert.equal(stockStatusFor(makeProduct({ stockQty: 8, lowStockAlert: 3 })), "Aman");
  // tanpa harga modal (buy_price 0/tidak diisi Olsera) → data tidak lengkap, bukan Aman/Habis
  assert.equal(stockStatusFor(makeProduct({ stockQty: 8, buyPrice: 0 })), "Data Tidak Lengkap");
  assert.equal(stockStatusFor(makeProduct({ stockQty: 0, buyPrice: 0 })), "Data Tidak Lengkap");
});

test("nilai persediaan = stok × harga modal", () => {
  assert.equal(inventoryValueFor(makeProduct({ stockQty: 7, buyPrice: 4000 })), 28000);
  assert.equal(inventoryValueFor(makeProduct({ stockQty: 0, buyPrice: 4000 })), 0);
});

test("summary: agregat dari data produk", () => {
  const summary = summarizeInventory([
    makeProduct({ _id: "a", stockQty: 10, buyPrice: 1000 }),
    makeProduct({ _id: "b", stockQty: 0, buyPrice: 500 }),
    makeProduct({ _id: "c", stockQty: 3, buyPrice: 200, lowStockAlert: 5 }),
    makeProduct({ _id: "d", trackInventory: false, active: false }),
  ]);
  assert.equal(summary.totalProducts, 4);
  assert.equal(summary.activeProducts, 3);
  assert.equal(summary.outOfStock, 1);
  assert.equal(summary.lowStock, 1);
  assert.equal(summary.totalStock, 13);
  assert.equal(summary.totalValue, 10 * 1000 + 0 + 3 * 200);
  assert.equal(summary.usesDefaultThreshold, true);
});

test("name index: produk polos dan ber-variant cocok dengan itemName order", () => {
  const index = buildNameIndex([
    makeProduct({ _id: "a", name: "POCARI SWEAT" }),
    makeProduct({ _id: "b", name: "SEWA RAKET", variantName: "1 Jam," }),
  ]);
  assert.equal(index.get(normalizeItemName("Pocari Sweat"))?._id, "a");
  assert.equal(index.get(normalizeItemName("SEWA RAKET - 1 Jam,"))?._id, "b");
  assert.equal(index.get(normalizeItemName("TIDAK ADA")), undefined);
});

test("konsistensi: Snapshot Tersedia saat penjualan tercatat menjelaskan perubahan snapshot", () => {
  const row = computeConsistency({
    key: "a",
    sku: null,
    name: "POCARI",
    category: "MINUMAN",
    trackInventory: true,
    snapshots: [
      { date: "2026-07-10", stockQty: 20 },
      { date: "2026-07-14", stockQty: 15 },
    ],
    movements: [
      { date: "2026-07-12", qtyChange: -3 },
      { date: "2026-07-13", qtyChange: -2 },
    ],
  });
  assert.equal(row.startSnapshotQty, 20);
  assert.equal(row.recordedSales, 5);
  assert.equal(row.endSnapshotQty, 15);
  assert.equal(row.snapshotChange, -5);
  assert.equal(row.status, "Snapshot Tersedia");
});

test("konsistensi: Perlu Stock Opname saat perubahan snapshot tidak habis dijelaskan penjualan tercatat", () => {
  const row = computeConsistency({
    key: "a",
    sku: null,
    name: "POCARI",
    category: "MINUMAN",
    trackInventory: true,
    snapshots: [
      { date: "2026-07-10", stockQty: 20 },
      { date: "2026-07-14", stockQty: 30 },
    ],
    movements: [{ date: "2026-07-12", qtyChange: -3 }],
  });
  assert.equal(row.recordedSales, 3);
  assert.equal(row.snapshotChange, 10); // naik 10, padahal penjualan tercatat hanya -3 (bukan angka stok masuk palsu)
  assert.equal(row.status, "Perlu Stock Opname");
});

test("konsistensi: satu snapshot = histori tidak lengkap (snapshot tetap ditampilkan, perubahan/penjualan tidak dihitung)", () => {
  const single = computeConsistency({
    key: "a", sku: null, name: "X", category: "Y", trackInventory: true,
    snapshots: [{ date: "2026-07-14", stockQty: 5 }],
    movements: [],
  });
  assert.equal(single.status, "Histori Tidak Lengkap");
  assert.equal(single.startSnapshotQty, 5);
  assert.equal(single.endSnapshotQty, 5);
  assert.equal(single.recordedSales, null);
  assert.equal(single.snapshotChange, null);

  const none = computeConsistency({
    key: "a", sku: null, name: "X", category: "Y", trackInventory: true,
    snapshots: [],
    movements: [],
  });
  assert.equal(none.status, "Belum Ada Snapshot");
});

test("dateRangeList & buildPendingDates: incremental + prioritas tanggal gagal, tanpa duplikat", () => {
  assert.deepEqual(dateRangeList("2026-07-12", "2026-07-14"), ["2026-07-12", "2026-07-13", "2026-07-14"]);
  const queue = buildPendingDates(["2026-06-20", "2026-07-13"], "2026-07-12", "2026-07-14");
  assert.deepEqual(queue, ["2026-06-20", "2026-07-13", "2026-07-12", "2026-07-14"]);
  // klik dua kali: antrian deterministik yang sama — upsert menjamin tanpa duplikat data.
  assert.deepEqual(queue, buildPendingDates(["2026-07-13", "2026-06-20"], "2026-07-12", "2026-07-14"));
});

// --- Stale-lock: isInventorySyncStale & planStaleClosure ---
// Fixture waktu tetap (bukan Date.now() nyata) supaya test tidak bergantung jam sistem.
const NOW = new Date("2026-07-16T10:00:00.000Z");
const RECENT_HEARTBEAT = new Date(NOW.getTime() - 5 * 60 * 1000); // 5 menit lalu
const OLD_HEARTBEAT = new Date(NOW.getTime() - (INVENTORY_SYNC_STALE_MS + 60_000)); // basi + 1 menit

test("isInventorySyncStale: run running dengan heartbeat baru -> tidak stale", () => {
  const run = { status: "running" as const, startedAt: OLD_HEARTBEAT, updatedAt: RECENT_HEARTBEAT };
  assert.equal(isInventorySyncStale(run, NOW), false);
});

test("isInventorySyncStale: run running melewati batas waktu -> stale", () => {
  const run = { status: "running" as const, startedAt: OLD_HEARTBEAT, updatedAt: OLD_HEARTBEAT };
  assert.equal(isInventorySyncStale(run, NOW), true);
});

test("isInventorySyncStale: persis di batas waktu (belum lewat) -> tidak stale", () => {
  const boundary = new Date(NOW.getTime() - INVENTORY_SYNC_STALE_MS);
  const run = { status: "running" as const, startedAt: boundary, updatedAt: boundary };
  assert.equal(isInventorySyncStale(run, NOW), false);
});

test("isInventorySyncStale: status success/failed/partial tidak pernah dianggap stale meski heartbeat sangat lama", () => {
  for (const status of ["success", "failed", "partial"] as const) {
    const run = { status, startedAt: OLD_HEARTBEAT, updatedAt: OLD_HEARTBEAT };
    assert.equal(isInventorySyncStale(run, NOW), false, `status ${status} seharusnya tidak stale`);
  }
});

test("isInventorySyncStale: dokumen lama tanpa updatedAt -> fallback ke startedAt", () => {
  const staleByStartedAt = { status: "running" as const, startedAt: OLD_HEARTBEAT };
  assert.equal(isInventorySyncStale(staleByStartedAt, NOW), true);

  const freshByStartedAt = { status: "running" as const, startedAt: RECENT_HEARTBEAT };
  assert.equal(isInventorySyncStale(freshByStartedAt, NOW), false);

  // updatedAt null (bukan hanya undefined) juga harus fallback, bukan dianggap "0"/Invalid Date.
  const nullUpdatedAt = { status: "running" as const, startedAt: RECENT_HEARTBEAT, updatedAt: null };
  assert.equal(isInventorySyncStale(nullUpdatedAt, NOW), false);
});

test("planStaleClosure: fase movements dengan progres -> partial, currentDate masuk failedDates, pendingDates/processedDays tidak disentuh", () => {
  const plan = planStaleClosure({
    phase: "movements",
    currentDate: "2026-07-10",
    failedDates: ["2026-07-05"],
    processedDays: 3,
    createdRecords: 12,
    updatedRecords: 4,
  });
  assert.equal(plan.status, "partial");
  assert.equal(plan.phase, "done");
  assert.deepEqual(plan.failedDates, ["2026-07-05", "2026-07-10"]);
  assert.match(plan.errorMessage, /heartbeat/i);
  assert.match(plan.errorMessage, new RegExp(String(INVENTORY_SYNC_STALE_MINUTES)));
});

test("planStaleClosure: currentDate sudah ada di failedDates -> tidak dobel", () => {
  const plan = planStaleClosure({
    phase: "movements",
    currentDate: "2026-07-05",
    failedDates: ["2026-07-05"],
    processedDays: 1,
    createdRecords: 0,
    updatedRecords: 0,
  });
  assert.deepEqual(plan.failedDates, ["2026-07-05"]);
});

test("planStaleClosure: currentDate null (mis. macet pas transisi fase) -> failedDates tidak berubah", () => {
  const plan = planStaleClosure({
    phase: "movements",
    currentDate: null,
    failedDates: ["2026-07-05"],
    processedDays: 2,
    createdRecords: 0,
    updatedRecords: 0,
  });
  assert.deepEqual(plan.failedDates, ["2026-07-05"]);
});

test("planStaleClosure: macet di fase products tanpa progres apa pun -> failed", () => {
  const plan = planStaleClosure({
    phase: "products",
    currentDate: null,
    failedDates: [],
    processedDays: 0,
    createdRecords: 0,
    updatedRecords: 0,
  });
  assert.equal(plan.status, "failed");
  assert.equal(plan.phase, "done");
  assert.deepEqual(plan.failedDates, []);
});

test("planStaleClosure: fase products tapi sudah ada createdRecords -> tetap dianggap ada progres (partial)", () => {
  const plan = planStaleClosure({
    phase: "products",
    currentDate: null,
    failedDates: [],
    processedDays: 0,
    createdRecords: 5,
    updatedRecords: 0,
  });
  assert.equal(plan.status, "partial");
});

// --- Loop step cron: shouldStopCronLoop (lib/cron-olsera-inventory.ts) ---

test("shouldStopCronLoop: masih jauh dari deadline & iterasi -> null (lanjut)", () => {
  const result = shouldStopCronLoop({ iterations: 3, maxIterations: 400, nowMs: 1_000, deadlineMs: 10_000 });
  assert.equal(result, null);
});

test("shouldStopCronLoop: nowMs sudah lewat deadlineMs -> 'deadline'", () => {
  const result = shouldStopCronLoop({ iterations: 3, maxIterations: 400, nowMs: 10_001, deadlineMs: 10_000 });
  assert.equal(result, "deadline");
});

test("shouldStopCronLoop: persis di deadlineMs (belum lewat) -> berhenti juga ('deadline'), bukan lanjut", () => {
  // >= dipakai (bukan >) supaya loop TIDAK PERNAH memulai step baru yang bisa
  // melewati batas waktu eksekusi — lebih aman condong berhenti lebih awal.
  const result = shouldStopCronLoop({ iterations: 3, maxIterations: 400, nowMs: 10_000, deadlineMs: 10_000 });
  assert.equal(result, "deadline");
});

test("shouldStopCronLoop: iterations sudah mencapai maxIterations -> 'max-iterations', walau deadline masih jauh", () => {
  const result = shouldStopCronLoop({ iterations: 400, maxIterations: 400, nowMs: 1_000, deadlineMs: 999_999_999 });
  assert.equal(result, "max-iterations");
});

test("shouldStopCronLoop: iterations DAN deadline sama-sama terlewati -> 'max-iterations' (dicek lebih dulu)", () => {
  const result = shouldStopCronLoop({ iterations: 500, maxIterations: 400, nowMs: 999_999, deadlineMs: 1 });
  assert.equal(result, "max-iterations");
});

test("shouldStopCronLoop: iterations 0 di bawah maxIterations & nowMs jauh di bawah deadline -> tidak pernah berhenti prematur", () => {
  for (let i = 0; i < 400; i++) {
    assert.equal(shouldStopCronLoop({ iterations: i, maxIterations: 400, nowMs: 0, deadlineMs: 1 }), null);
  }
});

// --- Movement product mapping: selectMovementProduct & index builders ---
function movementIdentity(
  overrides: Partial<{ itemName: string; productId: number | null; variantId: number | null; resolvedProductId: number | null }> = {},
) {
  return { itemName: "PRODUK", productId: null, variantId: null, resolvedProductId: null, ...overrides };
}

test("buildMovementIdentityIndex: kelompokkan seluruh kandidat per productId", () => {
  const catalog = [
    makeProduct({ _id: "a", productId: 1, variantId: null }),
    makeProduct({ _id: "b", productId: 2, variantId: 10 }),
    makeProduct({ _id: "c", productId: 2, variantId: 20 }),
  ];
  const index = buildMovementIdentityIndex(catalog);
  assert.equal(index.get(1)?.length, 1);
  assert.equal(index.get(2)?.length, 2);
  assert.equal(index.get(999), undefined);
});

test("buildMovementNameIndex: nama polos produk ber-variant >1 terdaftar ambigu; produk tunggal tidak", () => {
  const catalog = [
    makeProduct({ _id: "a", productId: 1, name: "TUNGGAL" }),
    makeProduct({ _id: "b", productId: 2, variantId: 1, variantName: "X", name: "GANDA" }),
    makeProduct({ _id: "c", productId: 2, variantId: 2, variantName: "Y", name: "GANDA" }),
  ];
  const index = buildMovementNameIndex(catalog);
  assert.equal(index.get("TUNGGAL")?.length, 1);
  assert.equal(index.get("GANDA")?.length, 2); // nama polos ambigu — 2 variant terdaftar
  assert.equal(index.get("GANDA - X")?.length, 1);
  assert.equal(index.get("GANDA - Y")?.length, 1);
});

test("selectMovementProduct: 1. resolvedProductId dipakai meski nama produk berganti/berbeda saat transaksi", () => {
  const catalog = [makeProduct({ _id: "324175:200:0", productId: 200, name: "NAMA BARU DI KATALOG" })];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const item = movementIdentity({ itemName: "NAMA LAMA SAAT TRANSAKSI", productId: 999, resolvedProductId: 200 });
  const result = selectMovementProduct(item, idIndex, nameIndex);
  assert.equal(result.product?._id, "324175:200:0");
  assert.equal(result.method, "resolvedProductId");
  assert.match(result.note, /resolvedProductId/);
});

test("selectMovementProduct: 2. productId + variantId cocok -> variant yang benar dipilih", () => {
  const catalog = [
    makeProduct({ _id: "324175:300:10", productId: 300, variantId: 10, variantName: "STANDAR" }),
    makeProduct({ _id: "324175:300:20", productId: 300, variantId: 20, variantName: "PREMIUM" }),
  ];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const item = movementIdentity({ itemName: "PRODUK - PREMIUM", productId: 300, variantId: 20 });
  const result = selectMovementProduct(item, idIndex, nameIndex);
  assert.equal(result.product?._id, "324175:300:20");
  assert.equal(result.method, "productId+variantId");
});

test("selectMovementProduct: 3. productId cocok dengan satu produk (tanpa variant) -> dipakai", () => {
  const catalog = [makeProduct({ _id: "324175:400:0", productId: 400 })];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const item = movementIdentity({ itemName: "APAPUN NAMANYA DI TRANSAKSI", productId: 400 });
  const result = selectMovementProduct(item, idIndex, nameIndex);
  assert.equal(result.product?._id, "324175:400:0");
  assert.equal(result.method, "productId");
});

test("selectMovementProduct: 4. exact normalized name unik berhasil sebagai fallback terakhir", () => {
  const catalog = [makeProduct({ _id: "324175:500:0", productId: 500, name: "ES KOPI SUSU" })];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const item = movementIdentity({ itemName: "es kopi susu" }); // tanpa identitas ID sama sekali
  const result = selectMovementProduct(item, idIndex, nameIndex);
  assert.equal(result.product?._id, "324175:500:0");
  assert.equal(result.method, "name");
});

test("selectMovementProduct: 5. nama sama untuk beberapa produk -> tidak memilih sembarang (ambiguous)", () => {
  const catalog = [
    makeProduct({ _id: "324175:600:0", productId: 600, name: "COURT FEES" }),
    makeProduct({ _id: "324175:601:0", productId: 601, name: "COURT FEES" }),
  ];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const item = movementIdentity({ itemName: "COURT FEES" });
  const result = selectMovementProduct(item, idIndex, nameIndex);
  assert.equal(result.product, null);
  assert.equal(result.method, "ambiguous-name");
});

test("selectMovementProduct: 6. seluruh identitas kosong & nama tidak cocok -> productId null + note", () => {
  const catalog = [makeProduct({ _id: "324175:700:0", productId: 700, name: "PRODUK LAIN" })];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const item = movementIdentity({ itemName: "TIDAK DIKENAL SAMA SEKALI" });
  const result = selectMovementProduct(item, idIndex, nameIndex);
  assert.equal(result.product, null);
  assert.equal(result.method, "unmatched");
  assert.match(result.note, /tidak ditemukan/i);
});

test("selectMovementProduct: 7. SKU kosong tidak memengaruhi mapping (bukan kriteria pencocokan)", () => {
  const catalog = [makeProduct({ _id: "324175:800:0", productId: 800, sku: null, name: "PRODUK SKU KOSONG" })];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const item = movementIdentity({ itemName: "produk sku kosong" });
  const result = selectMovementProduct(item, idIndex, nameIndex);
  assert.equal(result.product?._id, "324175:800:0");
  assert.equal(result.method, "name");
});

test("selectMovementProduct: variantId item tidak cocok kandidat manapun -> tidak menebak variant, fallback nama bila unik", () => {
  const catalog = [
    makeProduct({ _id: "324175:900:11", productId: 900, variantId: 11, variantName: "A", name: "MULTI VARIANT ITEM" }),
    makeProduct({ _id: "324175:900:12", productId: 900, variantId: 12, variantName: "B", name: "MULTI VARIANT ITEM" }),
  ];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  // variantId 99 tidak ada di katalog untuk productId 900 — tidak boleh menebak salah satu dari A/B.
  const item = movementIdentity({ itemName: "MULTI VARIANT ITEM - A", productId: 900, variantId: 99 });
  const result = selectMovementProduct(item, idIndex, nameIndex);
  // Nama "MULTI VARIANT ITEM - A" unik di katalog -> fallback nama berhasil (bukan tebakan by ID).
  assert.equal(result.product?._id, "324175:900:11");
  assert.equal(result.method, "name");
});

test("selectMovementProduct: 8. productId ambigu (banyak variant) tanpa variantId item -> fallback nama, bukan variant pertama", () => {
  const catalog = [
    makeProduct({ _id: "324175:1000:21", productId: 1000, variantId: 21, variantName: "STANDAR", name: "SEWA RAKET" }),
    makeProduct({ _id: "324175:1000:22", productId: 1000, variantId: 22, variantName: "PREMIUM", name: "SEWA RAKET" }),
  ];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const item = movementIdentity({ itemName: "SEWA RAKET", productId: 1000, variantId: null });
  const result = selectMovementProduct(item, idIndex, nameIndex);
  // Nama polos "SEWA RAKET" juga ambigu (2 variant terdaftar di baseKey) -> tidak boleh menebak.
  assert.equal(result.product, null);
  assert.equal(result.method, "ambiguous-name");
});

// --- Regresi: nama produk mirip TIDAK boleh tertukar (kasus nyata Juni 2026:
// "YONEX MENS SHORTS # SM-P061-3085-RW2-S" vs "YONEX SHORTS MEN #
// SM-J035-2906-RW1-S" — penjualan salah satunya sempat tercatat kurang dari
// laporan resmi Backoffice; diaudit sampai ke fungsi matching ini untuk
// memastikan logika-nya sendiri TIDAK menjadi sumber salah atribusi bila
// productId/nama order item cocok persis). ---

test("selectMovementProduct: regresi — dua produk nama sangat mirip (YONEX SHORTS) tidak pernah tertukar via productId", () => {
  const catalog = [
    makeProduct({ _id: "1:5001:0", productId: 5001, name: "YONEX MENS SHORTS # SM-P061-3085-RW2-S" }),
    makeProduct({ _id: "1:5002:0", productId: 5002, name: "YONEX SHORTS MEN # SM-J035-2906-RW1-S" }),
  ];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);

  const itemA = movementIdentity({ itemName: "YONEX MENS SHORTS # SM-P061-3085-RW2-S", productId: 5001, variantId: null });
  const resultA = selectMovementProduct(itemA, idIndex, nameIndex);
  assert.equal(resultA.product?._id, "1:5001:0");

  const itemB = movementIdentity({ itemName: "YONEX SHORTS MEN # SM-J035-2906-RW1-S", productId: 5002, variantId: null });
  const resultB = selectMovementProduct(itemB, idIndex, nameIndex);
  assert.equal(resultB.product?._id, "1:5002:0");
});

test("selectMovementProduct: regresi — nama order item PERSIS cocok tanpa productId tetap ke produk yang benar (bukan yang mirip)", () => {
  const catalog = [
    makeProduct({ _id: "1:5001:0", productId: 5001, name: "YONEX MENS SHORTS # SM-P061-3085-RW2-S" }),
    makeProduct({ _id: "1:5002:0", productId: 5002, name: "YONEX SHORTS MEN # SM-J035-2906-RW1-S" }),
  ];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  // productId hilang dari payload (skenario yang diduga menyebabkan "kurang 3 unit" —
  // lihat audit) — fallback nama HARUS tetap tepat, bukan ambigu/tertukar,
  // karena kedua nama full (termasuk suffix SKU) berbeda persis.
  const item = movementIdentity({ itemName: "YONEX SHORTS MEN # SM-J035-2906-RW1-S", productId: null, variantId: null });
  const result = selectMovementProduct(item, idIndex, nameIndex);
  assert.equal(result.product?._id, "1:5002:0");
  assert.equal(result.method, "name");
});

test("selectMovementProduct: regresi — nama order item TERPOTONG (tanpa suffix SKU) tidak cocok ke produk manapun — unmatched, bukan tebakan salah", () => {
  // Hipotesis akar masalah "kurang 3 unit": bila Olsera mengirim item_name
  // terpotong ("YONEX SHORTS MEN" saja, tanpa "# SM-J035-2906-RW1-S") dan
  // productId juga kosong, fallback nama TIDAK exact match -> item unresolved
  // (dikecualikan dari olsera_inventory_movements), BUKAN tertukar ke produk
  // lain. Ini bukti bahwa logika matching-nya sendiri aman (tidak salah
  // atribusi) — akar masalah (bila hipotesis ini benar) ada di data mentah
  // Olsera (item_name terpotong/productId kosong), di luar jangkauan fungsi ini.
  const catalog = [
    makeProduct({ _id: "1:5001:0", productId: 5001, name: "YONEX MENS SHORTS # SM-P061-3085-RW2-S" }),
    makeProduct({ _id: "1:5002:0", productId: 5002, name: "YONEX SHORTS MEN # SM-J035-2906-RW1-S" }),
  ];
  const idIndex = buildMovementIdentityIndex(catalog);
  const nameIndex = buildMovementNameIndex(catalog);
  const item = movementIdentity({ itemName: "YONEX SHORTS MEN", productId: null, variantId: null });
  const result = selectMovementProduct(item, idIndex, nameIndex);
  assert.equal(result.product, null);
  assert.equal(result.method, "unmatched");
});

// --- Orphan cleanup: planMovementReconciliation ---

test("planMovementReconciliation: 13. tanggal belum fully synced -> cleanup dilewati, alasan tercatat", () => {
  const plan = planMovementReconciliation({
    expectedIds: ["sale:1"],
    existingSaleMovementIds: ["sale:1", "sale:2"],
    dateFullySynced: false,
  });
  assert.deepEqual(plan.idsToDelete, []);
  assert.equal(plan.cleanupSkipped, true);
  assert.match(plan.cleanupSkippedReason ?? "", /belum terkonfirmasi/i);
});

test("planMovementReconciliation: 11. tanggal fully synced -> movement yatim (tidak ada di expected) dihapus", () => {
  const plan = planMovementReconciliation({
    expectedIds: ["sale:1"],
    existingSaleMovementIds: ["sale:1", "sale:2", "sale:3"],
    dateFullySynced: true,
  });
  assert.deepEqual(plan.idsToDelete.sort(), ["sale:2", "sale:3"]);
  assert.equal(plan.cleanupSkipped, false);
  assert.equal(plan.cleanupSkippedReason, null);
});

test("planMovementReconciliation: 12. semua item dibatalkan (expected kosong) & fully synced -> semua movement sale tanggal itu dihapus", () => {
  const plan = planMovementReconciliation({
    expectedIds: [],
    existingSaleMovementIds: ["sale:1", "sale:2"],
    dateFullySynced: true,
  });
  assert.deepEqual(plan.idsToDelete.sort(), ["sale:1", "sale:2"]);
});

test("planMovementReconciliation: tidak ada movement yatim -> idsToDelete kosong (re-run aman)", () => {
  const plan = planMovementReconciliation({
    expectedIds: ["sale:1", "sale:2"],
    existingSaleMovementIds: ["sale:1", "sale:2"],
    dateFullySynced: true,
  });
  assert.deepEqual(plan.idsToDelete, []);
});

test("planMovementReconciliation: idempotent — input sama menghasilkan output sama", () => {
  const input = { expectedIds: ["sale:1"], existingSaleMovementIds: ["sale:1", "sale:2"], dateFullySynced: true };
  const first = planMovementReconciliation(input);
  const second = planMovementReconciliation(input);
  assert.deepEqual(first, second);
});
