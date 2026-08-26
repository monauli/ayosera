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
  getInventoryPeriodState,
  isPreCutoffLedgerRow,
  lastDayOfMonth,
  monthlySnapshotDocId,
  monthsAscending,
  monthsDescending,
  nextMonth,
  previousMonth,
  type BackwardAnchor,
  type ForwardAnchor,
  type MatchingContext,
  type MonthKey,
  type MonthlyLedgerEntry,
  type ProductAliasEntry,
  type RawSalesActivityByKey,
} from "./olsera-inventory-monthly-snapshot-core.ts";
import { fetchStockMovementRange } from "./olsera-inventory-stockmovement.ts";
import { runFebruaryHistoricalMigration } from "./february-historical-migration.ts";
import { currentStoreId } from "./olsera-store-id.ts";
import { getInventoryMonthlyPeriodLock } from "./inventory-monthly-period-lock.ts";

// ---------------------------------------------------------------------------
// Repo (bisa diinject — tes memakai fake in-memory, produksi memakai Mongo)
// ---------------------------------------------------------------------------

export type MonthlySnapshotRepo = {
  upsertMany(docs: OlseraInventoryMonthlySnapshotDocument[]): Promise<void>;
  findMonth(storeId: number, year: number, month: number): Promise<OlseraInventoryMonthlySnapshotDocument[]>;
  findPeriodLock?(storeId: number, year: number, month: number): Promise<{ status: "locked" | "unlocked" } | null>;
};

export async function getMongoMonthlySnapshotRepo(): Promise<MonthlySnapshotRepo> {
  const c = await collections();
  const { olseraInventoryMonthlySnapshots } = c;
  const upsertMany = async (docs: OlseraInventoryMonthlySnapshotDocument[]) => {
    if (!docs.length) return;
    await olseraInventoryMonthlySnapshots.bulkWrite(
      docs.map((doc) => {
        const { createdAt, ...rest } = doc;
        return { updateOne: { filter: { _id: doc._id }, update: { $set: rest, $setOnInsert: { createdAt } }, upsert: true } };
      }),
    );
  };
  return {
    upsertMany,
    async findMonth(storeId, year, month) {
      return olseraInventoryMonthlySnapshots.find({ storeId, year, month }).toArray();
    },
    async findPeriodLock(storeId, year, month) {
      return (await c.inventoryMonthlyPeriodLocks.findOne({ _id: `${storeId}:${year}-${String(month).padStart(2, "0")}` }, { projection: { status: 1 } })) as { status: "locked" | "unlocked" } | null;
    },
  };
}

// ---------------------------------------------------------------------------
// Katalog + alias + bukti eksistensi (dibaca sekali, dipakai di seluruh rantai)
// ---------------------------------------------------------------------------

