// Backfill kategori item Olsera sejak baseline (lib/olsera-baseline.ts, rerunnable, idempoten).
//
// Yang dilakukan:
// 1. Setiap dokumen olsera_order_items pada rentang di-resolve ulang dengan
//    canonical resolver (katalog aktif + alias + histori) dan field identitas/
//    resolusi kategorinya diperbarui. Qty, nominal, orderNo, waktu TIDAK disentuh.
// 2. Agregat olsera_sales_by_category per tanggal dibangun ulang dari item —
//    HANYA bila total qty & nominal tanggal itu identik dengan agregat lama
//    (menjamin total tidak berubah); perubahan per kategori dicatat.
//
// Pakai: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/backfill-olsera-categories.ts [START] [END]
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
const { loadResolverContext, identityFromStoredItem } = await import("../lib/olsera-resolver-context.ts");
const { resolveItemCategory, normalizeName, UNKNOWN_CATEGORY } = await import("../lib/olsera-category-resolver.ts");
const { OLSERA_SALES_BASELINE_DATE } = await import("../lib/olsera-baseline.ts");

const START = process.argv[2] ?? OLSERA_SALES_BASELINE_DATE;
const END =
  process.argv[3] ??
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

console.log(`Backfill kategori Olsera: ${START} s/d ${END}\n`);

// Snapshot totals Inventori SEBELUM — bukti backfill tidak menyentuh inventori.
async function inventoryTotals() {
  return withMongo(async () => {
    const { olseraInventoryProducts } = await collections();
    const docs = await olseraInventoryProducts.find({ trackInventory: true }).toArray();
    const stock = docs.reduce((s, d) => s + d.stockQty, 0);
    const value = docs.reduce((s, d) => s + d.stockQty * d.buyPrice, 0);
    return { stock, value };
  });
}
const invBefore = await inventoryTotals();
console.log(`Inventori sebelum: total stok=${invBefore.stock}, nilai persediaan=${invBefore.value.toFixed(2)}`);

const { ctx } = await loadResolverContext({ forceRefresh: true });

// ---- Tahap 1: resolusi ulang identitas & kategori per item ----
const { items } = await withMongo(async () => {
  const { olseraOrderItems } = await collections();
  return { items: await olseraOrderItems.find({ date: { $gte: START, $lte: END } }).toArray() };
});
console.log(`\nTahap 1 — item dipindai: ${items.length}`);

let itemsUpdated = 0;
let unresolvedCount = 0;
const categoryChangesByItem: string[] = [];
const bulkOps: { updateOne: { filter: { _id: number }; update: { $set: Record<string, unknown> } } }[] = [];

for (const item of items) {
  const resolution = resolveItemCategory(identityFromStoredItem(item), ctx);
  if (resolution.status === "unresolved") unresolvedCount++;
  const next = {
    normalizedItemName: normalizeName(item.itemName),
    resolvedProductId: resolution.resolvedProductId,
    resolvedCategoryId: resolution.categoryId,
    resolvedCategoryName: resolution.status === "resolved" ? resolution.category : null,
    categoryResolutionMethod: resolution.method,
    categoryResolutionStatus: resolution.status,
    categoryResolutionReason: resolution.reason,
    // resolvedAt hanya relevan untuk manual_override; pertahankan nilai lama
    // bila sudah ada agar rerun tidak terus menggeser waktunya (idempoten).
    ...(resolution.method === "manual_override" ? { resolvedAt: item.resolvedAt ?? new Date() } : {}),
  };
  const changed =
    item.normalizedItemName !== next.normalizedItemName ||
    item.resolvedProductId !== next.resolvedProductId ||
    item.resolvedCategoryName !== next.resolvedCategoryName ||
    item.categoryResolutionMethod !== next.categoryResolutionMethod ||
    item.categoryResolutionStatus !== next.categoryResolutionStatus;
  if (!changed) continue;
  if (item.resolvedCategoryName !== next.resolvedCategoryName) {
    categoryChangesByItem.push(
      `  [_id=${item._id}] ${item.date} "${item.itemName}" : ${item.resolvedCategoryName ?? "(belum ada)"} → ${
        next.resolvedCategoryName ?? UNKNOWN_CATEGORY
      } (method=${next.categoryResolutionMethod})`,
    );
  }
  itemsUpdated++;
  bulkOps.push({ updateOne: { filter: { _id: item._id }, update: { $set: next } } });
}
if (bulkOps.length) {
  await withMongo(async () => {
    const { olseraOrderItems } = await collections();
    await olseraOrderItems.bulkWrite(bulkOps);
  });
}
console.log(`Item diperbarui field resolusinya: ${itemsUpdated}; unresolved: ${unresolvedCount}`);
if (categoryChangesByItem.length) {
  console.log(`Perubahan kategori per item (${categoryChangesByItem.length}):`);
  for (const line of categoryChangesByItem.slice(0, 40)) console.log(line);
}

// ---- Tahap 2: rebuild agregat per tanggal (total qty & nominal wajib identik) ----
console.log("\nTahap 2 — rebuild agregat olsera_sales_by_category:");
const resultSummary = { rebuilt: 0, unchanged: 0, skippedMismatch: [] as string[], changes: [] as string[] };

