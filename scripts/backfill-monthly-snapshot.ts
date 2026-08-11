// Rebuild EKSPLISIT ledger stok bulanan (olsera_inventory_monthly_snapshots)
// untuk rentang bulan yang jelas dan disebutkan sendiri oleh pemanggil.
// DEFAULT = DRY-RUN (tidak menulis apa pun) — WAJIB --write untuk benar-benar
// menulis Mongo. WAJIB --period=YYYY-MM atau --from=YYYY-MM --to=YYYY-MM
// (tidak ada default "semua bulan" — mencegah rebuild tidak sengaja
// menyentuh bulan yang tidak dimaksud). Tidak pernah menghapus collection,
// selalu upsert by _id (idempotent), tidak pernah menyentuh bulan di luar
// rentang yang diminta.
//
// Dipakai SETELAH scripts/audit-inventory-monthly-periods.ts (dry-run,
// read-only) menandai suatu periode STALE_NEEDS_REBUILD/MANUAL_REVIEW.
//
// Jalankan:
//   node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/backfill-monthly-snapshot.ts --period=2026-07
//   node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/backfill-monthly-snapshot.ts --from=2026-07 --to=2026-08 --write
//
// --product-id=<id> (opsional, additive) — batasi rebuild ke SATU entity
// (productId katalog kanonik saat ini + --variant-id opsional, default
// variantId null). Saat diisi: HANYA entity itu yang dihitung/write/diff;
// produk lain (termasuk yang lain-lain punya alias verified sendiri, mis.
// Yonex) TIDAK disentuh sama sekali. TANPA --product-id, perilaku PERSIS
// sama seperti sebelumnya (seluruh katalog).
import { dominantStoreId, monthsAscending, monthsDescending, type MonthKey } from "../lib/olsera-inventory-monthly-snapshot-core.ts";
import {
  backfillBackwardRange,
  backfillForwardRange,
  fetchMatchingContext,
  fetchRawSalesActivityByMonth,
  getMongoMonthlySnapshotRepo,
  type EntityFilter,
  type MonthlySnapshotRepo,
} from "../lib/olsera-inventory-monthly-snapshot-store.ts";
import type { OlseraInventoryMonthlySnapshotDocument } from "../lib/mongodb.ts";

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;
const JUNE_2026: MonthKey = { year: 2026, month: 6 };

function parsePeriod(period: string): MonthKey {
  const [year, month] = period.split("-").map(Number);
  return { year, month };
}

