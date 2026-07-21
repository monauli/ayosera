// Bootstrap SATU KALI ledger stok bulanan: baca doc export/INVENTORI.xlsx
// sheet JUNI'26 (file baseline TERVERIFIKASI — nama "Pergerakan Stock Juni
// 2026.xlsx" yang disebut di instruksi TIDAK ADA di repo; file ini dipakai
// karena isinya cocok PERSIS dengan target yang diberikan: 60 produk, 12
// grup, Stok Awal 3368, Barang Masuk 1916, Penjualan 1386, Keluar 46, Stock
// Akhir 3852 — divalidasi di bawah, STOP bila tidak cocok) → tulis 2 dokumen
// per produk ke olsera_inventory_monthly_snapshots:
//   - Mei 2026 (status "boundary-only"): closingQty = Stok Awal Juni dari
//     file (anchor utk backfill mundur — ledger Mei penuh baru lengkap
//     setelah scripts/backfill-monthly-snapshot.ts dijalankan).
//   - Juni 2026 (status "complete"): ledger penuh (opening/incoming/return/
//     sales/outgoing/closing) langsung dari file — anchor utk backfill maju.
// Idempotent: upsert by _id (storeId:year:month:productId:variantId) — aman
// dijalankan ulang, tidak pernah insert baris dobel.
//
// Jalankan: node --no-warnings --experimental-strip-types --import ./scripts/alias-register.mjs scripts/bootstrap-monthly-snapshot-baseline.ts
import path from "path";
import XLSX from "xlsx";
import { normalizeItemName, stripGenericCategoryPrefix, type InventoryProductInput } from "../lib/olsera-inventory-monthly-core.ts";
import { dominantStoreId, lastDayOfMonth, monthlySnapshotDocId, stripDuplicateSuffix } from "../lib/olsera-inventory-monthly-snapshot-core.ts";
import { fetchMatchingContext, getMongoMonthlySnapshotRepo } from "../lib/olsera-inventory-monthly-snapshot-store.ts";
import type { OlseraInventoryMonthlySnapshotDocument } from "../lib/mongodb.ts";

const DOC_DIR = path.join(process.cwd(), "doc export");
const BASELINE_PATH = path.join(DOC_DIR, "INVENTORI.xlsx");
const SHEET_NAME = "JUNI'26";

/**
 * Override nama file baseline -> nama katalog, HANYA untuk "BOLA PADEL
 * ODEA" (nama di file, tanpa warna) -> "BOLA PADEL ODEA ROSE" (nama katalog
 * live) — DIBUKTIKAN live 2026-07-21: sum(qty) olsera_order_items Juni utk
 * resolvedProductId=116138490 (ODEA ROSE) = 46, PERSIS sama dengan kolom
 * Penjualan baris ini di file (45/24/46/2/21). "BOLA PADEL ODEA RED"
 * (productId=119043265) adalah produk BERBEDA — nol transaksi/movement Juni,
 * baru mulai aktif Juli 2026 (terverifikasi live) — TIDAK PERNAH digabung
 * ke sini, dan karena tidak ada baris "ODEA RED" di file baseline, produk
 * itu memang tidak masuk bootstrap (baru muncul lewat backfill maju Juli).
 */
const BASELINE_NAME_OVERRIDE: Record<string, string> = {
  [normalizeItemName("BOLA PADEL ODEA")]: normalizeItemName("BOLA PADEL ODEA ROSE"),
};

const TARGET = { products: 60, groups: 12, stokAwal: 3368, barangMasuk: 1916, penjualan: 1386, keluar: 46, stockAkhir: 3852 } as const;

type BaselineRow = {
  group: string;
  name: string;
  stokAwal: number;
  barangMasuk: number;
  penjualan: number;
  keluar: number;
  stockAkhir: number;
};

function readBaselineRows(): BaselineRow[] {
  const wb = XLSX.readFile(BASELINE_PATH);
  const sheet = wb.Sheets[SHEET_NAME];
  if (!sheet) throw new Error(`Sheet "${SHEET_NAME}" tidak ditemukan di ${BASELINE_PATH}.`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true }) as unknown[][];
  const result: BaselineRow[] = [];
  for (const row of rows) {
    const group = String(row[0] ?? "").trim();
    const name = String(row[1] ?? "").trim();
    if (!group || !name) continue; // lewati baris judul/header tanpa data (Group/Nama kosong)
    if (group.toLowerCase() === "total" || group.toLowerCase() === "group" || name.toLowerCase() === "nama barang") continue; // lewati baris Total & baris header kolom itu sendiri
    result.push({
      group,
      name,
      stokAwal: Number(row[4]) || 0,
      barangMasuk: Number(row[5]) || 0,
      penjualan: Number(row[36]) || 0,
      keluar: Number(row[37]) || 0,
      stockAkhir: Number(row[38]) || 0,
    });
  }
  return result;
}

