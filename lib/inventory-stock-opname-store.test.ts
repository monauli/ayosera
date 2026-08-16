// Test lib/inventory-stock-opname-store.ts — MongoDB DIGANTI koleksi tiruan
// in-memory (DI, pola sama lib/reconciliation-sources.test.ts) supaya TIDAK
// PERNAH menyentuh database sungguhan. Dijalankan via
// `tsx --conditions=react-server --test` karena modul ini memakai "server-only".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  InventoryStockOpnameError,
  loadInventoryOpnameCutoff,
  loadInventoryOpnameMonth,
  saveInventoryOpnameBatch,
  finalizeInventoryStockOpname,
  unlockInventoryStockOpname,
  type InventoryStockOpnameContext,
  type MinimalOpnameCollection,
  type MinimalReadCollection,
} from "./inventory-stock-opname-store.ts";
import { buildMatchingContext } from "./olsera-inventory-monthly-snapshot-core.ts";
import type { InventoryProductInput } from "./olsera-inventory-core.ts";
import type { StockMovementApiRow } from "./olsera-inventory-monthly-core.ts";
import type { FetchStockMovementResult } from "./olsera-inventory-stockmovement.ts";
import type { InventoryStockOpnameDocument, OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";

type Doc = Record<string, unknown>;

function matchesFilter(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => doc[key] === cond);
}

function fakeRead<T>(docs: Array<Partial<T>>): MinimalReadCollection<T> {
  return {
    find(filter: Doc) {
      const filtered = (docs as Doc[]).filter((doc) => matchesFilter(doc, filter));
      return { toArray: async () => filtered as T[] };
    },
  };
}

/** Koleksi berita acara tiruan — mencatat semua panggilan updateOne/deleteOne untuk verifikasi idempotency & isolasi. */
function fakeOpnameCollection(initial: Array<Partial<InventoryStockOpnameDocument>> = []): MinimalOpnameCollection & { store: Map<string, Doc>; updateCalls: number; deleteCalls: number } {
  const store = new Map<string, Doc>((initial as Doc[]).map((doc) => [String(doc._id), doc]));
  return {
    store,
    updateCalls: 0,
    deleteCalls: 0,
    find(filter: Doc) {
      const filtered = [...store.values()].filter((doc) => matchesFilter(doc, filter));
      return { toArray: async () => filtered as InventoryStockOpnameDocument[] };
    },
    async updateOne(filter: Doc, update: Doc, options: { upsert: boolean }) {
      this.updateCalls += 1;
      const id = String(filter._id);
      const existing = store.get(id);
      if (!existing && !options.upsert) return { matchedCount: 0 };
      const setOnInsert = existing ? {} : ((update.$setOnInsert as Doc) ?? {});
      const merged = { ...existing, ...setOnInsert, ...(update.$set as Doc) };
      store.set(id, merged);
      return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 };
    },
    async deleteOne(filter: Doc) {
      this.deleteCalls += 1;
      const id = String(filter._id);
      const existed = store.delete(id);
      return { deletedCount: existed ? 1 : 0 };
    },
  };
}

function snapshotDoc(overrides: Partial<OlseraInventoryMonthlySnapshotDocument> & { productId: number }): Partial<OlseraInventoryMonthlySnapshotDocument> {
  return {
    storeId: 324175,
    year: 2026,
    month: 5,
    variantId: null,
    productName: "Produk Uji",
    productSku: "SKU-1",
    groupName: "SEWA RAKET",
    openingQty: 10,
    incomingQty: 0,
    returnQty: 0,
    salesQty: 0,
    outgoingQty: 0,
    closingQty: 10,
    canonicalProductId: null,
    status: "complete",
    diagnostics: [],
    ...overrides,
  };
}

function context(snapshots: Array<Partial<OlseraInventoryMonthlySnapshotDocument>>, opname: ReturnType<typeof fakeOpnameCollection>): InventoryStockOpnameContext {
  return { snapshots: fakeRead<OlseraInventoryMonthlySnapshotDocument>(snapshots), opname };
}

const SUPERVISOR = { role: "supervisor" as const, email: "timunemas@ayo.local" };
const VIEWER = { role: "user" as const, email: "viewer@ayo.local" };

