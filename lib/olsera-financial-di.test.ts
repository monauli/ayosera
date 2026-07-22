// Regression test Tahap 4A — memastikan financial store/sync memakai
// dependency injection (bukan withMongo()/singleton production) saat context
// MongoDB TEST dipasok, sementara jalur production tetap tersedia tanpa
// perubahan. Tidak pernah membuka database production sungguhan: singleton
// "./mongodb" di-mock supaya menyentuhnya langsung memicu error.
//
// Jalankan: npm run test:olsera-financial-di
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.OLSERA_INTERNAL_STORE_ID = "324175";

const PRODUCTION_TOUCHED = "PRODUCTION_SINGLETON_TOUCHED";

mock.module("./mongodb", {
  namedExports: {
    collections: async () => {
      throw new Error(PRODUCTION_TOUCHED);
    },
    withMongo: async (fn: () => Promise<unknown>) => fn(),
  },
});

mock.module("./olsera-financial-client", {
  namedExports: {
    getAccounts: async () => [
      { data: [{ account_id: 1, account_code: "11105", account_name: "Kas" }] },
      { data: [] },
    ],
    getBalanceSheet: async () => ({ data: { assets: { amount: 100 }, liabilityCapital: { amount: 100 } } }),
    getProfitLoss: async () => ({
      data: {
        revenue: { amount: 1000 },
        costOfGoodsSold: { amount: 200 },
        laba_kotor: { amount: 800 },
        operatingExpenses: { amount: 300 },
        nonOperatingIncome: { amount: 0 },
        nonOperatingExpenses: { amount: 0 },
        netProfit: { amount: 500 },
      },
    }),
    getCashFlow: async () => ({
      data: { operational: { amount: 100 }, investing: { amount: 50 }, funding: { amount: 50 }, cashIncrease: { amount: 200 }, openingCash: { amount: 1000 }, endingCash: { amount: 1200 } },
    }),
    getLedgerSummary: async () => ({ "0": { account_id: 1, account_code: "11105", fdebit: "100", fcredit: "0", famount: "100" } }),
    getLedgerDetail: async () => ({
      data: [
        { transaction_date: "2026-05-01", transaction_description: "Saldo Awal", famount: "500" },
        { transaction_date: "2026-05-02", transaction_description: "Penjualan", fdebit: "50", fcredit: "0", famount: "550" },
      ],
    }),
  },
});

/** Koleksi palsu in-memory — cukup untuk menguji upsert/idempotensi tanpa MongoDB sungguhan. */
class FakeCollection {
  docs = new Map<string, Record<string, unknown>>();

  private matches(doc: Record<string, unknown>, filter: Record<string, unknown>) {
    return Object.entries(filter).every(([key, value]) => doc[key] === value);
  }

  async createIndex() {
    return "ok";
  }

  async updateOne(filter: Record<string, unknown>, update: Record<string, any>, options: { upsert?: boolean } = {}) {
    const id = filter._id as string;
    let doc = this.docs.get(id);
    if (!doc) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      doc = {};
      if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
    }
    if (update.$set) Object.assign(doc, update.$set);
    this.docs.set(id, doc);
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 1 };
  }

  async bulkWrite(ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, any>; upsert?: boolean } }>) {
    for (const op of ops) await this.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert });
    return { ok: 1 };
  }

  async findOne(filter: Record<string, unknown>) {
    return [...this.docs.values()].find((doc) => this.matches(doc, filter)) ?? null;
  }

  async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, any>) {
    await this.updateOne(filter, update, {});
    return this.findOne(filter);
  }

  async countDocuments(filter: Record<string, unknown>) {
    return [...this.docs.values()].filter((doc) => this.matches(doc, filter)).length;
  }

  find(filter: Record<string, unknown>) {
    const docs = [...this.docs.values()].filter((doc) => this.matches(doc, filter));
    return { toArray: async () => docs };
  }
}

function fakeCollections() {
  return {
    monthlyReports: new FakeCollection(),
    accounts: new FakeCollection(),
    ledgerEntries: new FakeCollection(),
    syncLogs: new FakeCollection(),
  };
}

test("store: context yang dipasok TIDAK PERNAH menyentuh singleton production", async () => {
  const { createFinancialSyncRun, upsertAccounts } = await import("./olsera-financial-store.ts");
  const fc = fakeCollections();
  await upsertAccounts([{ account_id: 1, account_code: "11105", account_name: "Kas" }], fc);
  const run = await createFinancialSyncRun("2026-05", ["11105"], fc);
  assert.equal(run.period, "2026-05");
  assert.equal(await fc.accounts.countDocuments({}), 1);
});

