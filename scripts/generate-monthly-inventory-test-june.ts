// Skrip uji (BUKAN Mongo live — lihat catatan) untuk Export Inventori Bulanan:
// generate "Laporan Stock Opname" Juni 2026 dari file summary Pergerakan Stok
// Olsera resmi (doc export/), lalu bandingkan Stock Akhir Sistem terhadap
// kolom "Sisa" file tersebut.
//
// CATATAN PENTING: sesi ini tidak punya akses jaringan ke MongoDB Atlas
// produksi (ECONNREFUSED saat DNS SRV lookup ke cluster0.dqvtxp8.mongodb.net),
// sehingga katalog produk (harga beli/jual) TIDAK bisa diambil live dari DB.
// Sebagai gantinya, skrip ini memakai katalog fixture dengan NAMA KANONIK
// dari doc export/INVENTORI.xlsx (mensimulasikan olsera_inventory_products)
// yang SENGAJA DIBUAT BERBEDA dari nama pada file summary Olsera untuk 4
// produk yang diketahui berbeda ejaan — supaya matchSummaryRowToProduct
// (SKU → nama exact → alias → prefix generik dihapus) benar-benar diuji
// jalurnya, bukan trivially cocok dengan dirinya sendiri. Baris file summary
// Olsera dibaca APA ADANYA lewat parser produksi (parseSummaryWorkbookBuffer)
// — bukan diketik ulang manual. HASIL SKRIP INI BELUM TERVALIDASI TERHADAP
// KATALOG MONGO ASLI — wajib diuji ulang begitu koneksi Mongo tersedia.
//
// Jalankan: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/generate-monthly-inventory-test-june.ts
import { readFile, writeFile } from "fs/promises";
import path from "path";
import {
  aggregateDailySales,
} from "../lib/olsera-inventory-monthly-core.ts";
import {
  buildMonthlyInventoryWorkbook,
  buildMonthlyRows,
  parseSummaryWorkbookBuffer,
} from "../lib/olsera-inventory-monthly-export.ts";
import type { InventoryProductInput } from "../lib/olsera-inventory-core.ts";
import ExcelJS from "exceljs";

const DOC_DIR = path.join(process.cwd(), "doc export");
const SUMMARY_PATH = path.join(DOC_DIR, "summary-2026-06-01__2026-06-30.xlsx");
const INVENTORI_PATH = path.join(DOC_DIR, "INVENTORI.xlsx");
const OUTPUT_PATH = path.join(DOC_DIR, "Laporan Stock Opname-2026-06 (uji, tanpa Mongo live).xlsx");

/**
 * Nilai sel apa adanya; sel formula memakai hasil terhitungnya. Sel merge
 * yang bukan sel jangkar (master) dianggap kosong — lihat catatan yang sama
 * di scripts/bootstrap-monthly-snapshot-baseline.ts (baris judul merge lebar
 * akan ikut lolos filter kalau tidak ditangani).
 */
function invCellValue(cell: ExcelJS.Cell): unknown {
  if (cell.isMerged && cell.master !== cell) return null;
  const v = cell.value;
  if (v && typeof v === "object" && "result" in (v as unknown as Record<string, unknown>)) return (v as unknown as { result: unknown }).result;
  return v;
}

