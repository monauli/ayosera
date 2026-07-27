// AUDIT READ-ONLY — preview rebuild pipeline snapshot inventori bulanan
// (olsera_inventory_monthly_snapshots) TANPA PERNAH menulis collection itu.
// Membandingkan dokumen snapshot YANG ADA vs "dihitung ulang" dari
// olsera_inventory_movements (ledger penjualan independen AYOSERA, BUKAN
// stockmovement API Olsera — lihat lib/olsera-inventory-monthly-snapshot-store.ts
// fetchRawSalesActivityByMonth), lalu mengklasifikasikan selisihnya via
// lib/inventory-snapshot-pipeline-audit-core.ts (murni, testable terpisah).
//
// Dua mode:
//   1. --product-id diisi  -> preview SATU entity (snapshot existing vs
//      calculated, difference per komponen, klasifikasi, proposed action).
//   2. --product-id KOSONG -> scan SELURUH produk pada storeId+period,
//      rekap jumlah per klasifikasi + contoh terbatas (dipakai untuk laporan
//      tmp/inventory-snapshot-pipeline-audit-*.md/.json).
//
// GARIS KERAS: TIDAK PERNAH menulis olsera_inventory_monthly_snapshots atau
// collection sumber apa pun, TIDAK memanggil API Olsera/AYO live, TIDAK
// sync/backfill/rebuild sungguhan, TIDAK mencetak credential/payload mentah
// besar (hanya field identitas + angka, contoh dibatasi). Selalu memfilter
// berdasarkan storeId (storeId TOKO INI atau null/legacy — TIDAK PERNAH
// storeId toko lain, lihat Known Case 37).
//
// Penggunaan:
//   npm run audit:inventory-snapshot-rebuild -- --period=2026-04 --product-id=116138490
//   npm run audit:inventory-snapshot-rebuild -- --period=2026-04 --json-output=tmp/foo.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function loadLocalEnv(): void {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* shell mungkin sudah menyediakan env */
  }
}
// PENTING: harus dimuat SEBELUM import lib/mongodb.ts — pola sama
// scripts/audit-reconciliation-inventory-null-product.ts. Dynamic import
// ditunda ke main() (bukan top-level await) supaya kompatibel dgn tsx tanpa
// package.json "type":"module".
loadLocalEnv();

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

type Args = { period: string; storeId: number | null; productId: number | null; variantId: number | null; jsonOutput: string | null };

function parseArgs(argv: string[]): Args {
  let period = "";
  let storeId: number | null = null;
  let productId: number | null = null;
  let variantId: number | null = null;
  let jsonOutput: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--period=")) period = arg.slice("--period=".length);
    else if (arg.startsWith("--store-id=")) storeId = Number(arg.slice("--store-id=".length));
    else if (arg.startsWith("--product-id=")) productId = Number(arg.slice("--product-id=".length));
    else if (arg.startsWith("--variant-id=")) variantId = Number(arg.slice("--variant-id=".length));
    else if (arg.startsWith("--json-output=")) jsonOutput = arg.slice("--json-output=".length);
  }
  return { period, storeId, productId, variantId, jsonOutput };
}

