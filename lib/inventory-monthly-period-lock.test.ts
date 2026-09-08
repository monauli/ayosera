import assert from "node:assert/strict";
import test from "node:test";
import { getInventoryPeriodCompleteness, isValidInventoryMonthlySnapshot, lockInventoryMonthlyPeriod, unlockInventoryMonthlyPeriod, type InventoryMonthlyPeriodLockContext } from "./inventory-monthly-period-lock.ts";
import type { InventoryMonthlyPeriodLockDocument, OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";

const snapshot = (closingQty = 15): OlseraInventoryMonthlySnapshotDocument => ({ _id: "1:2026-02:1:0", storeId: 1, year: 2026, month: 2, snapshotDate: "2026-02-28", productId: 1, variantId: null, canonicalProductId: null, productName: "YONEX SHORTS MEN", productSku: "SM-J035-2906-RW1-S", groupName: "YONEX", openingQty: 24, incomingQty: 0, returnQty: 0, salesQty: 9, outgoingQty: 0, closingQty, source: "baseline-file", status: "complete", diagnostics: [], createdAt: new Date(), updatedAt: new Date() });

function fakeContext(initial: InventoryMonthlyPeriodLockDocument | null = null, products: Array<{ productId: number; variantId: number | null; active?: boolean; stockQty?: number }> = []): InventoryMonthlyPeriodLockContext {
  let lock = initial;
  return {
    snapshots: { find: () => ({ toArray: async () => [snapshot()] }) },
    products: { find: () => ({ toArray: async () => products }) },
    locks: {
      findOne: async () => lock,
      findOneAndUpdate: async (_filter, update) => {
        const set = update.$set as Record<string, unknown>;
        const pushed = (update.$push as { history: InventoryMonthlyPeriodLockDocument["history"][number] }).history;
        lock = { ...(lock ?? { _id: "1:2026-02", createdAt: new Date(), history: [] }), ...set, history: [...(lock?.history ?? []), pushed] } as InventoryMonthlyPeriodLockDocument;
        return lock;
      },
    },
  };
}

test("valid monthly snapshot arithmetic is lockable; closing 130 is rejected", () => {
  assert.equal(isValidInventoryMonthlySnapshot(snapshot(15)), true);
  assert.equal(isValidInventoryMonthlySnapshot(snapshot(130)), false);
});

test("locked monthly snapshot is immutable and unlock keeps audit history", async () => {
  const context = fakeContext();
  const locked = await lockInventoryMonthlyPeriod({ storeId: 1, year: 2026, month: 2, actor: "supervisor" }, context);
  assert.equal(locked.status, "locked");
  assert.equal(locked.snapshots[0].closingQty, 15);
  const unlocked = await unlockInventoryMonthlyPeriod({ storeId: 1, year: 2026, month: 2, actor: "supervisor", reason: "Koreksi resmi" }, context);
  assert.equal(unlocked.status, "unlocked");
  assert.deepEqual(unlocked.history.map((item) => item.action), ["lock", "unlock"]);
});

test("inventory unlock requires a reason", async () => {
  await assert.rejects(() => unlockInventoryMonthlyPeriod({ storeId: 1, year: 2026, month: 2, actor: "supervisor", reason: " " }, fakeContext()), /Reason unlock wajib/);
});

test("lock rejects unresolved catalog-only candidates outside historical Februari", async () => {
  await assert.rejects(
    () => lockInventoryMonthlyPeriod({ storeId: 1, year: 2026, month: 3, actor: "supervisor" }, fakeContext(null, [{ productId: 99, variantId: null, active: true, stockQty: 2 }])),
    /produk katalog yang belum diverifikasi/,
  );
});

// --- Produk yang lahir setelah bulan yang diperiksa ---
// Katalog yang dibandingkan adalah katalog hari ini, jadi produk baru memblokir
// penguncian bulan lampau selamanya (kasus nyata: NESTLE PURE LIFE 1500ML
// Duplikate, snapshot pertama Agustus 2026, memblokir Feb s/d Juli).

function contextWithSnapshots(snaps: OlseraInventoryMonthlySnapshotDocument[], products: Array<{ productId: number; variantId: number | null; active?: boolean; stockQty?: number }>): InventoryMonthlyPeriodLockContext {
  return { ...fakeContext(null, products), snapshots: { find: (filter: Record<string, unknown>) => ({ toArray: async () => (filter.month === undefined ? snaps : snaps.filter((s) => s.year === filter.year && s.month === filter.month)) }) } };
}

const snapAt = (year: number, month: number, productId: number): OlseraInventoryMonthlySnapshotDocument =>
  ({ ...snapshot(), _id: `1:${year}-${String(month).padStart(2, "0")}:${productId}:0`, year, month, productId });

test("kelengkapan periode: produk yang snapshot pertamanya SETELAH bulan yang diperiksa TIDAK memblokir kunci", async () => {
  const LAHIR_AGUSTUS = 120601602;
  const context = contextWithSnapshots(
    [snapAt(2026, 6, 1), snapAt(2026, 8, LAHIR_AGUSTUS)],
    [{ productId: LAHIR_AGUSTUS, variantId: null, active: true, stockQty: 112 }],
  );
  const completeness = await getInventoryPeriodCompleteness({ storeId: 1, year: 2026, month: 6 }, context);
  assert.equal(completeness.unverified, 0, "produk yang belum lahir di bulan itu tidak mungkin diverifikasi — jangan dihitung");
  assert.equal(completeness.pass, true);
  const locked = await lockInventoryMonthlyPeriod({ storeId: 1, year: 2026, month: 6, actor: "supervisor" }, context);
  assert.equal(locked.status, "locked", "Kunci Periode harus berhasil");
});

test("kelengkapan periode: produk yang SUDAH ada di bulan itu tapi belum diverifikasi TETAP memblokir (regresi)", async () => {
  const SUDAH_ADA = 555;
  const context = contextWithSnapshots(
    // snapshot pertamanya April, bulan yang diperiksa Juni -> sudah ada duluan
    [snapAt(2026, 6, 1), snapAt(2026, 4, SUDAH_ADA)],
    [{ productId: SUDAH_ADA, variantId: null, active: true, stockQty: 3 }],
  );
  const completeness = await getInventoryPeriodCompleteness({ storeId: 1, year: 2026, month: 6 }, context);
  assert.equal(completeness.unverified, 1, "produk yang sudah ada sejak April wajib tetap dihitung belum diverifikasi");
  assert.equal(completeness.pass, false);
  await assert.rejects(() => lockInventoryMonthlyPeriod({ storeId: 1, year: 2026, month: 6, actor: "supervisor" }, context), /produk katalog yang belum diverifikasi/);
});

test("kelengkapan periode: produk TANPA jejak snapshot sama sekali TETAP memblokir (fail-closed, tidak ada bukti kapan lahir)", async () => {
  const context = contextWithSnapshots(
    [snapAt(2026, 6, 1)],
    [{ productId: 777, variantId: null, active: true, stockQty: 5 }],
  );
  const completeness = await getInventoryPeriodCompleteness({ storeId: 1, year: 2026, month: 6 }, context);
  assert.equal(completeness.unverified, 1, "tanpa jejak snapshot, kelahirannya tidak diketahui -> jangan diloloskan");
  assert.equal(completeness.pass, false);
});
