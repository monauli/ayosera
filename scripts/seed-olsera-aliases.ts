// Seed alias produk Olsera terverifikasi (rerunnable, upsert).
//
// Kasus terbukti dari investigasi Juni 2026: product_id lama 106743815
// ("YONEX SHORTS MEN # SM-J035-2906-RW1-S") dihapus dari katalog dan diganti
// product_id baru 118420650 ("... duplicate", klasifikasi CELANA PRIA).
// Script ini MEMVERIFIKASI klaim tersebut terhadap katalog aktif sebelum
// menulis alias — tidak menebak ID pengganti.
//
// Pakai: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/seed-olsera-aliases.ts
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
const { loadResolverContext } = await import("../lib/olsera-resolver-context.ts");
const { normalizeName } = await import("../lib/olsera-category-resolver.ts");

// Kandidat alias dari investigasi. new_product_id akan DIVERIFIKASI terhadap
// katalog aktif; alias hanya ditulis bila produk baru benar-benar ada.
const CANDIDATES = [
  {
    oldProductId: 106743815,
    oldName: "YONEX SHORTS MEN # SM-J035-2906-RW1-S",
    newProductId: 118420650,
    source: "manual-verified",
  },
  // 106743802 diperiksa tetapi TIDAK dialiaskan bila masih ada di katalog aktif
  // (probe 2026-07-14: masih ada, klasifikasi CELANA PRIA, published=0).
  {
    oldProductId: 106743802,
    oldName: "YONEX MENS SHORTS # SM-P061-3085-RW2-S",
    newProductId: null as number | null,
    source: "manual-verified",
  },
];

const { ctx } = await loadResolverContext({ forceRefresh: true });

let written = 0;
for (const candidate of CANDIDATES) {
  const stillActive = ctx.byProductId.get(candidate.oldProductId);
  if (stillActive) {
    console.log(
      `SKIP  ${candidate.oldProductId} ("${candidate.oldName}") masih ada di katalog aktif ` +
        `(klasifikasi "${stillActive.category}") — alias tidak diperlukan.`,
    );
    continue;
  }
  if (candidate.newProductId === null) {
    console.log(`SKIP  ${candidate.oldProductId}: tidak ada ID pengganti terverifikasi dan produk hilang dari katalog.`);
    continue;
  }
  const target = ctx.byProductId.get(candidate.newProductId);
  if (!target) {
    console.log(`GAGAL ${candidate.oldProductId}: ID pengganti ${candidate.newProductId} tidak ditemukan di katalog aktif — alias TIDAK ditulis.`);
    continue;
  }
  await withMongo(async () => {
    const { olseraProductAliases } = await collections();
    const now = new Date();
    await olseraProductAliases.updateOne(
      { _id: `${candidate.oldProductId}:0` },
      {
        $set: {
          oldProductId: candidate.oldProductId,
          newProductId: candidate.newProductId,
          oldVariantId: null,
          newVariantId: null,
          sku: null,
          normalizedName: normalizeName(candidate.oldName),
          categoryId: target.categoryId,
          categoryName: target.category,
          source: candidate.source,
          confidence: "verified" as const,
          verifiedAt: now,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  });
  written++;
  console.log(
    `OK    alias ${candidate.oldProductId} → ${candidate.newProductId} ` +
      `(kategori "${target.category}" dari katalog, nama lama "${candidate.oldName}")`,
  );
}

const total = await withMongo(async () => {
  const { olseraProductAliases } = await collections();
  return olseraProductAliases.countDocuments();
});
console.log(`\nSelesai: ${written} alias ditulis/diperbarui, total alias di DB: ${total}.`);
await mongoClient.close().catch(() => undefined);