async function main() {
  const { classifySnapshotEntity } = await import("../lib/inventory-snapshot-pipeline-audit-core.ts");
  const { isCurrentJakartaPeriod } = await import("../lib/olsera-financial-core.ts");
  const { validateStoreIdArg } = await import("../lib/reconciliation-inventory-null-audit-core.ts");

  const args = parseArgs(process.argv.slice(2));
  if (!PERIOD_PATTERN.test(args.period)) throw new Error(`--period tidak valid (wajib format YYYY-MM): ${args.period}`);
  const [yearStr, monthStr] = args.period.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const start = `${args.period}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${args.period}-${String(lastDay).padStart(2, "0")}`;

  const storeIdEnv = process.env.OLSERA_INTERNAL_STORE_ID ? Number(process.env.OLSERA_INTERNAL_STORE_ID) : null;
  const storeId = validateStoreIdArg(args.storeId ?? storeIdEnv);
  const isDraftPeriod = isCurrentJakartaPeriod(args.period);

  console.log(`[audit-snapshot-rebuild] storeId=${storeId} period=${args.period} (${start}..${end}) isDraftPeriod=${isDraftPeriod} — READ-ONLY, tidak menulis snapshot apa pun.`);

  const { collections } = await import("../lib/mongodb.ts");
  const { olseraInventoryMonthlySnapshots, olseraInventoryMovements, olseraInventoryProducts } = await collections();

  // Semua dokumen snapshot bulan ini (existing) — proyeksi eksplisit.
  const snapshotDocs = await olseraInventoryMonthlySnapshots
    .find({ storeId, year, month })
    .project({ productId: 1, variantId: 1, productName: 1, source: 1, status: 1, salesQty: 1, openingQty: 1, closingQty: 1 })
    .toArray();
  const snapshotByKey = new Map(snapshotDocs.map((d) => [`${d.productId}:${d.variantId ?? 0}`, d as unknown as Record<string, unknown>]));

  // Semua movement (storeId toko ini ATAU null/legacy — Known Case 37, TIDAK PERNAH storeId toko lain).
  const movements = await olseraInventoryMovements
    .find({ storeId: { $in: [storeId, null] }, date: { $gte: start, $lte: end } })
    .project({ productId: 1, variantId: 1, qtyChange: 1, storeId: 1 })
    .toArray();

  // trackInventory per productId+variantId — rantai ledger bulanan HANYA mencakup barang stok
  // (trackInventory:true, baseline Juni = 60 produk fisik). Minuman LABERS/SEWA RAKET/COURT FEE
  // dll SENGAJA trackInventory:false — tidak masuk rantai walau tercatat penjualan (lihat
  // lib/inventory-snapshot-pipeline-audit-core.ts classifySnapshotEntity).
  const catalogDocs = await olseraInventoryProducts.find({ storeId }).project({ productId: 1, variantId: 1, trackInventory: 1 }).toArray();
  const trackInventoryByKey = new Map(catalogDocs.map((p) => [`${p.productId}:${p.variantId ?? 0}`, Boolean(p.trackInventory)]));

  type Activity = { sumAbs: number; hasLegacyNullStore: boolean };
  const activityByKey = new Map<string, Activity>();
  for (const m of movements as unknown as { productId: number | null; variantId: number | null; qtyChange: number; storeId: number | null }[]) {
    if (m.productId === null) continue;
    const key = `${m.productId}:${m.variantId ?? 0}`;
    const entry = activityByKey.get(key) ?? { sumAbs: 0, hasLegacyNullStore: false };
    entry.sumAbs += Math.abs(m.qtyChange);
    if (m.storeId === null) entry.hasLegacyNullStore = true;
    activityByKey.set(key, entry);
  }

  const allKeys = new Set<string>([...snapshotByKey.keys(), ...activityByKey.keys()]);

  type EntityReport = {
    key: string;
    productId: number;
    variantId: number | null;
    productName: string | null;
    existing: { source: string; status: string; salesQty: number | null; openingQty: number | null; closingQty: number | null } | null;
    calculatedSalesQty: number;
    difference: number;
    hasLegacyNullStore: boolean;
    isTrackedInventory: boolean;
    classification: string;
    reason: string;
    proposedAction: string;
  };

  const reports: EntityReport[] = [];
  for (const key of allKeys) {
    const [productIdStr, variantIdStr] = key.split(":");
    const doc = snapshotByKey.get(key);
    const activity = activityByKey.get(key) ?? { sumAbs: 0, hasLegacyNullStore: false };
    // Tidak ditemukan di katalog sekali pun -> diperlakukan konservatif sebagai trackInventory:true
    // (kasus langka; semua 70 distinct productId movement terverifikasi ADA di katalog saat audit ini).
    const isTrackedInventory = trackInventoryByKey.get(key) ?? true;
    const existingDoc = doc ? { source: doc.source as string, status: doc.status as string, salesQty: (doc.salesQty as number | null) ?? null } : null;
    const result = classifySnapshotEntity({
      existingDoc: existingDoc as never,
      rawSalesActivity: activity.sumAbs,
      rawSalesActivityIncludesLegacyNullStore: activity.hasLegacyNullStore,
      isDraftPeriod,
      isTrackedInventory,
    });
    reports.push({
      key,
      productId: Number(productIdStr),
      variantId: variantIdStr === "0" ? null : Number(variantIdStr),
      productName: (doc?.productName as string | undefined) ?? null,
      existing: doc
        ? { source: doc.source as string, status: doc.status as string, salesQty: (doc.salesQty as number | null) ?? null, openingQty: (doc.openingQty as number | null) ?? null, closingQty: (doc.closingQty as number | null) ?? null }
        : null,
      calculatedSalesQty: activity.sumAbs,
      difference: activity.sumAbs - (doc ? ((doc.salesQty as number | null) ?? 0) : 0),
      hasLegacyNullStore: activity.hasLegacyNullStore,
      isTrackedInventory,
      classification: result.classification,
      reason: result.reason,
      proposedAction: result.proposedAction,
    });
  }

  if (args.productId !== null) {
    const key = `${args.productId}:${args.variantId ?? 0}`;
    const report = reports.find((r) => r.key === key);
    if (!report) {
      console.log(`[audit-snapshot-rebuild] Tidak ada dokumen snapshot MAUPUN movement mentah untuk productId=${args.productId} variantId=${args.variantId ?? "null"} pada ${args.period}.`);
      return;
    }
    console.log(`\n=== Preview entity productId=${report.productId} variantId=${report.variantId ?? "null"} (${report.productName ?? "(tidak diketahui)"}) periode ${args.period} ===`);
    console.log("snapshot existing:", JSON.stringify(report.existing));
    console.log("calculated (dari olsera_inventory_movements):", { salesQty: report.calculatedSalesQty });
    console.log("difference (per komponen — HANYA salesQty yg bisa dibandingkan independen di sini):", report.difference);
    console.log("hasLegacyNullStore:", report.hasLegacyNullStore);
    console.log("klasifikasi:", report.classification);
    console.log("alasan:", report.reason);
    console.log("proposed action:", report.proposedAction);
    if (args.jsonOutput) {
      mkdirSync(path.dirname(args.jsonOutput), { recursive: true });
      writeFileSync(args.jsonOutput, JSON.stringify({ generatedAt: new Date().toISOString(), storeId, period: args.period, isDraftPeriod, entity: report }, null, 2));
      console.log(`[audit-snapshot-rebuild] output ditulis ke ${args.jsonOutput}`);
    }
    return;
  }

  // Mode scan penuh.
  const byClassification = new Map<string, number>();
  for (const r of reports) byClassification.set(r.classification, (byClassification.get(r.classification) ?? 0) + 1);

  console.log(`\n=== Scan penuh storeId=${storeId} periode=${args.period}: ${reports.length} entity (union snapshot+movement) ===`);
  for (const [cls, count] of [...byClassification.entries()].sort()) console.log(`  ${cls}: ${count}`);

  const nonExpected = reports.filter((r) => r.classification !== "EXPECTED_NO_ACTION" && r.classification !== "BOUNDARY_CURRENT_MONTH");
  console.log(`\n${nonExpected.length} entity butuh perhatian (bukan EXPECTED_NO_ACTION/BOUNDARY_CURRENT_MONTH):`);
  for (const r of nonExpected.slice(0, 30)) {
    console.log(`  [${r.classification}] productId=${r.productId} variantId=${r.variantId ?? "null"} (${r.productName ?? "?"}) diff=${r.difference} — ${r.reason}`);
  }

  if (args.jsonOutput) {
    mkdirSync(path.dirname(args.jsonOutput), { recursive: true });
    writeFileSync(
      args.jsonOutput,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          storeId,
          period: args.period,
          isDraftPeriod,
          totalEntities: reports.length,
          byClassification: Object.fromEntries(byClassification),
          entities: reports,
        },
        null,
        2,
      ),
    );
    console.log(`[audit-snapshot-rebuild] output ditulis ke ${args.jsonOutput}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[audit-snapshot-rebuild] gagal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