function fmt(month: MonthKey): string {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

function monthIndex({ year, month }: MonthKey): number {
  return year * 12 + (month - 1);
}

type Args = { period: string | null; from: string | null; to: string | null; write: boolean; productId: number | null; variantId: number | null };

function parseArgs(argv: string[]): Args {
  let period: string | null = null;
  let from: string | null = null;
  let to: string | null = null;
  let write = false;
  let productId: number | null = null;
  let variantId: number | null = null;
  for (const arg of argv) {
    if (arg === "--write") write = true;
    else if (arg.startsWith("--period=")) period = arg.slice("--period=".length);
    else if (arg.startsWith("--from=")) from = arg.slice("--from=".length);
    else if (arg.startsWith("--to=")) to = arg.slice("--to=".length);
    else if (arg.startsWith("--product-id=")) productId = Number(arg.slice("--product-id=".length));
    else if (arg.startsWith("--variant-id=")) variantId = Number(arg.slice("--variant-id=".length));
  }
  return { period, from, to, write, productId, variantId };
}

/** Repo dry-run: baca Mongo asli apa adanya, TAPI upsertMany hanya mencatat "would-be" summary — TIDAK PERNAH menulis. */
function makeDryRunRepo(real: MonthlySnapshotRepo) {
  const changes: { _id: string; before: OlseraInventoryMonthlySnapshotDocument | null; after: OlseraInventoryMonthlySnapshotDocument }[] = [];
  const repo: MonthlySnapshotRepo = {
    findMonth: real.findMonth,
    async upsertMany(docs) {
      for (const doc of docs) {
        const existingMonth = await real.findMonth(doc.storeId, doc.year, doc.month);
        const before = existingMonth.find((d) => d._id === doc._id) ?? null;
        changes.push({ _id: doc._id, before, after: doc });
      }
      // TIDAK memanggil real.upsertMany — dry-run tidak pernah menulis.
    },
  };
  return { repo, changes };
}

function summarizeChanges(changes: { _id: string; before: OlseraInventoryMonthlySnapshotDocument | null; after: OlseraInventoryMonthlySnapshotDocument }[]) {
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  const details: string[] = [];
  for (const c of changes) {
    if (!c.before) {
      added++;
      details.push(`  + BARU   ${c._id}  ${c.after.productName}  closing=${c.after.closingQty}`);
      continue;
    }
    const fieldsToCompare: (keyof OlseraInventoryMonthlySnapshotDocument)[] = ["openingQty", "incomingQty", "returnQty", "salesQty", "outgoingQty", "closingQty", "status"];
    const diffFields = fieldsToCompare.filter((f) => c.before![f] !== c.after[f]);
    if (diffFields.length) {
      changed++;
      details.push(`  ~ UBAH   ${c._id}  ${c.after.productName}  [${diffFields.map((f) => `${f}: ${c.before![f]}→${c.after[f]}`).join(", ")}]`);
    } else {
      unchanged++;
    }
  }
  return { added, changed, unchanged, details };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const periods: MonthKey[] = [];
  if (args.period) {
    if (!PERIOD_PATTERN.test(args.period)) throw new Error(`--period tidak valid (wajib YYYY-MM): ${args.period}`);
    periods.push(parsePeriod(args.period));
  } else if (args.from && args.to) {
    if (!PERIOD_PATTERN.test(args.from) || !PERIOD_PATTERN.test(args.to)) throw new Error(`--from/--to wajib format YYYY-MM (diterima: from=${args.from} to=${args.to})`);
    const from = parsePeriod(args.from);
    const to = parsePeriod(args.to);
    if (monthIndex(from) > monthIndex(to)) throw new Error(`--from (${args.from}) harus <= --to (${args.to})`);
    periods.push(...monthsAscending(from, to));
  } else {
    throw new Error(
      "WAJIB menyebutkan rentang bulan secara eksplisit: --period=YYYY-MM ATAU --from=YYYY-MM --to=YYYY-MM. Tidak ada default 'semua bulan' — mencegah rebuild tidak sengaja menyentuh bulan yang tidak dimaksud.",
    );
  }

  if (args.variantId !== null && args.productId === null) {
    throw new Error("--variant-id hanya boleh diisi bersama --product-id.");
  }

  console.log(`[backfill-monthly-snapshot] Mode: ${args.write ? "WRITE (akan menulis Mongo)" : "DRY-RUN (tidak menulis apa pun)"}`);
  console.log(`[backfill-monthly-snapshot] Rentang: ${periods.map(fmt).join(", ")}`);
  if (args.productId !== null) {
    console.log(`[backfill-monthly-snapshot] SCOPED: HANYA productId=${args.productId} variantId=${args.variantId ?? "null"} — produk lain TIDAK dihitung/write/diff sama sekali.\n`);
  } else {
    console.log("");
  }

  const matchingContext = await fetchMatchingContext();
  if (!matchingContext.catalogProducts.length) {
    console.error("Katalog produk inventori (olsera_inventory_products) kosong — jalankan Sync Inventori terlebih dahulu.");
    process.exit(1);
  }
  const storeId = dominantStoreId(matchingContext.catalogProducts);

  let entityFilter: EntityFilter | undefined;
  if (args.productId !== null) {
    const target = matchingContext.catalogProducts.find((p) => p.productId === args.productId && (args.variantId === null || p.variantId === args.variantId));
    if (!target) {
      console.error(`[backfill-monthly-snapshot] GAGAL: productId=${args.productId} variantId=${args.variantId ?? "null"} tidak ditemukan di katalog aktif (olsera_inventory_products) — rebuild dibatalkan, tidak ada yang dihitung/ditulis.`);
      process.exit(1);
    }
    entityFilter = { productId: args.productId, variantId: args.variantId };
    console.log(`[backfill-monthly-snapshot] Target scoped: "${target.name}" (productId=${target.productId}, variantId=${target.variantId ?? "null"}, kategori=${target.category})\n`);
  }

  const realRepo = await getMongoMonthlySnapshotRepo();
  const { repo, changes } = args.write ? { repo: realRepo, changes: [] as ReturnType<typeof makeDryRunRepo>["changes"] } : makeDryRunRepo(realRepo);

  const backwardPeriods = periods.filter((m) => monthIndex(m) <= monthIndex(JUNE_2026));
  const forwardPeriods = periods.filter((m) => monthIndex(m) > monthIndex(JUNE_2026));

  let hadFailure = false;

  if (backwardPeriods.length) {
    // Anchor: bulan tepat SETELAH awal rentang mundur (closingQty-nya harus sudah ada).
    const earliest = backwardPeriods.reduce((min, m) => (monthIndex(m) < monthIndex(min) ? m : min), backwardPeriods[0]);
    const latest = backwardPeriods.reduce((max, m) => (monthIndex(m) > monthIndex(max) ? m : max), backwardPeriods[0]);
    const anchorCandidates = monthsAscending(latest, JUNE_2026);
    let anchorMonth: MonthKey | null = null;
    for (const month of anchorCandidates) {
      if (monthIndex(month) === monthIndex(latest)) continue;
      const docs = await realRepo.findMonth(storeId, month.year, month.month);
      if (docs.length) {
        anchorMonth = month;
        break;
      }
    }
    if (!anchorMonth) {
      console.error(`Tidak ada dokumen anchor SETELAH ${fmt(latest)} untuk memulai rebuild mundur — jalankan bootstrap baseline dulu, atau sertakan bulan anchor dalam rentang --from/--to.`);
      hadFailure = true;
    } else {
      console.log(`=== Backfill MUNDUR: ${fmt(anchorMonth)} (anchor) -> ${fmt(earliest)} ===`);
      const summaries = await backfillBackwardRange({
        fromInclusive: anchorMonth,
        toInclusive: earliest,
        storeId,
        matchingContext,
        repo,
        rawSalesActivityFetcher: (start, end) => fetchRawSalesActivityByMonth(storeId, start, end),
        entityFilter,
      });
      for (const s of summaries) {
        if (s.ok) console.log(`  ${fmt(s.month)}: OK — ${s.docsWritten} entity, ${s.stopped.length} dihentikan (belum ada bukti eksistensi).`);
        else {
          console.error(`  ${fmt(s.month)}: GAGAL — ${s.error}`);
          hadFailure = true;
        }
      }
    }
  }

  if (forwardPeriods.length) {
    const earliest = forwardPeriods.reduce((min, m) => (monthIndex(m) < monthIndex(min) ? m : min), forwardPeriods[0]);
    const latest = forwardPeriods.reduce((max, m) => (monthIndex(m) > monthIndex(max) ? m : max), forwardPeriods[0]);
    const anchorCandidates = monthsDescending(earliest, JUNE_2026);
    let anchorMonth: MonthKey | null = null;
    for (const month of anchorCandidates) {
      if (monthIndex(month) === monthIndex(earliest)) continue;
      const docs = await realRepo.findMonth(storeId, month.year, month.month);
      if (docs.length) {
        anchorMonth = month;
        break;
      }
    }
    if (!anchorMonth) {
      console.error(`Tidak ada dokumen anchor SEBELUM ${fmt(earliest)} untuk memulai rebuild maju — jalankan bootstrap baseline dulu, atau sertakan bulan anchor dalam rentang --from/--to.`);
      hadFailure = true;
    } else {
      console.log(`\n=== Backfill MAJU: ${fmt(anchorMonth)} (anchor) -> ${fmt(latest)} ===`);
      const summaries = await backfillForwardRange({
        fromInclusive: anchorMonth,
        toInclusive: latest,
        storeId,
        matchingContext,
        repo,
        rawSalesActivityFetcher: (start, end) => fetchRawSalesActivityByMonth(storeId, start, end),
        entityFilter,
      });
      for (const s of summaries) {
        if (s.ok) console.log(`  ${fmt(s.month)}: OK — ${s.docsWritten} entity.`);
        else {
          console.error(`  ${fmt(s.month)}: GAGAL — ${s.error}`);
          hadFailure = true;
        }
      }
    }
  }

  if (!args.write) {
    const { added, changed, unchanged, details } = summarizeChanges(changes);
    console.log(`\n=== DRY-RUN SUMMARY (tidak ada yang ditulis) ===`);
    console.log(`  ${added} entity BARU, ${changed} entity BERUBAH, ${unchanged} entity TIDAK berubah.`);
    if (details.length) {
      console.log(`\nDetail (maks 50 baris):`);
      for (const line of details.slice(0, 50)) console.log(line);
      if (details.length > 50) console.log(`  ... (${details.length - 50} baris lagi, gunakan --write setelah direview untuk benar-benar menulis)`);
    }
    console.log(`\nJalankan ulang dengan --write untuk benar-benar menulis perubahan di atas ke Mongo.`);
  } else {
    console.log(`\n=== SELESAI — perubahan sudah ditulis ke olsera_inventory_monthly_snapshots ===`);
  }

  if (hadFailure) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error("[backfill-monthly-snapshot] gagal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
