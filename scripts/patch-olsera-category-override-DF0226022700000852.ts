// Patch SATU item transaksi Olsera yang tetap unresolved: konfirmasi langsung
// dari kasir bahwa item "Custom" (product_id 1) pada order DF0226022700000852
// (27 Februari 2026, catatan API: "Teh Hot") adalah MINUMAN.
//
// TIDAK membuat aturan global — override disimpan di olsera_category_overrides
// dengan kunci orderItemId (unique key baris item, BUKAN nama/product_id),
// sehingga item lain bernama "Custom" atau product_id 1 TIDAK ikut berubah
// (lihat priority 0 di lib/olsera-category-resolver.ts + test 0b/0c).
//
// Hanya menyentuh:
// - satu dokumen olsera_order_items (_id = orderItemId di bawah), field
//   resolusi kategori saja — qty/amount/costAmount/addonPrice/tanggal/jam/
//   orderNo TIDAK disentuh;
// - dua baris olsera_sales_by_category tanggal 2026-02-27 (kategori lama →
//   dikurangi; MINUMAN → ditambah) sebesar qty & amount item ini SAJA.
// Rerunnable & idempoten: run kedua mendeteksi override sudah terpasang dan
// tidak menulis apa pun (0 perubahan).
//
// Pakai: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/patch-olsera-category-override-DF0226022700000852.ts
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
const { UNKNOWN_CATEGORY } = await import("../lib/olsera-category-resolver.ts");

// ---- Identitas paling spesifik yang tersedia (semua dipakai sebagai guard) ----
const ORDER_ITEM_ID = 3110441219; // unique key baris item (olsera_order_items._id)
const ORDER_NO = "DF0226022700000852";
const DATE = "2026-02-27";
const ITEM_NAME = "Custom";
const PRODUCT_ID = 1;
const EXPECTED_QTY = 1;
const EXPECTED_AMOUNT = 20000;
const NEW_CATEGORY = "MINUMAN";
const REASON = "Confirmed directly with cashier";

console.log(`=== Patch kategori manual: order ${ORDER_NO}, item _id=${ORDER_ITEM_ID} ===\n`);

const item = await withMongo(async () => {
  const { olseraOrderItems } = await collections();
  return olseraOrderItems.findOne({ _id: ORDER_ITEM_ID });
});

if (!item) {
  console.error(`GAGAL: item _id=${ORDER_ITEM_ID} tidak ditemukan di olsera_order_items.`);
  await mongoClient.close().catch(() => undefined);
  process.exit(1);
}

// Guard: pastikan ini benar-benar item yang dimaksud SEBELUM menulis apa pun.
const mismatches: string[] = [];
if (item.orderNo !== ORDER_NO) mismatches.push(`orderNo: expected ${ORDER_NO}, got ${item.orderNo}`);
if (item.date !== DATE) mismatches.push(`date: expected ${DATE}, got ${item.date}`);
if (item.itemName !== ITEM_NAME) mismatches.push(`itemName: expected "${ITEM_NAME}", got "${item.itemName}"`);
if (item.productId !== PRODUCT_ID) mismatches.push(`productId: expected ${PRODUCT_ID}, got ${item.productId}`);
if (item.qty !== EXPECTED_QTY) mismatches.push(`qty: expected ${EXPECTED_QTY}, got ${item.qty}`);
if (item.amount !== EXPECTED_AMOUNT) mismatches.push(`amount: expected ${EXPECTED_AMOUNT}, got ${item.amount}`);
if (mismatches.length) {
  console.error("GAGAL: item tidak cocok dengan identitas yang diharapkan — tidak ada yang ditulis.");
  for (const m of mismatches) console.error(`  - ${m}`);
  await mongoClient.close().catch(() => undefined);
  process.exit(1);
}
console.log("PASS  Identitas item terverifikasi (orderNo, date, itemName, productId, qty, amount cocok).");

// ---- Idempotency guard: sudah pernah di-patch? ----
const existingOverride = await withMongo(async () => {
  const { olseraCategoryOverrides } = await collections();
  return olseraCategoryOverrides.findOne({ _id: ORDER_ITEM_ID });
});

const alreadyApplied =
  item.categoryResolutionMethod === "manual_override" &&
  item.categoryResolutionStatus === "resolved" &&
  item.resolvedCategoryName === NEW_CATEGORY &&
  existingOverride?.category === NEW_CATEGORY;

if (alreadyApplied) {
  console.log("\nSTATUS: sudah diterapkan sebelumnya — 0 perubahan (idempoten).");
  const cat = await withMongo(async () => {
    const { olseraSalesByCategory } = await collections();
    return olseraSalesByCategory.find({ date: DATE }).toArray();
  });
  const minuman = cat.find((c) => c.category === NEW_CATEGORY);
  console.log(`MINUMAN ${DATE}: qty=${minuman?.qty}, totalAmount=${minuman?.totalAmount}`);
  await mongoClient.close().catch(() => undefined);
  process.exit(0);
}

const OLD_CATEGORY = item.categoryResolutionStatus === "resolved" && item.resolvedCategoryName ? item.resolvedCategoryName : UNKNOWN_CATEGORY;
console.log(`Kategori lama (sebelum patch): ${OLD_CATEGORY} (status=${item.categoryResolutionStatus})`);
console.log(`Kategori baru                : ${NEW_CATEGORY}\n`);

