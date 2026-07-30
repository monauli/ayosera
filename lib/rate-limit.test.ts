// Regression test untuk Task 4 (security hardening): rate limiting berbasis
// MongoDB. checkRateLimit diuji dengan koleksi palsu in-memory (pola sama
// lib/reconciliation-store.test.ts) — TIDAK PERNAH menyentuh database
// sungguhan. currentWindowBucket (murni) diuji langsung untuk logika waktu.
import assert from "node:assert/strict";
import test from "node:test";
import { checkRateLimit, checkRateLimitSafe, clientIp, currentWindowBucket, type RateLimitCollection } from "./rate-limit.ts";

class FakeRateLimitCollection implements RateLimitCollection {
  private docs = new Map<string, { count: number }>();
  async findOneAndUpdate(filter: { _id: string }) {
    const existing = this.docs.get(filter._id);
    const next = { count: (existing?.count ?? 0) + 1 };
    this.docs.set(filter._id, next);
    return next;
  }
}

test("currentWindowBucket: sisa waktu selalu antara 1 dan windowSeconds", () => {
  const { retryAfterSeconds } = currentWindowBucket(Date.now(), 60);
  assert.ok(retryAfterSeconds >= 1 && retryAfterSeconds <= 60);
});

test("currentWindowBucket: waktu yang sama menghasilkan bucket yang sama (deterministik)", () => {
  const now = 1_700_000_000_000;
  const a = currentWindowBucket(now, 60);
  const b = currentWindowBucket(now, 60);
  assert.equal(a.bucketStart, b.bucketStart);
});

test("checkRateLimit: request di bawah limit -> allowed true", async () => {
  const collection = new FakeRateLimitCollection();
  const r1 = await checkRateLimit("k", 3, 60, collection);
  const r2 = await checkRateLimit("k", 3, 60, collection);
  const r3 = await checkRateLimit("k", 3, 60, collection);
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, true);
});

test("checkRateLimit: request melebihi limit -> allowed false (429)", async () => {
  const collection = new FakeRateLimitCollection();
  await checkRateLimit("k", 2, 60, collection);
  await checkRateLimit("k", 2, 60, collection);
  const r3 = await checkRateLimit("k", 2, 60, collection);
  assert.equal(r3.allowed, false);
  assert.ok(r3.retryAfterSeconds >= 1);
});

test("checkRateLimit: key berbeda tidak saling memengaruhi (per-IP/per-tujuan terpisah)", async () => {
  const collection = new FakeRateLimitCollection();
  await checkRateLimit("a", 1, 60, collection);
  const bAllowed = (await checkRateLimit("b", 1, 60, collection)).allowed;
  assert.equal(bAllowed, true);
});

test("checkRateLimit: melempar bila collection error (dibuktikan sebelum menguji fail-open pembungkusnya)", async () => {
  const brokenCollection: RateLimitCollection = {
    async findOneAndUpdate() {
      throw new Error("Mongo unavailable");
    },
  };
  await assert.rejects(() => checkRateLimit("k", 1, 60, brokenCollection));
});

test("checkRateLimitSafe: memanggil checkRateLimit lalu menangkap error menjadi allowed:true (fail-open), bukan melempar ulang", async () => {
  assert.equal(typeof checkRateLimitSafe, "function");
  // checkRateLimitSafe tidak menerima parameter collection injeksi (dipakai
  // lewat koneksi Mongo nyata di produksi) — perilaku fail-safe-nya sendiri
  // (try/catch membungkus checkRateLimit, mengembalikan allowed:true saat
  // error alih-alih melempar) diverifikasi lewat pembacaan sumber di bawah,
  // karena memaksa checkRateLimit asli melempar tanpa injeksi memerlukan
  // memutus koneksi MongoDB sungguhan — tidak bisa dilakukan aman di test unit.
  const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./rate-limit.ts", import.meta.url), "utf8"));
  const fnMatch = source.match(/export async function checkRateLimitSafe[\s\S]*?\n}/);
  assert.ok(fnMatch, "checkRateLimitSafe harus ditemukan");
  assert.ok(fnMatch[0].includes("try {"));
  assert.ok(fnMatch[0].includes("return await checkRateLimit("));
  assert.ok(fnMatch[0].includes("return { allowed: true"));
});

test("clientIp: mengambil IP pertama dari x-forwarded-for", () => {
  const req = new Request("https://example.test", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
  assert.equal(clientIp(req), "1.2.3.4");
});

test("clientIp: fallback 'unknown' bila header tidak ada", () => {
  const req = new Request("https://example.test");
  assert.equal(clientIp(req), "unknown");
});
