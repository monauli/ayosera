// AUDIT READ-ONLY — rekap per-PERIODE (bulan) status pipeline snapshot
// inventori bulanan (olsera_inventory_monthly_snapshots), Februari 2026
// s/d bulan berjalan secara default. TIDAK PERNAH menulis Mongo, TIDAK
// pernah sync/backfill/rebuild — hanya MEMBANDINGKAN dokumen lokal vs
// tarikan LIVE stockmovement API Olsera untuk rentang tanggal bulan yang
// sama (bukti data langsung, BUKAN menebak dari timestamp createdAt — lihat
// tmp/ai-handoff.md "Inventory July-August Product Timing Audit").
//
// Beda dari scripts/audit-inventory-snapshot-rebuild.ts (per-entity, existing
// snapshot vs olsera_inventory_movements lokal): script ini per-PERIODE, dan
// pembandingnya adalah tarikan API Olsera LANGSUNG (sumber kebenaran), bukan
// ledger lokal — jadi bisa membuktikan "produk ini ADA di Olsera tapi TIDAK
// ADA di dokumen lokal" secara pasti, sesuai kebutuhan audit lifecycle bulanan.
//
// Pakai:
//   npm run inventory:audit-periods
//   npm run inventory:audit-periods -- --from=2026-02 --to=2026-08
//   npm run inventory:audit-periods -- --json-output=tmp/inventory-audit-periods.json
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
loadLocalEnv();

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

type Args = { from: string | null; to: string | null; jsonOutput: string | null };

function parseArgs(argv: string[]): Args {
  let from: string | null = null;
  let to: string | null = null;
  let jsonOutput: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--from=")) from = arg.slice("--from=".length);
    else if (arg.startsWith("--to=")) to = arg.slice("--to=".length);
    else if (arg.startsWith("--json-output=")) jsonOutput = arg.slice("--json-output=".length);
  }
  return { from, to, jsonOutput };
}

function todayJakarta(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "numeric" }).formatToParts(new Date());
  return { year: Number(parts.find((p) => p.type === "year")?.value), month: Number(parts.find((p) => p.type === "month")?.value) };
}

