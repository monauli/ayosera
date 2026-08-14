// Route-level test untuk GET /api/audit/olsera-validation (Phase 1/2/3 fix).
// Root cause production: setiap fetch per-section (?section=category|inventory|financial)
// SELALU membawa key stub `{status:"Data Belum Lengkap"}` untuk section lain, dan
// OlseraValidationPanel.validate() menggabungkannya lewat Object.assign — fetch
// section berikutnya menimpa data section sebelumnya yang sudah lengkap dengan
// stub itu (category jadi "-"/NaN, inventory jadi 0/0). Fix: response hanya
// menyertakan key section yang benar-benar dihitung. Semua dependency
// (auth/mongo/olsera) di-mock lewat --experimental-test-module-mocks SEBELUM
// route diimpor, TIDAK PERNAH menyentuh MongoDB/Olsera sungguhan.
import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

function collectionStub(rows: unknown[]) {
  return { find: () => ({ toArray: async () => rows }) };
}

let categoryLive: { items: Array<{ amount: number; qty: number }>; orders: unknown[] } = { items: [], orders: [] };
let categoryLiveThrows = false;
let storedCategoryRows: Array<{ totalAmount: number; qty: number }> = [];
let stockmovementResult: { ok: true; rows: Array<{ productId: number; sisa: number }> } | { ok: false; error: string } = { ok: true, rows: [] };
let storedInventoryRows: Array<{ productId: number; productName: string; closingQty: number | null }> = [];
let storedFinancialReports: Array<{ reportType: string; normalizedPayload: unknown }> = [];
let liveBalanceSheetTotals: Record<string, number> = {};
let liveLedgerRows: Array<Record<string, unknown>> = [];

mock.module("@/lib/auth", { namedExports: { requireModule: mock.fn(async () => ({ id: "u1", role: "user" as const, allowedModules: ["audit"] })) } });
mock.module("@/lib/mongodb", {
  namedExports: {
    withMongo: async (handler: () => Promise<unknown>) => handler(),
    collections: async () => ({
      olseraSalesByCategory: collectionStub(storedCategoryRows),
      olseraInventoryMonthlySnapshots: collectionStub(storedInventoryRows),
      olseraFinancialMonthlyReports: collectionStub(storedFinancialReports),
    }),
  },
});
mock.module("@/lib/olsera-sync", {
  namedExports: {
    fetchOlseraSalesAuditSource: mock.fn(async () => {
      if (categoryLiveThrows) throw new Error("Olsera API gagal diakses.");
      return categoryLive;
    }),
  },
});
mock.module("@/lib/olsera-inventory-stockmovement", { namedExports: { fetchStockMovementRange: async () => stockmovementResult } });
mock.module("@/lib/olsera-financial-client", {
  namedExports: {
    getBalanceSheet: async () => ({}),
    getProfitLoss: async () => ({}),
    getCashFlow: async () => ({}),
    getLedgerSummary: async () => ({}),
  },
});
mock.module("@/lib/olsera-financial-core", {
  namedExports: {
    normalizeBalanceSheetPayload: () => ({ totals: liveBalanceSheetTotals }),
    normalizeProfitLossPayload: () => ({ totals: {} }),
    normalizeCashFlowPayload: () => ({ totals: {} }),
    normalizeLedgerSummaryPayload: () => liveLedgerRows,
  },
});

let GET!: typeof import("./route.ts").GET;
before(async () => {
  ({ GET } = await import("./route.ts"));
});

function req(period: string, section?: string) {
  const url = new URL(`http://localhost/api/audit/olsera-validation?period=${period}${section ? `&section=${section}` : ""}`);
  return new Request(url);
}

test.beforeEach(() => {
  categoryLive = { items: [{ amount: 1000, qty: 3 }], orders: [{ id: 1 }] };
  categoryLiveThrows = false;
  storedCategoryRows = [{ totalAmount: 1000, qty: 3 }];
  stockmovementResult = { ok: true, rows: [{ productId: 1, sisa: 5 }] };
  storedInventoryRows = [{ productId: 1, productName: "Produk A", closingQty: 5 }];
  storedFinancialReports = [];
  liveBalanceSheetTotals = {};
  liveLedgerRows = [];
});

test("section=category response tidak menyertakan key inventory/financial sama sekali (root cause clobber fix)", async () => {
  const res = await GET(req("2026-02", "category"));
  const body = await res.json();
  assert.ok("category" in body);
  assert.ok(!("inventory" in body), "response section=category tidak boleh membawa key inventory stub");
  assert.ok(!("financial" in body), "response section=category tidak boleh membawa key financial stub");
});