/**
 * Index tambahan: nama katalog SETELAH dibersihkan (hapus suffix "duplicate"
 * dan/atau prefix kategori generik BOLA/BOLA PADEL/GRIP) -> produk. Perlu
 * KARENA arah mismatch di sini KEBALIKAN dari yang ditangani
 * stripGenericCategoryPrefix biasa: file baseline (laporan resmi, sudah
 * dirapikan manual oleh staf) memakai nama BERSIH ("HEAD PRO ISI 3", "YONEX
 * AC102"), sedangkan katalog Mongo live MASIH memakai nama mentah Olsera
 * ("BOLA HEAD PRO ISI 3", "GRIP YONEX AC102", dan "... duplicate" utk YONEX
 * SHORTS) — dibuktikan live 2026-07-21. Tidak pernah menggabung >1 kandidat
 * (ambigu tetap ambigu, dilaporkan bukan ditebak).
 */
function buildCleanedCatalogNameIndex(products: InventoryProductInput[]): Map<string, InventoryProductInput[]> {
  const index = new Map<string, InventoryProductInput[]>();
  const add = (key: string, product: InventoryProductInput) => {
    const list = index.get(key) ?? [];
    if (!list.includes(product)) list.push(product);
    index.set(key, list);
  };
  for (const product of products) {
    const base = product.variantName ? `${product.name} - ${product.variantName}` : product.name;
    const variants = new Set<string>();
    const noDup = normalizeItemName(stripDuplicateSuffix(base));
    variants.add(noDup);
    const noPrefix = stripGenericCategoryPrefix(normalizeItemName(base));
    if (noPrefix) variants.add(noPrefix);
    const noPrefixNoDup = stripGenericCategoryPrefix(noDup);
    if (noPrefixNoDup) variants.add(noPrefixNoDup);
    variants.delete(normalizeItemName(base)); // jangan duplikasi entri exact-name (sudah ditangani nameIndex biasa)
    for (const variant of variants) add(variant, product);
  }
  return index;
}

function matchProduct(
  row: BaselineRow,
  nameIndex: Map<string, InventoryProductInput[]>,
  cleanedCatalogNameIndex: Map<string, InventoryProductInput[]>,
): { product: InventoryProductInput | null; method: string } {
  const normalized = normalizeItemName(row.name);

  const exact = nameIndex.get(normalized) ?? [];
  if (exact.length === 1) return { product: exact[0], method: "name" };
  if (exact.length > 1) return { product: null, method: "ambiguous-name" };

  const overridden = BASELINE_NAME_OVERRIDE[normalized];
  if (overridden) {
    const candidates = nameIndex.get(overridden) ?? [];
    if (candidates.length === 1) return { product: candidates[0], method: "baseline-override" };
    if (candidates.length > 1) return { product: null, method: "ambiguous-name" };
  }

  const stripped = stripGenericCategoryPrefix(normalized);
  if (stripped) {
    const candidates = nameIndex.get(stripped) ?? [];
    if (candidates.length === 1) return { product: candidates[0], method: "name-prefix-stripped" };
    if (candidates.length > 1) return { product: null, method: "ambiguous-name" };
  }

  const cleaned = cleanedCatalogNameIndex.get(normalized) ?? [];
  if (cleaned.length === 1) return { product: cleaned[0], method: "catalog-name-cleaned" };
  if (cleaned.length > 1) return { product: null, method: "ambiguous-name" };

  return { product: null, method: "unmatched" };
}

