import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBalanceSheetPayload } from "./olsera-financial-core.ts";
import { EMPTY_LEDGER_CONFIRMATION_MIN_GAP_MS, markLedgerNonEmptyObservation, recordLedgerEmptyObservation } from "./olsera-financial-store.ts";
import { withTimeout } from "./with-timeout.ts";

process.env.OLSERA_INTERNAL_STORE_ID = "324175";

class FakeCollection {
  docs = new Map<string, any>();
  deletes: any[] = [];
  inserts: any[] = [];
  async findOne(filter: any) { return this.docs.get(filter._id) ?? null; }
  async updateOne(filter: any, update: any, options: any = {}) {
    const current = this.docs.get(filter._id);
    if (!current && !options.upsert) return { matchedCount: 0, modifiedCount: 0 };
    this.docs.set(filter._id, { ...(current ?? {}), ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) });
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async deleteMany(filter: any) { this.deletes.push(filter); return { deletedCount: 1 }; }
  async insertOne(value: any) { this.inserts.push(value); return { acknowledged: true }; }
  find(filter: any) {
    const rows = [...this.docs.values()].filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value));
    return { sort: () => ({ limit: () => ({ toArray: async () => rows }) }), toArray: async () => rows };
  }
}

test("source subtotal zero is preserved and mismatch is diagnosable", () => {
  const result = normalizeBalanceSheetPayload({ data: { assets: { famount: "0", children: [{ name: "Kas", famount: "10" }] }, liabilityCapital: { famount: "0" } } });
  assert.equal(result.assets.amount, 0);
  assert.equal(result.assets.subtotalSourceAmount, 0);
  assert.equal(result.assets.subtotalMatches, false);
  assert.equal(result.assets.childrenAmount, 10);
});

test("empty ledger cleanup needs two successful observations from separate invocations", async () => {
  const confirmations = new FakeCollection();
  const ledger = new FakeCollection();
  const audits = new FakeCollection();
  const context = { monthlyReports: new FakeCollection(), accounts: new FakeCollection(), ledgerEntries: ledger, syncLogs: new FakeCollection(), emptyLedgerConfirmations: confirmations, staleCleanupAudits: audits };
  const first = new Date("2026-08-01T00:00:00.000Z");
  assert.equal((await recordLedgerEmptyObservation("2026-07", "11101", "run-1", "inv-1", context, first)).status, "candidate");
  assert.equal(ledger.deletes.length, 0);
  assert.equal((await recordLedgerEmptyObservation("2026-07", "11101", "run-1", "inv-1", context, new Date(first.getTime() + EMPTY_LEDGER_CONFIRMATION_MIN_GAP_MS))).status, "candidate");
  assert.equal(ledger.deletes.length, 0);
  const second = await recordLedgerEmptyObservation("2026-07", "11101", "run-2", "inv-2", context, new Date(first.getTime() + EMPTY_LEDGER_CONFIRMATION_MIN_GAP_MS * 2));
  assert.equal(second.status, "confirmed");
  assert.equal(ledger.deletes.length, 1);
  assert.equal(audits.inserts.length, 1);
  await markLedgerNonEmptyObservation("2026-07", "11101", context, new Date(first.getTime() + EMPTY_LEDGER_CONFIRMATION_MIN_GAP_MS * 3));
  assert.equal(confirmations.docs.get("324175:2026-07:11101").status, "cancelled");
});

test("timeout rejects safely and clears its timer path", async () => {
  await assert.rejects(() => withTimeout(new Promise((resolve) => setTimeout(resolve, 30)), 5, "safe timeout"), /safe timeout/);
  assert.equal(await withTimeout(Promise.resolve("ok"), 100, "unused"), "ok");
});
