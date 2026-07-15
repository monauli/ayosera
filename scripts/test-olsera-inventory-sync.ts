// Test end-to-end sync Inventori Olsera terhadap API + MongoDB nyata.
// - Sync pertama: baseline (lib/olsera-baseline.ts) s/d hari ini (start + step berulang).
// - Idempotensi: run kedua (incremental) tidak menggandakan data.
// - Export: ketiga workbook terbentuk dengan angka Excel (number, bukan string).
//
// Pakai: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/test-olsera-inventory-sync.ts
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

const { startInventorySync, stepInventorySync, getInventorySyncStatus, getInventorySummary } = await import(
  "../lib/olsera-inventory.ts"
);
const { buildInventoryStockWorkbook, buildInventoryMovementWorkbook, buildInventoryConsistencyWorkbook } = await import(
  "../lib/olsera-inventory-export.ts"
);
const { collections, withMongo, mongoClient } = await import("../lib/mongodb.ts");
const { INVENTORY_BASELINE_DATE } = await import("../lib/olsera-inventory-core.ts");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function counts() {
  return withMongo(async () => {
    const { olseraInventoryProducts, olseraInventorySnapshots, olseraInventoryMovements } = await collections();
    const [products, snapshots, movements] = await Promise.all([
      olseraInventoryProducts.countDocuments(),
      olseraInventorySnapshots.countDocuments(),
      olseraInventoryMovements.countDocuments(),
    ]);
    return { products, snapshots, movements };
  });
}

async function runFullSync(label: string) {
  const run = await startInventorySync();
  console.log(`\n[${label}] run ${run.id}: ${run.startDate} s/d ${run.endDate} (${run.totalDays} hari antrian)`);
  let steps = 0;
  for (;;) {
    const result = await stepInventorySync();
    if ("error" in result) throw new Error(result.error);
    steps++;
    if (result.run.phase === "movements" && steps % 20 === 0) {
      console.log(`  ...${result.run.processedDays}/${result.run.totalDays} hari`);
    }
    if (result.done) return { run: result.run, steps };
  }
}

// ---- Run 1: sync pertama (atau lanjutan) dari baseline ----
const statusBefore = await getInventorySyncStatus();
console.log(
  `Status awal: lastSyncedDate=${statusBefore.state.lastSyncedDate}, produk=${statusBefore.productCount}, mutasi=${statusBefore.movementCount}`,
);

const first = await runFullSync("Run 1");
check("run 1 selesai tanpa failed", first.run.status === "success" || first.run.status === "partial");
check(
  "sync pertama mulai dari baseline",
  statusBefore.state.lastSyncedDate !== null || first.run.startDate === INVENTORY_BASELINE_DATE,
  `startDate=${first.run.startDate}`,
);
check("proses bertahap (banyak step kecil)", first.steps === first.run.totalDays + 1, `steps=${first.steps}`);

const afterFirst = await counts();
console.log(`Setelah run 1: ${afterFirst.products} produk, ${afterFirst.snapshots} snapshot, ${afterFirst.movements} mutasi`);
check("katalog produk tersimpan", afterFirst.products > 0);
check("snapshot stok tersimpan", afterFirst.snapshots > 0);

// ---- Run 2: incremental + idempoten ----
const statusMid = await getInventorySyncStatus();
check("checkpoint maju setelah run sukses", first.run.status !== "success" || statusMid.state.lastSyncedDate === first.run.endDate);

const second = await runFullSync("Run 2 (incremental)");
const afterSecond = await counts();
console.log(`Setelah run 2: ${afterSecond.products} produk, ${afterSecond.snapshots} snapshot, ${afterSecond.movements} mutasi`);
check("incremental: rentang run 2 lebih pendek", second.run.totalDays <= first.run.totalDays, `run2=${second.run.totalDays} hari`);
check("upsert: jumlah produk tidak berubah", afterSecond.products === afterFirst.products);
check("upsert: mutasi tidak duplikat", afterSecond.movements === afterFirst.movements);
check("upsert: snapshot tidak duplikat", afterSecond.snapshots === afterFirst.snapshots);

// ---- Summary & status ----
const summary = await getInventorySummary();
console.log(
  `Summary: total=${summary.totalProducts}, aktif=${summary.activeProducts}, habis=${summary.outOfStock}, hampir=${summary.lowStock}, nilai=${summary.totalValue}`,
);
check("summary dihitung dari database", summary.totalProducts === afterSecond.products);
const statusAfter = await getInventorySyncStatus();
check("earliestAvailableDate terisi", Boolean(statusAfter.state.earliestAvailableDate), String(statusAfter.state.earliestAvailableDate));
check("historyCoverage = snapshot-only", statusAfter.state.historyCoverage === "snapshot-only");

// ---- Export ----
const stockWb = await buildInventoryStockWorkbook({});
const stockSheet = stockWb.worksheets[0];
check("export stok: baris data ada", stockSheet.rowCount > 5, `rows=${stockSheet.rowCount}`);
// Kolom 8 = "Stok Saat Ini" (SKU, Produk, Varian, Kategori, Satuan, Outlet, Gudang, Stok Saat Ini, ...).
const sampleCell = stockSheet.getRow(5).getCell(8).value;
check("export stok: kolom stok berupa number", typeof sampleCell === "number", `typeof=${typeof sampleCell}`);

const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const movementWb = await buildInventoryMovementWorkbook({ startDate: INVENTORY_BASELINE_DATE, endDate: today });
check("export mutasi: workbook terbentuk", movementWb.worksheets[0].rowCount > 3);

const consistencyWb = await buildInventoryConsistencyWorkbook();
check("export konsistensi: workbook terbentuk", consistencyWb.worksheets[0].rowCount > 3);

await mongoClient.close().catch(() => undefined);
console.log(failures ? `\n${failures} check GAGAL` : "\nSemua check PASS");
process.exit(failures ? 1 : 0);