// ---------------------------------------------------------------------------
// Cutoff tanggal BA (basis BARU) — helper tiruan katalog + fetch stockmovement
// (TIDAK PERNAH memanggil Open API Olsera/Mongo sungguhan di test, pola sama
// lib/olsera-inventory-monthly-snapshot-store.test.ts:product/mockFetchStockmovementByMonth).
// ---------------------------------------------------------------------------

const CUTOFF_STORE_ID = 324175;
const CUTOFF_PRODUCT_ID = 116138490; // produk contoh riset live (lihat AYOSERA-HANDOFF-LATEST.md).

function cutoffProduct(overrides: Partial<InventoryProductInput> = {}): InventoryProductInput {
  return {
    _id: `${CUTOFF_STORE_ID}:${CUTOFF_PRODUCT_ID}:0`,
    productId: CUTOFF_PRODUCT_ID,
    variantId: null,
    sku: "SKU-BOLA-PADEL",
    barcode: null,
    name: "BOLA PADEL CONTOH",
    variantName: null,
    category: "BOLA PADEL",
    subCategory: null,
    uom: null,
    storeId: CUTOFF_STORE_ID,
    storeName: "Toko",
    active: true,
    trackInventory: true,
    sellPrice: 10000,
    buyPrice: 5000,
    lastBuyPrice: 5000,
    stockQty: 36,
    holdQty: 0,
    lowStockAlert: null,
    isOutStock: false,
    modifiedTime: null,
    stockSyncTime: null,
    ...overrides,
  };
}

function cutoffMatchingContext(products: InventoryProductInput[] = [cutoffProduct()]) {
  return buildMatchingContext(products, []);
}

function stockMovementRow(overrides: Partial<StockMovementApiRow> = {}): StockMovementApiRow {
  return {
    storeId: CUTOFF_STORE_ID,
    storeName: "Toko",
    productId: CUTOFF_PRODUCT_ID,
    productGroupName: "BOLA PADEL",
    productName: "BOLA PADEL CONTOH",
    productSku: "SKU-BOLA-PADEL",
    productVariantId: null,
    productVariantName: null,
    productVariantSku: null,
    beginningQty: 0,
    incomingQty: 0,
    returnQty: 0,
    salesQty: 0,
    outgoingQty: 0,
    sisa: 0,
    ...overrides,
  };
}

/**
 * Tiruan fetchStockMovementRange: `sisa` bergantung PERSIS pada `end_date`
 * yang diminta (meniru temuan riset live 2026-08: 14 Juli->12, 15 Juli->36
 * (barang masuk), 16 Juli->36, 17 Juli->35 (penjualan +1 tepat tanggal itu)) —
 * dipakai buat membuktikan movement SETELAH cutoff tidak pernah ikut, murni
 * lewat parameter end_date (bukan filter manual di pemanggil).
 */
function fakeCutoffFetch(sisaByEndDate: Record<string, number>) {
  const calls: Array<{ startDate: string; endDate: string }> = [];
  const impl = async (startDate: string, endDate: string): Promise<FetchStockMovementResult> => {
    calls.push({ startDate, endDate });
    const sisa = sisaByEndDate[endDate];
    if (sisa === undefined) return { ok: true, rows: [], skippedRawRows: 0 };
    return { ok: true, rows: [stockMovementRow({ sisa })], skippedRawRows: 0 };
  };
  return { impl, calls };
}

function cutoffContext(
  opname: ReturnType<typeof fakeOpnameCollection>,
  sisaByEndDate: Record<string, number>,
): InventoryStockOpnameContext & { calls: Array<{ startDate: string; endDate: string }> } {
  const { impl, calls } = fakeCutoffFetch(sisaByEndDate);
  return {
    snapshots: fakeRead<OlseraInventoryMonthlySnapshotDocument>([]),
    opname,
    fetchStockMovementRangeImpl: impl,
    matchingContext: cutoffMatchingContext(),
    calls,
  };
}

