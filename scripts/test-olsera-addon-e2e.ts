// Test end-to-end dukungan addonPrice: data nyata, kedua export, no double
// count. Membandingkan payload Olsera (read-only) ↔ MongoDB ↔ Export Rincian
// Penjualan ↔ Export Kategori Penjualan untuk transaksi addon_price>0 nyata.
//
// Pakai: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/test-olsera-addon-e2e.ts
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import ExcelJS from "exceljs";

for (const fileName of [".env.local", ".env"]) {
  const filePath = path.join(process.cwd(), fileName);
  if (!existsSync(filePath)) continue;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const { collections, withMongo, mongoClient } = await import("../lib/mongodb.ts");
const { buildOlseraItemWorkbook } = await import("../lib/olsera-item-export.ts");
const { buildOlseraCategoryWorkbook } = await import("../lib/olsera-category-export.ts");
const { loadResolverContext, resolveStoredItemCategory } = await import("../lib/olsera-resolver-context.ts");
const { getAccessToken } = await import("../lib/olsera.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function cellNumber(value: ExcelJS.CellValue): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "formula" in value) return Number((value as { result?: number }).result ?? NaN);
  return NaN;
}

// ---- 1. Cari transaksi addon>0 nyata di MongoDB (setelah backfill) ----
const candidates = await withMongo(async () => {
  const { olseraOrderItems } = await collections();
  return olseraOrderItems
    .find({ date: { $gte: "2026-05-01" }, addonPrice: { $gt: 0 } } as never)
    .sort({ date: 1 })
    .limit(5)
    .toArray();
});
check("ditemukan minimal satu item addonPrice > 0 sejak 1 Mei 2026 di MongoDB", candidates.length > 0, `ditemukan ${candidates.length}`);
if (!candidates.length) {
  console.log("\nTidak ada kandidat — jalankan backfill terlebih dahulu. Menghentikan test.");
  await mongoClient.close().catch(() => undefined);
  process.exit(1);
}

const target = candidates[0];
console.log(`\nTransaksi uji: _id=${target._id} date=${target.date} order=${target.orderNo} item="${target.itemName}"`);
console.log(`  MongoDB: qty=${target.qty} amount=${target.amount} costAmount=${target.costAmount} discount=${target.discount} addonPrice=${target.addonPrice}`);

// ---- 2. Bandingkan dengan payload Olsera langsung (read-only GET) ----
const auth = await getAccessToken();
if ("error" in auth) throw new Error(auth.error);
const token = auth.token;
const BASE = "https://api-open.olsera.co.id";
const PREFIX = "/api/open-api/v1/id";
const H = { Authorization: `Bearer ${token}`, Accept: "application/json" };

let apiAddon: number | null = null;
let apiAmount: number | null = null;
outer: for (const kind of ["closeorder", "openorder"]) {
  const params = new URLSearchParams({ per_page: "100", start_date: target.date, end_date: target.date });
  if (kind === "openorder") params.set("is_paid", "1");
  const listRes = await fetch(`${BASE}${PREFIX}/order/${kind}?${params}`, { headers: H });
  if (listRes.status === 404) continue;
  const listBody = (await listRes.json()) as { data?: { id: number; order_no?: string }[] };
  for (const order of listBody.data ?? []) {
    if (String(order.order_no ?? order.id) !== target.orderNo) continue;
    const detailRes = await fetch(`${BASE}${PREFIX}/order/${kind}/detail?id=${order.id}`, { headers: H });
    const detailBody = (await detailRes.json()) as { data?: { orderitems?: Record<string, unknown>[] } };
    const item = (detailBody.data?.orderitems ?? []).find((it) => Number(it.id) === target._id);
    if (item) {
      apiAddon = Number(item.addon_price ?? 0);
      apiAmount = Number(item.amount ?? 0);
      console.log(`  API Olsera (disensor): addon_price=${item.addon_price} amount=${item.amount} price=${item.price} qty=${item.qty}`);
      break outer;
    }
  }
}
const storedAddonPrice = target.addonPrice ?? 0;
check("addon_price di MongoDB sama dengan payload Olsera", apiAddon !== null && Math.abs(apiAddon - storedAddonPrice) < 0.01, `api=${apiAddon}, mongo=${storedAddonPrice}`);
check("amount di MongoDB TIDAK berubah (masih sama dengan API)", apiAmount !== null && Math.abs(apiAmount - target.amount) < 0.01, `api=${apiAmount}, mongo=${target.amount}`);

// ---- 3. Build kedua export untuk tanggal transaksi + rentang yang mencakupnya ----
const DATE = target.date;
const RANGE_START = "2026-05-01";
const RANGE_END = target.date;

const itemsForDate = await withMongo(async () => {
  const { olseraOrderItems } = await collections();
  return olseraOrderItems.find({ date: DATE }).sort({ orderDate: 1, orderNo: 1 }).toArray();
});
const itemsForRange = await withMongo(async () => {
  const { olseraOrderItems } = await collections();
  return olseraOrderItems.find({ date: { $gte: RANGE_START, $lte: RANGE_END } }).sort({ orderDate: 1, orderNo: 1 }).toArray();
});

const { ctx } = await loadResolverContext();
const categoryRowsForDate = itemsForDate.map((item) => ({ ...item, category: resolveStoredItemCategory(item, ctx) }));
const categoryRowsForRange = itemsForRange.map((item) => ({ ...item, category: resolveStoredItemCategory(item, ctx) }));

const itemBufDate = await buildOlseraItemWorkbook({ start: DATE, end: DATE, rows: itemsForDate });
const itemBufRange = await buildOlseraItemWorkbook({ start: RANGE_START, end: RANGE_END, rows: itemsForRange });
const catBufDate = await buildOlseraCategoryWorkbook({ start: DATE, end: DATE, rows: categoryRowsForDate });
const catBufRange = await buildOlseraCategoryWorkbook({ start: RANGE_START, end: RANGE_END, rows: categoryRowsForRange });

writeFileSync(`Rincian Penjualan-${DATE}__${DATE}.xlsx`, itemBufDate);
writeFileSync(`Rincian Penjualan-${RANGE_START}__${RANGE_END}.xlsx`, itemBufRange);
writeFileSync(`Kategori Penjualan-${DATE}__${DATE}.xlsx`, catBufDate);
writeFileSync(`Kategori Penjualan-${RANGE_START}__${RANGE_END}.xlsx`, catBufRange);
console.log("\nWorkbook ditulis untuk tanggal & rentang yang mencakup transaksi uji.");

// ---- 4. Validasi Export Rincian Penjualan (per order, satu sheet per tanggal) ----
async function validateItemWorkbook(buffer: Uint8Array, label: string, expectedSheetCount: number) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  check(`${label}: jumlah sheet tidak berubah (1 sheet per tanggal bertransaksi)`, wb.worksheets.length === expectedSheetCount, `${wb.worksheets.length} sheet`);

  const ws = wb.worksheets.find((sheet) => {
    for (let r = 1; r <= sheet.rowCount; r++) {
      if (String(sheet.getCell(r, 1).value ?? "") === target.orderNo) return true;
    }
    return false;
  });
  check(`${label}: sheet berisi order ${target.orderNo} ditemukan`, Boolean(ws));
  if (!ws) return;

  let orderRow = -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    if (String(ws.getCell(r, 1).value ?? "") === target.orderNo) {
      orderRow = r;
      break;
    }
  }
  const orderItemsInDb = (label.includes("range") ? itemsForRange : itemsForDate).filter((it) => it.orderNo === target.orderNo);
  const expectedAddonSum = orderItemsInDb.reduce((sum, it) => sum + (it.addonPrice ?? 0), 0);
  const expectedAmountSum = orderItemsInDb.reduce((sum, it) => sum + it.amount, 0);
  const expectedCostSum = orderItemsInDb.reduce((sum, it) => sum + it.costAmount, 0);

  const totalPenjualan = cellNumber(ws.getCell(orderRow, 9).value); // I
  const addonCell = cellNumber(ws.getCell(orderRow, 11).value); // K (baru)
  const modalCell = cellNumber(ws.getCell(orderRow, 13).value); // M (baru, was L)
  const labaCell = cellNumber(ws.getCell(orderRow, 15).value); // O (baru, was N)

  check(`${label}: header K4 = "Add-on Price"`, String(ws.getCell(4, 11).value) === "Add-on Price");
  check(`${label}: kolom Add-on Price numerik`, typeof ws.getCell(orderRow, 11).value === "number", `typeof=${typeof ws.getCell(orderRow, 11).value}`);
  check(`${label}: Add-on Price = SUM(addonPrice item order)`, Math.abs(addonCell - expectedAddonSum) < 0.01, `sheet=${addonCell}, expected=${expectedAddonSum}`);
  check(`${label}: Total Penjualan TETAP = amount (tidak berubah)`, Math.abs(totalPenjualan - expectedAmountSum) < 0.01, `sheet=${totalPenjualan}, expected=${expectedAmountSum}`);
  check(`${label}: Modal Produk TETAP`, Math.abs(modalCell - expectedCostSum) < 0.01, `sheet=${modalCell}, expected=${expectedCostSum}`);
  check(`${label}: Laba TETAP = Total Penjualan - Modal (bukan +addon)`, Math.abs(labaCell - (expectedAmountSum - expectedCostSum)) < 0.01, `sheet=${labaCell}, expected=${expectedAmountSum - expectedCostSum}`);
  check(`${label}: TIDAK ADA double count (Total Penjualan != amount+addon)`, Math.abs(totalPenjualan - (expectedAmountSum + expectedAddonSum)) > 0.01 || expectedAddonSum === 0);

  // Baris total sheet: numFmt IDR pada Add-on Price, tanpa formula error, tanpa #######.
  let totalRow = -1;
  for (let r = ws.rowCount; r >= 1; r--) {
    if (String(ws.getCell(r, 1).value ?? "") === "Total - IDR") {
      totalRow = r;
      break;
    }
  }
  check(`${label}: baris total ditemukan`, totalRow > 0);
  if (totalRow > 0) {
    const totalAddonCell = ws.getCell(totalRow, 11);
    check(`${label}: total Add-on Price numerik & tidak error`, typeof cellNumber(totalAddonCell.value) === "number" && !Number.isNaN(cellNumber(totalAddonCell.value)));
    check(`${label}: format IDR pada Add-on Price`, totalAddonCell.numFmt === '"IDR" #,##0');
    const width11 = ws.getColumn(11).width ?? 0;
    check(`${label}: lebar kolom Add-on Price cukup (tanpa #######)`, width11 >= 10, `width=${width11}`);
  }
}

