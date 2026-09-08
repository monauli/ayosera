// Koreksi produksi bertarget, SEKALI JALAN, disetujui user (2026-09-08).
// Lanjutan scripts/correct-yonex-sm-j035-june-2026.ts (commit 648eb0a) yang
// sudah membereskan Juni; skrip ini membereskan Februari s/d Mei 2026.
//
// Masalah: snapshot Feb (24/9/15), Mar (15/15), Apr (4/4) dan Mei (4/4) untuk
// "YONEX SHORTS MEN # SM-J035-2906-RW1-S duplicate" (productId 118420650)
// sebenarnya riwayat produk ASLI "YONEX SHORTS MEN # SM-J035-2906-RW1-S" yang
// sudah dihapus dari katalog Olsera. Karena entri katalog yang tersisa hanya
// yang "duplicate", seluruh penjualan lama ter-resolve ke productId ini. Audit
// langsung ke Olsera Backoffice membuktikan produk "duplicate" NOL TRANSAKSI
// pada Feb, Mar, Apr, Mei DAN Juni 2026 — barang pertama baru masuk 3 Juli 2026.
//
// Menulis TEPAT DUA hal, keduanya hanya untuk productId 118420650:
//   1. olsera_inventory_monthly_snapshots Feb/Mar/Apr/Mei 2026 -> seluruh
//      ledger (opening/incoming/return/sales/outgoing/closing) jadi 0.
//   2. inventory_stock_opname_reconciliations Feb/Mar/Apr 2026 -> DIHAPUS
//      (Mei tidak punya dokumen BA). Setelah koreksi (1), keenam angka bulan
//      itu jadi nol sehingga hasInventoryActivity menyembunyikan baris
//      sistemnya; baris BA dirender per baris sistem, jadi dokumen BA-nya akan
//      jadi yatim (tak terlihat, tak bisa diedit, tapi masih ada). Perlakuan
//      SAMA PERSIS dengan BA Juni kemarin. Salinannya disimpan ke marker.
//
// TIDAK perlu rebuild bulan sesudahnya: Juni sudah 0 (koreksi terpisah) dan
// seluruh bulan <= Juni 2026 berada di zona mundur yang tidak pernah dihitung
// ulang dari API (guard isBackwardZone di
// lib/olsera-inventory-monthly-snapshot-store.ts). Juli s/d September sudah
// dibangun ulang dari anchor Juni = 0 dan semuanya sudah 0.
//
// Pola PERSIS scripts/correct-yonex-sm-j035-june-2026.ts: dijaga marker di
// olsera_inventory_state (idempoten, tidak bisa jalan dua kali), menolak
// periode terkunci, memverifikasi bukti angka sebelum menulis, optimistic
// write (filter menyertakan updatedAt lama), dan DEFAULT DRY-RUN — wajib
// --apply untuk menulis.
//
// Jalankan:
//   node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/correct-yonex-sm-j035-feb-may-2026.ts
//   node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/correct-yonex-sm-j035-feb-may-2026.ts --apply
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

const MARKER = "USER_CONFIRMED_YONEX_SM_J035_FEB_MAY_2026_09_08";
const PRODUCT_ID = 118420650;
const YEAR = 2026;
/** Bulan target + kondisi yang WAJIB masih terpenuhi sebelum ditulis (bukti angka). */
const TARGETS = [
  { month: 2, expect: { source: "baseline-file", openingQty: 24, salesQty: 9, closingQty: 15 } },
  { month: 3, expect: { source: "carry-forward", openingQty: 15, salesQty: 0, closingQty: 15 } },
  { month: 4, expect: { source: "carry-forward", openingQty: 4, salesQty: 0, closingQty: 4 } },
  { month: 5, expect: { source: "carry-forward", openingQty: 4, salesQty: 0, closingQty: 4 } },
] as const;
const DIAGNOSTIC =
  `Dikoreksi manual ${MARKER}: angka lama bulan ini adalah riwayat produk ASLI ` +
  `"YONEX SHORTS MEN # SM-J035-2906-RW1-S" yang sudah dihapus dari katalog Olsera dan ter-resolve ke ` +
  `productId "duplicate" ini. Audit Olsera Backoffice: produk ini NOL transaksi pada Februari s/d Juni 2026 ` +
  `(barang pertama masuk 3 Juli 2026). Seluruh ledger bulan ini disetel 0.`;

const APPLY = process.argv.includes("--apply");
const storeId = currentStoreId();