test("cutoff: loadInventoryOpnameCutoff memanggil fetchStockMovementRange dengan end_date = cutoffDate persis (bukan akhir bulan)", async () => {
  const opname = fakeOpnameCollection();
  const ctx = cutoffContext(opname, { "2026-07-16": 36 });
  const result = await loadInventoryOpnameCutoff({ storeId: CUTOFF_STORE_ID, year: 2026, month: 7, cutoffDate: "2026-07-16" }, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].endDate, "2026-07-16", "end_date API harus persis cutoffDate, BUKAN akhir bulan (2026-07-31)");
  assert.equal(ctx.calls[0].startDate, "2026-07-01");
  assert.equal(result.rows[0].systemClosingQty, 36);
  assert.equal(result.cutoffDate, "2026-07-16");
});

test("cutoff: movement TANGGAL SETELAH cutoff (17 Juli) tidak pernah ikut dalam Stok Akhir Sistem pada cutoff 16 Juli", async () => {
  const opname = fakeOpnameCollection();
  // Tiruan Olsera: end_date=16 Juli -> sisa 36 (BELUM termasuk penjualan 17 Juli);
  // end_date=17 Juli -> sisa 35 (SUDAH termasuk). Movement 17 Juli hanya boleh
  // memengaruhi hasil bila cutoff-nya sendiri >= 17 Juli.
  const ctx = cutoffContext(opname, { "2026-07-16": 36, "2026-07-17": 35 });

  const atCutoff16 = await loadInventoryOpnameCutoff({ storeId: CUTOFF_STORE_ID, year: 2026, month: 7, cutoffDate: "2026-07-16" }, ctx);
  assert.equal(atCutoff16.rows[0].systemClosingQty, 36, "cutoff 16 Juli TIDAK boleh mencakup penjualan 17 Juli");

  const atCutoff17 = await loadInventoryOpnameCutoff({ storeId: CUTOFF_STORE_ID, year: 2026, month: 7, cutoffDate: "2026-07-17" }, ctx);
  assert.equal(atCutoff17.rows[0].systemClosingQty, 35, "cutoff 17 Juli sendiri SUDAH mencakup penjualan tanggal itu (kontrol positif)");
});

