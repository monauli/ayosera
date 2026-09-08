// Koreksi produksi bertarget, SEKALI JALAN, disetujui user (2026-09-08).
//
// Masalah: snapshot Juni 2026 untuk "YONEX SHORTS MEN # SM-J035-2906-RW1-S
// duplicate" (productId 118420650) berasal dari file baseline
// doc export/INVENTORI.xlsx sheet JUNI'26 — opening 4, sales 3, closing 1.
// Audit langsung ke Olsera Backoffice membuktikan produk ini NOL transaksi di
// Juni (baru masuk 3 Juli 2026, langsung terjual hari itu juga, sisa 0).
// Angka 1 dari file merambat ke Juli (opening 1) dan Agustus/September
// (carry-forward 1). Bulan <= Juni 2026 TIDAK PERNAH dihitung ulang dari API
// (guard isBackwardZone di lib/olsera-inventory-monthly-snapshot-store.ts),
// jadi rebuild biasa tidak bisa memperbaikinya — perlu koreksi eksplisit ini.
//
// Menulis TEPAT DUA hal, keduanya hanya untuk productId 118420650:
//   1. olsera_inventory_monthly_snapshots Juni 2026 -> seluruh ledger jadi 0.
//   2. inventory_stock_opname_reconciliations Juni 2026 -> DIHAPUS. Setelah
//      koreksi (1), keenam angka Juni jadi nol sehingga hasInventoryActivity
//      menyembunyikan baris sistemnya; baris BA dirender per baris sistem,
//      jadi dokumen fisik=1 itu akan jadi yatim (tak terlihat, tak bisa
//      diedit, tapi masih ada). Barangnya memang tidak ada di Juni, jadi
//      barisnya tidak seharusnya ada di BA Juni. Disetujui user 2026-09-08.
// Juli s/d September dibetulkan SETELAH ini lewat
// scripts/backfill-monthly-snapshot.ts --product-id=118420650 (rantai maju
// otomatis ikut turun ke 0). TIDAK PERNAH menyentuh produk lain, bulan lain,
// koleksi Berita Acara, atau bulan yang terkunci.
//
// Pola PERSIS scripts/targeted-inventory-correction-2026-08-19.ts: dijaga
// marker di olsera_inventory_state (idempoten, tidak bisa jalan dua kali),
// menolak periode terkunci, menyimpan dokumen "before" ke dalam marker
// sebagai backup, dan DEFAULT DRY-RUN — wajib --apply untuk menulis.
//
// Jalankan:
//   node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/correct-yonex-sm-j035-june-2026.ts
//   node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/correct-yonex-sm-j035-june-2026.ts --apply
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

const { collections, mongoClient } = await import("../lib/mongodb.ts");
const { currentStoreId } = await import("../lib/olsera-store-id.ts");

const MARKER = "USER_CONFIRMED_YONEX_SM_J035_2026_09_08";
const PRODUCT_ID = 118420650;
const YEAR = 2026;
const MONTH = 6;
/** Bulan yang ikut terdampak rantai maju — dicek kuncinya, TIDAK ditulis di sini. */
const DOWNSTREAM_MONTHS = [6, 7, 8, 9];
const DIAGNOSTIC =
  `Dikoreksi manual ${MARKER}: angka lama (opening 4, sales 3, closing 1) berasal dari file baseline ` +
  `doc export/INVENTORI.xlsx sheet JUNI'26 dan merupakan riwayat produk ASLI "YONEX SHORTS MEN # SM-J035-2906-RW1-S" ` +
  `yang sudah tidak ada di katalog, bukan produk "duplicate" ini. Audit Olsera Backoffice: produk ini NOL transaksi ` +
  `pada Juni 2026 (masuk pertama 3 Juli 2026). Seluruh ledger Juni disetel 0.`;

const APPLY = process.argv.includes("--apply");
const storeId = currentStoreId();