const dateSheetCountItem = new Set(itemsForDate.map((it) => it.date)).size;
const rangeSheetCountItem = new Set(itemsForRange.map((it) => it.date)).size;
await validateItemWorkbook(itemBufDate, "Rincian Penjualan (satu tanggal)", dateSheetCountItem);
await validateItemWorkbook(itemBufRange, "Rincian Penjualan (rentang, contains range)", rangeSheetCountItem);

// ---- 5. Validasi Export Kategori Penjualan (per item, satu baris per item) ----
async function validateCategoryWorkbook(buffer: Uint8Array, label: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const targetCategory = categoryRowsForRange.find((r) => r._id === target._id)?.category ?? categoryRowsForDate.find((r) => r._id === target._id)?.category;
  check(`${label}: kategori transaksi uji ditemukan`, Boolean(targetCategory), `category=${targetCategory}`);
  const ws = wb.worksheets.find((s) => s.name === targetCategory || (targetCategory && s.name.startsWith(targetCategory.slice(0, 25))));
  check(`${label}: sheet kategori "${targetCategory}" ditemukan`, Boolean(ws));
  if (!ws) return;

  let itemRow = -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    if (String(ws.getCell(r, 1).value ?? "") === target.orderNo && String(ws.getCell(r, 7).value ?? "") === target.itemName) {
      itemRow = r;
      break;
    }
  }
  check(`${label}: baris item ditemukan`, itemRow > 0);
  if (itemRow < 0) return;

  const totalPesanan = cellNumber(ws.getCell(itemRow, 10).value); // J
  const addonCell = cellNumber(ws.getCell(itemRow, 11).value); // K (baru)
  const modalCell = cellNumber(ws.getCell(itemRow, 13).value); // M (baru, was L)
  const labaCell = cellNumber(ws.getCell(itemRow, 17).value); // Q (baru, was P)

  check(`${label}: header K4 = "Add-on Price"`, String(ws.getCell(2, 11).value) === "Add-on Price");
  check(`${label}: kolom Add-on Price numerik`, typeof ws.getCell(itemRow, 11).value === "number");
  check(`${label}: Add-on Price = addonPrice item (bukan agregasi order)`, Math.abs(addonCell - storedAddonPrice) < 0.01, `sheet=${addonCell}, expected=${storedAddonPrice}`);
  check(`${label}: Total Pesanan TETAP = amount`, Math.abs(totalPesanan - target.amount) < 0.01, `sheet=${totalPesanan}, expected=${target.amount}`);
  check(`${label}: Modal Produk TETAP`, Math.abs(modalCell - target.costAmount) < 0.01);
  check(`${label}: Laba TETAP = Total Pesanan - Modal (bukan +addon)`, Math.abs(labaCell - (target.amount - target.costAmount)) < 0.01, `sheet=${labaCell}`);
  check(`${label}: TIDAK ADA double count`, Math.abs(totalPesanan - (target.amount + storedAddonPrice)) > 0.01 || storedAddonPrice === 0);
}

await validateCategoryWorkbook(catBufDate, "Kategori Penjualan (satu tanggal)");
await validateCategoryWorkbook(catBufRange, "Kategori Penjualan (rentang)");

// ---- 6. Validasi total keseluruhan workbook (grand total) tidak berubah ----
async function validateGrandTotalUnchanged(buffer: Uint8Array, items: typeof itemsForDate, label: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  let grandAmount = 0;
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= ws.rowCount; r++) {
      if (String(ws.getCell(r, 1).value ?? "") === "Total - IDR") grandAmount += cellNumber(ws.getCell(r, 9).value);
    }
  }
  const expected = items.reduce((sum, it) => sum + it.amount, 0);
  check(`${label}: grand total Total Penjualan = SUM(amount) seluruh item (tidak berubah)`, Math.abs(grandAmount - expected) < 1, `workbook=${grandAmount}, expected=${expected}`);
}
await validateGrandTotalUnchanged(itemBufRange, itemsForRange, "Rincian Penjualan rentang");

await mongoClient.close().catch(() => undefined);
console.log(failures ? `\n${failures} check GAGAL` : "\nSemua check PASS");
process.exit(failures ? 1 : 0);