test("cutoff: berita acara tersimpan (physicalQty) tetap digabung ke baris hasil cutoff seperti jalur bulanan", async () => {
  const opname = fakeOpnameCollection([
    { _id: `${CUTOFF_STORE_ID}:2026:07:${CUTOFF_PRODUCT_ID}:0`, storeId: CUTOFF_STORE_ID, year: 2026, month: 7, productId: CUTOFF_PRODUCT_ID, variantId: null, physicalQty: 36, systemClosingQty: 36, differenceQty: 0, status: "COCOK", note: null, updatedBy: SUPERVISOR.email, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const ctx = cutoffContext(opname, { "2026-07-16": 36 });
  const result = await loadInventoryOpnameCutoff({ storeId: CUTOFF_STORE_ID, year: 2026, month: 7, cutoffDate: "2026-07-16" }, ctx);
  assert.equal(result.rows[0].physicalQty, 36);
  assert.equal(result.rows[0].status, "COCOK");
});

test("finalize cutoff: sukses saat cutoffDate cocok periode, dikonfirmasi, dan angka cocok -> LOCKED dengan cutoffDate tersimpan", async () => {
  // BA WAJIB mencatat SELISIH (verifyStockOpnameBa/finalize memblokir differenceQty===0 —
  // "BA hanya memuat selisih", lihat lib/inventory-stock-opname.ts) — physicalQty 35 vs
  // systemClosingQty 36 pada cutoff 16 Juli (selisih -1, item hilang/rusak).
  const opname = fakeOpnameCollection([
    { _id: `${CUTOFF_STORE_ID}:2026:07:${CUTOFF_PRODUCT_ID}:0`, storeId: CUTOFF_STORE_ID, year: 2026, month: 7, productId: CUTOFF_PRODUCT_ID, variantId: null, physicalQty: 35, systemClosingQty: 36, differenceQty: -1, status: "PERLU_DICEK", note: "1 rusak", updatedBy: SUPERVISOR.email, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const ctx = cutoffContext(opname, { "2026-07-16": 36 });
  const locked = await finalizeInventoryStockOpname(
    {
      storeId: CUTOFF_STORE_ID,
      year: 2026,
      month: 7,
      actor: SUPERVISOR.email,
      cutoff: "2026-07-16",
      cutoffDate: "2026-07-16",
      cutoffConfirmed: true,
      baOnlyDifferencesConfirmed: true,
      attachment: { fileName: "ba.pdf", mimeType: "application/pdf", size: 10, url: "https://blob.test/ba.pdf", uploadedAt: new Date(), uploadedBy: SUPERVISOR.email },
      now: new Date("2026-08-13T00:00:00Z"),
    },
    ctx,
  );
  assert.equal(locked.status, "LOCKED");
  assert.equal(locked.cutoffDate, "2026-07-16");
  const eventDoc = opname.store.get(`${CUTOFF_STORE_ID}:2026:07:event`) as Record<string, unknown>;
  assert.equal(eventDoc.cutoffDate, "2026-07-16");
});

test("finalize cutoff: diblokir bila cutoffDate diisi tapi cutoffConfirmed tidak dicentang (konfirmasi wajib, pola sama baOnlyDifferencesConfirmed)", async () => {
  const opname = fakeOpnameCollection([
    { _id: `${CUTOFF_STORE_ID}:2026:07:${CUTOFF_PRODUCT_ID}:0`, storeId: CUTOFF_STORE_ID, year: 2026, month: 7, productId: CUTOFF_PRODUCT_ID, variantId: null, physicalQty: 36, systemClosingQty: 36, differenceQty: 0, status: "COCOK", note: null, updatedBy: SUPERVISOR.email, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const ctx = cutoffContext(opname, { "2026-07-16": 36 });
  await assert.rejects(
    () =>
      finalizeInventoryStockOpname(
        { storeId: CUTOFF_STORE_ID, year: 2026, month: 7, actor: SUPERVISOR.email, cutoff: "2026-07-16", cutoffDate: "2026-07-16", cutoffConfirmed: false, baOnlyDifferencesConfirmed: true, attachment: { fileName: "ba.pdf", mimeType: "application/pdf", size: 10, url: "https://blob.test/ba.pdf", uploadedAt: new Date(), uploadedBy: SUPERVISOR.email }, now: new Date("2026-08-13T00:00:00Z") },
        ctx,
      ),
    (error: unknown) => error instanceof InventoryStockOpnameError && /konfirmasi cutoff/i.test(error.message),
  );
  assert.equal(opname.store.has(`${CUTOFF_STORE_ID}:2026:07:event`), false);
});

test("finalize cutoff: BA salah periode (cutoffDate bulan lain dari filter year/month) diblokir, butuh review — bukan langsung lolos", async () => {
  const opname = fakeOpnameCollection([
    { _id: `${CUTOFF_STORE_ID}:2026:07:${CUTOFF_PRODUCT_ID}:0`, storeId: CUTOFF_STORE_ID, year: 2026, month: 7, productId: CUTOFF_PRODUCT_ID, variantId: null, physicalQty: 36, systemClosingQty: 36, differenceQty: 0, status: "COCOK", note: null, updatedBy: SUPERVISOR.email, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const ctx = cutoffContext(opname, { "2026-06-30": 36 });
  await assert.rejects(
    () =>
      finalizeInventoryStockOpname(
        { storeId: CUTOFF_STORE_ID, year: 2026, month: 7, actor: SUPERVISOR.email, cutoff: "2026-06-30", cutoffDate: "2026-06-30", cutoffConfirmed: true, baOnlyDifferencesConfirmed: true, attachment: { fileName: "ba.pdf", mimeType: "application/pdf", size: 10, url: "https://blob.test/ba.pdf", uploadedAt: new Date(), uploadedBy: SUPERVISOR.email }, now: new Date("2026-08-13T00:00:00Z") },
        ctx,
      ),
    (error: unknown) => error instanceof InventoryStockOpnameError && /salah periode/i.test(error.message),
  );
  assert.equal(opname.store.has(`${CUTOFF_STORE_ID}:2026:07:event`), false);
  assert.equal(ctx.calls.length, 0, "TIDAK PERNAH memanggil stockmovement API sama sekali bila cutoff sudah terbukti implausible — gagal cepat sebelum fetch");
});

test("finalize cutoff: cutoffDate tidak terbaca/ambigu (string kosong) diblokir, butuh review", async () => {
  const opname = fakeOpnameCollection();
  const ctx = cutoffContext(opname, {});
  await assert.rejects(
    () =>
      finalizeInventoryStockOpname(
        { storeId: CUTOFF_STORE_ID, year: 2026, month: 7, actor: SUPERVISOR.email, cutoff: "", cutoffDate: "tidak-terbaca", cutoffConfirmed: true, baOnlyDifferencesConfirmed: true, attachment: { fileName: "ba.pdf", mimeType: "application/pdf", size: 10, url: "https://blob.test/ba.pdf", uploadedAt: new Date(), uploadedBy: SUPERVISOR.email }, now: new Date("2026-08-13T00:00:00Z") },
        ctx,
      ),
    (error: unknown) => error instanceof InventoryStockOpnameError,
  );
});

test("finalize cutoff: movement setelah cutoff tidak mempengaruhi hasil finalisasi (BA=35 vs sistem cutoff-16=36 tetap LOCKED — kalau salah pakai sisa 17 Juli (35) selisihnya jadi 0 dan WAJIB diblokir)", async () => {
  // Pembeda kunci: BA mencatat fisik=35. Sistem PADA CUTOFF 16 Juli = 36 (selisih -1,
  // valid, LOCKED). Bila implementasi keliru memakai sisa 17 Juli (35 — SUDAH
  // mencakup penjualan setelah cutoff), selisihnya jadi 0 dan finalize WAJIB gagal
  // (blokir "item tanpa selisih") — jadi test ini gagal (bukan sekadar assert longgar)
  // persis saat movement setelah cutoff bocor ke perhitungan.
  const opname = fakeOpnameCollection([
    { _id: `${CUTOFF_STORE_ID}:2026:07:${CUTOFF_PRODUCT_ID}:0`, storeId: CUTOFF_STORE_ID, year: 2026, month: 7, productId: CUTOFF_PRODUCT_ID, variantId: null, physicalQty: 35, systemClosingQty: 36, differenceQty: -1, status: "PERLU_DICEK", note: "1 hilang", updatedBy: SUPERVISOR.email, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const ctx = cutoffContext(opname, { "2026-07-16": 36, "2026-07-17": 35 });
  const locked = await finalizeInventoryStockOpname(
    { storeId: CUTOFF_STORE_ID, year: 2026, month: 7, actor: SUPERVISOR.email, cutoff: "2026-07-16", cutoffDate: "2026-07-16", cutoffConfirmed: true, baOnlyDifferencesConfirmed: true, attachment: { fileName: "ba.pdf", mimeType: "application/pdf", size: 10, url: "https://blob.test/ba.pdf", uploadedAt: new Date(), uploadedBy: SUPERVISOR.email }, now: new Date("2026-08-13T00:00:00Z") },
    ctx,
  );
  assert.equal(locked.status, "LOCKED");
});

test("finalize TANPA cutoffDate (dokumen lama/BA tanpa cutoff eksplisit) tetap pakai jalur snapshot bulanan lama — backward compatible", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context([snapshotDoc({ productId: 1, closingQty: 10 })], opname);
  await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 1, variantId: null, physicalQty: 8 }] }, ctx);
  const locked = await finalizeInventoryStockOpname({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR.email, cutoff: "2026-05-31", baOnlyDifferencesConfirmed: true, attachment: { fileName: "ba.pdf", mimeType: "application/pdf", size: 10, url: "https://blob.test/ba.pdf", uploadedAt: new Date(), uploadedBy: SUPERVISOR.email } }, ctx);
  assert.equal(locked.status, "LOCKED");
  assert.equal(locked.cutoffDate, null, "tanpa cutoffDate eksplisit -> null, TIDAK memaksa nilai apa pun");
});

// ---------------------------------------------------------------------------
// Rule 5: lock event stock opname TIDAK PERNAH memfreeze/menghalangi cron
// atau sync inventori setelah cutoff — dibuktikan secara ARSITEKTURAL (pola
// sama lib/reconciliation-omzet-period-lock-ui.test.ts: assertion source-text,
// TIDAK ADA infrastruktur render/integrasi DOM di test suite proyek ini).
// Cron/sync inventori (lib/cron-olsera-inventory.ts, lib/olsera-inventory.ts)
// WAJIB tidak pernah merujuk koleksi/lock rekonsiliasi stock opname sama
// sekali sebelum menulis data — independensi ini BUKAN kebetulan, jadi harus
// dijaga oleh regresi eksplisit, bukan cuma "belum ada kode yang menyambungkannya".
// ---------------------------------------------------------------------------
test("lock stock opname TIDAK memfreeze cron/sync inventory — cron/sync tidak mereferensikan koleksi/lock rekonsiliasi stock opname sama sekali", () => {
  const cronSource = readFileSync(new URL("./cron-olsera-inventory.ts", import.meta.url), "utf8");
  const syncSource = readFileSync(new URL("./olsera-inventory.ts", import.meta.url), "utf8");
  for (const [label, source] of [["lib/cron-olsera-inventory.ts", cronSource], ["lib/olsera-inventory.ts", syncSource]] as const) {
    assert.doesNotMatch(source, /inventory-stock-opname/i, `${label} tidak boleh mengimpor modul stock opname sama sekali`);
    assert.doesNotMatch(source, /inventoryStockOpnameReconciliations/, `${label} tidak boleh membaca koleksi lock stock opname`);
    assert.doesNotMatch(source, /lockedAt|lockedBy/, `${label} tidak boleh mengecek status lock stock opname sebelum menulis`);
  }
});

// 6. Penyimpanan ulang produk yang sama tidak membuat duplikat.
test("save: penyimpanan ulang produk yang sama tidak membuat duplikat (upsert idempotent)", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context([snapshotDoc({ productId: 1 })], opname);

  await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 1, variantId: null, physicalQty: 8 }] }, ctx);
  assert.equal(opname.store.size, 1);

  await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 1, variantId: null, physicalQty: 9 }] }, ctx);
  assert.equal(opname.store.size, 1, "tidak boleh ada dokumen kedua untuk produk yang sama");
  const only = [...opname.store.values()][0];
  assert.equal(only.physicalQty, 9, "nilai terbaru menimpa yang lama pada _id yang sama");
});

test("save: physicalQty null menghapus dokumen (snapshot valid kembali Cocok tanpa BA)", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context([snapshotDoc({ productId: 1 })], opname);
  await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 1, variantId: null, physicalQty: 8 }] }, ctx);
  assert.equal(opname.store.size, 1);
  await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 1, variantId: null, physicalQty: null }] }, ctx);
  assert.equal(opname.store.size, 0);
  const result = await loadInventoryOpnameMonth({ storeId: 324175, year: 2026, month: 5 }, ctx);
  assert.equal(result.rows[0].status, "COCOK");
});

