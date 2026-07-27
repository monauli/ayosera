// Backfill ledger stok bulanan MUNDUR (Mei -> baseline sync inventori,
// Februari 2026) dan MAJU (Juli 2026 -> bulan berjalan) dari anchor Mei/Juni
// yang ditulis scripts/bootstrap-monthly-snapshot-baseline.ts. WAJIB
// dijalankan SETELAH bootstrap. Idempotent (upsert by _id) — aman dijalankan
// ulang, bulan yang sudah lengkap dihitung ulang dengan hasil deterministik
// yang sama, bukan diakumulasi.
//
// Jalankan: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/backfill-monthly-snapshot.ts
import { OLSERA_INVENTORY_BASELINE_DATE } from "../lib/olsera-baseline.ts";
import { dominantStoreId } from "../lib/olsera-inventory-monthly-snapshot-core.ts";
import {
  backfillBackwardRange,
  backfillForwardRange,
  fetchMatchingContext,
  fetchRawSalesActivityByMonth,
  getMongoMonthlySnapshotRepo,
} from "../lib/olsera-inventory-monthly-snapshot-store.ts";

function todayJakarta(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function fmt(month: { year: number; month: number }): string {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

async function main() {
  const matchingContext = await fetchMatchingContext();
  const storeId = dominantStoreId(matchingContext.catalogProducts);
  const repo = await getMongoMonthlySnapshotRepo();
  console.log(`storeId=${storeId}, katalog=${matchingContext.catalogProducts.length} produk.`);

  const baselineYear = Number(OLSERA_INVENTORY_BASELINE_DATE.slice(0, 4));
  const baselineMonth = Number(OLSERA_INVENTORY_BASELINE_DATE.slice(5, 7));

  console.log(`\n=== Backfill MUNDUR: 2026-05 -> ${fmt({ year: baselineYear, month: baselineMonth })} ===`);
  const backward = await backfillBackwardRange({
    fromInclusive: { year: 2026, month: 5 },
    toInclusive: { year: baselineYear, month: baselineMonth },
    storeId,
    matchingContext,
    repo,
    rawSalesActivityFetcher: (start, end) => fetchRawSalesActivityByMonth(storeId, start, end),
  });
  for (const s of backward) {
    if (s.ok) console.log(`  ${fmt(s.month)}: OK — ${s.docsWritten} dokumen, ${s.stopped.length} produk dihentikan (belum ada bukti eksistensi).`);
    else console.error(`  ${fmt(s.month)}: GAGAL — ${s.error}`);
  }

  const today = todayJakarta();
  const [ty, tm] = today.split("-").map(Number);
  console.log(`\n=== Backfill MAJU: 2026-07 -> ${fmt({ year: ty, month: tm })} (hari ini) ===`);
  const forward = await backfillForwardRange({
    fromInclusive: { year: 2026, month: 6 },
    toInclusive: { year: ty, month: tm },
    storeId,
    matchingContext,
    repo,
    rawSalesActivityFetcher: (start, end) => fetchRawSalesActivityByMonth(storeId, start, end),
  });
  for (const s of forward) {
    if (s.ok) console.log(`  ${fmt(s.month)}: OK — ${s.docsWritten} dokumen.`);
    else console.error(`  ${fmt(s.month)}: GAGAL — ${s.error}`);
  }

  if (backward.some((s) => !s.ok) || forward.some((s) => !s.ok)) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