const dates = [...new Set(items.map((it) => it.date))].sort();
for (const date of dates) {
  await withMongo(async () => {
    const { olseraOrderItems, olseraSalesByCategory } = await collections();
    const [dayItems, existingRows] = await Promise.all([
      olseraOrderItems.find({ date }).toArray(),
      olseraSalesByCategory.find({ date }).toArray(),
    ]);

    // Agregat baru dari item (kategori resolved; unresolved → Tidak Diketahui).
    const next = new Map<string, { qty: number; amount: number; costAmount: number }>();
    for (const item of dayItems) {
      const category = item.resolvedCategoryName ?? UNKNOWN_CATEGORY;
      const entry = next.get(category) ?? { qty: 0, amount: 0, costAmount: 0 };
      entry.qty += item.qty;
      entry.amount += item.amount;
      entry.costAmount += item.costAmount;
      next.set(category, entry);
    }

    const oldTotal = existingRows.reduce(
      (acc, row) => ({ qty: acc.qty + row.qty, amount: acc.amount + row.totalAmount }),
      { qty: 0, amount: 0 },
    );
    const newTotal = [...next.values()].reduce(
      (acc, row) => ({ qty: acc.qty + row.qty, amount: acc.amount + row.amount }),
      { qty: 0, amount: 0 },
    );

    // Guard total: agregat hanya ditulis ulang bila total tanggal TIDAK berubah.
    if (Math.abs(oldTotal.qty - newTotal.qty) > 0.001 || Math.abs(oldTotal.amount - newTotal.amount) > 0.01) {
      resultSummary.skippedMismatch.push(
        `${date}: item(qty=${newTotal.qty}, amount=${newTotal.amount}) != agregat(qty=${oldTotal.qty}, amount=${oldTotal.amount})`,
      );
      return;
    }

    // Deteksi perbedaan distribusi kategori.
    const oldByCategory = new Map(existingRows.map((row) => [row.category, row]));
    let differs = oldByCategory.size !== next.size;
    if (!differs) {
      for (const [category, agg] of next) {
        const old = oldByCategory.get(category);
        if (!old || Math.abs(old.qty - agg.qty) > 0.001 || Math.abs(old.totalAmount - agg.amount) > 0.01) {
          differs = true;
          break;
        }
      }
    }
    if (!differs) {
      resultSummary.unchanged++;
      return;
    }

    for (const [category, agg] of next) {
      const old = oldByCategory.get(category);
      if (!old || Math.abs(old.qty - agg.qty) > 0.001 || Math.abs(old.totalAmount - agg.amount) > 0.01) {
        resultSummary.changes.push(
          `  ${date} ${category}: ${old ? `qty ${old.qty}→${agg.qty}, Rp${old.totalAmount}→Rp${agg.amount}` : `BARU qty=${agg.qty}, Rp${agg.amount}`}`,
        );
      }
    }
    for (const [category, old] of oldByCategory) {
      if (!next.has(category)) resultSummary.changes.push(`  ${date} ${category}: DIHAPUS (qty ${old.qty}, Rp${old.totalAmount})`);
    }

    const syncedAt = new Date();
    await olseraSalesByCategory.bulkWrite(
      [...next.entries()].map(([category, agg]) => ({
        updateOne: {
          filter: { date, category },
          update: { $set: { qty: agg.qty, totalAmount: agg.amount, costAmount: agg.costAmount, syncedAt } },
          upsert: true,
        },
      })),
    );
    await olseraSalesByCategory.deleteMany({ date, category: { $nin: [...next.keys()] } });
    resultSummary.rebuilt++;
  });
}

console.log(`Tanggal dibangun ulang: ${resultSummary.rebuilt}; tidak berubah: ${resultSummary.unchanged}`);
if (resultSummary.changes.length) {
  console.log("Perubahan agregat (sebelum → sesudah):");
  for (const line of resultSummary.changes) console.log(line);
}
if (resultSummary.skippedMismatch.length) {
  console.log("PERINGATAN — tanggal dilewati (total item != total agregat, perlu resync):");
  for (const line of resultSummary.skippedMismatch) console.log(`  ${line}`);
}

const invAfter = await inventoryTotals();
console.log(`\nInventori sesudah: total stok=${invAfter.stock}, nilai persediaan=${invAfter.value.toFixed(2)}`);
console.log(
  invAfter.stock === invBefore.stock && Math.abs(invAfter.value - invBefore.value) < 0.01
    ? "PASS  Inventori tidak berubah."
    : "FAIL  Inventori berubah!",
);

// Daftar unresolved tersisa (audit).
const unresolvedLeft = await withMongo(async () => {
  const { olseraOrderItems } = await collections();
  return olseraOrderItems
    .find({ date: { $gte: START, $lte: END }, categoryResolutionStatus: "unresolved" })
    .project<{ _id: number; date: string; orderNo: string; itemName: string; categoryResolutionReason: string | null }>({
      date: 1,
      orderNo: 1,
      itemName: 1,
      categoryResolutionReason: 1,
    })
    .toArray();
});
console.log(`\nUnresolved tersisa pada rentang: ${unresolvedLeft.length}`);
for (const item of unresolvedLeft.slice(0, 20)) {
  console.log(`  ${item.date} ${item.orderNo} "${item.itemName}" — ${item.categoryResolutionReason ?? "-"}`);
}

await mongoClient.close().catch(() => undefined);
