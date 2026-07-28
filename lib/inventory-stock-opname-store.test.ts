// Test lib/inventory-stock-opname-store.ts — MongoDB DIGANTI koleksi tiruan
// in-memory (DI, pola sama lib/reconciliation-sources.test.ts) supaya TIDAK
// PERNAH menyentuh database sungguhan. Dijalankan via
// `tsx --conditions=react-server --test` karena modul ini memakai "server-only".
import assert from "node:assert/strict";
import test from "node:test";
import {
  InventoryStockOpnameError,
  loadInventoryOpnameMonth,
  saveInventoryOpnameBatch,
  type InventoryStockOpnameContext,
  type MinimalOpnameCollection,
  type MinimalReadCollection,
} from "./inventory-stock-opname-store.ts";
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

test("save: physicalQty null menghapus dokumen (kembali ke Belum Diisi)", async () => {
  const opname = fakeOpnameCollection();
  const ctx = context([snapshotDoc({ productId: 1 })], opname);
  await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 1, variantId: null, physicalQty: 8 }] }, ctx);
  assert.equal(opname.store.size, 1);
  await saveInventoryOpnameBatch({ storeId: 324175, year: 2026, month: 5, actor: SUPERVISOR, entries: [{ productId: 1, variantId: null, physicalQty: null }] }, ctx);
  assert.equal(opname.store.size, 0);
  const result = await loadInventoryOpnameMonth({ storeId: 324175, year: 2026, month: 5 }, ctx);
  assert.equal(result.rows[0].status, "BELUM_DIISI");
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
  assert.equal(result.summary.cocok, 1);
  assert.equal(result.summary.perluDicek, 1);
  assert.equal(result.summary.belumDiisi, 1);
  assert.equal(result.summary.totalSelisihNegatif, -2);
});