// 7. Viewer tidak dapat menyimpan.
test("permission: viewer (role user) tidak dapat menyimpan berita acara", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context([snapshotDoc({ productId: 1 })], opname);
  await assert.rejects(
    () => saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: VIEWER, entries: [{ productId: 1, variantId: null, physicalQty: 8 }] }, ctx),
    (error: unknown) => error instanceof InventoryStockOpnameError && error.code === "FORBIDDEN",
  );
  assert.equal(opname.store.size, 0, "tidak ada yang tersimpan setelah percobaan viewer ditolak");
});

// 8. Supervisor dapat menyimpan.
test("permission: supervisor dapat menyimpan berita acara", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context([snapshotDoc({ productId: 1 })], opname);
  const result = await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 1, variantId: null, physicalQty: 10 }] }, ctx);
  assert.equal(result.rows[0].status, "COCOK");
  assert.equal(opname.store.size, 1);
});

// 9. Store isolation tetap aman.
test("store isolation: produk milik storeId lain tidak ikut terbaca maupun tertulis", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context(
    [snapshotDoc({ productId: 1, storeId: 324175 }), snapshotDoc({ productId: 2, storeId: 999999 })],
    opname,
  );
  const result = await loadInventoryOpnameMonth({ storeId: 324175, year: 2026, month: 5 }, ctx);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].productId, 1);

  // Simpan atas nama storeId lain tidak boleh menyentuh produk storeId 324175 (kunci _id berbeda).
  await saveInventoryOpnameBatch({ storeId: 999999, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 2, variantId: null, physicalQty: 5 }] }, ctx);
  const resultAfter = await loadInventoryOpnameMonth({ storeId: 324175, year: 2026, month: 5 }, ctx);
  assert.equal(resultAfter.rows[0].physicalQty, null, "storeId 324175 tidak terpengaruh oleh penyimpanan storeId lain");
});

