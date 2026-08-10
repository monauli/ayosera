import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOrderItemIdentity, type IdentityClassificationContext } from "./historical-order-item-identity.ts";
import { planExactMatchBackfill, runOrderItemIdentityBackfill, type OrderItemBackfillWriteContext } from "./historical-order-item-backfill.ts";
import type { HistoricalBackfillAuditLogDocument } from "./mongodb.ts";

function emptyContext(): IdentityClassificationContext {
  return { catalogByName: new Map(), catalogByBaseName: new Map(), aliasByName: new Map(), historicalByName: new Map(), duplicateKeyCount: new Map() };
}

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return { _id: 1, date: "2026-05-01", orderNo: "ORD-1", itemName: "COURT FEES - 1", qty: 1, amount: 150000, ...overrides } as any;
}

class FakeOrderItemsCollection {
  docs = new Map<number, { productId?: number | null; variantId?: number | null; sku?: string | null }>();
  async findOne(filter: { _id: number }) {
    return this.docs.get(filter._id) ?? null;
  }
  async updateOne(filter: { _id: number }, update: { $set: Record<string, unknown> }) {
    const doc = this.docs.get(filter._id) ?? {};
    Object.assign(doc, update.$set);
    this.docs.set(filter._id, doc);
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

class FakeAuditLog {
  inserted: HistoricalBackfillAuditLogDocument[] = [];
  async insertOne(doc: HistoricalBackfillAuditLogDocument) {
    this.inserted.push(doc);
    return { acknowledged: true };
  }
}

test("planExactMatchBackfill: hanya menyertakan baris 'Exact Match', mengabaikan klasifikasi lain", () => {
  const context = emptyContext();
  context.catalogByName.set("COURT FEES - 1", [{ productId: 100, variantId: 200, sku: "SKU-1", name: "COURT FEES - 1", active: true }]);
  const exactMatch = classifyOrderItemIdentity(row({ _id: 1 }), context);
  const ambiguous = classifyOrderItemIdentity(row({ _id: 2, itemName: "TIDAK DIKENAL" }), emptyContext());

  const plan = planExactMatchBackfill([exactMatch, ambiguous]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].orderItemId, 1);
  assert.deepEqual(plan[0].after, { productId: 100, variantId: 200, sku: "SKU-1" });
});

test("planExactMatchBackfill: 'before' merefleksikan state field yang benar-benar hilang (null bila absent/null/empty)", () => {
  const context = emptyContext();
  context.catalogByName.set("COURT FEES - 1", [{ productId: 100, variantId: 200, sku: "SKU-1", name: "COURT FEES - 1", active: true }]);
  // productId sengaja TIDAK disebut sama sekali (bukan `productId: undefined`)
  // supaya fieldState melihatnya sbg "absent", persis representasi dokumen
  // MongoDB nyata (driver tidak pernah menyimpan key dgn value undefined).
  const classified = classifyOrderItemIdentity(row({ _id: 5, variantId: null, sku: "" }), context);
  const plan = planExactMatchBackfill([classified]);
  assert.deepEqual(plan[0].before, { productId: null, variantId: null, sku: null });
});

test("runOrderItemIdentityBackfill: dryRun=true TIDAK PERNAH menulis apa pun", async () => {
  const orderItems = new FakeOrderItemsCollection();
  const auditLog = new FakeAuditLog();
  const context: OrderItemBackfillWriteContext = { orderItems: orderItems as any, auditLog };
  const plan = [{ orderItemId: 1, before: { productId: null, variantId: null, sku: null }, after: { productId: 100, variantId: 200, sku: "SKU-1" } }];

  const result = await runOrderItemIdentityBackfill({ storeId: 324175, plan, dryRun: true, triggeredBy: "test" }, context);

  assert.equal(result.dryRun, true);
  assert.equal(result.planned, 1);
  assert.equal(result.updated, 0);
  assert.equal(orderItems.docs.size, 0, "dryRun tidak boleh menyentuh koleksi order items");
  assert.equal(auditLog.inserted.length, 0, "dryRun tidak boleh menulis audit log");
});

test("runOrderItemIdentityBackfill: dryRun=false menulis HANYA productId/variantId/sku dan mencatat audit log reversibel", async () => {
  const orderItems = new FakeOrderItemsCollection();
  orderItems.docs.set(1, {});
  const auditLog = new FakeAuditLog();
  const context: OrderItemBackfillWriteContext = { orderItems: orderItems as any, auditLog };
  const plan = [{ orderItemId: 1, before: { productId: null, variantId: null, sku: null }, after: { productId: 100, variantId: 200, sku: "SKU-1" } }];

  const result = await runOrderItemIdentityBackfill({ storeId: 324175, plan, dryRun: false, triggeredBy: "supervisor:abc" }, context);

  assert.equal(result.updated, 1);
  assert.deepEqual(orderItems.docs.get(1), { productId: 100, variantId: 200, sku: "SKU-1" });
  assert.equal(auditLog.inserted.length, 1);
  assert.deepEqual(auditLog.inserted[0].before, { productId: null, variantId: null, sku: null });
  assert.deepEqual(auditLog.inserted[0].after, { productId: 100, variantId: 200, sku: "SKU-1" });
  assert.equal(auditLog.inserted[0].triggeredBy, "supervisor:abc");
});

test("runOrderItemIdentityBackfill: baris dengan variantId/sku null yang SAH (sesuai katalog produk tanpa varian/SKU) dianggap SUDAH terisi — bukan gagal, tidak ditulis ulang pada rerun", async () => {
  const orderItems = new FakeOrderItemsCollection();
  // productId sudah terisi dari run sebelumnya; variantId/sku TETAP null karena
  // katalog produk ini memang tidak punya varian/SKU (kasus nyata produksi:
  // productId 109533497, lihat verifikasi Milestone 4).
  orderItems.docs.set(1, { productId: 109533497, variantId: null, sku: null });
  const auditLog = new FakeAuditLog();
  const context: OrderItemBackfillWriteContext = { orderItems: orderItems as any, auditLog };
  const plan = [{ orderItemId: 1, before: { productId: null, variantId: null, sku: null }, after: { productId: 109533497, variantId: null, sku: null } }];

  const result = await runOrderItemIdentityBackfill({ storeId: 324175, plan, dryRun: false, triggeredBy: "test" }, context);

  assert.equal(result.updated, 0, "productId sudah ada -> dianggap sudah dibackfill, JANGAN ditulis ulang");
  assert.equal(result.skippedAlreadyFilled, 1);
  assert.equal(auditLog.inserted.length, 0, "tidak boleh ada audit log baru untuk baris yang sudah selesai");
});

test("runOrderItemIdentityBackfill: idempoten — baris yang SUDAH terisi (mis. sudah dibackfill run sebelumnya) dilewati, tidak ditimpa ulang", async () => {
  const orderItems = new FakeOrderItemsCollection();
  orderItems.docs.set(1, { productId: 999, variantId: 1, sku: "SUDAH-ADA" }); // sudah terisi oleh proses lain sejak plan dibuat
  const auditLog = new FakeAuditLog();
  const context: OrderItemBackfillWriteContext = { orderItems: orderItems as any, auditLog };
  const plan = [{ orderItemId: 1, before: { productId: null, variantId: null, sku: null }, after: { productId: 100, variantId: 200, sku: "SKU-1" } }];

  const result = await runOrderItemIdentityBackfill({ storeId: 324175, plan, dryRun: false, triggeredBy: "test" }, context);

  assert.equal(result.updated, 0);
  assert.equal(result.skippedAlreadyFilled, 1);
  assert.deepEqual(orderItems.docs.get(1), { productId: 999, variantId: 1, sku: "SUDAH-ADA" }, "nilai yang sudah ada TIDAK BOLEH ditimpa");
  assert.equal(auditLog.inserted.length, 0);
});

test("runOrderItemIdentityBackfill: rerun setelah sukses bersifat aman (idempoten penuh) — jalankan plan yang sama dua kali", async () => {
  const orderItems = new FakeOrderItemsCollection();
  orderItems.docs.set(1, {});
  const auditLog = new FakeAuditLog();
  const context: OrderItemBackfillWriteContext = { orderItems: orderItems as any, auditLog };
  const plan = [{ orderItemId: 1, before: { productId: null, variantId: null, sku: null }, after: { productId: 100, variantId: 200, sku: "SKU-1" } }];

  const first = await runOrderItemIdentityBackfill({ storeId: 324175, plan, dryRun: false, triggeredBy: "test" }, context);
  const second = await runOrderItemIdentityBackfill({ storeId: 324175, plan, dryRun: false, triggeredBy: "test" }, context);

  assert.equal(first.updated, 1);
  assert.equal(second.updated, 0);
  assert.equal(second.skippedAlreadyFilled, 1);
  assert.equal(auditLog.inserted.length, 1, "audit log tidak boleh duplikat pada rerun");
});