test("fetch berurutan category -> inventory -> financial (simulasi Object.assign panel) tidak saling menimpa", async () => {
  const merged: Record<string, unknown> = {};
  Object.assign(merged, await (await GET(req("2026-02", "category"))).json());
  Object.assign(merged, await (await GET(req("2026-02", "inventory"))).json());
  Object.assign(merged, await (await GET(req("2026-02", "financial"))).json());
  const category = merged.category as { ayosera?: { qty: number } };
  const inventory = merged.inventory as { checked?: number; matching?: number };
  assert.equal(category.ayosera?.qty, 3, "category tidak boleh jadi stub setelah fetch inventory/financial berikutnya");
  assert.equal(inventory.checked, 1, "inventory tidak boleh jadi 0/0 setelah fetch financial berikutnya");
  assert.equal(inventory.matching, 1);
});

test("category: source live sukses -> angka numerik nyata, tidak pernah NaN", async () => {
  const res = await GET(req("2026-02", "category"));
  const body = (await res.json()) as { category: { ayosera: { qty: number; total: number }; olseraLive: { qty: number; total: number }; delta: { qty: number; total: number } } };
  assert.equal(body.category.ayosera.qty, 3);
  assert.equal(body.category.olseraLive.qty, 3);
  assert.equal(body.category.delta.qty, 0);
  assert.ok(Number.isFinite(body.category.delta.qty));
  assert.ok(Number.isFinite(body.category.delta.total));
});

test("category: fetchOlseraSalesAuditSource gagal -> Gagal Dicek, bukan Data Belum Lengkap palsu", async () => {
  categoryLiveThrows = true;
  const res = await GET(req("2026-02", "category"));
  const body = (await res.json()) as { category: { status: string } };
  assert.equal(body.category.status, "Gagal Dicek");
});

test("category: Olsera live mengembalikan 0 order -> Data Belum Lengkap dengan reason, bukan Selisih palsu", async () => {
  categoryLive = { items: [], orders: [] };
  const res = await GET(req("2026-02", "category"));
  const body = (await res.json()) as { category: { status: string; reason: string | null } };
  assert.equal(body.category.status, "Data Belum Lengkap");
  assert.ok(body.category.reason);
});

test("inventory: stored ada item tapi live stockmovement kosong -> Data Belum Lengkap, BUKAN 0/0 Cocok", async () => {
  stockmovementResult = { ok: true, rows: [] };
  const res = await GET(req("2026-02", "inventory"));
  const body = (await res.json()) as { inventory: { status: string; checked: number; liveItems: number; reason: string | null } };
  assert.equal(body.inventory.status, "Data Belum Lengkap");
  assert.equal(body.inventory.checked, 1, "checked harus tetap mencerminkan jumlah item stored yang sebenarnya, bukan 0");
  assert.equal(body.inventory.liveItems, 0);
  assert.ok(body.inventory.reason);
});

test("inventory: stored dan live sama-sama ada -> hasil real count, bukan 0/0", async () => {
  const res = await GET(req("2026-02", "inventory"));
  const body = (await res.json()) as { inventory: { status: string; checked: number; matching: number } };
  assert.equal(body.inventory.status, "Cocok");
  assert.equal(body.inventory.checked, 1);
  assert.equal(body.inventory.matching, 1);
});

test("inventory: stockmovement API gagal -> Gagal Dicek", async () => {
  stockmovementResult = { ok: false, error: "Stockmovement API timeout" };
  const res = await GET(req("2026-02", "inventory"));
  const body = (await res.json()) as { inventory: { status: string } };
  assert.equal(body.inventory.status, "Gagal Dicek");
});

test("financial: mismatch totals ter-render dengan ayosera/olsera/delta per field", async () => {
  storedFinancialReports = [{ reportType: "balance-sheet", normalizedPayload: { totals: { aset: 1000 } } }];
  liveBalanceSheetTotals = { aset: 1200 };
  const res = await GET(req("2026-02", "financial"));
  const body = (await res.json()) as { financial: { balanceSheet: { status: string; totals: Record<string, { ayosera: number; olsera: number; delta: number }> } } };
  assert.equal(body.financial.balanceSheet.status, "Selisih");
  assert.equal(body.financial.balanceSheet.totals.aset.ayosera, 1000);
  assert.equal(body.financial.balanceSheet.totals.aset.olsera, 1200);
  assert.equal(body.financial.balanceSheet.totals.aset.delta, 200);
});

test("ledger: 85 akun dicek dan mismatch akun ter-render di ledgerAccounts.differences", async () => {
  storedFinancialReports = [
    { reportType: "ledger-summary", normalizedPayload: [{ accountCode: "100", accountName: "Kas", debit: 10, credit: 0, balance: 100 }] },
  ];
  liveLedgerRows = [{ accountCode: "100", accountName: "Kas", debit: 10, credit: 0, balance: 150 }];
  const res = await GET(req("2026-02", "financial"));
  const body = (await res.json()) as { financial: { ledgerAccounts: { checked: number; matching: number; differences: Array<{ accountCode: string }> } } };
  assert.equal(body.financial.ledgerAccounts.checked, 1);
  assert.equal(body.financial.ledgerAccounts.matching, 0);
  assert.equal(body.financial.ledgerAccounts.differences.length, 1);
  assert.equal(body.financial.ledgerAccounts.differences[0].accountCode, "100");
});