// 10. Snapshot tidak pernah berubah setelah penyimpanan berita acara.
test("snapshot tidak pernah berubah setelah penyimpanan berita acara (koleksi snapshot read-only, tanpa method tulis)", async () => {
  const opname = fakeOpnameCollection();
  const snapshotRows = [snapshotDoc({ productId: 1, closingQty: 10 })];
  const ctx = context(snapshotRows, opname);

  const before = await loadInventoryOpnameMonth({ storeId: 324175, year: 2026, month: 5 }, ctx);
  await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 1, variantId: null, physicalQty: 7, note: "opname manual" }] }, ctx);
  const after = await loadInventoryOpnameMonth({ storeId: 324175, year: 2026, month: 5 }, ctx);

  assert.equal(before.rows[0].snapshotClosingQty, 10);
  assert.equal(after.rows[0].snapshotClosingQty, 10, "closingQty snapshot tidak berubah");
  assert.deepEqual(snapshotRows[0], snapshotDoc({ productId: 1, closingQty: 10 }), "objek snapshot sumber sama persis sebelum & sesudah — tidak ada mutasi in-place");
  // Bukti arsitektural: tipe MinimalReadCollection untuk snapshot HANYA mengekspos find() —
  // tidak ada updateOne/deleteOne/insertOne yang bisa dipanggil terhadap koleksi snapshot di modul ini.
});