async function main() {
  const { getInventoryPeriodState, lastDayOfMonth, monthsAscending, dominantStoreId } = await import("../lib/olsera-inventory-monthly-snapshot-core.ts");
  const { attachMovementsToProducts } = await import("../lib/olsera-inventory-monthly-core.ts");
  const { classifySnapshotPeriod } = await import("../lib/inventory-snapshot-pipeline-audit-core.ts");
  const { fetchMatchingContext } = await import("../lib/olsera-inventory-monthly-snapshot-store.ts");
  const { fetchStockMovementRange } = await import("../lib/olsera-inventory-stockmovement.ts");

  const args = parseArgs(process.argv.slice(2));
  const current = todayJakarta();
  const fromPeriod = args.from ?? "2026-02";
  const toPeriod = args.to ?? `${current.year}-${String(current.month).padStart(2, "0")}`;
  if (!PERIOD_PATTERN.test(fromPeriod) || !PERIOD_PATTERN.test(toPeriod)) {
    throw new Error(`--from/--to wajib format YYYY-MM (diterima: from=${fromPeriod} to=${toPeriod})`);
  }

  console.log(`[audit-monthly-periods] READ-ONLY — ${fromPeriod}..${toPeriod}. Tidak pernah menulis Mongo, tidak sync/backfill/rebuild.\n`);

  const { collections } = await import("../lib/mongodb.ts");
  const { olseraInventoryMonthlySnapshots } = await collections();

  const matchingContext = await fetchMatchingContext();
  if (!matchingContext.catalogProducts.length) {
    console.error("Katalog produk inventori (olsera_inventory_products) kosong — jalankan Sync Inventori terlebih dahulu.");
    process.exit(1);
  }
  const storeId = dominantStoreId(matchingContext.catalogProducts);

  const [fromYear, fromMonth] = fromPeriod.split("-").map(Number);
  const [toYear, toMonth] = toPeriod.split("-").map(Number);
  const months = monthsAscending({ year: fromYear, month: fromMonth }, { year: toYear, month: toMonth });

  const rows: {
    period: string;
    periodState: string;
    localEntityCount: number;
    sourceEntityCount: number;
    missingLocalCount: number;
    localOnlyCount: number;
    qtyMismatchCount: number;
    localQtySum: number;
    sourceQtySum: number;
    classification: string;
    reason: string;
    missingLocalSample: { productId: number; variantId: number | null; name: string }[];
  }[] = [];

  for (const month of months) {
    const period = `${month.year}-${String(month.month).padStart(2, "0")}`;
    const now = new Date();
    const periodState = getInventoryPeriodState(month.year, month.month, now);

    const localDocs = await olseraInventoryMonthlySnapshots
      .find({ storeId, year: month.year, month: month.month })
      .project({ productId: 1, variantId: 1, productName: 1, closingQty: 1 })
      .toArray();
    const localByKey = new Map(localDocs.map((d) => [`${storeId}:${d.productId}:${d.variantId ?? 0}`, d]));

    if (periodState === "future") {
      const result = classifySnapshotPeriod({ periodState, localEntityCount: localDocs.length, sourceEntityCount: 0, missingLocalCount: 0, qtyMismatchCount: 0 });
      rows.push({
        period,
        periodState,
        localEntityCount: localDocs.length,
        sourceEntityCount: 0,
        missingLocalCount: 0,
        localOnlyCount: 0,
        qtyMismatchCount: 0,
        localQtySum: 0,
        sourceQtySum: 0,
        classification: result.classification,
        reason: result.reason,
        missingLocalSample: [],
      });
      console.log(`${period}  [${result.classification}]  local=${localDocs.length}  (masa depan — API tidak ditarik)`);
      continue;
    }

    const startDate = `${period}-01`;
    const endDate = lastDayOfMonth(month.year, month.month);
    const fetched = await fetchStockMovementRange(startDate, endDate);
    if (!fetched.ok) {
      rows.push({
        period,
        periodState,
        localEntityCount: localDocs.length,
        sourceEntityCount: 0,
        missingLocalCount: 0,
        localOnlyCount: 0,
        qtyMismatchCount: 0,
        localQtySum: 0,
        sourceQtySum: 0,
        classification: "MANUAL_REVIEW",
        reason: `Gagal menarik stockmovement API: ${fetched.error}`,
        missingLocalSample: [],
      });
      console.log(`${period}  [MANUAL_REVIEW]  gagal menarik API: ${fetched.error}`);
      continue;
    }

    const unmatchedOrAmbiguous: unknown[] = [];
    const matched = attachMovementsToProducts(
      fetched.rows,
      matchingContext.identityIndex,
      matchingContext.skuIndex,
      matchingContext.nameIndex,
      `audit ${period}`,
      unmatchedOrAmbiguous as never,
    );

    let missingLocalCount = 0;
    let localOnlyCount = 0;
    let qtyMismatchCount = 0;
    let sourceQtySum = 0;
    const missingLocalSample: { productId: number; variantId: number | null; name: string }[] = [];

    for (const [key, movement] of matched) {
      sourceQtySum += movement.row.sisa;
      const localDoc = localByKey.get(key);
      if (!localDoc) {
        missingLocalCount++;
        if (missingLocalSample.length < 10) {
          missingLocalSample.push({ productId: movement.row.productId, variantId: movement.row.productVariantId ?? null, name: movement.row.productVariantName ? `${movement.row.productName} - ${movement.row.productVariantName}` : movement.row.productName });
        }
      } else if (localDoc.closingQty !== null && localDoc.closingQty !== movement.row.sisa) {
        qtyMismatchCount++;
      }
    }
    for (const key of localByKey.keys()) {
      if (!matched.has(key)) localOnlyCount++;
    }
    const localQtySum = localDocs.reduce((sum, d) => sum + (d.closingQty ?? 0), 0);

    const result = classifySnapshotPeriod({
      periodState,
      localEntityCount: localDocs.length,
      sourceEntityCount: matched.size,
      missingLocalCount,
      qtyMismatchCount,
    });

    rows.push({
      period,
      periodState,
      localEntityCount: localDocs.length,
      sourceEntityCount: matched.size,
      missingLocalCount,
      localOnlyCount,
      qtyMismatchCount,
      localQtySum,
      sourceQtySum,
      classification: result.classification,
      reason: result.reason,
      missingLocalSample,
    });

    console.log(
      `${period}  [${result.classification}]  local=${localDocs.length} source=${matched.size} missingLocal=${missingLocalCount} localOnly=${localOnlyCount} qtyMismatch=${qtyMismatchCount}  — ${result.reason}`,
    );
    if (missingLocalSample.length) {
      for (const p of missingLocalSample) console.log(`    missing: productId=${p.productId} variantId=${p.variantId ?? "null"} (${p.name})`);
    }
  }

  console.log(`\n=== Rekap ${rows.length} periode (${fromPeriod}..${toPeriod}) ===`);
  const byClassification = new Map<string, number>();
  for (const r of rows) byClassification.set(r.classification, (byClassification.get(r.classification) ?? 0) + 1);
  for (const [cls, count] of [...byClassification.entries()].sort()) console.log(`  ${cls}: ${count}`);

  if (args.jsonOutput) {
    mkdirSync(path.dirname(args.jsonOutput), { recursive: true });
    writeFileSync(args.jsonOutput, JSON.stringify({ generatedAt: new Date().toISOString(), storeId, from: fromPeriod, to: toPeriod, periods: rows }, null, 2));
    console.log(`\n[audit-monthly-periods] output ditulis ke ${args.jsonOutput}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[audit-monthly-periods] gagal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
