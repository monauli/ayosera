// AUDIT READ-ONLY — diagnostic untuk mengonfirmasi/menyangkal temuan audit
// lama "37 movement dengan productId null" (2026-05-01..2026-07-13) terhadap
// hasil dry-run Phase 5B yang melaporkan 0 finding movement-null di seluruh
// Feb-Jul 2026 (lib/reconciliation-sources.ts loadInventoryMovementFindings
// hanya mendeteksi productId === null secara STRICT — skrip ini memeriksa
// SEMUA bentuk "identitas hilang" yang mungkin terlewat oleh strict check
// tsb: field tidak ada sama sekali, string kosong, tipe data tidak terduga).
// Logika klasifikasi murni ada di lib/reconciliation-inventory-null-audit-core.ts
// (testable tanpa MongoDB) — skrip ini hanya orkestrasi baca data.
//
// GARIS KERAS: skrip ini TIDAK PERNAH menulis ke MongoDB, TIDAK memanggil API
// Olsera/AYO live, TIDAK melakukan sync/backfill, TIDAK mencetak
// token/URI/credential, dan TIDAK mencetak payload mentah besar (hanya field
// identitas + jumlah, dibatasi contoh). Selalu memfilter berdasarkan storeId.
//
// Penggunaan:
//   npm run audit:reconciliation-null-product -- --from=2026-05-01 --to=2026-07-31
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
// PENTING: harus dimuat SEBELUM import lib/mongodb.ts — lihat pola sama di
// scripts/audit-order-item-identity-2026.ts. Dynamic import ditunda ke dalam
// main() (bukan top-level await) supaya kompatibel dengan tsx tanpa
// package.json "type":"module".
loadLocalEnv();

const DEFAULT_FROM = "2026-05-01";
const DEFAULT_TO = "2026-07-31";
const EXPECTED_NULL_PRODUCT_MOVEMENTS = 37;
const MAX_SAMPLES_PER_GROUP = 8;

type Args = { from: string; to: string; storeId: number | null; jsonOutput: string | null };

function parseArgs(argv: string[]): Args {
  let from = DEFAULT_FROM;
  let to = DEFAULT_TO;
  let storeId: number | null = null;
  let jsonOutput: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--from=")) from = arg.slice("--from=".length);
    else if (arg.startsWith("--to=")) to = arg.slice("--to=".length);
    else if (arg.startsWith("--store-id=")) storeId = Number(arg.slice("--store-id=".length));
    else if (arg.startsWith("--json-output=")) jsonOutput = arg.slice("--json-output=".length);
  }
  return { from, to, storeId, jsonOutput };
}

async function main() {
  const { classifyField, classifyProductId, isMissingIdentity, validateDateArg, validateStoreIdArg } = await import(
    "../lib/reconciliation-inventory-null-audit-core.ts"
  );

  const args = parseArgs(process.argv.slice(2));
  const from = validateDateArg(args.from, "--from");
  const to = validateDateArg(args.to, "--to");
  const storeIdEnv = process.env.OLSERA_INTERNAL_STORE_ID ? Number(process.env.OLSERA_INTERNAL_STORE_ID) : null;
  const storeId = validateStoreIdArg(args.storeId ?? storeIdEnv);

  console.log(`[audit-null-product] storeId=${storeId} from=${from} to=${to} (read-only, tidak menulis MongoDB)`);

  const { collections } = await import("../lib/mongodb.ts");
  const { olseraInventoryMovements } = await collections();

  // Proyeksi eksplisit (BUKAN seluruh dokumen) — hanya field identitas + metadata ringan, TIDAK ADA payload mentah besar.
  const rawDocs = await olseraInventoryMovements
    .find({ storeId, date: { $gte: from, $lte: to } })
    .project({ _id: 1, date: 1, productId: 1, variantId: 1, sku: 1, productName: 1, qtyChange: 1, storeId: 1 })
    .toArray();

  console.log(`[audit-null-product] total movement dibaca (storeId=${storeId}, ${from}..${to}): ${rawDocs.length}`);

  type Row = {
    _id: string;
    month: string;
    productIdState: ReturnType<typeof classifyProductId>;
    variantIdState: ReturnType<typeof classifyField>;
    skuState: ReturnType<typeof classifyField>;
    productName: string;
  };

  const rows: Row[] = [];
  for (const raw of rawDocs as unknown as Record<string, unknown>[]) {
    const productIdState = classifyProductId(raw);
    if (!isMissingIdentity(productIdState)) continue; // hanya catat yang identitasnya bermasalah
    const date = String(raw.date ?? "");
    rows.push({
      _id: String(raw._id),
      month: date.slice(0, 7),
      productIdState,
      variantIdState: classifyField(raw, "variantId"),
      skuState: classifyField(raw, "sku"),
      // productName dipotong (bukan payload mentah besar) — hanya untuk identifikasi manusia.
      productName: typeof raw.productName === "string" ? raw.productName.slice(0, 60) : "(tidak ada)",
    });
  }

  const totalMissing = rows.length;
  const byMonth = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, []);
    byMonth.get(r.month)!.push(r);
  }
  const byState = new Map<string, number>();
  for (const r of rows) byState.set(r.productIdState, (byState.get(r.productIdState) ?? 0) + 1);

  console.log(`[audit-null-product] total movement dengan identitas productId bermasalah: ${totalMissing} (ekspektasi Known Case: ${EXPECTED_NULL_PRODUCT_MOVEMENTS})`);
  console.log(`[audit-null-product] rincian per bentuk: ${JSON.stringify(Object.fromEntries(byState))}`);
  for (const [month, groupRows] of [...byMonth.entries()].sort()) {
    console.log(`[audit-null-product]   ${month}: ${groupRows.length} movement`);
  }

  const matches = totalMissing === EXPECTED_NULL_PRODUCT_MOVEMENTS;
  console.log(
    matches
      ? `[audit-null-product] COCOK dengan angka Known Case (${EXPECTED_NULL_PRODUCT_MOVEMENTS}).`
      : `[audit-null-product] TIDAK COCOK dengan angka Known Case (${EXPECTED_NULL_PRODUCT_MOVEMENTS}) — lihat rincian per bentuk & per bulan di atas untuk investigasi lanjutan (rentang tanggal/field/storeId berbeda). Tidak ada kode yang dipaksa menghasilkan 37.`,
  );

  const output = {
    generatedAt: new Date().toISOString(),
    storeId,
    range: { from, to },
    totalMovementsRead: rawDocs.length,
    totalMissingProductIdentity: totalMissing,
    expectedFromKnownCase: EXPECTED_NULL_PRODUCT_MOVEMENTS,
    matchesKnownCase: matches,
    byIdentityState: Object.fromEntries(byState),
    byMonth: Object.fromEntries([...byMonth.entries()].sort().map(([m, r]) => [m, r.length])),
    samples: Object.fromEntries([...byMonth.entries()].sort().map(([m, r]) => [m, r.slice(0, MAX_SAMPLES_PER_GROUP)])),
  };

  if (args.jsonOutput) {
    mkdirSync(path.dirname(args.jsonOutput), { recursive: true });
    writeFileSync(args.jsonOutput, JSON.stringify(output, null, 2));
    console.log(`[audit-null-product] output ditulis ke ${args.jsonOutput}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[audit-null-product] gagal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