test("produk tanpa snapshot pada bulan tsb dilewati (tidak membuat dokumen berita acara sembarangan)", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context([snapshotDoc({ productId: 1 })], opname);
  const result = await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 999, variantId: null, physicalQty: 5 }] }, ctx);
  assert.equal(opname.store.size, 0);
  assert.equal(result.rows.length, 1);
});

test("manual adjust: produk dengan status incomplete tetap BUTUH_ADJUST_MANUAL walau berita acara diisi", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context([snapshotDoc({ productId: 1, closingQty: 10, status: "incomplete", diagnostics: ["productId kemungkinan berubah tanpa alias."] })], opname);
  const result = await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 1, variantId: null, physicalQty: 10 }] }, ctx);
  assert.equal(result.rows[0].status, "BUTUH_ADJUST_MANUAL");
});

test("ringkasan bulan menghitung total selisih & tally status dari gabungan snapshot + berita acara", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context(
    [
      snapshotDoc({ productId: 1, closingQty: 10 }),
      snapshotDoc({ productId: 2, closingQty: 10 }),
      snapshotDoc({ productId: 3, closingQty: 10 }),
    ],
    opname,
  );
  await saveInventoryOpnameBatch(
    { storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [
      { productId: 1, variantId: null, physicalQty: 10 },
      { productId: 2, variantId: null, physicalQty: 8 },
    ] },
    ctx,
  );
  const result = await loadInventoryOpnameMonth({ storeId: 324175, year: 2026, month: 5 }, ctx);
  assert.equal(result.summary.totalProduk, 3);
  assert.equal(result.summary.cocok, 2);
  assert.equal(result.summary.perluDicek, 1);
  assert.equal(result.summary.belumDiisi, 0);
  assert.equal(result.summary.totalSelisihNegatif, -2);
});

