// Approved, narrowly scoped production correction for February 2026.
// Writes only olsera_sales_corrections, the one approved Custom item/category
// override, and the February olsera_sales_by_category rebuild. Never writes
// inventory collections and never touches other months.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

for (const fileName of [".env.local", ".env"]) {
  const filePath = path.join(process.cwd(), fileName);
  if (!existsSync(filePath)) continue;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

const { collections, withMongo, mongoClient } = await import("../lib/mongodb.ts");
const { FEBRUARY_2026_CORRECTIONS } = await import("../lib/olsera-sales-corrections.ts");

const START = "2026-02-01";
const END = "2026-02-28";
const CUSTOM_ID = 3110441219;
const now = new Date();

const result = await withMongo(async () => {
  const { olseraOrderItems, olseraCategoryOverrides, olseraSalesCorrections, olseraSalesByCategory } = await collections();
  const custom = await olseraOrderItems.findOne({ _id: CUSTOM_ID });
  if (!custom || custom.orderNo !== "DF0226022700000852" || custom.date !== "2026-02-27" || custom.itemName !== "Custom" || custom.qty !== 1 || custom.amount !== 20000) {
    throw new Error("Guard gagal: item Custom approved tidak cocok; tidak ada write dilakukan.");
  }

  const customCategory = custom.resolvedCategoryName;
  const customOverride = await olseraCategoryOverrides.findOne({ _id: CUSTOM_ID });
  await olseraCategoryOverrides.updateOne(
    { _id: CUSTOM_ID },
    { $set: { orderNo: custom.orderNo, date: custom.date, itemName: custom.itemName, productId: custom.productId ?? null, category: "CUSTOM", reason: "Official Olsera export / manual-verified", updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  await olseraOrderItems.updateOne(
    { _id: CUSTOM_ID, orderNo: custom.orderNo, date: custom.date, itemName: custom.itemName, qty: 1, amount: 20000 },
    { $set: { resolvedCategoryName: "CUSTOM", resolvedCategoryId: null, resolvedProductId: custom.productId ?? null, categoryResolutionMethod: "manual_override", categoryResolutionStatus: "resolved", categoryResolutionReason: "Official Olsera export / manual-verified", resolvedAt: custom.resolvedAt ?? now } },
  );

  for (const correction of FEBRUARY_2026_CORRECTIONS) {
    await olseraSalesCorrections.updateOne(
      { _id: correction._id },
      { $set: { ...correction, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  }

  const [items, corrections] = await Promise.all([
    olseraOrderItems.find({ date: { $gte: START, $lte: END } }).toArray(),
    olseraSalesCorrections.find({ date: { $gte: START, $lte: END } }).toArray(),
  ]);
  const byDateCategory = new Map<string, { date: string; category: string; qty: number; totalAmount: number; costAmount: number }>();
  const add = (date: string, category: string, qty: number, amount: number, costAmount = 0) => {
    const key = `${date}|${category}`;
    const entry = byDateCategory.get(key) ?? { date, category, qty: 0, totalAmount: 0, costAmount: 0 };
    entry.qty += qty; entry.totalAmount += amount; entry.costAmount += costAmount; byDateCategory.set(key, entry);
  };
  for (const item of items) add(item.date, item.resolvedCategoryName ?? "Tidak Diketahui", item.qty, item.amount, item.costAmount);
  for (const correction of corrections) add(correction.date, correction.category, correction.qty, correction.amount);

  await olseraSalesByCategory.deleteMany({ date: { $gte: START, $lte: END } });
  await olseraSalesByCategory.insertMany([...byDateCategory.values()].map((entry) => ({ ...entry, syncedAt: now })));

  const final = await olseraSalesByCategory.aggregate([
    { $match: { date: { $gte: START, $lte: END } } },
    { $group: { _id: "$category", qty: { $sum: "$qty" }, amount: { $sum: "$totalAmount" } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  return { customCategory, customOverrideCategory: customOverride?.category ?? null, correctionCount: corrections.length, final };
});

console.log(JSON.stringify(result, null, 2));
await mongoClient.close();