async function main() {
  console.log(`Membaca baseline: ${BASELINE_PATH} sheet "${SHEET_NAME}"...`);
  const baselineRows = readBaselineRows();
  console.log(`  ${baselineRows.length} baris produk terbaca.`);

  const groups = new Set(baselineRows.map((r) => r.group));
  const sum = (f: (r: BaselineRow) => number) => baselineRows.reduce((s, r) => s + f(r), 0);
  const totals = {
    products: baselineRows.length,
    groups: groups.size,
    stokAwal: sum((r) => r.stokAwal),
    barangMasuk: sum((r) => r.barangMasuk),
    penjualan: sum((r) => r.penjualan),
    keluar: sum((r) => r.keluar),
    stockAkhir: sum((r) => r.stockAkhir),
  };
  console.log("Total baseline:", totals);

  const mismatches = (Object.keys(TARGET) as (keyof typeof TARGET)[]).filter((k) => totals[k] !== TARGET[k]);
  if (mismatches.length) {
    console.error("STOP — total baseline TIDAK cocok dengan target:");
    for (const k of mismatches) console.error(`  - ${k}: file=${totals[k]} target=${TARGET[k]}`);
    process.exitCode = 1;
    return;
  }
  console.log("Total baseline cocok PERSIS dengan target. Lanjut matching ke katalog Mongo live...");

  const matchingContext = await fetchMatchingContext();
  console.log(
    `Katalog: ${matchingContext.catalogProducts.length} produk (dikecualikan sebagai duplicate SKU-proven: ${matchingContext.duplicateResolution.excludedIds.length}).`,
  );

  const storeId = dominantStoreId(matchingContext.catalogProducts);
  const cleanedCatalogNameIndex = buildCleanedCatalogNameIndex(matchingContext.catalogProducts);

  const matched: { row: BaselineRow; product: InventoryProductInput; method: string }[] = [];
  const unmatched: { row: BaselineRow; method: string }[] = [];
  for (const row of baselineRows) {
    const result = matchProduct(row, matchingContext.nameIndex, cleanedCatalogNameIndex);
    if (result.product) matched.push({ row, product: result.product, method: result.method });
    else unmatched.push({ row, method: result.method });
  }

  console.log(`Matched: ${matched.length}/${baselineRows.length}.`);
  if (unmatched.length) {
    console.error("STOP — ada baris baseline yang TIDAK cocok ke katalog (tidak pernah ditebak):");
    for (const u of unmatched) console.error(`  - [${u.method}] ${u.row.group} / ${u.row.name}`);
    process.exitCode = 1;
    return;
  }

  const methodCounts = new Map<string, number>();
  for (const m of matched) methodCounts.set(m.method, (methodCounts.get(m.method) ?? 0) + 1);
  console.log("Metode matching:", Object.fromEntries(methodCounts));

  const now = new Date();
  const mayDocs: OlseraInventoryMonthlySnapshotDocument[] = [];
  const juneDocs: OlseraInventoryMonthlySnapshotDocument[] = [];
  for (const { row, product, method } of matched) {
    const name = product.variantName ? `${product.name} - ${product.variantName}` : product.name;
    mayDocs.push({
      _id: monthlySnapshotDocId(storeId, 2026, 5, product.productId, product.variantId),
      storeId,
      year: 2026,
      month: 5,
      snapshotDate: lastDayOfMonth(2026, 5),
      productId: product.productId,
      variantId: product.variantId,
      canonicalProductId: null,
      productName: name,
      productSku: product.sku,
      groupName: row.group,
      openingQty: null,
      incomingQty: null,
      returnQty: null,
      salesQty: null,
      outgoingQty: null,
      closingQty: row.stokAwal,
      source: "baseline-file",
      status: "boundary-only",
      diagnostics: [
        "Hanya closingQty (= Stok Awal Juni dari file baseline doc export/INVENTORI.xlsx sheet JUNI'26) — ledger Mei penuh dilengkapi scripts/backfill-monthly-snapshot.ts (arah mundur).",
      ],
      createdAt: now,
      updatedAt: now,
    });
    juneDocs.push({
      _id: monthlySnapshotDocId(storeId, 2026, 6, product.productId, product.variantId),
      storeId,
      year: 2026,
      month: 6,
      snapshotDate: lastDayOfMonth(2026, 6),
      productId: product.productId,
      variantId: product.variantId,
      canonicalProductId: null,
      productName: name,
      productSku: product.sku,
      groupName: row.group,
      openingQty: row.stokAwal,
      incomingQty: row.barangMasuk,
      returnQty: 0,
      salesQty: row.penjualan,
      outgoingQty: row.keluar,
      closingQty: row.stockAkhir,
      source: "baseline-file",
      status: "complete",
      diagnostics: [`Dari file baseline doc export/INVENTORI.xlsx sheet JUNI'26 (total tervalidasi cocok persis target perusahaan) — metode matching nama: ${method}.`],
      createdAt: now,
      updatedAt: now,
    });
  }

  const repo = await getMongoMonthlySnapshotRepo();
  await repo.upsertMany(mayDocs);
  await repo.upsertMany(juneDocs);
  console.log(`Upsert selesai (idempotent): ${mayDocs.length} dokumen Mei 2026 (boundary-only), ${juneDocs.length} dokumen Juni 2026 (complete).`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
