// Glue Mongo/HTTP untuk ledger stok bulanan (lib/olsera-inventory-monthly-snapshot-core.ts
// berisi seluruh logika murni/testable — file ini HANYA orkestrasi I/O: baca
// katalog+alias+bukti eksistensi dari Mongo, tarik stockmovement API per
// bulan, tulis dokumen olsera_inventory_monthly_snapshots via upsert).
//
// Dipakai oleh: scripts/bootstrap-monthly-snapshot-baseline.ts,
// scripts/backfill-monthly-snapshot.ts, dan
// lib/olsera-inventory-monthly-export.ts (ensureMonthlySnapshotChain saat
// snapshot bulan yang diminta belum ada).
import { collections, type OlseraInventoryMonthlySnapshotDocument } from "./mongodb.ts";
import {
  attachMovementsToProducts,
  resolveDuplicateNamedProducts,
  type InventoryProductInput,
  type UnmatchedMovementEntry,
} from "./olsera-inventory-monthly-core.ts";
import {
  buildMatchingContext,
  computeMonthlyStepBackward,
  computeMonthlyStepForward,
  dominantStoreId,
  lastDayOfMonth,
  monthlySnapshotDocId,
  monthsAscending,
  monthsDescending,
  nextMonth,
  type BackwardAnchor,
  type ForwardAnchor,
  type MatchingContext,
  type MonthKey,
  type MonthlyLedgerEntry,
  type ProductAliasEntry,
} from "./olsera-inventory-monthly-snapshot-core.ts";
import { fetchStockMovementRange } from "./olsera-inventory-stockmovement.ts";

// ---------------------------------------------------------------------------
// Repo (bisa diinject — tes memakai fake in-memory, produksi memakai Mongo)
// ---------------------------------------------------------------------------

export type MonthlySnapshotRepo = {
  upsertMany(docs: OlseraInventoryMonthlySnapshotDocument[]): Promise<void>;
  findMonth(storeId: number, year: number, month: number): Promise<OlseraInventoryMonthlySnapshotDocument[]>;
};

export async function getMongoMonthlySnapshotRepo(): Promise<MonthlySnapshotRepo> {
  const { olseraInventoryMonthlySnapshots } = await collections();
  return {
    async upsertMany(docs) {
      if (!docs.length) return;
      await olseraInventoryMonthlySnapshots.bulkWrite(
        docs.map((doc) => {
          const { createdAt, ...rest } = doc;
          return { updateOne: { filter: { _id: doc._id }, update: { $set: rest, $setOnInsert: { createdAt } }, upsert: true } };
        }),
      );
    },
    async findMonth(storeId, year, month) {
      return olseraInventoryMonthlySnapshots.find({ storeId, year, month }).toArray();
    },
  };
}

// ---------------------------------------------------------------------------
// Katalog + alias + bukti eksistensi (dibaca sekali, dipakai di seluruh rantai)
// ---------------------------------------------------------------------------

export async function fetchMatchingContext(): Promise<MatchingContext & { duplicateResolution: ReturnType<typeof resolveDuplicateNamedProducts> }> {
  const { olseraInventoryProducts, olseraProductAliases } = await collections();
  const [products, aliasDocs] = await Promise.all([olseraInventoryProducts.find().toArray(), olseraProductAliases.find().toArray()]);
  const rawCatalogProducts = products as InventoryProductInput[];

  // Produk bernama "duplicate" yang TERBUKTI sama (SKU cocok tunggal ke
  // produk katalog non-"duplicate" lain) dikecualikan SEBELUM index matching
  // dibangun — supaya baris movement/order-item yang harusnya cocok ke
  // produk itu otomatis jatuh ke SKU yang sama di produk kanonik (index SKU
  // tinggal 1 kandidat). TIDAK PERNAH menggabungkan hanya berdasar nama —
  // lihat resolveDuplicateNamedProducts. Audit live 2026-07-21: SAAT INI
  // tidak ada satu pun kasus "duplicate" yang SKU-nya terbukti punya
  // kembaran (mis. YONEX SHORTS "duplicate" adalah SATU-SATUNYA entri
  // katalog utk SKU itu) — mekanisme ini tetap dipasang untuk kasus masa
  // depan, nama tampil "duplicate" dibersihkan terpisah (stripDuplicateSuffix).
  const duplicateResolution = resolveDuplicateNamedProducts(rawCatalogProducts);
  const excludedIds = new Set(duplicateResolution.excludedIds);
  const catalogProducts = rawCatalogProducts.filter((p) => !excludedIds.has(p._id));

  const aliases: ProductAliasEntry[] = aliasDocs.map((a) => ({
    oldProductId: a.oldProductId,
    oldVariantId: a.oldVariantId,
    newProductId: a.newProductId,
    newVariantId: a.newVariantId,
  }));
  return { ...buildMatchingContext(catalogProducts, aliases), duplicateResolution };
}

