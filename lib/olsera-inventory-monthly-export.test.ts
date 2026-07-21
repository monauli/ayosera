// Test unit Export Inventori Bulanan menggunakan fixture data Juni 2026 nyata
// (doc export/INVENTORI.xlsx dan doc export/summary-2026-06-01__2026-06-30.xlsx),
// dibekukan sebagai literal di file ini supaya test tidak bergantung pada file
// eksternal yang bisa berubah/hilang. Tidak menyentuh MongoDB.
// Jalankan: npm run test:olsera-inventory-monthly
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateDailySales, parseSummaryRows } from "./olsera-inventory-monthly-core.ts";
import {
  buildMonthlyInventoryWorkbook,
  buildMonthlyRows,
  type MonthlyImportDiagnostics,
} from "./olsera-inventory-monthly-export.ts";
import type { InventoryProductInput } from "./olsera-inventory-core.ts";

// ---- Fixture: 34 baris export resmi Pergerakan Stok Olsera Juni 2026 -------
// (header + data, persis struktur file summary-2026-06-01__2026-06-30.xlsx)
const SUMMARY_RAW: unknown[][] = [
  ["NESTLE PURE LIFE 1500ML", "MINUMAN", 59, 633, 0, 426, 0, 0, 0, 12, 254],
  ["BOLA AMA PINK ISI 2", "BOLA PADEL", 15, 0, 0, 3, 0, 0, 0, 0, 12],
  ["NESTLE PURE LIFE 600ML", "MINUMAN", 402, 48, 0, 298, 0, 0, 0, 9, 143],
  ["OVERGRIPS WILSON", "GRIP", 93, 2, 0, 43, 0, 0, 0, 0, 52],
  ["BOLA PADEL ODEA", "BOLA PADEL", 45, 24, 0, 46, 0, 0, 0, 2, 21],
  ["POCARI SWEAT PET 900ML", "MINUMAN", 118, 150, 0, 92, 0, 0, 0, 16, 160],
  ["POCARI SWEAT PET 500 ML", "MINUMAN", 27, 617, 0, 172, 0, 0, 0, 1, 471],
  ["POCARI ION WATER 500ML", "MINUMAN", 207, 240, 0, 162, 0, 0, 0, 5, 280],
  ["GRIP LI-NING", "GRIP", 18, 0, 0, 12, 0, 0, 0, 1, 5],
  ["SOY JOY MULTI VARIANT", "SNACK", 25, 90, 0, 53, 0, 0, 0, 0, 62],
  ["PERMEN HACKER", "SNACK", 8, 36, 0, 19, 0, 0, 0, 0, 25],
  ["YONEX LADIES SOCKS # SSL-2859R-S", "KAOS KAKI", 8, 0, 0, 2, 0, 0, 0, 0, 6],
  ["YONEX MEN POLO T-SHIRT # PM-P064-2626-EASY3-S", "BAJU PRIA", 15, 0, 0, 3, 0, 0, 0, 0, 12],
  ["BOLA BULLPADEL PREMIUM PRO ISI 3", "BOLA PADEL", 43, 0, 0, 2, 0, 0, 0, 0, 41],
  ["YONEX LADIES SKORT #SKL-P061-2846-SOLID-S", "SKORT WANITA", 23, 0, 0, 4, 0, 0, 0, 0, 19],
  ["BOLA HEAD PRO ISI 3", "BOLA PADEL", 2, 2, 0, 1, 0, 0, 0, 0, 3],
  ["BOLA PADEL HEAD PRO S+ ISI 3", "BOLA PADEL", 4, 26, 0, 4, 0, 0, 0, 0, 26],
  ["GRIP YONEX AC102", "GRIP", 19, 0, 0, 5, 0, 0, 0, 0, 14],
  ["YONEX MEN SOCKS SSM-1086ID-MP6-S", "KAOS KAKI", 10, 0, 0, 3, 0, 0, 0, 0, 7],
  ["YONEX  WOMEN CAP SILICON", "TOPI", 53, 0, 0, 2, 0, 0, 0, 0, 51],
  ["YONEX MENS SHORTS # SM-P061-3085-RW2-S", "CELANA PRIA", 3, 0, 0, 3, 0, 0, 0, 0, 0],
  ["YONEX POLO MEN # PM-P064-2736-EASY4-S", "BAJU PRIA", 13, 0, 0, 3, 0, 0, 0, 0, 10],
  ["YONEX LADIES SOCKS # SSL-2860R-S", "KAOS KAKI", 4, 0, 0, 3, 0, 0, 0, 0, 1],
  ["YONEX SOCKS SSM-1055ID-MP6-SR", "KAOS KAKI", 20, 0, 0, 3, 0, 0, 0, 0, 17],
  ["BOLA ADIDAS SPEED RX ISI 3", "BOLA PADEL", 8, 24, 0, 7, 0, 0, 0, 0, 25],
  ["YONEX MEN SOCKS SSM-1255ID-MP6-SR", "KAOS KAKI", 1, 0, 0, 1, 0, 0, 0, 0, 0],
  ["KAOS KAKI NOX SOCKS SHORT", "KAOS KAKI", 0, 2, 0, 0, 0, 0, 0, 0, 2],
  ["KAOS KAKI NOX SOCKS LONG", "KAOS KAKI", 0, 10, 0, 2, 0, 0, 0, 0, 8],
  ["YONEX MEN SOCKS SSM-1284ID-MP6-S", "KAOS KAKI", 29, 0, 0, 2, 0, 0, 0, 0, 27],
  ["SKORT PADEL VARIASI", "SKORT WANITA", 0, 12, 0, 2, 0, 0, 0, 0, 10],
  ["YONEX MEN SOCKS SSM-1855ID-MP6-SR", "KAOS KAKI", 25, 0, 0, 1, 0, 0, 0, 0, 24],
  ["YONEX MEN SOCKS SSM-1285ID-MP6-S", "KAOS KAKI", 13, 0, 0, 3, 0, 0, 0, 0, 10],
  ["Bullpadel Indiga Mundial Argentina LTD 1988", "RAKET PADEL", 2, 0, 0, 1, 0, 0, 0, 0, 1],
].map(([product, group, begining, incoming, ret, sales, outgoing, prodIn, prodOut, opname, balance]) => [
  group, product, "", "", begining, incoming, ret, sales, outgoing, prodIn, prodOut, opname, balance, "ASYFA", "2026-06-01 07:00:00",
]);

