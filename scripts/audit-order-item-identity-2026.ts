// AUDIT READ-ONLY — olsera_order_items yang kehilangan productId/variantId/sku
// (periode order 2026-05-01..2026-07-13, syncedAt sekitar 11-14 Juli 2026).
//
// GARIS KERAS: skrip ini TIDAK PERNAH menulis ke MongoDB, TIDAK memanggil API
// Olsera live, TIDAK melakukan sync/backfill, dan TIDAK mencetak
// token/URI/password. Hanya membaca collections lewat lib/mongodb.ts dan
// menulis artefak ke tmp/order-item-identity-audit-2026/.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

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
// PENTING: harus dimuat SEBELUM import lib/mongodb.ts (yang membaca
// process.env.MONGODB_URI di top-level module) — karena itu dynamic import
// dipakai di bawah setelah loadLocalEnv() dipanggil.
loadLocalEnv();
const { collections } = await import("../lib/mongodb.ts");
const { normalizeName } = await import("../lib/olsera-category-resolver.ts");

const OUT_DIR = path.join(process.cwd(), "tmp", "order-item-identity-audit-2026");
const GAP_START = "2026-05-01";
const GAP_END = "2026-07-13";

type GapField = "absent" | "null" | "empty" | "present";

type Row = {
  _id: number;
  date: string;
  orderNo: string;
  itemName: string;
  normalizedItemName: string;
  qty: number;
  amount: number;
  syncedAt: Date | null;
  productId: number | null | undefined;
  variantId: number | null | undefined;
  sku: string | null | undefined;
  originalCategoryName: string | null | undefined;
  resolvedCategoryName: string | null | undefined;
  categoryResolutionStatus: string | null | undefined;
  categoryResolutionMethod: string | null | undefined;
  resolvedProductId: number | null | undefined;
};