const result = await (async () => {
  const c = await collections();

  const existingMarker = (await c.olseraInventoryState.findOne({ _id: "olsera-inventory" }))?.targetedInventoryCorrections?.[MARKER];
  if (existingMarker?.status === "complete") return { status: "skipped", reason: "marker-already-complete", marker: MARKER };

  const months = TARGETS.map((t) => t.month);
  const locks = await c.inventoryMonthlyPeriodLocks
    .find({ storeId, year: YEAR, month: { $in: months }, status: "locked" })
    .project({ _id: 1 })
    .toArray();
  if (locks.length) throw new Error(`Target period locked (${locks.map((l) => l._id).join(", ")}); correction stopped without unlock.`);

  // Bukti identitas: TEPAT satu produk katalog dengan productId ini.
  const products = await c.olseraInventoryProducts
    .find({ storeId: { $in: [storeId, null] }, productId: PRODUCT_ID })
    .project({ productId: 1, variantId: 1, name: 1, sku: 1, active: 1, stockQty: 1 })
    .toArray();
  if (products.length !== 1) throw new Error(`Exact productId catalog proof failed: ${products.length} produk untuk ${PRODUCT_ID}.`);

  const rows = [];
  for (const target of TARGETS) {
    const before = await c.olseraInventoryMonthlySnapshots.findOne({ storeId, year: YEAR, month: target.month, productId: PRODUCT_ID });
    if (!before) throw new Error(`Snapshot ${YEAR}-${String(target.month).padStart(2, "0")} untuk ${PRODUCT_ID} tidak ditemukan.`);
    // Bukti angka: hanya boleh mengoreksi dokumen yang PERSIS seperti yang diverifikasi.
    for (const [field, expected] of Object.entries(target.expect)) {
      const actual = (before as unknown as Record<string, unknown>)[field];
      if (actual !== expected) {
        throw new Error(`Dokumen ${YEAR}-${String(target.month).padStart(2, "0")} sudah berubah dari kondisi yang diverifikasi (${field}=${String(actual)}, diharapkan ${String(expected)}); koreksi dihentikan tanpa menulis apa pun.`);
      }
    }
    const after = { ...before, openingQty: 0, incomingQty: 0, returnQty: 0, salesQty: 0, outgoingQty: 0, closingQty: 0, status: "complete" as const, diagnostics: [DIAGNOSTIC], updatedAt: new Date() };
    rows.push({ productId: PRODUCT_ID, month: target.month, before, after });
  }

  // Baris BA yang akan dihapus (bulan tanpa dokumen BA dilewati, bukan error).
  const baIds = months.map((month) => `${storeId}:${YEAR}:${String(month).padStart(2, "0")}:${PRODUCT_ID}:0`);
  const baBefore = await c.inventoryStockOpnameReconciliations.find({ _id: { $in: baIds } }).toArray();

  const summary = {
    marker: MARKER,
    storeId,
    product: products[0],
    changedProductIds: [PRODUCT_ID],
    rows: rows.map((r) => ({
      month: r.month,
      before: { source: r.before.source, opening: r.before.openingQty, incoming: r.before.incomingQty, return: r.before.returnQty, sales: r.before.salesQty, outgoing: r.before.outgoingQty, closing: r.before.closingQty },
      after: { source: r.after.source, opening: r.after.openingQty, incoming: r.after.incomingQty, return: r.after.returnQty, sales: r.after.salesQty, outgoing: r.after.outgoingQty, closing: r.after.closingQty },
    })),
    beritaAcaraToDelete: baBefore.map((d) => ({ _id: d._id, month: d.month, physicalQty: d.physicalQty, systemClosingQty: d.systemClosingQty, status: d.status })),
    beritaAcaraMonthsWithoutDoc: months.filter((month) => !baBefore.some((d) => d.month === month)),
  };
  if (!APPLY) return { ...summary, status: "dry-run" };

  const now = new Date();
  const claimed = await c.olseraInventoryState.findOneAndUpdate(
    { _id: "olsera-inventory", [`targetedInventoryCorrections.${MARKER}`]: { $exists: false } },
    { $set: { [`targetedInventoryCorrections.${MARKER}`]: { status: "running", marker: MARKER, reason: MARKER, backup: rows.map((r) => r.before), beritaAcaraBackup: baBefore, changedProductIds: [PRODUCT_ID], startedAt: now } } },
    { upsert: true, returnDocument: "after" },
  );
  if (claimed?.targetedInventoryCorrections?.[MARKER]?.status !== "running") return { status: "skipped", reason: "marker-claimed-by-another-run", marker: MARKER };

  let modifiedCount = 0;
  for (const row of rows) {
    const { createdAt, ...update } = row.after;
    const written = await c.olseraInventoryMonthlySnapshots.updateOne(
      { _id: row.before._id, storeId, year: YEAR, month: row.month, productId: PRODUCT_ID, updatedAt: row.before.updatedAt },
      { $set: update, $setOnInsert: { createdAt } },
    );
    if (written.matchedCount !== 1) throw new Error(`Dokumen ${YEAR}-${String(row.month).padStart(2, "0")} berubah di tengah jalan (updatedAt tidak cocok); jalankan ulang dari awal.`);
    modifiedCount += written.modifiedCount;
  }

  const deleted = baBefore.length ? (await c.inventoryStockOpnameReconciliations.deleteMany({ _id: { $in: baBefore.map((d) => d._id) } })).deletedCount : 0;

  await c.olseraInventoryState.updateOne(
    { _id: "olsera-inventory" },
    { $set: { [`targetedInventoryCorrections.${MARKER}`]: { status: "complete", marker: MARKER, reason: MARKER, backup: rows.map((r) => r.before), beritaAcaraBackup: baBefore, changedProductIds: [PRODUCT_ID], startedAt: now, completedAt: new Date() } } },
  );
  return { ...summary, status: "applied", modifiedCount, beritaAcaraDeletedCount: deleted };
})();

console.log(JSON.stringify(result, null, 2));
await mongoClient.close();