test("rekonsiliasi memakai universe bulanan yang sama dengan Stok Keseluruhan", async () => {
  const ctx = context([
    snapshotDoc({ productId: 1, groupName: "BOLA PADEL", closingQty: 10 }),
    snapshotDoc({ productId: 2, groupName: "LABERS", closingQty: 10 }),
    snapshotDoc({ productId: 3, groupName: "BOLA PADEL", openingQty: 0, closingQty: 0 }),
  ], fakeOpnameCollection());
  const result = await loadInventoryOpnameMonth({ storeId: 324175, year: 2026, month: 5 }, ctx);
  assert.deepEqual(result.rows.map((row) => row.productId), [1]);
  assert.equal(result.summary.totalProduk, 1);
});

test("Februari historical final memakai closing snapshot sebagai Cocok tanpa BA", async () => {
  const ctx = context([
    snapshotDoc({ productId: 1, year: 2026, month: 2, status: "incomplete", canonicalProductId: null, closingQty: 10 }),
    snapshotDoc({ productId: 2, year: 2026, month: 2, status: "complete", canonicalProductId: 999, closingQty: 20 }),
  ], fakeOpnameCollection());
  ctx.approvedRows = [
    { productId: 1, variantId: null, productSku: "SKU-1", productName: "Produk 1", openingQty: 10, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0, closingQty: 10 },
    { productId: 2, variantId: null, productSku: "SKU-1", productName: "Produk 2", openingQty: 10, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0, closingQty: 20 },
  ];
  const result = await loadInventoryOpnameMonth({ storeId: 324175, year: 2026, month: 2 }, ctx);
  assert.equal(result.summary.totalProduk, 2);
  assert.equal(result.summary.cocok, 2);
  assert.equal(result.summary.perluDicek, 0);
  assert.equal(result.summary.butuhAdjustManual, 0);
  assert.ok(result.rows.every((row) => row.physicalQty === row.systemClosingQty && row.status === "COCOK"));
});

test("end-to-end finalisasi lalu lock event tidak melakukan double adjustment", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context([snapshotDoc({ productId: 1, closingQty: 10 })], opname);
  await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 1, variantId: null, physicalQty: 8, note: "selisih fisik" }] }, ctx);
  const locked = await finalizeInventoryStockOpname({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR.email, cutoff: "2026-05-31", baOnlyDifferencesConfirmed: true, attachment: { fileName: "ba.pdf", mimeType: "application/pdf", size: 10, url: "https://blob.test/ba.pdf", uploadedAt: new Date(), uploadedBy: SUPERVISOR.email } }, ctx);
  assert.equal(locked.status, "LOCKED");
  assert.equal(locked.adjustmentApplied, false);
  assert.equal(opname.store.size, 2, "satu row evidence + satu event lock, bukan adjustment Olsera");
  const unlocked = await unlockInventoryStockOpname({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR.email, reason: "Koreksi pembacaan BA" }, ctx);
  assert.equal(unlocked.status, "UNLOCKED");
  assert.equal(opname.store.get("324175:2026:05:event")?.lockedAt, null);
});

test("BA-only: item kosong dianggap Cocok dan disimpan sebagai evidence assumed match", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context([snapshotDoc({ productId: 7, closingQty: 69 })], opname);
  const locked = await finalizeInventoryStockOpname({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR.email, cutoff: "2026-05-31", baOnlyDifferencesConfirmed: true, attachment: { fileName: "ba.pdf", mimeType: "application/pdf", size: 10, url: "https://blob.test/ba.pdf", uploadedAt: new Date(), uploadedBy: SUPERVISOR.email } }, ctx);
  assert.equal(locked.status, "LOCKED");
  const evidence = opname.store.get("324175:2026:05:7:0") as Record<string, unknown>;
  assert.equal(evidence.physicalQty, 69);
  assert.equal(evidence.differenceQty, 0);
  assert.equal(evidence.evidenceSource, "BA_OMITTED_ASSUMED_MATCH");
});

test("BA-only OFF: item kosong tetap memblokir finalisasi", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context([snapshotDoc({ productId: 8, closingQty: 10 })], opname);
  await assert.rejects(() => finalizeInventoryStockOpname({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR.email, cutoff: "2026-05-31", baOnlyDifferencesConfirmed: false, attachment: { fileName: "ba.pdf", mimeType: "application/pdf", size: 10, url: "https://blob.test/ba.pdf", uploadedAt: new Date(), uploadedBy: SUPERVISOR.email } }, ctx));
});