async function main() {
  const summaryBuffer = await readFile(SUMMARY_PATH);
  const parsed = await parseSummaryWorkbookBuffer(summaryBuffer);
  if (!parsed.ok) {
    console.error("Gagal parse file summary:", parsed.errors);
    process.exit(1);
  }
  console.log(`Parsed ${parsed.rows.length} baris dari summary Olsera (skipped blank: ${parsed.skippedBlankRows}).`);

  // Katalog + penjualan harian dari INVENTORI.xlsx (lihat catatan di atas —
  // pengganti sementara katalog/movement live karena DB tidak terjangkau).
  const invWorkbook = new ExcelJS.Workbook();
  await invWorkbook.xlsx.readFile(INVENTORI_PATH);
  const ws = invWorkbook.worksheets[0];

  const priceByName = new Map<string, { buyPrice: number; sellPrice: number }>();
  const dailyByName = new Map<string, number[]>();
  ws.eachRow({ includeEmpty: true }, (row) => {
    if (row.number <= 3) return; // 3 baris pertama = header
    const cell = (col: number) => invCellValue(row.getCell(col));
    const name = String(cell(2) ?? "").trim(); // kolom B
    if (!name) return;
    priceByName.set(name, { buyPrice: Number(cell(3)) || 0, sellPrice: Number(cell(4)) || 0 }); // kolom C, D
    const days: number[] = [];
    for (let c = 7; c <= 36; c++) { // kolom G..AJ
      const v = cell(c);
      days.push(v === "" || v === null || v === undefined ? 0 : Number(v));
    }
    dailyByName.set(name, days);
  });

  // Katalog fixture: memakai nama KANONIK dari INVENTORI.xlsx (mensimulasikan
  // katalog Mongo olsera_inventory_products) — SENGAJA BUKAN nama dari file
  // summary, supaya jalur matchSummaryRowToProduct (SKU → nama exact → alias
  // → prefix generik dihapus) benar-benar diuji seperti di produksi, bukan
  // trivially match dengan dirinya sendiri.
  let productId = 5000;
  const canonicalNames = [...priceByName.keys()];
  const catalog: InventoryProductInput[] = canonicalNames.map((name) => {
    productId += 1;
    const price = priceByName.get(name) ?? { buyPrice: 0, sellPrice: 0 };
    return {
      _id: `1:${productId}:0`,
      productId,
      variantId: null,
      sku: null,
      barcode: null,
      name,
      variantName: null,
      category: "(uji)",
      subCategory: null,
      uom: null,
      storeId: 1,
      storeName: "Uji Juni",
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

  const movements: { key: string; date: string; qtyChange: number }[] = [];
  for (const product of catalog) {
    const days = dailyByName.get(product.name);
    if (!days) continue;
    days.forEach((qty, dayIndex) => {
      if (!qty) return;
      const day = String(dayIndex + 1).padStart(2, "0");
      movements.push({ key: product._id, date: `2026-06-${day}`, qtyChange: -qty });
    });
  }
  const dailySalesByProductKey = aggregateDailySales(movements, 2026, 6);

  const { rows, diagnostics } = buildMonthlyRows({
    summaryRows: parsed.rows,
    catalogProducts: catalog,
    dailySalesByProductKey,
    days: 30,
  });

  console.log(`\nHasil mapping: ${rows.length} baris dari file summary.`);
  const methodCounts = new Map<string, number>();
  for (const row of rows) methodCounts.set(row.matchMethod, (methodCounts.get(row.matchMethod) ?? 0) + 1);
  console.log("Metode matching:", Object.fromEntries(methodCounts));
  console.log(`Ambigu/tidak ditemukan: ${diagnostics.unmatchedOrAmbiguous.length}`);
  for (const item of diagnostics.unmatchedOrAmbiguous) console.log(`  - [${item.method}] ${item.group} / ${item.product}`);
  console.log(`Selisih Penjualan AYOSERA vs Olsera: ${diagnostics.salesMismatch.length}`);
  for (const item of diagnostics.salesMismatch) console.log(`  - ${item.product}: AYOSERA=${item.totalPenjualanAyosera} Olsera=${item.totalPenjualanOlsera}`);
  console.log(`Selisih Stock Akhir Sistem vs Sisa Olsera: ${diagnostics.balanceMismatch.length}`);
  for (const item of diagnostics.balanceMismatch) console.log(`  - ${item.product}: dihitung=${item.stockAkhirSistem} Olsera=${item.balanceOlsera}`);

  const workbook = buildMonthlyInventoryWorkbook({
    year: 2026,
    month: 6,
    days: 30,
    rows,
    diagnostics: { headerErrors: [], skippedBlankRows: parsed.skippedBlankRows, rowsOutsidePeriod: [], duplicates: [], ...diagnostics },
  });
  const buffer = await workbook.xlsx.writeBuffer();
  await writeFile(OUTPUT_PATH, Buffer.from(buffer));
  console.log(`\nFile hasil uji ditulis ke: ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
