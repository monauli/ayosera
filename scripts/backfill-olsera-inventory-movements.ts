// Backfill mutasi Inventori Olsera ("penjualan", turunan olsera_order_items)
// untuk tanggal SEBELUM checkpoint lama — dibutuhkan saat baseline dimundurkan
// (mis. dari 1 Mei ke 1 Februari 2026): startInventorySync() hanya sync maju
// dari checkpoint (lastSyncedDate - 1 hari), sehingga tanggal sebelum checkpoint
// lama tidak pernah ditarik ulang tanpa skrip ini.
//
// Hanya mengisi koleksi olsera_inventory_movements (upsert, _id deterministik
// `sale:${orderItemId}`) dan field earliestAvailableDate pada olsera_inventory_state.
// TIDAK PERNAH menyentuh stockQty/buyPrice/olsera_inventory_products (katalog &
// stok saat ini tidak berubah), TIDAK menyentuh lastSyncedDate/lastSuccessfulSyncAt
// (checkpoint incremental forward tetap seperti semula).
//
// Pakai: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/backfill-olsera-inventory-movements.ts
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
const { runMovementDate, refreshInventoryEarliestAvailableDate, getInventorySyncStatus } = await import(
  "../lib/olsera-inventory.ts"
);
const { addDays } = await import("../lib/olsera-sync.ts");
const { OLSERA_INVENTORY_BASELINE_DATE } = await import("../lib/olsera-baseline.ts");

console.log("=== Backfill Mutasi Inventori Olsera (gap sebelum checkpoint lama) ===");

const statusBefore = await getInventorySyncStatus();
console.log(`earliestAvailableDate sebelum: ${statusBefore.state.earliestAvailableDate ?? "(belum ada)"}`);
console.log(`Baseline inventori target    : ${OLSERA_INVENTORY_BASELINE_DATE}`);

const invBefore = await withMongo(async () => {
  const { olseraInventoryProducts } = await collections();
  const docs = await olseraInventoryProducts.find({ trackInventory: true }).toArray();
  return {
    stock: docs.reduce((s, d) => s + d.stockQty, 0),
    value: docs.reduce((s, d) => s + d.stockQty * d.buyPrice, 0),
    productCount: docs.length,
  };
});
console.log(`Inventori sebelum: produk=${invBefore.productCount}, stok=${invBefore.stock}, nilai=${invBefore.value.toFixed(2)}\n`);

const gapEnd = statusBefore.state.earliestAvailableDate;
if (!gapEnd || gapEnd <= OLSERA_INVENTORY_BASELINE_DATE) {
  console.log("Tidak ada gap — earliestAvailableDate sudah di baseline atau lebih awal. Tidak ada yang perlu di-backfill.");
  await mongoClient.close().catch(() => undefined);
  process.exit(0);
}

const gapEndExclusive = addDays(gapEnd, -1);
const dates: string[] = [];
for (let d = OLSERA_INVENTORY_BASELINE_DATE; d <= gapEndExclusive; d = addDays(d, 1)) dates.push(d);
console.log(`Mengisi mutasi untuk ${dates.length} tanggal: ${OLSERA_INVENTORY_BASELINE_DATE} s/d ${gapEndExclusive}\n`);

let totalMovements = 0;
let totalCreated = 0;
let totalUpdated = 0;
for (const date of dates) {
  const result = await runMovementDate(date);
  totalMovements += result.movements;
  totalCreated += result.created;
  totalUpdated += result.updated;
  if (result.movements > 0) {
    console.log(`  ${date}: ${result.movements} mutasi (created=${result.created}, updated=${result.updated})`);
  }
}

await refreshInventoryEarliestAvailableDate({ advanceCheckpointTo: null });

const statusAfter = await getInventorySyncStatus();
const invAfter = await withMongo(async () => {
  const { olseraInventoryProducts } = await collections();
  const docs = await olseraInventoryProducts.find({ trackInventory: true }).toArray();
  return {
    stock: docs.reduce((s, d) => s + d.stockQty, 0),
    value: docs.reduce((s, d) => s + d.stockQty * d.buyPrice, 0),
    productCount: docs.length,
  };
});

console.log("\n=== Ringkasan ===");
console.log(`Total mutasi diperiksa : ${totalMovements}`);
console.log(`  - dibuat baru        : ${totalCreated}`);
console.log(`  - diperbarui         : ${totalUpdated}`);
console.log(`earliestAvailableDate sesudah: ${statusAfter.state.earliestAvailableDate ?? "(tidak ada)"}`);
console.log(`Inventori sesudah: produk=${invAfter.productCount}, stok=${invAfter.stock}, nilai=${invAfter.value.toFixed(2)}`);
console.log(
  invAfter.stock === invBefore.stock && invAfter.productCount === invBefore.productCount && Math.abs(invAfter.value - invBefore.value) < 0.01
    ? "PASS  Katalog produk, stok saat ini, dan nilai persediaan TIDAK berubah."
    : "FAIL  Katalog/stok/nilai persediaan berubah — periksa!",
);

await mongoClient.close().catch(() => undefined);