const result = await (async () => {
  const c = await collections();

  const existingMarker = (await c.olseraInventoryState.findOne({ _id: "olsera-inventory" }))?.targetedInventoryCorrections?.[MARKER];
  if (existingMarker?.status === "complete") return { status: "skipped", reason: "marker-already-complete", marker: MARKER };

  const locks = await c.inventoryMonthlyPeriodLocks
    .find({ storeId, year: YEAR, month: { $in: DOWNSTREAM_MONTHS }, status: "locked" })
    .project({ _id: 1 })
    .toArray();
  if (locks.length) throw new Error(`Target period locked (${locks.map((l) => l._id).join(", ")}); correction stopped without unlock.`);

  // Bukti identitas: TEPAT satu produk katalog dengan productId ini.
  const products = await c.olseraInventoryProducts
    .find({ storeId: { $in: [storeId, null] }, productId: PRODUCT_ID })
    .project({ productId: 1, variantId: 1, name: 1, sku: 1, active: 1, stockQty: 1 })
    .toArray();
  if (products.length !== 1) throw new Error(`Exact productId catalog proof failed: ${products.length} produk untuk ${PRODUCT_ID}.`);

  const before = await c.olseraInventoryMonthlySnapshots.findOne({ storeId, year: YEAR, month: MONTH, productId: PRODUCT_ID });
  if (!before) throw new Error(`Snapshot ${YEAR}-${String(MONTH).padStart(2, "0")} untuk ${PRODUCT_ID} tidak ditemukan.`);
  // Bukti angka: hanya boleh mengoreksi dokumen yang PERSIS seperti yang dilaporkan.
  if (before.source !== "baseline-file" || before.openingQty !== 4 || before.salesQty !== 3 || before.closingQty !== 1) {
    throw new Error(`Dokumen Juni sudah berubah dari kondisi yang diverifikasi (source=${before.source} opening=${before.openingQty} sales=${before.salesQty} closing=${before.closingQty}); koreksi dihentikan.`);
  }

  const after = { ...before, openingQty: 0, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0, closingQty: 0, status: "complete" as const, diagnostics: [DIAGNOSTIC], updatedAt: new Date() };

  // Baris BA Juni yang akan dihapus (boleh tidak ada — sudah dihapus manual, dsb.).
  const baId = `${storeId}:${YEAR}:${String(MONTH).padStart(2, "0")}:${PRODUCT_ID}:0`;
  const baBefore = await c.inventoryStockOpnameReconciliations.findOne({ _id: baId });

  const summary = {
    marker: MARKER,
    storeId,
    product: products[0],
    changedProductIds: [PRODUCT_ID],
    rows: [{ productId: PRODUCT_ID, month: MONTH, before, after }],
    beritaAcaraToDelete: baBefore ? { _id: baId, physicalQty: baBefore.physicalQty, systemClosingQty: baBefore.systemClosingQty, status: baBefore.status } : null,
  };
  if (!APPLY) return { ...summary, status: "dry-run" };

  const now = new Date();
  const claimed = await c.olseraInventoryState.findOneAndUpdate(
    { _id: "olsera-inventory", [`targetedInventoryCorrections.${MARKER}`]: { $exists: false } },
    { $set: { [`targetedInventoryCorrections.${MARKER}`]: { status: "running", marker: MARKER, reason: MARKER, backup: [before], beritaAcaraBackup: baBefore ? [baBefore] : [], changedProductIds: [PRODUCT_ID], startedAt: now } } },
    { upsert: true, returnDocument: "after" },
  );
  if (claimed?.targetedInventoryCorrections?.[MARKER]?.status !== "running") return { status: "skipped", reason: "marker-claimed-by-another-run", marker: MARKER };

  const { createdAt, ...update } = after;
  const written = await c.olseraInventoryMonthlySnapshots.updateOne(
    { _id: before._id, storeId, year: YEAR, month: MONTH, productId: PRODUCT_ID, updatedAt: before.updatedAt },
    { $set: update, $setOnInsert: { createdAt } },
  );
  if (written.matchedCount !== 1) throw new Error("Dokumen berubah di tengah jalan (updatedAt tidak cocok); tidak ada yang ditulis.");

  const deleted = baBefore ? (await c.inventoryStockOpnameReconciliations.deleteOne({ _id: baId })).deletedCount : 0;

  await c.olseraInventoryState.updateOne(
    { _id: "olsera-inventory" },
    { $set: { [`targetedInventoryCorrections.${MARKER}`]: { status: "complete", marker: MARKER, reason: MARKER, backup: [before], beritaAcaraBackup: baBefore ? [baBefore] : [], changedProductIds: [PRODUCT_ID], startedAt: now, completedAt: new Date() } } },
  );
  return { ...summary, status: "applied", modifiedCount: written.modifiedCount, beritaAcaraDeletedCount: deleted };
})();

console.log(JSON.stringify(result, null, 2));
await mongoClient.close();
