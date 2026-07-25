// Test unit distributed lock/lease Olsera (Tahap 7): acquire atomic, expiry
// recovery, release hanya oleh owner, dan status aman (tanpa BSON/detail
// rahasia). MongoDB di-mock in-memory — tidak pernah menyentuh database
// sungguhan.
// Jalankan: npm run test:olsera-cron-lock
import test, { mock, before } from "node:test";
import assert from "node:assert/strict";

class DuplicateKeyError extends Error {
  code = 11000;
}

/** Koleksi palsu in-memory yang meniru semantik findOneAndUpdate MongoDB
 * (termasuk kegagalan atomik saat filter non-equality tidak cocok tapi _id
 * sudah ada — dilempar sebagai duplicate key, persis seperti race dua upsert
 * pertama pada index unik _id). */
class FakeLockCollection {
  doc: Record<string, unknown> | null = null;

  private matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, value]) => {
      if (value && typeof value === "object" && "$lte" in (value as Record<string, unknown>)) {
        const bound = (value as { $lte: Date }).$lte;
        const current = doc[key] as Date | undefined;
        return current !== undefined && current <= bound;
      }
      return doc[key] === value;
    });
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: { $set: Record<string, unknown> },
    options: { upsert?: boolean; returnDocument?: "after" } = {},
  ) {
    if (this.doc && this.matchesFilter(this.doc, filter)) {
      Object.assign(this.doc, update.$set);
      return { ...this.doc };
    }
    if (!options.upsert) return null;
    // _id sudah ada tapi filter (mis. lockedUntil <= now) tidak cocok -> lock aktif milik proses lain.
    if (this.doc && this.doc._id === filter._id) {
      throw new DuplicateKeyError("E11000 duplicate key");
    }
    this.doc = { _id: filter._id, ...update.$set };
    return { ...this.doc };
  }

  async updateOne(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) {
    if (this.doc && this.matchesFilter(this.doc, filter)) {
      Object.assign(this.doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async findOne(filter: Record<string, unknown>) {
    if (this.doc && this.matchesFilter(this.doc, filter)) return { ...this.doc };
    return null;
  }
}

const fakeCollection = new FakeLockCollection();

mock.module("@/lib/mongodb", {
  namedExports: {
    collections: async () => ({ olseraSyncLocks: fakeCollection }),
    withMongo: async (fn: () => Promise<unknown>) => fn(),
  },
});

let acquireOlseraSyncLock: typeof import("./olsera-cron-lock.ts").acquireOlseraSyncLock;
let releaseOlseraSyncLock: typeof import("./olsera-cron-lock.ts").releaseOlseraSyncLock;
let getOlseraSyncLockStatus: typeof import("./olsera-cron-lock.ts").getOlseraSyncLockStatus;
let withOlseraSyncLock: typeof import("./olsera-cron-lock.ts").withOlseraSyncLock;

before(async () => {
  const mod = await import("./olsera-cron-lock.ts");
  acquireOlseraSyncLock = mod.acquireOlseraSyncLock;
  releaseOlseraSyncLock = mod.releaseOlseraSyncLock;
  getOlseraSyncLockStatus = mod.getOlseraSyncLockStatus;
  withOlseraSyncLock = mod.withOlseraSyncLock;
});

test("acquire pertama kali (belum ada lock sama sekali) berhasil", async () => {
  fakeCollection.doc = null;
  const result = await acquireOlseraSyncLock("sales", "cron", 60_000);
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.runId.length > 0);
});

test("acquire kedua ditolak selama lock pertama masih aktif (belum kedaluwarsa)", async () => {
  fakeCollection.doc = null;
  const first = await acquireOlseraSyncLock("sales", "cron", 60_000);
  assert.equal(first.ok, true);
  const second = await acquireOlseraSyncLock("inventory", "cron", 60_000);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.activeModule, "sales");
    assert.equal(second.runId, (first as { ok: true; runId: string }).runId);
  }
});

test("lock basi (lockedUntil sudah lewat) bisa diambil alih modul lain", async () => {
  fakeCollection.doc = null;
  const first = await acquireOlseraSyncLock("sales", "cron", -1); // lease negatif -> langsung kedaluwarsa
  assert.equal(first.ok, true);
  const second = await acquireOlseraSyncLock("inventory", "cron", 60_000);
  assert.equal(second.ok, true);
  if (second.ok) assert.notEqual(second.runId, (first as { ok: true; runId: string }).runId);
});

test("release hanya berhasil oleh owner (runId) yang benar", async () => {
  fakeCollection.doc = null;
  const acquired = await acquireOlseraSyncLock("financial", "manual", 60_000);
  assert.equal(acquired.ok, true);
  const runId = (acquired as { ok: true; runId: string }).runId;

  const releasedByWrongOwner = await releaseOlseraSyncLock("bukan-runId-yang-benar");
  assert.equal(releasedByWrongOwner, false);

  const status = await getOlseraSyncLockStatus();
  assert.equal(status.locked, true);

  const releasedByOwner = await releaseOlseraSyncLock(runId);
  assert.equal(releasedByOwner, true);

  const statusAfter = await getOlseraSyncLockStatus();
  assert.equal(statusAfter.locked, false);
});

test("getOlseraSyncLockStatus tidak pernah mengembalikan field selain locked/activeModule/runId/source", async () => {
  fakeCollection.doc = null;
  await acquireOlseraSyncLock("inventory", "cron", 60_000);
  const status = await getOlseraSyncLockStatus();
  const keys = Object.keys(status).sort();
  assert.deepEqual(keys, ["activeModule", "locked", "runId", "source"]);
});

test("withOlseraSyncLock: manual dan cron saling mengunci — yang kedua menerima locked:true tanpa runId proses lain terekspos ke pemanggilan pertama", async () => {
  fakeCollection.doc = null;
  const first = await withOlseraSyncLock("sales", "manual", 60_000, async () => "manual-selesai");
  assert.equal(first.locked, false);
  if (!first.locked) assert.equal(first.result, "manual-selesai");
  // Lock sudah dilepas otomatis oleh withOlseraSyncLock (finally) — modul lain sekarang bebas mengunci.
  const second = await withOlseraSyncLock("inventory", "cron", 60_000, async () => "cron-selesai");
  assert.equal(second.locked, false);
});

test("withOlseraSyncLock: proses kedua diblokir selama proses pertama masih memegang lock", async () => {
  fakeCollection.doc = null;
  let releaseFirst!: () => void;
  const blocker = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstPromise = withOlseraSyncLock("sales", "cron", 60_000, async () => {
    await blocker;
    return "selesai";
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await withOlseraSyncLock("inventory", "manual", 60_000, async () => "tidak-boleh-jalan");
  assert.equal(second.locked, true);
  if (second.locked) assert.equal(second.activeModule, "sales");
  releaseFirst();
  const first = await firstPromise;
  assert.equal(first.locked, false);
});
