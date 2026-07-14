// Validasi hasil backfill mapping kategori (read-only).
// Target (fakta laporan resmi Olsera):
// - Juni 2026: total qty 3.272, total Rp148.182.000; CELANA PRIA qty 6 / Rp720.000; tanpa "Tidak Diketahui".
// - 14 Mei 2026: dua item produk lama 106743815 → CELANA PRIA.
// - Inventori: total stok & nilai persediaan tidak berubah.
//
// Pakai: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/validate-olsera-category-mapping.ts
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

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

await withMongo(async () => {
  const { olseraSalesByCategory, olseraOrderItems, olseraInventoryProducts } = await collections();

  // ---- Juni 2026 ----
  const june = await olseraSalesByCategory
    .aggregate<{ _id: string; qty: number; amount: number }>([
      { $match: { date: { $gte: "2026-06-01", $lte: "2026-06-30" } } },
      { $group: { _id: "$category", qty: { $sum: "$qty" }, amount: { $sum: "$totalAmount" } } },
    ])
    .toArray();
  const juneTotalQty = june.reduce((s, r) => s + r.qty, 0);
  const juneTotalAmount = june.reduce((s, r) => s + r.amount, 0);
  const juneCelana = june.find((r) => r._id === "CELANA PRIA");
  const juneUnknown = june.find((r) => r._id === "Tidak Diketahui");

  console.log("=== Juni 2026 (dashboard/olsera_sales_by_category) ===");
  check("Total Qty Juni = 3.272", juneTotalQty === 3272, `qty=${juneTotalQty}`);
  check("Total Penjualan Juni = Rp148.182.000", juneTotalAmount === 148182000, `amount=${juneTotalAmount}`);
  check("CELANA PRIA Juni qty = 6", juneCelana?.qty === 6, `qty=${juneCelana?.qty ?? 0}`);
  check("CELANA PRIA Juni = Rp720.000", juneCelana?.amount === 720000, `amount=${juneCelana?.amount ?? 0}`);
  check("Tidak Diketahui Juni sudah hilang", !juneUnknown, juneUnknown ? `masih qty=${juneUnknown.qty}` : "");

  // ---- Mei 2026 (14 Mei: dua item produk lama 106743815) ----
  const mayItems = await olseraOrderItems.find({ _id: { $in: [3334826689, 3334900012] } }).toArray();
  console.log("\n=== 14 Mei 2026 (dua item produk lama) ===");
  for (const item of mayItems) {
    check(
      `Item ${item._id} (${item.date}, "${item.itemName}") → CELANA PRIA via alias`,
      item.resolvedCategoryName === "CELANA PRIA" && item.categoryResolutionMethod === "alias",
      `resolved=${item.resolvedCategoryName}, method=${item.categoryResolutionMethod}, qty=${item.qty}, amount=${item.amount}`,
    );
  }
  const may14 = await olseraSalesByCategory.find({ date: "2026-05-14" }).toArray();
  const may14Celana = may14.find((r) => r.category === "CELANA PRIA");
  const may14Unknown = may14.find((r) => r.category === "Tidak Diketahui");
  check("Agregat 14 Mei: CELANA PRIA qty 2 / Rp240.000", may14Celana?.qty === 2 && may14Celana?.totalAmount === 240000,
    `qty=${may14Celana?.qty ?? 0}, amount=${may14Celana?.totalAmount ?? 0}`);
  check("Agregat 14 Mei: Tidak Diketahui hilang", !may14Unknown);

  // ---- Seluruh DB: tidak ada lagi agregat/item Tidak Diketahui ----
  const unknownRows = await olseraSalesByCategory.countDocuments({ category: "Tidak Diketahui" });
  const unresolvedItems = await olseraOrderItems.countDocuments({ categoryResolutionStatus: "unresolved" });
  console.log("\n=== Seluruh database ===");
  check("Baris agregat 'Tidak Diketahui' = 0", unknownRows === 0, `rows=${unknownRows}`);
  check("Item unresolved = 0", unresolvedItems === 0, `items=${unresolvedItems}`);

  // ---- Inventori tidak berubah ----
  const invDocs = await olseraInventoryProducts.find({ trackInventory: true }).toArray();
  const stock = invDocs.reduce((s, d) => s + d.stockQty, 0);
  const value = invDocs.reduce((s, d) => s + d.stockQty * d.buyPrice, 0);
  console.log("\n=== Inventori ===");
  check("Total stok = 3.262", stock === 3262, `stok=${stock}`);
  check("Total nilai persediaan ≈ Rp82.049.013", Math.abs(value - 82049012.89) < 1, `nilai=${value.toFixed(2)}`);
});

await mongoClient.close().catch(() => undefined);
console.log(failures ? `\n${failures} check GAGAL` : "\nSemua check PASS");
process.exit(failures ? 1 : 0);