// ---- Fixture: penjualan harian per produk (dari kolom hari 1-30 INVENTORI.xlsx) ----
const DAILY_SALES: Record<string, number[]> = {
  "NESTLE PURE LIFE 1500ML": [10,20,10,17,11,19,17,16,10,15,8,9,9,25,20,14,10,26,8,11,17,10,10,7,15,11,21,26,16,8],
  "NESTLE PURE LIFE 600ML": [12,6,5,8,14,10,15,9,2,16,15,7,7,16,10,11,7,12,13,8,23,4,2,9,2,11,11,16,11,6],
  "POCARI SWEAT PET 500 ML": [10,6,5,4,5,9,6,3,9,8,3,4,4,3,7,11,3,7,4,5,14,5,5,3,5,4,8,3,8,1],
  "POCARI SWEAT PET 900ML": [4,3,6,4,4,5,4,2,4,2,4,1,2,3,2,2,1,4,5,2,8,3,3,2,0,3,2,4,3,0],
  "POCARI ION WATER 500ML": [12,7,4,11,5,11,10,5,9,4,4,0,6,5,4,4,1,3,1,7,13,1,6,3,4,6,9,4,3,0],
  "OVERGRIPS WILSON": [6,0,4,0,1,2,0,0,0,2,1,1,0,0,0,2,3,0,2,3,4,2,1,1,0,0,2,2,2,2],
  "GRIP LI-NING": [2,0,1,0,1,2,0,0,0,0,0,0,0,0,0,0,0,3,0,0,0,2,0,0,1,0,0,0,0,0],
  "BOLA PADEL ODEA": [1,1,3,2,0,2,5,2,0,3,1,4,2,3,0,0,0,1,0,2,3,1,1,2,2,1,2,2,0,0],
  "BOLA AMA PINK ISI 2": [1,0,0,0,0,0,0,1,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "SOY JOY MULTI VARIANT": [1,0,0,2,1,2,5,1,3,2,5,1,0,0,1,8,0,4,1,0,1,2,2,3,1,1,1,3,1,1],
  "PERMEN HACKER": [0,1,0,2,0,0,0,0,0,1,0,0,0,0,0,0,1,0,1,0,1,1,0,1,1,7,0,1,1,0],
  "GRIP YONEX AC102": [0,0,2,0,0,0,0,1,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0],
  "YONEX  WOMEN CAP SILICON": [0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "BOLA BULLPADEL PREMIUM PRO ISI 3": [0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0],
  "BOLA ADIDAS SPEED RX ISI 3": [0,0,0,0,0,0,0,0,1,0,1,0,1,1,0,0,2,0,0,1,0,0,0,0,0,0,0,0,0,0],
  "BOLA HEAD PRO ISI 3": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0],
  "BOLA PADEL HEAD PRO S+ ISI 3": [0,0,0,0,0,0,1,0,0,0,0,0,0,1,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0],
  "YONEX LADIES SOCKS # SSL-2859R-S": [0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "YONEX LADIES SOCKS # SSL-2860R-S": [0,0,0,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "YONEX MEN POLO T-SHIRT # PM-P064-2626-EASY3-S": [0,1,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "YONEX POLO MEN # PM-P064-2736-EASY4-S": [0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0],
  "YONEX LADIES SKORT #SKL-P061-2846-SOLID-S": [0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0],
  "SKORT PADEL VARIASI": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0],
  "YONEX MENS SHORTS # SM-P061-3085-RW2-S": [0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,1,0,0,0,0,0,0],
  "YONEX MEN SOCKS SSM-1086ID-MP6-S": [0,0,0,1,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "YONEX SOCKS SSM-1055ID-MP6-SR": [0,0,0,0,0,0,0,0,2,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "YONEX MEN SOCKS SSM-1255ID-MP6-SR": [0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "KAOS KAKI NOX SOCKS LONG": [0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0],
  "KAOS KAKI NOX SOCKS SHORT": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "YONEX MEN SOCKS SSM-1284ID-MP6-S": [0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0],
  "YONEX MEN SOCKS SSM-1855ID-MP6-SR": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0],
  "YONEX MEN SOCKS SSM-1285ID-MP6-S": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,1,1,0,0],
  "Bullpadel Indiga Mundial Argentina LTD 1988": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0],
};

// ---- Fixture: harga beli/jual per produk (kolom C/D INVENTORI.xlsx) --------
const PRICES: Record<string, { buyPrice: number; sellPrice: number }> = {
  "NESTLE PURE LIFE 1500ML": { buyPrice: 4558.67, sellPrice: 15000 },
  "NESTLE PURE LIFE 600ML": { buyPrice: 2116.6, sellPrice: 10000 },
  "POCARI SWEAT PET 500 ML": { buyPrice: 6250, sellPrice: 12000 },
  "POCARI SWEAT PET 900ML": { buyPrice: 10250, sellPrice: 20000 },
  "POCARI ION WATER 500ML": { buyPrice: 6250, sellPrice: 12000 },
  "OVERGRIPS WILSON": { buyPrice: 25000, sellPrice: 35000 },
  "GRIP LI-NING": { buyPrice: 30000, sellPrice: 40000 },
};

function buildFixtureCatalog(): InventoryProductInput[] {
  const names = new Set(SUMMARY_RAW.map((row) => String(row[1])));
  let productId = 1000;
  return [...names].map((name) => {
    const price = PRICES[name] ?? { buyPrice: 0, sellPrice: 0 };
    productId += 1;
    return {
      _id: `1:${productId}:0`,
      productId,
      variantId: null,
      sku: null,
      barcode: null,
      name,
      variantName: null,
      category: "(fixture)",
      subCategory: null,
      uom: null,
      storeId: 1,
      storeName: "Fixture Store",
      active: true,
      trackInventory: true,
      sellPrice: price.sellPrice,
      buyPrice: price.buyPrice,
      lastBuyPrice: price.buyPrice,
      stockQty: 0,
      holdQty: 0,
      lowStockAlert: null,
      isOutStock: false,
      modifiedTime: null,
      stockSyncTime: null,
    };
  });
}

function buildFixtureDailySales(catalog: InventoryProductInput[]) {
  const byName = new Map(catalog.map((product) => [product.name, product]));
  const movements: { key: string; date: string; qtyChange: number }[] = [];
  for (const [name, days] of Object.entries(DAILY_SALES)) {
    const product = byName.get(name);
    if (!product) continue;
    days.forEach((qty, dayIndex) => {
      if (!qty) return;
      const day = String(dayIndex + 1).padStart(2, "0");
      movements.push({ key: product._id, date: `2026-06-${day}`, qtyChange: -qty });
    });
  }
  return aggregateDailySales(movements, 2026, 6);
}

function buildFixtureRows() {
  const { rows: summaryRows } = parseSummaryRows(SUMMARY_RAW.map((row) => row.slice(0, 15)));
  const catalog = buildFixtureCatalog();
  const dailySalesByProductKey = buildFixtureDailySales(catalog);
  return buildMonthlyRows({ summaryRows, catalogProducts: catalog, dailySalesByProductKey, days: 30 });
}

// ---- Perbandingan fixture Juni: Stock Akhir Sistem harus == Sisa Olsera ----

test("fixture Juni: seluruh 33 produk dipetakan (tidak ada ambigu/unmatched)", () => {
  const { diagnostics } = buildFixtureRows();
  assert.deepEqual(diagnostics.unmatchedOrAmbiguous, []);
});

test("fixture Juni: Stock Akhir Sistem == Sisa (balance) Olsera untuk semua baris", () => {
  const { rows } = buildFixtureRows();
  assert.equal(rows.length, 33);
  for (const row of rows) {
    assert.equal(
      row.stockAkhirSistem,
      row.balanceOlsera,
      `${row.name}: dihitung ${row.stockAkhirSistem} != Sisa Olsera ${row.balanceOlsera}`,
    );
  }
});

test("fixture Juni: Total Penjualan (AYOSERA, dari movement harian) == sales Olsera untuk semua baris", () => {
  const { diagnostics } = buildFixtureRows();
  assert.deepEqual(diagnostics.salesMismatch, []);
});

test("fixture Juni: Keluar == opname Olsera (bukan outgoing) — Nestle Pure Life 1500ml", () => {
  const { rows } = buildFixtureRows();
  const row = rows.find((r) => r.name === "NESTLE PURE LIFE 1500ML")!;
  assert.equal(row.keluar, 12);
  assert.equal(row.stockAkhirSistem, 254);
});

test("fixture Juni: produk tanpa pergerakan bulan ini (KAOS KAKI NOX SOCKS SHORT) tetap konsisten", () => {
  const { rows } = buildFixtureRows();
  const row = rows.find((r) => r.name === "KAOS KAKI NOX SOCKS SHORT")!;
  assert.equal(row.totalPenjualan, 0);
  assert.equal(row.stockAkhirSistem, 2);
  assert.equal(row.balanceOlsera, 2);
});

test("fixture Juni: produk dengan koreksi stock opname besar (Pocari Sweat 900ml, opname 16)", () => {
  const { rows } = buildFixtureRows();
  const row = rows.find((r) => r.name === "POCARI SWEAT PET 900ML")!;
  assert.equal(row.keluar, 16);
  assert.equal(row.stockAkhirSistem, 160);
  assert.equal(row.stockAkhirSistem, row.balanceOlsera);
});

// ---- Row total & workbook rendering (Aktual kosong, Selisih formula) ------

test("buildMonthlyInventoryWorkbook: row Total menjumlahkan Stok Awal/Barang Masuk/Penjualan/Keluar/Stock Akhir", () => {
  const { rows, diagnostics } = buildFixtureRows();
  const workbook = buildMonthlyInventoryWorkbook({
    year: 2026,
    month: 6,
    days: 30,
    rows,
    diagnostics: { headerErrors: [], skippedBlankRows: 0, rowsOutsidePeriod: [], duplicates: [], ...diagnostics } as MonthlyImportDiagnostics,
  });
  const sheet = workbook.worksheets[0];
  const totalRowNumber = 4 + rows.length;
  const totalRow = sheet.getRow(totalRowNumber);
  assert.equal(totalRow.getCell(1).value, "Total");

  const expectedStokAwal = rows.reduce((sum, r) => sum + (r.stokAwal ?? 0), 0);
  const expectedStockAkhir = rows.reduce((sum, r) => sum + (r.stockAkhirSistem ?? 0), 0);
  assert.equal(totalRow.getCell(5).value, expectedStokAwal);
  assert.equal(totalRow.getCell(sheet.columnCount - 2).value, expectedStockAkhir);
});

test("buildMonthlyInventoryWorkbook: kolom Aktual selalu kosong (bukan 0) untuk setiap baris data", () => {
  const { rows, diagnostics } = buildFixtureRows();
  const workbook = buildMonthlyInventoryWorkbook({
    year: 2026,
    month: 6,
    days: 30,
    rows,
    diagnostics: { headerErrors: [], skippedBlankRows: 0, rowsOutsidePeriod: [], duplicates: [], ...diagnostics } as MonthlyImportDiagnostics,
  });
  const sheet = workbook.worksheets[0];
  const aktualCol = sheet.columnCount - 1;
  for (let r = 4; r < 4 + rows.length; r++) {
    assert.equal(sheet.getRow(r).getCell(aktualCol).value, null);
  }
});

test("buildMonthlyInventoryWorkbook: kolom Selisih berisi formula IF(AKTUAL=\"\",\"\",AKTUAL-STOCKAKHIR)", () => {
  const { rows, diagnostics } = buildFixtureRows();
  const workbook = buildMonthlyInventoryWorkbook({
    year: 2026,
    month: 6,
    days: 30,
    rows,
    diagnostics: { headerErrors: [], skippedBlankRows: 0, rowsOutsidePeriod: [], duplicates: [], ...diagnostics } as MonthlyImportDiagnostics,
  });
  const sheet = workbook.worksheets[0];
  const selisihCol = sheet.columnCount;
  const aktualCol = sheet.columnCount - 1;
  const stockAkhirCol = sheet.columnCount - 2;
  const cell = sheet.getRow(4).getCell(selisihCol);
  const formula = (cell.value as { formula: string }).formula;
  const aktualAddr = sheet.getRow(4).getCell(aktualCol).address;
  const stockAkhirAddr = sheet.getRow(4).getCell(stockAkhirCol).address;
  assert.equal(formula, `IF(${aktualAddr}="","",${aktualAddr}-${stockAkhirAddr})`);
});

test("buildMonthlyInventoryWorkbook: jumlah kolom hari mengikuti jumlah hari bulan (Juni = 30)", () => {
  const { rows, diagnostics } = buildFixtureRows();
  const workbook = buildMonthlyInventoryWorkbook({
    year: 2026,
    month: 6,
    days: 30,
    rows,
    diagnostics: { headerErrors: [], skippedBlankRows: 0, rowsOutsidePeriod: [], duplicates: [], ...diagnostics } as MonthlyImportDiagnostics,
  });
  const sheet = workbook.worksheets[0];
  // 6 kolom tetap (Group..Barang Masuk) + 30 hari + 5 kolom akhir (Penjualan/Keluar/StockAkhir/Aktual/Selisih)
  assert.equal(sheet.columnCount, 6 + 30 + 5);
});