function fieldState(raw: Record<string, unknown>, key: string): GapField {
  if (!(key in raw)) return "absent";
  const v = raw[key];
  if (v === null) return "null";
  if (typeof v === "string" && v.trim() === "") return "empty";
  return "present";
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const { olseraOrderItems, olseraInventoryProducts, olseraProductAliases, olseraInventoryMovements } = await collections();

  // --- 1. Ambil seluruh baris dalam periode temuan (proyeksi lengkap agar bisa membedakan absent/null/empty) ---
  const rawRows = await olseraOrderItems
    .find({ date: { $gte: GAP_START, $lte: GAP_END } })
    .project({
      _id: 1, date: 1, orderNo: 1, itemName: 1, normalizedItemName: 1, qty: 1, amount: 1, syncedAt: 1,
      productId: 1, variantId: 1, sku: 1, originalCategoryName: 1, originalCategoryId: 1,
      resolvedCategoryName: 1, categoryResolutionStatus: 1, categoryResolutionMethod: 1, resolvedProductId: 1,
    })
    .toArray();

  const fieldStates = rawRows.map((raw) => ({
    productId: fieldState(raw as Record<string, unknown>, "productId"),
    variantId: fieldState(raw as Record<string, unknown>, "variantId"),
    sku: fieldState(raw as Record<string, unknown>, "sku"),
  }));

  const gapped: Row[] = [];
  const gappedFieldStates: { productId: GapField; variantId: GapField; sku: GapField }[] = [];
  rawRows.forEach((raw, i) => {
    const fs = fieldStates[i];
    const isGapped = fs.productId !== "present" || fs.variantId !== "present" || fs.sku !== "present";
    if (!isGapped) return;
    gapped.push({
      _id: raw._id,
      date: raw.date,
      orderNo: raw.orderNo,
      itemName: raw.itemName,
      normalizedItemName: raw.normalizedItemName ?? normalizeName(raw.itemName),
      qty: raw.qty,
      amount: raw.amount,
      syncedAt: raw.syncedAt ?? null,
      productId: raw.productId,
      variantId: raw.variantId,
      sku: raw.sku,
      originalCategoryName: raw.originalCategoryName,
      resolvedCategoryName: raw.resolvedCategoryName,
      categoryResolutionStatus: raw.categoryResolutionStatus,
      categoryResolutionMethod: raw.categoryResolutionMethod,
      resolvedProductId: raw.resolvedProductId,
    });
    gappedFieldStates.push(fs);
  });

  console.log(`Total baris periode ${GAP_START}..${GAP_END}: ${rawRows.length}`);
  console.log(`Total baris gapped (productId/variantId/sku tidak "present"): ${gapped.length}`);

  const uniqueNames = [...new Set(gapped.map((r) => r.normalizedItemName))];

  // --- 2. Katalog aktif/nonaktif (olsera_inventory_products) — sumber kandidat ---
  const catalogDocs = await olseraInventoryProducts.find().toArray();
  type CatalogEntry = { productId: number; variantId: number | null; sku: string | null; name: string; active: boolean };
  const catalogByName = new Map<string, CatalogEntry[]>();
  const catalogByBaseName = new Map<string, CatalogEntry[]>();
  for (const p of catalogDocs) {
    const fullName = p.variantName ? `${p.name} - ${p.variantName}` : p.name;
    const entry: CatalogEntry = { productId: p.productId, variantId: p.variantId, sku: p.sku, name: fullName, active: p.active };
    const key = normalizeName(fullName);
    if (!catalogByName.has(key)) catalogByName.set(key, []);
    catalogByName.get(key)!.push(entry);
    const baseKey = normalizeName(p.name);
    if (!catalogByBaseName.has(baseKey)) catalogByBaseName.set(baseKey, []);
    catalogByBaseName.get(baseKey)!.push(entry);
  }

  // --- 3. Alias produk (olsera_product_aliases) ---
  const aliasDocs = await olseraProductAliases.find().toArray();
  const aliasByName = new Map<string, typeof aliasDocs>();
  for (const a of aliasDocs) {
    if (!a.normalizedName) continue;
    if (!aliasByName.has(a.normalizedName)) aliasByName.set(a.normalizedName, []);
    aliasByName.get(a.normalizedName)!.push(a);
  }

  // --- 4. Identitas historis: baris LAIN (dalam/luar periode) dgn nama sama yg PUNYA productId ---
  const historicalAgg = await olseraOrderItems
    .aggregate<{ _id: string; combos: { productId: number; variantId: number | null; sku: string | null }[]; minDate: string; maxDate: string }>([
      { $match: { normalizedItemName: { $in: uniqueNames }, productId: { $type: "number" } } },
      {
        $group: {
          _id: "$normalizedItemName",
          combos: { $addToSet: { productId: "$productId", variantId: "$variantId", sku: "$sku" } },
          minDate: { $min: "$date" },
          maxDate: { $max: "$date" },
        },
      },
    ])
    .toArray();
  const historicalByName = new Map(historicalAgg.map((h) => [h._id, h]));

  // --- 5. Inventory movement (source: sale) yang sudah tercatat untuk baris gapped ini ---
  const movementIds = gapped.map((r) => `sale:${r._id}`);
  const movements = await olseraInventoryMovements.find({ _id: { $in: movementIds } }).toArray();
  const movementById = new Map(movements.map((m) => [m._id, m]));

  // --- 6. Duplicate candidate: baris gapped dgn (date, orderNo, itemName, qty, amount) sama ---
  const dupKeyCount = new Map<string, number>();
  for (const r of gapped) {
    const k = `${r.date}|${r.orderNo}|${r.normalizedItemName}|${r.qty}|${r.amount}`;
    dupKeyCount.set(k, (dupKeyCount.get(k) ?? 0) + 1);
  }

  type Classification =
    | "Exact Match"
    | "Exact Product, Variant Ambiguous"
    | "Name Match Only"
    | "Historical Product"
    | "Product Missing"
    | "Duplicate Candidate"
    | "Butuh Adjust Manual";

  type Candidate = { source: string; productId: number | null; variantId: number | null; sku: string | null; note: string };

  type Classified = Row & {
    classification: Classification;
    candidates: Candidate[];
    isDuplicateCandidate: boolean;
    inventoryMovementExists: boolean;
    inventoryMovementNote: string | null;
    inventoryMovementProductId: number | null;
    categorySafe: boolean;
    fieldStates: { productId: GapField; variantId: GapField; sku: GapField };
    manualReason: string | null;
  };

  const results: Classified[] = gapped.map((r, i) => {
    const fs = gappedFieldStates[i];
    const candidates: Candidate[] = [];
    const key = r.normalizedItemName;
    const baseKey = normalizeName(r.itemName.split(" - ")[0]);

    const fullNameHits = catalogByName.get(key) ?? [];
    const baseNameHits = key !== baseKey ? (catalogByName.get(baseKey) ?? []) : [];
    const baseProductHits = catalogByBaseName.get(key === baseKey ? key : baseKey) ?? [];
    const aliasHits = aliasByName.get(key) ?? [];
    const hist = historicalByName.get(key);

    for (const h of fullNameHits) candidates.push({ source: "catalog-name-exact", productId: h.productId, variantId: h.variantId, sku: h.sku, note: `katalog: ${h.name} (${h.active ? "aktif" : "nonaktif"})` });
    for (const h of aliasHits) candidates.push({ source: "alias", productId: h.newProductId, variantId: h.newVariantId, sku: h.sku, note: `alias: ${h.source} (${h.confidence})` });
    if (hist) for (const c of hist.combos) candidates.push({ source: "historical", productId: c.productId, variantId: c.variantId, sku: c.sku, note: `histori ${hist.minDate}..${hist.maxDate}` });

    const movement = movementById.get(`sale:${r._id}`);
    // OlseraInventoryMovementDocument tidak punya field "method" tersimpan — hanya
    // productId/variantId/sku hasil selectMovementProduct (null bila unmatched/ambiguous)
    // dan `note` berisi teks alasan human-readable (lihat MOVEMENT_MAPPING_NOTE di
    // lib/olsera-inventory-core.ts). Gunakan productId null sbg penanda "tidak tertaut".

    let classification: Classification;
    let manualReason: string | null = null;

    const distinctFullNameProductVariant = new Set(fullNameHits.map((h) => `${h.productId}:${h.variantId ?? "null"}`));
    const distinctHistCombos = hist ? new Set(hist.combos.map((c) => `${c.productId}:${c.variantId ?? "null"}`)) : new Set<string>();
    const distinctBaseProducts = new Set(baseProductHits.map((h) => h.productId));

    const isDup = (dupKeyCount.get(`${r.date}|${r.orderNo}|${r.normalizedItemName}|${r.qty}|${r.amount}`) ?? 0) > 1;

    if (fullNameHits.length > 0 && distinctFullNameProductVariant.size === 1 && (!hist || distinctHistCombos.size === 0 || (distinctHistCombos.size === 1 && distinctHistCombos.has([...distinctFullNameProductVariant][0])))) {
      // Nama lengkap (termasuk suffix varian bila ada) cocok tepat SATU produk+varian di katalog,
      // dan histori (bila ada) tidak bertentangan.
      classification = "Exact Match";
    } else if (fullNameHits.length > 0 && distinctFullNameProductVariant.size > 1) {
      classification = "Butuh Adjust Manual";
      manualReason = "Nama lengkap cocok lebih dari satu kombinasi produk+varian di katalog (ambigu).";
    } else if (distinctBaseProducts.size === 1 && baseProductHits.length > 1 && fullNameHits.length === 0) {
      // Nama dasar (tanpa suffix varian) cocok SATU produk, tapi produk itu punya >1 varian
      // dan item TIDAK menyebut varian secara eksplisit -> jangan menebak variantId.
      classification = "Exact Product, Variant Ambiguous";
      manualReason = "Produk teridentifikasi via nama dasar, tetapi produk memiliki beberapa varian aktif dan histori tidak cukup untuk memastikan variant mana — TIDAK diisi otomatis berdasarkan nama produk induk saja.";
    } else if (distinctBaseProducts.size > 1) {
      classification = "Butuh Adjust Manual";
      manualReason = "Nama dasar cocok dengan lebih dari satu productId berbeda di katalog.";
    } else if (fullNameHits.length === 0 && distinctBaseProducts.size === 0 && hist && distinctHistCombos.size === 1) {
      // Tidak ada di katalog (produk mungkin nonaktif/dihapus), tapi histori order_items lain
      // dengan nama sama SELALU konsisten pada satu productId/variantId/sku.
      classification = "Historical Product";
    } else if (fullNameHits.length === 0 && distinctBaseProducts.size === 0 && hist && distinctHistCombos.size > 1) {
      classification = "Butuh Adjust Manual";
      manualReason = "Histori nama yang sama menunjukkan lebih dari satu kombinasi productId/variantId/sku berbeda — tidak konsisten.";
    } else if (fullNameHits.length === 0 && distinctBaseProducts.size === 0 && (!hist || distinctHistCombos.size === 0) && aliasHits.length === 0) {
      classification = "Product Missing";
      manualReason = "Tidak ditemukan di katalog aktif/nonaktif, tidak ada alias, dan tidak ada histori order_items lain dengan productId untuk nama ini.";
    } else if (aliasHits.length > 0 && fullNameHits.length === 0 && distinctBaseProducts.size === 0 && (!hist || distinctHistCombos.size === 0)) {
      const distinctAlias = new Set(aliasHits.map((a) => `${a.newProductId}:${a.newVariantId ?? "null"}`));
      classification = distinctAlias.size === 1 ? "Historical Product" : "Butuh Adjust Manual";
      if (distinctAlias.size !== 1) manualReason = "Lebih dari satu alias produk untuk nama yang sama.";
    } else {
      classification = "Name Match Only";
    }

    // Duplicate candidate hanya menggantikan klasifikasi bila identitas TIDAK bisa dipastikan
    // (Product Missing / Butuh Adjust Manual) — supaya tidak menutupi match yang sudah baik.
    if (isDup && (classification === "Product Missing" || classification === "Butuh Adjust Manual")) {
      classification = "Duplicate Candidate";
      manualReason = (manualReason ? manualReason + " " : "") + "Baris ini juga terindikasi duplikat (date+orderNo+itemName+qty+amount identik dengan baris gapped lain).";
    }

    const categorySafe = r.categoryResolutionStatus === "resolved" && !!r.resolvedCategoryName;

    return {
      ...r,
      classification,
      candidates,
      isDuplicateCandidate: isDup,
      inventoryMovementExists: !!movement,
      inventoryMovementNote: movement?.note ?? null,
      inventoryMovementProductId: movement?.productId ?? null,
      categorySafe,
      fieldStates: fs,
      manualReason,
    };
  });

  // --- 7. Agregat ---
  const totalRows = results.length;
  const uniqueOrders = new Set(results.map((r) => r.orderNo)).size;
  // transactionId tidak ada field terpisah di skema ini; orderNo dipakai sbg identitas transaksi (lihat lib/mongodb.ts OlseraOrderItemDocument — tidak ada transactionId eksplisit).
  const uniqueTransactions = uniqueOrders;
  const uniqueProductNames = new Set(results.map((r) => r.normalizedItemName)).size;
  const byClass = new Map<Classification, number>();
  for (const r of results) byClass.set(r.classification, (byClass.get(r.classification) ?? 0) + 1);
  const exactCount = byClass.get("Exact Match") ?? 0;
  const ambiguousCount = (byClass.get("Exact Product, Variant Ambiguous") ?? 0) + (byClass.get("Butuh Adjust Manual") ?? 0);
  const unresolvedCount = (byClass.get("Product Missing") ?? 0) + (byClass.get("Duplicate Candidate") ?? 0);
  const totalOmzet = results.reduce((s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0), 0);
  const totalQty = results.reduce((s, r) => s + (Number.isFinite(r.qty) ? r.qty : 0), 0);
  const categoryUnsafeCount = results.filter((r) => !r.categorySafe).length;
  const movementUnmatchedCount = results.filter((r) => r.inventoryMovementExists && r.inventoryMovementProductId === null).length;
  const movementMissingDocCount = results.filter((r) => !r.inventoryMovementExists).length;
  const movementOkCount = results.filter((r) => r.inventoryMovementExists && r.inventoryMovementProductId !== null).length;

  // --- 8. Tulis artefak ---
  writeFileSync(
    path.join(OUT_DIR, "raw-evidence.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        gapPeriod: { start: GAP_START, end: GAP_END },
        totalRowsInPeriod: rawRows.length,
        totalGappedRows: totalRows,
        expectedGappedRows: 6271,
        aggregates: {
          uniqueOrders, uniqueTransactions, uniqueProductNames,
          totalOmzet, totalQty, categoryUnsafeCount, movementOkCount, movementUnmatchedCount, movementMissingDocCount,
          byClassification: Object.fromEntries(byClass),
        },
        rows: results.map((r) => ({
          orderItemId: r._id, date: r.date, orderNo: r.orderNo, itemName: r.itemName, qty: r.qty, amount: r.amount,
          syncedAt: r.syncedAt, fieldStates: r.fieldStates, classification: r.classification, manualReason: r.manualReason,
          isDuplicateCandidate: r.isDuplicateCandidate, candidates: r.candidates,
          categoryResolutionStatus: r.categoryResolutionStatus, categoryResolutionMethod: r.categoryResolutionMethod,
          resolvedCategoryName: r.resolvedCategoryName, categorySafe: r.categorySafe,
          inventoryMovementExists: r.inventoryMovementExists, inventoryMovementNote: r.inventoryMovementNote, inventoryMovementProductId: r.inventoryMovementProductId,
        })),
      },
      null,
      2,
    ),
  );

  async function writeSheet(fileName: string, rows: Classified[], columns: { header: string; key: string; width?: number }[], mapRow: (r: Classified) => Record<string, unknown>) {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Data");
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    for (const r of rows) sheet.addRow(mapRow(r));
    await wb.xlsx.writeFile(path.join(OUT_DIR, fileName));
  }

  const commonColumns = [
    { header: "orderItemId", key: "orderItemId", width: 14 },
    { header: "date", key: "date", width: 12 },
    { header: "orderNo", key: "orderNo", width: 16 },
    { header: "itemName", key: "itemName", width: 32 },
    { header: "qty", key: "qty", width: 8 },
    { header: "amount", key: "amount", width: 14 },
    { header: "syncedAt", key: "syncedAt", width: 22 },
    { header: "productId_state", key: "productIdState", width: 14 },
    { header: "variantId_state", key: "variantIdState", width: 14 },
    { header: "sku_state", key: "skuState", width: 12 },
    { header: "classification", key: "classification", width: 30 },
    { header: "manualReason", key: "manualReason", width: 50 },
    { header: "isDuplicateCandidate", key: "isDuplicateCandidate", width: 10 },
    { header: "categoryResolutionStatus", key: "categoryResolutionStatus", width: 16 },
    { header: "categoryResolutionMethod", key: "categoryResolutionMethod", width: 18 },
    { header: "resolvedCategoryName", key: "resolvedCategoryName", width: 20 },
    { header: "categorySafe", key: "categorySafe", width: 10 },
    { header: "inventoryMovementExists", key: "inventoryMovementExists", width: 14 },
    { header: "inventoryMovementProductId", key: "inventoryMovementProductId", width: 16 },
    { header: "inventoryMovementNote", key: "inventoryMovementNote", width: 40 },
    { header: "candidateSummary", key: "candidateSummary", width: 60 },
  ];
  const mapCommon = (r: Classified) => ({
    orderItemId: r._id, date: r.date, orderNo: r.orderNo, itemName: r.itemName, qty: r.qty, amount: r.amount,
    syncedAt: r.syncedAt ? new Date(r.syncedAt).toISOString() : "",
    productIdState: r.fieldStates.productId, variantIdState: r.fieldStates.variantId, skuState: r.fieldStates.sku,
    classification: r.classification, manualReason: r.manualReason ?? "",
    isDuplicateCandidate: r.isDuplicateCandidate ? "YA" : "",
    categoryResolutionStatus: r.categoryResolutionStatus ?? "", categoryResolutionMethod: r.categoryResolutionMethod ?? "",
    resolvedCategoryName: r.resolvedCategoryName ?? "", categorySafe: r.categorySafe ? "YA" : "TIDAK",
    inventoryMovementExists: r.inventoryMovementExists ? "YA" : "TIDAK",
    inventoryMovementProductId: r.inventoryMovementProductId ?? "",
    inventoryMovementNote: r.inventoryMovementNote ?? "",
    candidateSummary: r.candidates.map((c) => `${c.source}:${c.productId ?? "-"}/${c.variantId ?? "-"}/${c.sku ?? "-"}`).join(" | "),
  });

  await writeSheet("affected-items.xlsx", results, commonColumns, mapCommon);
  await writeSheet("exact-matches.xlsx", results.filter((r) => r.classification === "Exact Match"), commonColumns, mapCommon);
  await writeSheet(
    "ambiguous-items.xlsx",
    results.filter((r) => r.classification === "Exact Product, Variant Ambiguous" || r.classification === "Butuh Adjust Manual"),
    commonColumns,
    mapCommon,
  );
  await writeSheet(
    "unresolved-items.xlsx",
    results.filter((r) => r.classification === "Product Missing" || r.classification === "Duplicate Candidate"),
    commonColumns,
    mapCommon,
  );

  // candidate-mapping.xlsx: satu baris per kandidat (bisa lebih dari satu per orderItemId)
  {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Candidates");
    sheet.columns = [
      { header: "orderItemId", key: "orderItemId", width: 14 },
      { header: "itemName", key: "itemName", width: 32 },
      { header: "classification", key: "classification", width: 30 },
      { header: "candidateSource", key: "candidateSource", width: 18 },
      { header: "candidateProductId", key: "candidateProductId", width: 16 },
      { header: "candidateVariantId", key: "candidateVariantId", width: 16 },
      { header: "candidateSku", key: "candidateSku", width: 16 },
      { header: "note", key: "note", width: 50 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const r of results) {
      if (r.candidates.length === 0) {
        sheet.addRow({ orderItemId: r._id, itemName: r.itemName, classification: r.classification, candidateSource: "(tidak ada kandidat)", candidateProductId: "", candidateVariantId: "", candidateSku: "", note: "" });
        continue;
      }
      for (const c of r.candidates) {
        sheet.addRow({ orderItemId: r._id, itemName: r.itemName, classification: r.classification, candidateSource: c.source, candidateProductId: c.productId ?? "", candidateVariantId: c.variantId ?? "", candidateSku: c.sku ?? "", note: c.note });
      }
    }
    await wb.xlsx.writeFile(path.join(OUT_DIR, "candidate-mapping.xlsx"));
  }

  // impact-analysis.xlsx: ringkasan dampak
  {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Impact");
    sheet.columns = [
      { header: "Metric", key: "metric", width: 55 },
      { header: "Value", key: "value", width: 30 },
      { header: "Note", key: "note", width: 70 },
    ];
    sheet.getRow(1).font = { bold: true };
    const rows: { metric: string; value: unknown; note: string }[] = [
      { metric: "Total baris dalam periode temuan", value: rawRows.length, note: `${GAP_START} s/d ${GAP_END}` },
      { metric: "Total baris gapped (missing productId/variantId/sku)", value: totalRows, note: "target instruksi: 6.271 baris" },
      { metric: "Selisih vs 6.271 baris yang dilaporkan", value: totalRows - 6271, note: "0 berarti cocok persis" },
      { metric: "Total order unik (orderNo)", value: uniqueOrders, note: "" },
      { metric: "Total transaksi unik", value: uniqueTransactions, note: "skema tidak punya field transactionId terpisah — orderNo dipakai sbg identitas transaksi" },
      { metric: "Jumlah nama produk unik (normalizedItemName)", value: uniqueProductNames, note: "" },
      { metric: "Exact Match", value: exactCount, note: "aman untuk backfill otomatis" },
      { metric: "Exact Product, Variant Ambiguous", value: byClass.get("Exact Product, Variant Ambiguous") ?? 0, note: "produk pasti, varian TIDAK diisi otomatis" },
      { metric: "Butuh Adjust Manual", value: byClass.get("Butuh Adjust Manual") ?? 0, note: "kandidat lebih dari satu / bertentangan" },
      { metric: "Historical Product", value: byClass.get("Historical Product") ?? 0, note: "produk kemungkinan nonaktif/dihapus dari katalog, histori konsisten" },
      { metric: "Name Match Only", value: byClass.get("Name Match Only") ?? 0, note: "cocok nama tapi tidak masuk kategori match kuat lainnya — perlu review" },
      { metric: "Product Missing", value: byClass.get("Product Missing") ?? 0, note: "tidak ada kandidat sama sekali" },
      { metric: "Duplicate Candidate", value: byClass.get("Duplicate Candidate") ?? 0, note: "date+orderNo+itemName+qty+amount identik dgn baris gapped lain, DAN identitas tidak pasti" },
      { metric: "Total ambiguous (Variant Ambiguous + Butuh Adjust Manual)", value: ambiguousCount, note: "" },
      { metric: "Total unresolved (Product Missing + Duplicate Candidate)", value: unresolvedCount, note: "" },
      { metric: "Total omzet (amount) pada baris terdampak", value: totalOmzet, note: "amount TIDAK bergantung pada productId/variantId/sku — angka ini sudah tersimpan independen di setiap baris" },
      { metric: "Total qty pada baris terdampak", value: totalQty, note: "" },
      { metric: "Baris dengan categoryResolutionStatus != resolved (kategori BELUM aman)", value: categoryUnsafeCount, note: "kategori resolver punya fallback name/historical yg tidak butuh productId — mayoritas biasanya tetap resolved" },
      { metric: "Baris dgn inventory movement ADA & productId TERTAUT (aman)", value: movementOkCount, note: "movement stok sudah tertaut ke produk lewat fallback nama, terlepas dari gap productId di order item" },
      { metric: "Baris dgn inventory movement ADA tapi productId NULL (unmatched/ambiguous)", value: movementUnmatchedCount, note: "mutasi stok baris ini TIDAK tertaut ke produk manapun -> reconciliation per-produk tidak akurat" },
      { metric: "Baris TANPA dokumen inventory movement sama sekali", value: movementMissingDocCount, note: "movement blm tersinkron ke modul inventori untuk baris ini" },
    ];
    for (const r of rows) sheet.addRow(r);
    await wb.xlsx.writeFile(path.join(OUT_DIR, "impact-analysis.xlsx"));
  }

  // --- 9. summary.md ---
  const confirmed = totalRows === 6271;
  const md = `# Audit Read-Only — Identitas Produk olsera_order_items (Periode ${GAP_START} s/d ${GAP_END})

Dibuat otomatis: ${new Date().toISOString()} — AUDIT READ-ONLY, tidak ada tulis ke MongoDB, tidak ada sync/backfill.

## 1. Konfirmasi jumlah baris

- Baris dalam periode order ${GAP_START}..${GAP_END}: **${rawRows.length}**
- Baris yang kehilangan productId dan/atau variantId dan/atau sku ("gapped"): **${totalRows}**
- Klaim awal: 6.271 baris — **${confirmed ? "TERKONFIRMASI, cocok persis" : `TIDAK cocok persis (selisih ${totalRows - 6271})`}**

## 2. Klasifikasi

| Klasifikasi | Jumlah |
| --- | --- |
${[...byClass.entries()].map(([k, v]) => `| ${k} | ${v} |`).join("\n")}

- **Exact Match**: ${exactCount}
- **Ambiguous** (Exact Product Variant Ambiguous + Butuh Adjust Manual): ${ambiguousCount}
- **Unresolved** (Product Missing + Duplicate Candidate): ${unresolvedCount}

## 3. Cakupan

- Order unik (orderNo): ${uniqueOrders}
- Transaksi unik: ${uniqueTransactions} (skema \`olsera_order_items\` tidak punya field \`transactionId\` terpisah — \`orderNo\` dipakai sebagai identitas transaksi)
- Nama produk unik: ${uniqueProductNames}
- Total omzet (amount) baris terdampak: ${totalOmzet.toLocaleString("id-ID")}
- Total qty baris terdampak: ${totalQty.toLocaleString("id-ID")}

## 4. Dampak

### Omzet & kategori (export Omzet Kategori, Kategori Penjualan, Export Rincian/Item, LABERS)

Berdasarkan pembacaan kode (\`lib/omzet-export.ts\`, \`lib/olsera-item-export.ts\`, \`lib/olsera-labers-export.ts\`, \`lib/olsera-category-export.ts\`, \`lib/omset-kategori-export.ts\`):
- Total omzet/qty dihitung dari field \`amount\`/\`qty\` yang tersimpan LANGSUNG di baris \`olsera_order_items\` — **tidak bergantung** pada \`productId\`/\`variantId\`/\`sku\`. Field-field ini tetap ada & benar pada 6.271 baris tsb, sehingga **angka omzet TIDAK terdampak**.
- Kategori dihitung lewat \`lib/olsera-category-resolver.ts\` (\`resolveItemCategory\`) yang punya urutan fallback: originalCategoryName → productId → variantId → alias → SKU → barcode → nama exact → histori nama → unresolved. productId/variantId/sku HANYA salah satu dari banyak jalur; nama (\`itemName\`) & histori tetap tersedia untuk baris gapped ini.
- Dari data tersimpan (\`categoryResolutionStatus\`): **${totalRows - categoryUnsafeCount} dari ${totalRows} baris** sudah punya status \`resolved\` (kategori aman apa adanya, sudah dihitung saat sync tanpa perlu backfill). **${categoryUnsafeCount} baris** berstatus TIDAK resolved — kategori baris ini masih "Tidak Diketahui"/butuh review, TERLEPAS dari audit identitas produk ini (lihat unresolved-items.xlsx & impact-analysis.xlsx untuk daftarnya).
- LABERS export (\`lib/olsera-labers-export.ts\`) memproyeksikan productId/variantId/sku tapi TIDAK memakainya dalam agregasi (hanya \`resolvedCategoryName\`/\`amount\`/\`addonPrice\`) — **tidak terdampak**.

**Kesimpulan omzet/kategori: AMAN**, dengan catatan ${categoryUnsafeCount} baris yang memang belum resolved (independen dari gap productId/variantId/sku ini, bukan disebabkan olehnya).

### Inventori / reconciliation per produk

- \`lib/olsera-inventory.ts\` membangun \`olsera_inventory_movements\` (source: sale) dari \`olsera_order_items\`, MEMBACA productId/variantId LANGSUNG dari baris tersimpan (\`resolvedProductId\` lalu \`productId\`/\`variantId\`), dan HANYA fallback ke pencocokan nama exact bila id tidak ada (\`selectMovementProduct\` di \`lib/olsera-inventory-core.ts\`).
- Untuk 6.271 baris gapped ini: **${movementOkCount} baris** sudah punya dokumen movement DENGAN productId tertaut (mutasi stok tetap akurat — fallback pencocokan nama di \`selectMovementProduct\` berhasil, independen dari gap di order item), **${movementUnmatchedCount} baris** movement-nya ADA tapi \`productId: null\` (nama tidak cocok unik di katalog saat sync inventori — mutasi stok baris ini TIDAK tertaut ke produk manapun), dan **${movementMissingDocCount} baris** BELUM punya dokumen movement sama sekali.
- **Kesimpulan inventori: ${movementUnmatchedCount + movementMissingDocCount > 0 ? "TERDAMPAK untuk subset baris di atas" : "AMAN"}** — reconciliation stok PER PRODUK untuk ${movementUnmatchedCount + movementMissingDocCount} baris (unmatched + belum ada movement) berisiko kurang akurat, sisanya (${movementOkCount} baris) sudah tertaut benar meskipun order item-nya sendiri masih kehilangan productId/variantId/sku. Total qty/omzet keseluruhan tetap benar terlepas dari ini.

### Varian & LABERS

- Baris dengan klasifikasi **Exact Product, Variant Ambiguous** (${byClass.get("Exact Product, Variant Ambiguous") ?? 0} baris) SENGAJA tidak diberi variantId — nama produk induk tidak cukup untuk memastikan varian yang benar bila produk punya >1 varian aktif. Ini murni masalah identitas produk (SKU/varian di katalog gudang), BUKAN masalah omzet.
- LABERS (bagi hasil) tidak memakai productId/variantId/sku — lihat di atas.

## 5. Rekomendasi

1. **Backfill otomatis HANYA untuk baris "Exact Match" (${exactCount} baris)** — satu-satunya kelompok dengan pemetaan productId+variantId+sku 100% pasti dari katalog dan/atau histori yang konsisten.
2. **Historical Product (${byClass.get("Historical Product") ?? 0} baris)**: backfill bisa dipertimbangkan HANYA setelah verifikasi manual bahwa produk tsb memang sudah nonaktif/dihapus dari katalog namun histori identitasnya tunggal & konsisten — bukan otomatis penuh, beri tanda "perlu konfirmasi admin katalog".
3. **Exact Product, Variant Ambiguous, Butuh Adjust Manual, Name Match Only, Product Missing, Duplicate Candidate — JANGAN dibackfill otomatis.** Perlu Adjust Manual oleh admin/kasir yang mengerti transaksi asli (cek struk asli / cross-check Olsera dashboard), terutama untuk produk multi-varian.
4. **Tidak perlu tindakan darurat pada omzet/kategori/LABERS** — sudah terbukti aman secara struktural (tidak bergantung pada field yang hilang).
5. **Perlu tindakan pada inventori**: baris dengan movement \`unmatched\`/\`ambiguous-name\` atau tanpa movement sebaiknya direview terpisah sebagai bagian dari audit stok, karena mempengaruhi akurasi kartu stok per produk.
6. Audit ini TIDAK melakukan backfill apa pun. Semua angka di atas berasal dari state MongoDB saat ini (read-only) dan kode yang berlaku saat ini (dibaca, tidak diubah).

## 6. Artefak

- \`raw-evidence.json\` — seluruh baris + kandidat mapping mentah, untuk verifikasi ulang.
- \`affected-items.xlsx\` — seluruh ${totalRows} baris + klasifikasi.
- \`exact-matches.xlsx\` — subset Exact Match (kandidat backfill otomatis).
- \`ambiguous-items.xlsx\` — subset Exact Product Variant Ambiguous + Butuh Adjust Manual.
- \`unresolved-items.xlsx\` — subset Product Missing + Duplicate Candidate.
- \`candidate-mapping.xlsx\` — satu baris per kandidat pemetaan (katalog/alias/histori) per orderItemId.
- \`impact-analysis.xlsx\` — ringkasan angka dampak (tabel di atas dalam bentuk xlsx).
`;
  writeFileSync(path.join(OUT_DIR, "summary.md"), md);

  console.log("Selesai. Artefak ditulis ke", OUT_DIR);
  console.log(`Exact=${exactCount} Ambiguous=${ambiguousCount} Unresolved=${unresolvedCount} Total=${totalRows}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Audit gagal:", error);
    process.exit(1);
  });