export async function fetchMatchingContext(): Promise<MatchingContext & { duplicateResolution: ReturnType<typeof resolveDuplicateNamedProducts> }> {
  const { olseraInventoryProducts, olseraProductAliases } = await collections();
  const [products, aliasDocs] = await Promise.all([
    olseraInventoryProducts.find({ storeId: { $in: [currentStoreId(), null] } }).toArray(),
    olseraProductAliases.find().toArray(),
  ]);
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
    confidence: a.confidence,
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

/** (start,end) YYYY-MM-DD -> RawSalesActivityByKey — dipanggil oleh backfillBackwardRange/backfillForwardRange bila diinject (opsional, lihat determineDraftCapReason di reconciliation-runner.ts untuk pola serupa). */
export type RawSalesActivityFetcher = (start: string, end: string) => Promise<RawSalesActivityByKey>;

/** Bentuk koleksi minimal (pola sama lib/reconciliation-sources.ts MinimalReadCollection) — supaya testable dgn koleksi tiruan tanpa Mongo. */
export type MinimalMovementReadCollection = {
  find(filter: Record<string, unknown>): { project(p: Record<string, 1>): { toArray(): Promise<Record<string, unknown>[]> } };
};

/**
 * Evidence independen (olsera_inventory_movements, ledger penjualan AYOSERA
 * sendiri — BUKAN stockmovement API Olsera) untuk mendeteksi carry-forward
 * yang kontradiktif (lihat komentar carryForwardStatusAndDiagnostic di
 * lib/olsera-inventory-monthly-snapshot-core.ts, kasus movement-qty:116138490:0).
 * storeId juga menerima `null` (data legacy belum distempel — Known Case 37,
 * pola sama lib/reconciliation-sources.ts loadInventoryMovementFindings),
 * TIDAK PERNAH membaca storeId toko lain. Movement dengan productId null
 * dilewati (tidak ikut key manapun — sudah ditangani jalur productId-null
 * terpisah, lihat recoverNullProductIdSales). `collectionOverride` opsional
 * (injeksi tes, tanpa Mongo asli) — default membaca olsera_inventory_movements live.
 */
export async function fetchRawSalesActivityByMonth(
  storeId: number,
  start: string,
  end: string,
  collectionOverride?: MinimalMovementReadCollection,
): Promise<RawSalesActivityByKey> {
  const olseraInventoryMovements = collectionOverride ?? (await collections()).olseraInventoryMovements;
  const rows = await olseraInventoryMovements
    .find({ storeId: { $in: [storeId, null] }, date: { $gte: start, $lte: end } })
    .project({ productId: 1, variantId: 1, qtyChange: 1, date: 1 })
    .toArray();
  const map: RawSalesActivityByKey = new Map();
  for (const row of rows as unknown as { productId: number | null; variantId: number | null; qtyChange: number; date: string }[]) {
    if (row.productId === null) continue;
    // Baris milik identitas Olsera LAMA (sebelum putus bersih) TIDAK dihitung
    // sebagai aktivitas produk kanonik — lihat LEDGER_HISTORY_CUTOFF_BY_PRODUCT_ID.
    if (isPreCutoffLedgerRow(row.productId, row.date)) continue;
    const key = `${storeId}:${row.productId}:${row.variantId ?? 0}`;
    map.set(key, (map.get(key) ?? 0) + Math.abs(row.qtyChange));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Konversi entry ledger (murni) -> dokumen Mongo
// ---------------------------------------------------------------------------

function entryToDocument(entry: MonthlyLedgerEntry, storeId: number, month: MonthKey, now: Date): OlseraInventoryMonthlySnapshotDocument {
  // finalizedAt: null bila bulan ini MASIH "current" saat ditulis (belum final,
  // ensureMonthlySnapshotChain akan menghitung ulang di panggilan berikutnya);
  // Date `now` bila bulan ini SUDAH "historical" saat ditulis (dipercaya final).
  const periodState = getInventoryPeriodState(month.year, month.month, now);
  const valuesKnown = [entry.openingQty, entry.incomingQty, entry.returnQty, entry.salesQty, entry.outgoingQty, entry.closingQty].every((value) => value !== null && Number.isFinite(value));
  const expectedClosing = valuesKnown ? (entry.openingQty as number) + (entry.incomingQty as number) + (entry.returnQty as number) - (entry.salesQty as number) - (entry.outgoingQty as number) : null;
  const arithmeticMismatch = expectedClosing !== null && expectedClosing !== entry.closingQty;
  // closingQty negatif = mustahil secara fisik -> ditandai "incomplete" + diagnostik
  // eksplisit. Nilai asli SENGAJA TIDAK di-clamp ke 0 dan penulisan TIDAK ditolak:
  // angka negatifnya harus tetap terlihat supaya bisa diinvestigasi.
  const negativeClosing = entry.closingQty !== null && entry.closingQty < 0;
  const status = arithmeticMismatch || negativeClosing ? "incomplete" : entry.status;
  const diagnostics = [
    ...entry.diagnostics,
    ...(arithmeticMismatch ? [`Formula histori tidak konsisten: closing ${entry.closingQty} berbeda dari hasil opening + incoming + return - sales - outgoing = ${expectedClosing}. Closing tidak dianggap final.`] : []),
    ...(negativeClosing ? [`closingQty negatif (${entry.closingQty}) — data tidak valid, perlu dicek. Nilai asli TIDAK di-clamp ke 0 dan TIDAK ditolak supaya bisa diinvestigasi.`] : []),
  ];
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
    status,
    diagnostics,
    finalizedAt: periodState === "historical" ? now : null,
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

/** Rebuild dibatasi ke SATU entity — lihat scripts/backfill-monthly-snapshot.ts --product-id. Produk lain TIDAK dihitung/write/diff sama sekali saat ini diisi. */
export type EntityFilter = { productId: number; variantId: number | null };

function entityFilterKey(storeId: number, filter: EntityFilter): string {
  return `${storeId}:${filter.productId}:${filter.variantId ?? 0}`;
}

/** Saring Map anchor/entry ke SATU key saja (dipakai entityFilter) — Map baru, input tidak diubah. */
function filterMapToKey<T>(map: Map<string, T>, key: string): Map<string, T> {
  const value = map.get(key);
  return value === undefined ? new Map() : new Map([[key, value]]);
}

export async function runBackwardBackfillMonth(input: {
  month: MonthKey;
  storeId: number;
  anchors: Map<string, BackwardAnchor>;
  matchingContext: MatchingContext;
  earliestByProductId: Map<number, string>;
  repo: MonthlySnapshotRepo;
  /** Opsional (additive) — bila diisi, mengaktifkan deteksi carry-forward kontradiktif (lihat fetchRawSalesActivityByMonth). Default: tidak fetch apa pun, perilaku sebelumnya tidak berubah. */
  rawSalesActivityFetcher?: RawSalesActivityFetcher;
  /** Opsional — waktu "sekarang" dipakai utk menentukan finalizedAt (lihat entryToDocument). Default: new Date(). Injeksi utk tes deterministik. */
  now?: Date;
  /** Opsional (additive) — lihat EntityFilter. Default: tidak diisi, SELURUH katalog dihitung/ditulis seperti sebelumnya (perilaku lama TIDAK berubah). */
  entityFilter?: EntityFilter;
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
  const rawSalesActivityByKey = input.rawSalesActivityFetcher ? await input.rawSalesActivityFetcher(startDate, endDate) : undefined;
  const step = computeMonthlyStepBackward({
    anchors: input.anchors,
    matched,
    catalogById: input.matchingContext.catalogById,
    hasEvidenceBeforeOrDuring: hasEvidence,
    rawSalesActivityByKey,
    verifiedAliasCanonicalKeys: input.matchingContext.verifiedAliasCanonicalKeys,
  });

  // Scoped rebuild (--product-id): HANYA entity target yang dihitung/write/
  // diff — produk lain TIDAK PERNAH masuk `docs` (tidak pernah dipanggil
  // repo.upsertMany untuknya) dan TIDAK PERNAH ikut nextAnchors (rantai
  // bulan berikutnya juga tetap ter-isolasi ke entity ini saja).
  const scopedEntries = input.entityFilter ? filterMapToKey(step.entries, entityFilterKey(input.storeId, input.entityFilter)) : step.entries;
  const scopedNextAnchors = input.entityFilter ? filterMapToKey(step.nextAnchors, entityFilterKey(input.storeId, input.entityFilter)) : step.nextAnchors;

  const now = input.now ?? new Date();
  const docs = [...scopedEntries.values()].map((entry) => entryToDocument(entry, input.storeId, input.month, now));
  await input.repo.upsertMany(docs);

  return { ok: true, nextAnchors: scopedNextAnchors, stopped: step.stopped, docsWritten: docs.length, unmatchedOrAmbiguous };
}

export async function runForwardBackfillMonth(input: {
  month: MonthKey;
  storeId: number;
  anchors: Map<string, ForwardAnchor>;
  matchingContext: MatchingContext;
  repo: MonthlySnapshotRepo;
  /** Opsional (additive) — lihat runBackwardBackfillMonth. */
  rawSalesActivityFetcher?: RawSalesActivityFetcher;
  /** Opsional — lihat runBackwardBackfillMonth. */
  now?: Date;
  /** Opsional (additive) — lihat EntityFilter/runBackwardBackfillMonth. */
  entityFilter?: EntityFilter;
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

  const rawSalesActivityByKey = input.rawSalesActivityFetcher ? await input.rawSalesActivityFetcher(startDate, endDate) : undefined;
  const step = computeMonthlyStepForward({
    anchors: input.anchors,
    matched,
    catalogById: input.matchingContext.catalogById,
    rawSalesActivityByKey,
    verifiedAliasCanonicalKeys: input.matchingContext.verifiedAliasCanonicalKeys,
    catalogOnly: getInventoryPeriodState(input.month.year, input.month.month, input.now ?? new Date()) === "current"
      ? new Map(input.matchingContext.catalogProducts.map((product) => [`${input.storeId}:${product.productId}:${product.variantId ?? 0}`, product]))
      : undefined,
  });

  const scopedEntries = input.entityFilter ? filterMapToKey(step.entries, entityFilterKey(input.storeId, input.entityFilter)) : step.entries;
  const scopedNextAnchors = input.entityFilter ? filterMapToKey(step.nextAnchors, entityFilterKey(input.storeId, input.entityFilter)) : step.nextAnchors;

  const now = input.now ?? new Date();
  const docs = [...scopedEntries.values()].map((entry) => entryToDocument(entry, input.storeId, input.month, now));
  await input.repo.upsertMany(docs);

  return { ok: true, nextAnchors: scopedNextAnchors, stopped: [], docsWritten: docs.length, unmatchedOrAmbiguous };
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
  /** Opsional (additive) — lihat runBackwardBackfillMonth/fetchRawSalesActivityByMonth. Default: tidak fetch apa pun (perilaku lama tidak berubah). */
  rawSalesActivityFetcher?: RawSalesActivityFetcher;
  /** Opsional — lihat runBackwardBackfillMonth. */
  now?: Date;
  /** Opsional (additive) — lihat EntityFilter. Default: seluruh katalog (perilaku lama TIDAK berubah). */
  entityFilter?: EntityFilter;
}): Promise<BackfillRangeSummary[]> {
  const earliestByProductId = input.earliestByProductId ?? (await fetchEarliestEvidenceByProductId());
  const existing = await input.repo.findMonth(input.storeId, input.fromInclusive.year, input.fromInclusive.month);
  let anchors = docsToBackwardAnchors(existing);
  if (input.entityFilter) anchors = filterMapToKey(anchors, entityFilterKey(input.storeId, input.entityFilter));
  const summaries: BackfillRangeSummary[] = [];

  for (const month of monthsDescending(input.fromInclusive, input.toInclusive)) {
    if ((await input.repo.findPeriodLock?.(input.storeId, month.year, month.month))?.status === "locked") {
      summaries.push({ month, ok: false, docsWritten: 0, stopped: [], error: "Periode terkunci. Unlock terlebih dahulu jika ingin melakukan koreksi." });
      break;
    }
    const result = await runBackwardBackfillMonth({
      month,
      storeId: input.storeId,
      anchors,
      matchingContext: input.matchingContext,
      earliestByProductId,
      repo: input.repo,
      rawSalesActivityFetcher: input.rawSalesActivityFetcher,
      now: input.now,
      entityFilter: input.entityFilter,
    });
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
  /** Opsional (additive) — lihat runBackwardBackfillMonth/fetchRawSalesActivityByMonth. Default: tidak fetch apa pun (perilaku lama tidak berubah). */
  rawSalesActivityFetcher?: RawSalesActivityFetcher;
  /** Opsional — lihat runBackwardBackfillMonth. */
  now?: Date;
  /** Opsional (additive) — lihat EntityFilter. Default: seluruh katalog (perilaku lama TIDAK berubah). */
  entityFilter?: EntityFilter;
}): Promise<BackfillRangeSummary[]> {
  const existing = await input.repo.findMonth(input.storeId, input.fromInclusive.year, input.fromInclusive.month);
  let anchors = docsToForwardAnchors(existing);
  if (input.entityFilter) anchors = filterMapToKey(anchors, entityFilterKey(input.storeId, input.entityFilter));
  const summaries: BackfillRangeSummary[] = [];

  for (const month of monthsAscending(nextMonth(input.fromInclusive), input.toInclusive)) {
    if ((await input.repo.findPeriodLock?.(input.storeId, month.year, month.month))?.status === "locked") {
      summaries.push({ month, ok: false, docsWritten: 0, stopped: [], error: "Periode terkunci. Unlock terlebih dahulu jika ingin melakukan koreksi." });
      break;
    }
    const result = await runForwardBackfillMonth({
      month,
      storeId: input.storeId,
      anchors,
      matchingContext: input.matchingContext,
      repo: input.repo,
      rawSalesActivityFetcher: input.rawSalesActivityFetcher,
      now: input.now,
      entityFilter: input.entityFilter,
    });
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

const JUNE_2026: MonthKey = { year: 2026, month: 6 };

/**
 * `already` boleh dipercaya langsung (tidak perlu dihitung ulang) HANYA bila
 * bulan itu benar-benar "historical" (sudah lewat) DAN tidak ada satu pun
 * dokumen yang masih `finalizedAt === null` (ditulis saat bulan itu masih
 * "current" dan belum pernah difinalisasi). Dokumen LEGACY tanpa field
 * `finalizedAt` sama sekali (`undefined`, bukan `null`) dianggap SUDAH final
 * (backward compatible — lihat lib/mongodb.ts) supaya deploy fix ini TIDAK
 * memicu hitung ulang massal untuk seluruh histori lama; rebuild retroaktif
 * untuk bulan lama yang terbukti stale (mis. Juli 2026) dilakukan lewat
 * scripts/audit-inventory-monthly-periods.ts + scripts/backfill-monthly-snapshot.ts
 * --write, bukan otomatis di sini.
 */
function isTrustedHistorical(docs: OlseraInventoryMonthlySnapshotDocument[], state: ReturnType<typeof getInventoryPeriodState>): boolean {
  return docs.length > 0 && state === "historical" && !docs.some((d) => d.finalizedAt === null);
}

/**
 * Pastikan snapshot bulan yang diminta tersedia DAN — untuk bulan "current"
 * (bulan kalender Asia/Jakarta yang sedang berjalan) — SELALU dihitung ulang
 * dari sumber Olsera terbaru (produk baru di tengah bulan, movement yang
 * baru masuk, dst.), TIDAK PERNAH dipercaya sebagai final hanya karena
 * dokumennya sudah pernah ada (root cause bug lama — lihat
 * tmp/ai-handoff.md "Inventory July-August Product Timing Audit"). Bulan
 * "historical" yang sudah pernah mendapat SATU KALI finalisasi (finalizedAt
 * bukan null) dipercaya langsung tanpa panggilan API (item C - jangan
 * memanggil Olsera setiap page load). Bulan "future" ditolak — tidak pernah
 * digenerate seolah sudah berjalan. TIDAK PERNAH fabrikasi angka: bila
 * rantai tidak bisa disambung (anchor terdekat pun tidak ada) atau fetch
 * sumber gagal, kembalikan error — data valid yang sudah ada TIDAK ditimpa.
 */
export async function ensureMonthlySnapshotChain(input: {
  year: number;
  month: number;
  repo?: MonthlySnapshotRepo;
  matchingContext?: MatchingContext;
  /** Opsional — waktu "sekarang" dipakai utk menentukan current/historical/future. Default: new Date(). Injeksi utk tes deterministik. */
  now?: Date;
  rawSalesActivityFetcher?: RawSalesActivityFetcher;
}): Promise<{ ok: true; storeId: number; docs: OlseraInventoryMonthlySnapshotDocument[] } | { ok: false; error: string }> {
  const now = input.now ?? new Date();
  const repo = input.repo ?? (await getMongoMonthlySnapshotRepo());
  const matchingContext = input.matchingContext ?? (await fetchMatchingContext());
  if (!matchingContext.catalogProducts.length) {
    return { ok: false, error: "Katalog produk inventori (olsera_inventory_products) kosong — jalankan Sync Inventori terlebih dahulu." };
  }
  const storeId = dominantStoreId(matchingContext.catalogProducts);
  const target: MonthKey = { year: input.year, month: input.month };

  // Locked months are served from their immutable snapshot. This check is at
  // the shared chain entrypoint so sync, rebuild, recovery, UI, and exports
  // all get the same protection without per-caller guards.
  if (!input.repo) {
    const locked = await getInventoryMonthlyPeriodLock(storeId, target.year, target.month);
    if (locked?.status === "locked") return { ok: true, storeId, docs: locked.snapshots };
  }

  const state = getInventoryPeriodState(target.year, target.month, now);
  if (state === "future") {
    return { ok: false, error: `Periode ${target.year}-${String(target.month).padStart(2, "0")} belum dimulai — tidak bisa dihitung.` };
  }

  const already = await repo.findMonth(storeId, target.year, target.month);
  // Februari adalah periode historis yang disetujui user. Jalur export resmi
  // juga harus menjalankan migrasi built-in terbaru agar snapshot parsial lama
  // tidak dipercaya sebagai hasil final. Migrasi hanya menulis 2026-02.
  if (target.year === 2026 && target.month === 2 && !input.repo) {
    await runFebruaryHistoricalMigration();
    const docs = await repo.findMonth(storeId, target.year, target.month);
    if (!docs.length) return { ok: false, error: "Migrasi historis Februari tidak menghasilkan snapshot." };
    return { ok: true, storeId, docs };
  }
  if (target.year === 2026 && target.month === 3 && !input.repo) {
    const februaryDocs = await repo.findMonth(storeId, 2026, 2);
    if (!februaryDocs.length) return { ok: false, error: "Snapshot Februari 2026 belum tersedia sebagai anchor Maret 2026." };
    const result = await runForwardBackfillMonth({
      month: target,
      storeId,
      anchors: docsToForwardAnchors(februaryDocs),
      matchingContext,
      repo,
      rawSalesActivityFetcher: input.rawSalesActivityFetcher,
      now,
    });
    if (!result.ok) return { ok: false, error: result.error };
    const docs = await repo.findMonth(storeId, target.year, target.month);
    if (!docs.length) return { ok: false, error: "Stockmovement Maret 2026 tidak menghasilkan snapshot." };
    return { ok: true, storeId, docs };
  }
  if (!(target.year === 2026 && target.month === 1) && isTrustedHistorical(already, state)) return { ok: true, storeId, docs: already };

  // Desember 2025 adalah bootstrap historis mandiri. Jangan mencari anchor
  // 2026: itu akan menulis bulan perantara dan mengubah rantai yang sudah ada.
  if (target.year === 2025 && target.month === 12) {
    const result = await runForwardBackfillMonth({
      month: target,
      storeId,
      anchors: new Map(),
      matchingContext,
      repo,
      rawSalesActivityFetcher: input.rawSalesActivityFetcher,
      now,
    });
    if (!result.ok) return { ok: false, error: result.error };
    const docs = await repo.findMonth(storeId, target.year, target.month);
    if (!docs.length) return { ok: false, error: "Stockmovement Desember 2025 tidak menghasilkan snapshot yang dapat dibuktikan." };
    return { ok: true, storeId, docs };
  }

  // Januari 2026 memakai closing Desember sebagai satu-satunya anchor.
  // Jangan memakai rantai historis lain: Februari dan periode sebelumnya
  // harus tetap tidak tersentuh.
  if (target.year === 2026 && target.month === 1) {
    const decemberDocs = await repo.findMonth(storeId, 2025, 12);
    if (!decemberDocs.length) return { ok: false, error: "Snapshot Desember 2025 belum tersedia sebagai anchor Januari 2026." };
    const result = await runForwardBackfillMonth({
      month: target,
      storeId,
      anchors: docsToForwardAnchors(decemberDocs),
      matchingContext,
      repo,
      rawSalesActivityFetcher: input.rawSalesActivityFetcher,
      now,
    });
    if (!result.ok) return { ok: false, error: result.error };
    const docs = await repo.findMonth(storeId, target.year, target.month);
    if (!docs.length) return { ok: false, error: "Pergerakan Januari 2026 tidak menghasilkan snapshot yang dapat dibuktikan." };
    return { ok: true, storeId, docs };
  }

  const isBackwardZone = target.year < JUNE_2026.year || (target.year === JUNE_2026.year && target.month <= JUNE_2026.month);

  if (isBackwardZone) {
    // Zona mundur (<= Juni 2026): tidak ada konsep "current" — bulan sejauh
    // ini di masa lalu selalu historical. Bila sudah ada dokumen (termasuk
    // legacy tanpa finalizedAt), percaya langsung; perilaku TIDAK berubah
    // dari sebelumnya untuk zona ini.
    if (already.length) return { ok: true, storeId, docs: already };
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
    const summaries = await backfillBackwardRange({ fromInclusive: anchorMonth, toInclusive: target, storeId, matchingContext, repo, rawSalesActivityFetcher: input.rawSalesActivityFetcher, now });
    const failed = summaries.find((s) => !s.ok);
    if (failed) return { ok: false, error: failed.error ?? "Backfill mundur gagal." };
    const docs = await repo.findMonth(storeId, target.year, target.month);
    if (!docs.length) return { ok: false, error: `Rantai snapshot sampai ke ${target.year}-${String(target.month).padStart(2, "0")}, tapi tidak ada produk tersisa (semua dihentikan/tidak ada bukti eksistensi) — periksa manual.` };
    return { ok: true, storeId, docs };
  }

  // Zona maju (>= Juli 2026) — Juni sendiri (baseline tetap) selalu tertangkap
  // oleh isBackwardZone di atas, tidak pernah sampai ke sini. Bulan ini perlu (di)hitung ulang — baik karena belum pernah ada, karena
  // "current" (selalu dinamis), atau karena "historical" tapi belum pernah
  // difinalisasi. SELALU anchor dari hasil TERBARU bulan sebelumnya —
  // rekursif, supaya bulan sebelumnya yang JUGA belum difinalisasi otomatis
  // dibetulkan dulu (item 4/5 PRD: "pastikan Juli sudah dihitung sampai 31
  // Juli SEBELUM dipakai sebagai opening Agustus"). Rekursi dibatasi jumlah
  // bulan kalender nyata sejak baseline Juni 2026 — tidak tak terbatas.
  const prev = previousMonth(target);
  const prevResult = await ensureMonthlySnapshotChain({ year: prev.year, month: prev.month, repo, matchingContext, now, rawSalesActivityFetcher: input.rawSalesActivityFetcher });
  if (!prevResult.ok) return prevResult;
  const anchors = docsToForwardAnchors(prevResult.docs);

  const result = await runForwardBackfillMonth({ month: target, storeId, anchors, matchingContext, repo, rawSalesActivityFetcher: input.rawSalesActivityFetcher, now });
  if (!result.ok) return { ok: false, error: result.error };

  const docs = await repo.findMonth(storeId, target.year, target.month);
  if (!docs.length) return { ok: false, error: `Rantai snapshot sampai ke ${target.year}-${String(target.month).padStart(2, "0")}, tapi tidak ada produk tersisa (semua dihentikan/tidak ada bukti eksistensi) — periksa manual.` };
  return { ok: true, storeId, docs };
}

export type { MonthKey };