const now = new Date();

await withMongo(async () => {
  const { olseraCategoryOverrides, olseraOrderItems, olseraSalesByCategory } = await collections();

  // 1. Override PER ITEM (unique key = orderItemId) — bertahan lintas resync/backfill.
  await olseraCategoryOverrides.updateOne(
    { _id: ORDER_ITEM_ID },
    {
      $set: { orderNo: ORDER_NO, date: DATE, itemName: ITEM_NAME, productId: PRODUCT_ID, category: NEW_CATEGORY, reason: REASON },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  console.log("OK  olsera_category_overrides upserted.");

  // 2. Field resolusi pada item itu sendiri SAJA — qty/amount/costAmount/addonPrice/
  //    tanggal/jam/orderNo tidak disentuh (filter menyertakan semuanya sebagai guard).
  const itemUpdate = await olseraOrderItems.updateOne(
    { _id: ORDER_ITEM_ID, orderNo: ORDER_NO, date: DATE, itemName: ITEM_NAME, productId: PRODUCT_ID, qty: EXPECTED_QTY, amount: EXPECTED_AMOUNT },
    {
      $set: {
        resolvedCategoryName: NEW_CATEGORY,
        resolvedCategoryId: null,
        resolvedProductId: item.productId ?? null,
        categoryResolutionMethod: "manual_override",
        categoryResolutionStatus: "resolved",
        categoryResolutionReason: REASON,
        resolvedAt: now,
      },
    },
  );
  console.log(`OK  olsera_order_items._id=${ORDER_ITEM_ID} diperbarui (matched=${itemUpdate.matchedCount}, modified=${itemUpdate.modifiedCount}).`);

  // 3. Pindahkan qty & amount item ini SAJA antar-bucket agregat harian.
  //    costAmount item ini = 0, jadi ikut dipindah untuk konsistensi (tidak berefek numerik).
  await olseraSalesByCategory.updateOne(
    { date: DATE, category: NEW_CATEGORY },
    { $inc: { qty: item.qty, totalAmount: item.amount, costAmount: item.costAmount }, $set: { syncedAt: now } },
    { upsert: true },
  );
  console.log(`OK  ${NEW_CATEGORY} ${DATE}: qty +${item.qty}, totalAmount +${item.amount}.`);

  const oldDoc = await olseraSalesByCategory.findOneAndUpdate(
    { date: DATE, category: OLD_CATEGORY },
    { $inc: { qty: -item.qty, totalAmount: -item.amount, costAmount: -item.costAmount }, $set: { syncedAt: now } },
    { returnDocument: "after" },
  );
  if (oldDoc && oldDoc.qty <= 0 && Math.abs(oldDoc.totalAmount) < 0.01) {
    // Bucket lama sekarang kosong (item ini satu-satunya penghuninya) — hapus
    // SATU dokumen spesifik ini saja (bukan hapus massal per tanggal/kategori lain).
    await olseraSalesByCategory.deleteOne({ _id: oldDoc._id });
    console.log(`OK  ${OLD_CATEGORY} ${DATE}: qty -${item.qty}, totalAmount -${item.amount} → bucket kosong, dihapus.`);
  } else if (oldDoc) {
    console.log(`OK  ${OLD_CATEGORY} ${DATE}: qty -${item.qty}, totalAmount -${item.amount} (sisa qty=${oldDoc.qty}, amount=${oldDoc.totalAmount}).`);
  }
});

// ---- Verifikasi hasil ----
const after = await withMongo(async () => {
  const { olseraOrderItems, olseraSalesByCategory } = await collections();
  const [patchedItem, categories, unresolvedCount] = await Promise.all([
    olseraOrderItems.findOne({ _id: ORDER_ITEM_ID }),
    olseraSalesByCategory.find({ date: DATE }).toArray(),
    olseraOrderItems.countDocuments({ date: DATE, categoryResolutionStatus: "unresolved" }),
  ]);
  const dayTotals = categories.reduce((acc, c) => ({ qty: acc.qty + c.qty, amount: acc.amount + c.totalAmount }), { qty: 0, amount: 0 });
  return { patchedItem, categories, unresolvedCount, dayTotals };
});

console.log("\n=== Hasil ===");
console.log(`Item _id=${ORDER_ITEM_ID}: resolvedCategoryName=${after.patchedItem?.resolvedCategoryName}, method=${after.patchedItem?.categoryResolutionMethod}, status=${after.patchedItem?.categoryResolutionStatus}, reason="${after.patchedItem?.categoryResolutionReason}", resolvedAt=${after.patchedItem?.resolvedAt?.toISOString()}`);
console.log(`Unresolved tersisa tanggal ${DATE}: ${after.unresolvedCount}`);
console.log(`Kategori tanggal ${DATE}:`);
for (const c of after.categories.sort((a, b) => a.category.localeCompare(b.category))) {
  console.log(`  ${c.category.padEnd(15)} qty=${c.qty}  totalAmount=${c.totalAmount}`);
}
console.log(`Total tanggal ${DATE}: qty=${after.dayTotals.qty}, amount=${after.dayTotals.amount}`);

await mongoClient.close().catch(() => undefined);