test("store: TANPA context tetap jatuh ke adapter production (withMongo/collections) — adapter production tetap tersedia", async () => {
  const { createFinancialSyncRun } = await import("./olsera-financial-store.ts");
  await assert.rejects(() => createFinancialSyncRun("2026-05", ["11105"]), new RegExp(PRODUCTION_TOUCHED));
});

test("sync: startFinancialSync + stepFinancialSync end-to-end memakai koleksi injeksi, tidak pernah menyentuh production", async () => {
  const { startFinancialSync, stepFinancialSync } = await import("./olsera-financial-sync.ts");
  const fc = fakeCollections();
  let run: NonNullable<Awaited<ReturnType<typeof startFinancialSync>>> = await startFinancialSync(2026, 5, fc);
  assert.equal(run.status, "running");
  while (run.status === "running") run = (await stepFinancialSync(run._id, fc))!;
  assert.equal(run.status, "success");
  assert.equal(run.phase, "completed");
  assert.equal(await fc.monthlyReports.countDocuments({ period: "2026-05" }), 4);
});

test("sync: bulkWrite/upsert idempotent — run kedua tidak menduplikasi atau mengubah createdAt", async () => {
  const { startFinancialSync, stepFinancialSync } = await import("./olsera-financial-sync.ts");
  const fc = fakeCollections();
  async function runToCompletion() {
    let run: NonNullable<Awaited<ReturnType<typeof startFinancialSync>>> = await startFinancialSync(2026, 5, fc);
    while (run.status === "running") run = (await stepFinancialSync(run._id, fc))!;
    return run;
  }
  await runToCompletion();
  const reportsBefore = [...fc.monthlyReports.docs.values()];
  const ledgerCountBefore = fc.ledgerEntries.docs.size;

  await runToCompletion();
  const reportsAfter = [...fc.monthlyReports.docs.values()];

  assert.equal(reportsAfter.length, reportsBefore.length);
  assert.equal(fc.ledgerEntries.docs.size, ledgerCountBefore);
  for (const before of reportsBefore) {
    const after = reportsAfter.find((doc) => doc._id === before._id);
    assert.ok(after);
    assert.equal((after as any).createdAt, (before as any).createdAt);
  }
});

test("source: lib/olsera-financial-test-db.ts tidak pernah mengimpor singleton production", () => {
  const source = readFileSync(new URL("./olsera-financial-test-db.ts", import.meta.url), "utf8");
  assert.ok(!/from\s+["']\.\/mongodb["']/.test(source), "olsera-financial-test-db.ts tidak boleh mengimpor ./mongodb");
});

test("source: adapter TEST hanya membuka empat collection financial", () => {
  const source = readFileSync(new URL("./olsera-financial-test-db.ts", import.meta.url), "utf8");
  const collectionCalls = [...source.matchAll(/db\.collection\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(
    new Set(collectionCalls),
    new Set(["olsera_financial_monthly_reports", "olsera_financial_accounts", "olsera_financial_ledger_entries", "olsera_financial_sync_logs"]),
  );
});

test("source: lib/olsera-financial-store.ts tidak melakukan static import dari ./mongodb (hanya dynamic import di jalur production)", () => {
  const source = readFileSync(new URL("./olsera-financial-store.ts", import.meta.url), "utf8");
  assert.ok(!/^import .*["']\.\/mongodb["']/m.test(source), "tidak boleh ada static `import ... from \"./mongodb\"`");
  assert.ok(/await import\("\.\/mongodb"\)/.test(source), "fallback production harus lewat dynamic import");
});

test("source: validator TIDAK memanggil withMongo() dan cleanup hanya berdasarkan storeId/period", () => {
  const source = readFileSync(new URL("../scripts/validate-olsera-financial-sync.ts", import.meta.url), "utf8");
  assert.ok(!/\bwithMongo\(/.test(source), "validator tidak boleh memanggil withMongo() langsung");
  assert.ok(!/dropDatabase/.test(source), "validator tidak boleh memanggil dropDatabase()");
  const deleteCalls = [...source.matchAll(/(\w+)\.deleteMany\(\{([^}]*)\}\)/g)];
  assert.ok(deleteCalls.length > 0, "validator harus membersihkan data TEST sebelum sync");
  for (const [, , filterBody] of deleteCalls) {
    assert.ok(/storeId/.test(filterBody), `deleteMany harus difilter storeId: ${filterBody}`);
  }
});