/** Map productId (katalog, resolved) -> tanggal order_item paling awal (YYYY-MM-DD) — bukti eksistensi utk backfill mundur. */
export async function fetchEarliestEvidenceByProductId(): Promise<Map<number, string>> {
  const { olseraOrderItems } = await collections();
  const rows = await olseraOrderItems
    .aggregate<{ _id: number; minDate: string }>([
      { $match: { resolvedProductId: { $ne: null } } },
      { $group: { _id: "$resolvedProductId", minDate: { $min: "$date" } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.minDate]));
}

function hasEvidenceFactory(catalogById: Map<string, InventoryProductInput>, earliestByProductId: Map<number, string>, monthEndDate: string) {
  return (key: string): boolean => {
    const product = catalogById.get(key);
    if (!product) return false;
    const earliest = earliestByProductId.get(product.productId);
    return earliest !== undefined && earliest <= monthEndDate;
  };
}

// ---------------------------------------------------------------------------
// Konversi entry ledger (murni) -> dokumen Mongo
// ---------------------------------------------------------------------------

function entryToDocument(entry: MonthlyLedgerEntry, storeId: number, month: MonthKey, now: Date): OlseraInventoryMonthlySnapshotDocument {
  return {
    _id: monthlySnapshotDocId(storeId, month.year, month.month, entry.productId, entry.variantId),
    storeId,
    year: month.year,
    month: month.month,
    snapshotDate: lastDayOfMonth(month.year, month.month),
    productId: entry.productId,
    variantId: entry.variantId,
    canonicalProductId: entry.canonicalProductId,
    productName: entry.productName,
    productSku: entry.productSku,
    groupName: entry.groupName,
    openingQty: entry.openingQty,
    incomingQty: entry.incomingQty,
    returnQty: entry.returnQty,
    salesQty: entry.salesQty,
    outgoingQty: entry.outgoingQty,
    closingQty: entry.closingQty,
    source: entry.source,
    status: entry.status,
    diagnostics: entry.diagnostics,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Satu langkah backfill (mundur/maju) — tarik stockmovement API bulan
// tsb, cocokkan, hitung via core, upsert ke repo. Idempotent: menjalankan
// bulan yang sama dua kali menghasilkan dokumen dengan isi identik (upsert
// by _id, bukan insert baru).
// ---------------------------------------------------------------------------

export type BackfillMonthResult<TAnchor> =
  | { ok: true; nextAnchors: Map<string, TAnchor>; stopped: string[]; docsWritten: number; unmatchedOrAmbiguous: UnmatchedMovementEntry[] }
  | { ok: false; error: string };

export async function runBackwardBackfillMonth(input: {
  month: MonthKey;
  storeId: number;
  anchors: Map<string, BackwardAnchor>;
  matchingContext: MatchingContext;
  earliestByProductId: Map<number, string>;
  repo: MonthlySnapshotRepo;
}): Promise<BackfillMonthResult<BackwardAnchor>> {
  const startDate = `${input.month.year}-${String(input.month.month).padStart(2, "0")}-01`;
  const endDate = lastDayOfMonth(input.month.year, input.month.month);
  const fetched = await fetchStockMovementRange(startDate, endDate);
  if (!fetched.ok) return { ok: false, error: `Gagal menarik stockmovement ${input.month.year}-${String(input.month.month).padStart(2, "0")}: ${fetched.error}` };

  const unmatchedOrAmbiguous: UnmatchedMovementEntry[] = [];
  const matched = attachMovementsToProducts(
    fetched.rows,
    input.matchingContext.identityIndex,
    input.matchingContext.skuIndex,
    input.matchingContext.nameIndex,
    `mundur ${input.month.year}-${String(input.month.month).padStart(2, "0")}`,
    unmatchedOrAmbiguous,
  );

  const hasEvidence = hasEvidenceFactory(input.matchingContext.catalogById, input.earliestByProductId, endDate);
  const step = computeMonthlyStepBackward({ anchors: input.anchors, matched, hasEvidenceBeforeOrDuring: hasEvidence });

  const now = new Date();
  const docs = [...step.entries.values()].map((entry) => entryToDocument(entry, input.storeId, input.month, now));
  await input.repo.upsertMany(docs);

  return { ok: true, nextAnchors: step.nextAnchors, stopped: step.stopped, docsWritten: docs.length, unmatchedOrAmbiguous };
}

export async function runForwardBackfillMonth(input: {
  month: MonthKey;
  storeId: number;
  anchors: Map<string, ForwardAnchor>;
  matchingContext: MatchingContext;
  repo: MonthlySnapshotRepo;
}): Promise<BackfillMonthResult<ForwardAnchor>> {
  const startDate = `${input.month.year}-${String(input.month.month).padStart(2, "0")}-01`;
  const endDate = lastDayOfMonth(input.month.year, input.month.month);
  const fetched = await fetchStockMovementRange(startDate, endDate);
  if (!fetched.ok) return { ok: false, error: `Gagal menarik stockmovement ${input.month.year}-${String(input.month.month).padStart(2, "0")}: ${fetched.error}` };

  const unmatchedOrAmbiguous: UnmatchedMovementEntry[] = [];
  const matched = attachMovementsToProducts(
    fetched.rows,
    input.matchingContext.identityIndex,
    input.matchingContext.skuIndex,
    input.matchingContext.nameIndex,
    `maju ${input.month.year}-${String(input.month.month).padStart(2, "0")}`,
    unmatchedOrAmbiguous,
  );

  const step = computeMonthlyStepForward({ anchors: input.anchors, matched, catalogById: input.matchingContext.catalogById });

  const now = new Date();
  const docs = [...step.entries.values()].map((entry) => entryToDocument(entry, input.storeId, input.month, now));
  await input.repo.upsertMany(docs);

  return { ok: true, nextAnchors: step.nextAnchors, stopped: [], docsWritten: docs.length, unmatchedOrAmbiguous };
}

// ---------------------------------------------------------------------------
// Muat anchor dari dokumen bulan yang SUDAH ada (dipakai untuk melanjutkan
// rantai dari titik terakhir yang diketahui, tanpa menghitung ulang bulan
// yang sudah selesai).
// ---------------------------------------------------------------------------

export function docsToBackwardAnchors(docs: OlseraInventoryMonthlySnapshotDocument[]): Map<string, BackwardAnchor> {
  const anchors = new Map<string, BackwardAnchor>();
  for (const doc of docs) {
    if (doc.closingQty === null) continue;
    const key = `${doc.storeId}:${doc.productId}:${doc.variantId ?? 0}`;
    anchors.set(key, { closingQty: doc.closingQty, productName: doc.productName, productSku: doc.productSku, groupName: doc.groupName });
  }
  return anchors;
}

export function docsToForwardAnchors(docs: OlseraInventoryMonthlySnapshotDocument[]): Map<string, ForwardAnchor> {
  const anchors = new Map<string, ForwardAnchor>();
  for (const doc of docs) {
    if (doc.closingQty === null) continue;
    const key = `${doc.storeId}:${doc.productId}:${doc.variantId ?? 0}`;
    anchors.set(key, { openingQty: doc.closingQty, productName: doc.productName, productSku: doc.productSku, groupName: doc.groupName });
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Orkestrasi rentang penuh (dipakai oleh scripts/backfill-monthly-snapshot.ts)
// ---------------------------------------------------------------------------

export type BackfillRangeSummary = {
  month: MonthKey;
  ok: boolean;
  docsWritten: number;
  stopped: string[];
  error?: string;
};

export async function backfillBackwardRange(input: {
  fromInclusive: MonthKey; // bulan PALING BARU yang closingQty-nya sudah diketahui (mis. Mei 2026)
  toInclusive: MonthKey; // bulan PALING LAMA yang ingin dihitung (mis. Februari 2026)
  storeId: number;
  matchingContext: MatchingContext;
  repo: MonthlySnapshotRepo;
  /** Injectable utk tes (fake, tanpa Mongo) — default: query olsera_order_items live. */
  earliestByProductId?: Map<number, string>;
}): Promise<BackfillRangeSummary[]> {
  const earliestByProductId = input.earliestByProductId ?? (await fetchEarliestEvidenceByProductId());
  const existing = await input.repo.findMonth(input.storeId, input.fromInclusive.year, input.fromInclusive.month);
  let anchors = docsToBackwardAnchors(existing);
  const summaries: BackfillRangeSummary[] = [];

  for (const month of monthsDescending(input.fromInclusive, input.toInclusive)) {
    const result = await runBackwardBackfillMonth({ month, storeId: input.storeId, anchors, matchingContext: input.matchingContext, earliestByProductId, repo: input.repo });
    if (!result.ok) {
      summaries.push({ month, ok: false, docsWritten: 0, stopped: [], error: result.error });
      break;
    }
    summaries.push({ month, ok: true, docsWritten: result.docsWritten, stopped: result.stopped });
    anchors = result.nextAnchors;
  }
  return summaries;
}

export async function backfillForwardRange(input: {
  fromInclusive: MonthKey; // bulan PALING LAMA yang openingQty-nya sudah diketahui (closing bulan sebelumnya, mis. Juni 2026)
  toInclusive: MonthKey; // bulan PALING BARU yang ingin dihitung (bulan berjalan)
  storeId: number;
  matchingContext: MatchingContext;
  repo: MonthlySnapshotRepo;
}): Promise<BackfillRangeSummary[]> {
  const existing = await input.repo.findMonth(input.storeId, input.fromInclusive.year, input.fromInclusive.month);
  let anchors = docsToForwardAnchors(existing);
  const summaries: BackfillRangeSummary[] = [];

  for (const month of monthsAscending(nextMonth(input.fromInclusive), input.toInclusive)) {
    const result = await runForwardBackfillMonth({ month, storeId: input.storeId, anchors, matchingContext: input.matchingContext, repo: input.repo });
    if (!result.ok) {
      summaries.push({ month, ok: false, docsWritten: 0, stopped: [], error: result.error });
      break;
    }
    summaries.push({ month, ok: true, docsWritten: result.docsWritten, stopped: [] });
    anchors = result.nextAnchors;
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Dipakai oleh export: pastikan snapshot bulan yang diminta sudah ada,
// backfill on-demand bila belum (mis. bulan berjalan yang baru pertama kali
// diminta) — TIDAK PERNAH fabrikasi; bila rantai tidak bisa disambung
// (anchor terdekat pun tidak ada), kembalikan error, bukan angka kosong.
// ---------------------------------------------------------------------------

export async function ensureMonthlySnapshotChain(input: {
  year: number;
  month: number;
  repo?: MonthlySnapshotRepo;
  matchingContext?: MatchingContext;
}): Promise<{ ok: true; storeId: number; docs: OlseraInventoryMonthlySnapshotDocument[] } | { ok: false; error: string }> {
  const repo = input.repo ?? (await getMongoMonthlySnapshotRepo());
  const matchingContext = input.matchingContext ?? (await fetchMatchingContext());
  if (!matchingContext.catalogProducts.length) {
    return { ok: false, error: "Katalog produk inventori (olsera_inventory_products) kosong — jalankan Sync Inventori terlebih dahulu." };
  }
  const storeId = dominantStoreId(matchingContext.catalogProducts);
  const target: MonthKey = { year: input.year, month: input.month };

  const already = await repo.findMonth(storeId, target.year, target.month);
  if (already.length) return { ok: true, storeId, docs: already };

  const JUNE_2026: MonthKey = { year: 2026, month: 6 };
  const isBackwardZone = target.year < JUNE_2026.year || (target.year === JUNE_2026.year && target.month <= JUNE_2026.month);

  if (isBackwardZone) {
    // Cari anchor ter-DEKAT (bulan lebih baru, s/d Juni) yang sudah punya dokumen.
    let anchorMonth: MonthKey | null = null;
    for (const month of monthsAscending(target, JUNE_2026)) {
      const docs = await repo.findMonth(storeId, month.year, month.month);
      if (docs.length) {
        anchorMonth = month;
        break;
      }
    }
    if (!anchorMonth) {
      return { ok: false, error: `Tidak ada snapshot bulanan ter-anchor s/d Juni 2026 untuk memulai rantai mundur ke ${target.year}-${String(target.month).padStart(2, "0")} — jalankan bootstrap baseline terlebih dahulu.` };
    }
    const summaries = await backfillBackwardRange({ fromInclusive: anchorMonth, toInclusive: target, storeId, matchingContext, repo });
    const failed = summaries.find((s) => !s.ok);
    if (failed) return { ok: false, error: failed.error ?? "Backfill mundur gagal." };
  } else {
    // Cari anchor ter-DEKAT (bulan lebih lama, mulai Juni) yang sudah punya dokumen.
    let anchorMonth: MonthKey | null = null;
    for (const month of monthsDescending(target, JUNE_2026)) {
      const docs = await repo.findMonth(storeId, month.year, month.month);
      if (docs.length) {
        anchorMonth = month;
        break;
      }
    }
    if (!anchorMonth) {
      return { ok: false, error: `Tidak ada snapshot bulanan ter-anchor dari Juni 2026 untuk memulai rantai maju ke ${target.year}-${String(target.month).padStart(2, "0")} — jalankan bootstrap baseline terlebih dahulu.` };
    }
    const summaries = await backfillForwardRange({ fromInclusive: anchorMonth, toInclusive: target, storeId, matchingContext, repo });
    const failed = summaries.find((s) => !s.ok);
    if (failed) return { ok: false, error: failed.error ?? "Backfill maju gagal." };
  }

  const docs = await repo.findMonth(storeId, target.year, target.month);
  if (!docs.length) return { ok: false, error: `Rantai snapshot sampai ke ${target.year}-${String(target.month).padStart(2, "0")}, tapi tidak ada produk tersisa (semua dihentikan/tidak ada bukti eksistensi) — periksa manual.` };
  return { ok: true, storeId, docs };
}

export type { MonthKey };
