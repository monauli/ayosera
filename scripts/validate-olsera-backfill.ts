// Validasi read-only pasca-backfill penjualan Olsera: laporan per bulan
// (Februari-Juli 2026) + bukti Inventori tidak tersentuh. TIDAK menulis apa pun.
//
// Pakai: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/validate-olsera-backfill.ts
import { existsSync, readFileSync } from "fs";
import path from "path";

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
const { todayJakarta, addDays } = await import("../lib/olsera-sync.ts");
const { OLSERA_SALES_BASELINE_DATE } = await import("../lib/olsera-baseline.ts");

const today = todayJakarta();

function monthRange(year: number, month: number): { start: string; end: string } | null {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let end = `${year}-${String(month).padStart(2, "0")}-${String(lastDayOfMonth).padStart(2, "0")}`;
  if (start > today) return null; // bulan belum dimulai
  if (end > today) end = today; // bulan berjalan: dipotong sampai hari ini
  return { start, end };
}

// Bulan Februari s/d bulan berjalan (turunan dari baseline, bukan hardcode).
const [baselineYear, baselineMonth] = OLSERA_SALES_BASELINE_DATE.split("-").map(Number);
const months: { label: string; start: string; end: string }[] = [];
for (let i = 0; i < 12; i++) {
  const y = baselineYear + Math.floor((baselineMonth - 1 + i) / 12);
  const m = ((baselineMonth - 1 + i) % 12) + 1;
  const range = monthRange(y, m);
  if (!range) break;
  months.push({
    label: new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(
      new Date(Date.UTC(y, m - 1, 1)),
    ),
    ...range,
  });
}

console.log("=== Validasi Backfill Penjualan Olsera per Bulan ===");
console.log(`Baseline: ${OLSERA_SALES_BASELINE_DATE}  |  Hari ini: ${today}\n`);

function eachDay(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  return dates;
}

const summaryRows: Record<string, unknown>[] = [];

for (const month of months) {
  const report = await withMongo(async () => {
    const { olseraOrderItems, olseraSyncedDays } = await collections();
    const items = await olseraOrderItems
      .find({ date: { $gte: month.start, $lte: month.end } })
      .project<{
        orderNo: string;
        qty: number;
        amount: number;
        addonPrice?: number;
        categoryResolutionStatus?: string;
      }>({ orderNo: 1, qty: 1, amount: 1, addonPrice: 1, categoryResolutionStatus: 1 })
      .toArray();

    const orderNos = new Set(items.map((i) => i.orderNo));
    const totalQty = items.reduce((sum, i) => sum + (i.qty ?? 0), 0);
    const totalAmount = items.reduce((sum, i) => sum + (i.amount ?? 0), 0);
    const addonPositive = items.filter((i) => (i.addonPrice ?? 0) > 0).length;
    const unresolved = items.filter((i) => i.categoryResolutionStatus === "unresolved").length;

    const syncedDates = new Set(
      (await olseraSyncedDays.find({ _id: { $gte: month.start, $lte: month.end } }, { projection: { _id: 1 } }).toArray()).map(
        (d) => d._id,
      ),
    );
    const failedDates = eachDay(month.start, month.end).filter((d) => !syncedDates.has(d));

    return {
      orders: orderNos.size,
      items: items.length,
      totalQty,
      totalAmount,
      addonPositive,
      unresolved,
      failedDates,
    };
  });

  console.log(`--- ${month.label} (${month.start} s/d ${month.end}) ---`);
  console.log(`  Jumlah order           : ${report.orders}`);
  console.log(`  Jumlah item            : ${report.items}`);
  console.log(`  Total qty              : ${report.totalQty}`);
  console.log(`  Total penjualan        : Rp${report.totalAmount.toLocaleString("id-ID")}`);
  console.log(`  Item addonPrice > 0    : ${report.addonPositive}`);
  console.log(`  Kategori unresolved    : ${report.unresolved}`);
  console.log(
    `  Tanggal belum tuntas   : ${report.failedDates.length}${report.failedDates.length ? ` (${report.failedDates.join(", ")})` : ""}`,
  );
  console.log("");
  summaryRows.push({ month: month.label, ...report });
}

// ---- Bukti Inventori tidak tersentuh oleh proses ini (read-only) ----
const inv = await withMongo(async () => {
  const { olseraInventoryProducts, olseraInventorySnapshots } = await collections();
  const products = await olseraInventoryProducts.find({ trackInventory: true }).toArray();
  const totalStock = products.reduce((s, p) => s + p.stockQty, 0);
  const totalValue = products.reduce((s, p) => s + p.stockQty * p.buyPrice, 0);
  const productCount = await olseraInventoryProducts.countDocuments();
  const duplicateProductIds = await olseraInventoryProducts
    .aggregate([{ $group: { _id: "$_id", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
    .toArray();
  const duplicateSnapshots = await olseraInventorySnapshots
    .aggregate([{ $group: { _id: "$_id", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
    .toArray();
  return { totalStock, totalValue, productCount, duplicateProductIds: duplicateProductIds.length, duplicateSnapshots: duplicateSnapshots.length };
});

console.log("=== Inventori (read-only, hanya laporan) ===");
console.log(`  Total produk tracked   : ${inv.productCount}`);
console.log(`  Total stok             : ${inv.totalStock}`);
console.log(`  Total nilai persediaan : Rp${inv.totalValue.toLocaleString("id-ID")}`);
console.log(`  Produk duplikat (_id)  : ${inv.duplicateProductIds} (harus 0 — _id unik per storeId:productId:variantId)`);
console.log(`  Snapshot duplikat (_id): ${inv.duplicateSnapshots} (harus 0 — _id unik per produk+tanggal)`);

const totalUnresolved = summaryRows.reduce((s, r) => s + (r.unresolved as number), 0);
const totalFailedDates = summaryRows.reduce((s, r) => s + (r.failedDates as string[]).length, 0);
const okDuplicates = inv.duplicateProductIds === 0 && inv.duplicateSnapshots === 0;

console.log("\n=== Ringkasan ===");
console.log(`Total kategori unresolved seluruh periode: ${totalUnresolved}`);
console.log(`Total tanggal belum tuntas seluruh periode: ${totalFailedDates}`);
console.log(okDuplicates ? "PASS  Tidak ada duplikat Inventori." : "FAIL  Ditemukan duplikat Inventori.");

await mongoClient.close().catch(() => undefined);
process.exit(totalFailedDates > 0 || !okDuplicates ? 1 : 0);
