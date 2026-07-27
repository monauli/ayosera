// AUDIT READ-ONLY — 37 baris olsera_inventory_movements (source: sale) yang
// productId-nya null, ditemukan sebagai bagian dari audit identitas produk
// olsera_order_items (lihat tmp/order-item-identity-audit-2026/). Skrip ini
// HANYA membaca MongoDB — TIDAK ADA updateOne/updateMany/bulkWrite/insert/
// delete/sync di sini, dan TIDAK PERNAH mencetak token/URI/password.
import { readFileSync, writeFileSync } from "node:fs";
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
loadLocalEnv();
const { collections } = await import("../lib/mongodb.ts");
const { normalizeName } = await import("../lib/olsera-category-resolver.ts");

const OUT_DIR = path.join(process.cwd(), "tmp", "order-item-identity-audit-2026");
const GAP_START = "2026-05-01";
const GAP_END = "2026-07-13";

async function main() {
  const { olseraInventoryMovements, olseraOrderItems, olseraInventoryProducts, olseraProductAliases } = await collections();

  // Baris movement source:sale dengan productId null dalam periode temuan Fase 2.
  const nullMovements = await olseraInventoryMovements
    .find({ source: "sale", productId: null, date: { $gte: GAP_START, $lte: GAP_END } })
    .toArray();

  console.log(`Movement source:sale productId:null dalam periode ${GAP_START}..${GAP_END}: ${nullMovements.length}`);

  const orderItemIds = nullMovements.map((m) => Number(String(m._id).split(":")[1]));
  const orderItems = await olseraOrderItems.find({ _id: { $in: orderItemIds } }).toArray();
  const orderItemById = new Map(orderItems.map((o) => [o._id, o]));

  // Muat 6.271 baris hasil audit Fase 2 (raw-evidence.json) untuk cek keanggotaan set ambiguous (276).
  const rawEvidencePath = path.join(OUT_DIR, "raw-evidence.json");
  const evidence = JSON.parse(readFileSync(rawEvidencePath, "utf8")) as {
    rows: { orderItemId: number; classification: string; candidates: { source: string; productId: number | null; variantId: number | null; sku: string | null; note: string }[] }[];
  };
  const evidenceByOrderItemId = new Map(evidence.rows.map((r) => [r.orderItemId, r]));

  // Katalog + alias untuk kandidat mapping mandiri (independen dari cache Fase 2, sbg verifikasi silang).
  const catalogDocs = await olseraInventoryProducts.find().toArray();
  const catalogByName = new Map<string, { productId: number; variantId: number | null; sku: string | null; name: string; active: boolean }[]>();
  for (const p of catalogDocs) {
    const fullName = p.variantName ? `${p.name} - ${p.variantName}` : p.name;
    const key = normalizeName(fullName);
    if (!catalogByName.has(key)) catalogByName.set(key, []);
    catalogByName.get(key)!.push({ productId: p.productId, variantId: p.variantId, sku: p.sku, name: fullName, active: p.active });
  }
  const aliasDocs = await olseraProductAliases.find().toArray();
  const aliasByName = new Map(aliasDocs.filter((a) => a.normalizedName).map((a) => [a.normalizedName as string, a]));

  type Row = {
    movementId: string;
    orderItemId: number;
    date: string;
    orderNo: string | null;
    itemName: string;
    qty: number | null;
    amount: number | null;
    movementNote: string | null;
    movementQtyChange: number;
    inGapAudit: boolean;
    isAmbiguousIn276: boolean;
    fase2Classification: string | null;
    independentCatalogMatches: number;
    independentAliasMatch: boolean;
  };

  const rows: Row[] = nullMovements.map((m) => {
    const orderItemId = Number(String(m._id).split(":")[1]);
    const item = orderItemById.get(orderItemId);
    const evidenceRow = evidenceByOrderItemId.get(orderItemId);
    const key = normalizeName(m.productName);
    const catalogHits = catalogByName.get(key) ?? [];
    const distinctCatalog = new Set(catalogHits.map((h) => `${h.productId}:${h.variantId ?? "null"}`));
    return {
      movementId: m._id,
      orderItemId,
      date: m.date,
      orderNo: item?.orderNo ?? null,
      itemName: m.productName,
      qty: item?.qty ?? null,
      amount: item?.amount ?? null,
      movementNote: m.note,
      movementQtyChange: m.qtyChange,
      inGapAudit: !!evidenceRow,
      isAmbiguousIn276: evidenceRow ? evidenceRow.classification !== "Exact Match" && evidenceRow.classification !== "Historical Product" : false,
      fase2Classification: evidenceRow?.classification ?? null,
      independentCatalogMatches: distinctCatalog.size,
      independentAliasMatch: aliasByName.has(key),
    };
  });

  const uniqueOrders = new Set(rows.map((r) => r.orderNo).filter(Boolean)).size;
  const uniqueItemNames = new Set(rows.map((r) => normalizeName(r.itemName))).size;
  const totalQty = rows.reduce((s, r) => s + (r.qty ?? 0), 0);
  const totalAmount = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const dates = rows.map((r) => r.date).sort();
  const minDate = dates[0] ?? null;
  const maxDate = dates[dates.length - 1] ?? null;
  const exactIndependent = rows.filter((r) => r.independentCatalogMatches === 1).length;
  const ambiguousIndependent = rows.filter((r) => r.independentCatalogMatches > 1).length;
  const noMatchIndependent = rows.filter((r) => r.independentCatalogMatches === 0 && !r.independentAliasMatch).length;
  const allInGapAudit = rows.every((r) => r.inGapAudit);
  const allAmbiguousIn276 = rows.every((r) => r.isAmbiguousIn276);
  const countAmbiguousIn276 = rows.filter((r) => r.isAmbiguousIn276).length;

  // --- xlsx ---
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Movement Null ProductId");
  sheet.columns = [
    { header: "movementId", key: "movementId", width: 20 },
    { header: "orderItemId", key: "orderItemId", width: 14 },
    { header: "date", key: "date", width: 12 },
    { header: "orderNo", key: "orderNo", width: 18 },
    { header: "itemName", key: "itemName", width: 32 },
    { header: "qty", key: "qty", width: 8 },
    { header: "amount", key: "amount", width: 14 },
    { header: "movementQtyChange", key: "movementQtyChange", width: 16 },
    { header: "movementNote", key: "movementNote", width: 45 },
    { header: "inGapAudit(6271)", key: "inGapAudit", width: 14 },
    { header: "fase2Classification", key: "fase2Classification", width: 30 },
    { header: "isAmbiguousIn276", key: "isAmbiguousIn276", width: 14 },
    { header: "independentCatalogMatches", key: "independentCatalogMatches", width: 22 },
    { header: "independentAliasMatch", key: "independentAliasMatch", width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const r of rows) {
    sheet.addRow({
      movementId: r.movementId, orderItemId: r.orderItemId, date: r.date, orderNo: r.orderNo ?? "", itemName: r.itemName,
      qty: r.qty ?? "", amount: r.amount ?? "", movementQtyChange: r.movementQtyChange, movementNote: r.movementNote ?? "",
      inGapAudit: r.inGapAudit ? "YA" : "TIDAK", fase2Classification: r.fase2Classification ?? "(tidak ada di 6.271 — gap terpisah)",
      isAmbiguousIn276: r.isAmbiguousIn276 ? "YA" : "TIDAK", independentCatalogMatches: r.independentCatalogMatches,
      independentAliasMatch: r.independentAliasMatch ? "YA" : "TIDAK",
    });
  }
  const summarySheet = wb.addWorksheet("Summary");
  summarySheet.columns = [
    { header: "Metric", key: "metric", width: 55 },
    { header: "Value", key: "value", width: 30 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  const summaryRows = [
    { metric: "Total movement source:sale productId:null (periode temuan)", value: rows.length },
    { metric: "Order unik (orderNo)", value: uniqueOrders },
    { metric: "Nama item unik", value: uniqueItemNames },
    { metric: "Total qty (dari order item terkait)", value: totalQty },
    { metric: "Total nilai penjualan / amount (dari order item terkait)", value: totalAmount },
    { metric: "Tanggal paling awal", value: minDate },
    { metric: "Tanggal paling akhir", value: maxDate },
    { metric: "Exact match independen (1 kandidat katalog persis)", value: exactIndependent },
    { metric: "Ambiguous independen (>1 kandidat katalog)", value: ambiguousIndependent },
    { metric: "Tidak ada kandidat sama sekali (independen)", value: noMatchIndependent },
    { metric: "Seluruh 37 baris termasuk dalam 6.271 audit Fase 2?", value: allInGapAudit ? "YA, seluruhnya" : `TIDAK, hanya ${rows.filter((r) => r.inGapAudit).length}/${rows.length}` },
    { metric: "Seluruh 37 baris termasuk dalam 276 ambiguous Fase 2?", value: allAmbiguousIn276 ? "YA, seluruhnya" : `TIDAK, hanya ${countAmbiguousIn276}/${rows.length}` },
  ];
  for (const r of summaryRows) summarySheet.addRow(r);
  await wb.xlsx.writeFile(path.join(OUT_DIR, "inventory-movement-37-review.xlsx"));

  // --- summary.md ---
  const md = `# Review Read-Only — 37 Inventory Movement dengan productId Null (source: sale)

Dibuat otomatis: ${new Date().toISOString()} — AUDIT READ-ONLY. Tidak ada update/backfill/sync dijalankan.

## Ringkasan

- Total movement \`source: "sale"\` dengan \`productId: null\` dalam periode temuan (${GAP_START} s/d ${GAP_END}): **${rows.length}**
- Order unik (orderNo): **${uniqueOrders}**
- Nama item/produk unik: **${uniqueItemNames}**
- Total qty (dari order item terkait): **${totalQty.toLocaleString("id-ID")}**
- Total nilai penjualan (amount, dari order item terkait): **${totalAmount.toLocaleString("id-ID")}**
- Rentang tanggal: **${minDate} s/d ${maxDate}**

## Kandidat mapping (verifikasi independen terhadap katalog saat ini)

- Exact match independen (nama cocok tepat 1 kombinasi produk+varian di katalog): **${exactIndependent}**
- Ambiguous independen (nama cocok >1 kombinasi produk+varian): **${ambiguousIndependent}**
- Tidak ada kandidat sama sekali (independen, tanpa alias juga): **${noMatchIndependent}**

## Keterkaitan dengan audit Fase 2 (6.271 baris / 276 ambiguous)

- Seluruh 37 baris ini termasuk dalam 6.271 baris hasil audit identitas Fase 2? **${allInGapAudit ? "YA — seluruhnya" : `TIDAK — hanya ${rows.filter((r) => r.inGapAudit).length} dari ${rows.length}`}**
- Seluruh 37 baris ini termasuk dalam 276 baris "ambiguous" Fase 2 (Exact Product Variant Ambiguous + Butuh Adjust Manual)? **${allAmbiguousIn276 ? "YA — seluruhnya" : `TIDAK SEMUA — ${countAmbiguousIn276} dari ${rows.length} baris ("COURT FEES - N", klasifikasi Exact Product Variant Ambiguous). ${rows.length - countAmbiguousIn276} baris sisanya berklasifikasi "Historical Product" (nama "YONEX SHORTS MEN ...", produk tidak ada di katalog aktif tapi punya alias/histori — kategori TERPISAH dari 276 ambiguous, tapi SAMA-SAMA butuh konfirmasi manual sebelum backfill sesuai rekomendasi Fase 2).`}**

## Potensi dampak ke closingQty / reconciliation

- Movement dengan \`productId: null\` TIDAK ikut dihitung ke kartu stok/closingQty produk manapun (baik yang benar maupun salah) karena \`productId\` adalah kunci join utama snapshot bulanan (\`olsera_inventory_monthly_snapshots\`) dan konsistensi stok (\`getInventoryConsistency\`). Artinya: 37 baris ini **tidak mendistorsi stok produk yang SALAH** (tidak ada produk yang closingQty-nya jadi keliru akibat baris ini), tapi **qty penjualan sebesar ${totalQty.toLocaleString("id-ID")} unit dari transaksi tsb TIDAK tercermin di kartu stok produk manapun** — closingQty produk terkait berpotensi terlihat LEBIH TINGGI dari kondisi fisik sebenarnya sebesar qty yang hilang ini, sampai baris ini dipetakan secara manual.
- Risiko ini BUKAN masalah baru dari Fase 1 (fitur DRAFT laporan keuangan) dan tidak memengaruhi modul laporan keuangan/omzet/kategori sama sekali.

## Batasan audit

- Audit ini murni READ-ONLY: tidak ada \`updateOne\`/\`updateMany\`/\`bulkWrite\`/\`insertOne\`/\`deleteOne\`/sync dijalankan.
- Tidak ada perbaikan data movement/order item yang dilakukan.
- Rekomendasi: perbaikan 37 baris ini menunggu keputusan manual yang sama dengan 276 baris ambiguous Fase 2 (butuh konfirmasi admin katalog/kasir untuk memastikan varian/produk yang benar sebelum backfill apa pun).
`;
  writeFileSync(path.join(OUT_DIR, "inventory-movement-37-summary.md"), md);

  console.log("Selesai. Artefak ditulis ke", OUT_DIR);
  console.log(`rows=${rows.length} exactIndependent=${exactIndependent} ambiguousIndependent=${ambiguousIndependent} noMatch=${noMatchIndependent}`);
  console.log(`allInGapAudit=${allInGapAudit} allAmbiguousIn276=${allAmbiguousIn276} (${countAmbiguousIn276}/${rows.length})`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Audit gagal:", error);
    process.exit(1);
  });
