// Sync & query modul Inventori Olsera. Read-only terhadap Olsera (tidak pernah
// menulis apa pun ke Olsera) dan terpisah total dari sync penjualan/kategori.
//
// Arsitektur sync bertahap (aman Vercel):
// - "start"  → buat run baru (atau lanjutkan run running yang ada) berisi antrian tanggal.
// - "step"   → proses SATU langkah kecil per request:
//     fase "products": tarik katalog /product (paged) + snapshot stok hari ini;
//     fase "movements": satu tanggal per step — mutasi "penjualan" diturunkan dari
//     olsera_order_items (order Olsera nyata hasil sync modul penjualan).
// - Frontend memanggil step berulang sampai selesai; checkpoint run tersimpan di
//   MongoDB sehingga proses terputus bisa dilanjutkan.
//
// API Olsera TIDAK menyediakan endpoint histori mutasi/adjustment/purchase/transfer
// (semua 404 — lihat scripts/inspect-olsera-inventory.ts). Karena itu stok awal
// pada baseline (lib/olsera-baseline.ts) tidak dapat direkonstruksi; snapshot
// pertama = data paling awal yang benar-benar tersedia dari API.

import {
  collections,
  withMongo,
  type OlseraInventoryMovementDocument,
  type OlseraInventoryProductDocument,
  type OlseraInventorySyncRunDocument,
} from "@/lib/mongodb";
import { getAccessToken } from "@/lib/olsera";
import { todayJakarta, addDays } from "@/lib/olsera-sync";
import {
  buildNameIndex,
  buildPendingDates,
  computeConsistency,
  flattenOlseraProduct,
  normalizeItemName,
  summarizeInventory,
  INVENTORY_BASELINE_DATE,
  DEFAULT_LOW_STOCK_THRESHOLD,
  type ConsistencyRow,
  type ConsistencyStatus,
  type InventoryProductInput,
} from "@/lib/olsera-inventory-core";

const BASE_URL = "https://api-open.olsera.co.id";
const API_PREFIX = "/api/open-api/v1/id";
const LIST_DELAY_MS = 150;

export { INVENTORY_BASELINE_DATE, DEFAULT_LOW_STOCK_THRESHOLD };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(token: string, pathName: string, params: Record<string, string>) {
  const url = new URL(BASE_URL + pathName);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const isRateLimited = response.status === 429;
    if ((isRateLimited || response.status >= 500) && attempt < (isRateLimited ? 6 : 4)) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
      await sleep(Math.min(waitMs, 10_000));
      continue;
    }
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`HTTP ${response.status} untuk ${pathName}: ${raw.slice(0, 200)}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}

/** Tarik seluruh katalog produk Olsera (paged) dan ratakan ke baris inventori. */
async function fetchInventoryProducts(token: string): Promise<InventoryProductInput[]> {
  const rows: InventoryProductInput[] = [];
  let page = 1;
  for (;;) {
    const body = await getJson(token, `${API_PREFIX}/product`, { per_page: "100", page: String(page) });
    const list = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
    for (const raw of list) rows.push(...flattenOlseraProduct(raw));
    const meta = body.meta as { last_page?: number } | undefined;
    if (!meta?.last_page || page >= meta.last_page) break;
    page++;
    await sleep(LIST_DELAY_MS);
  }
  return rows;
}

// ---- Sync run lifecycle ----

export type InventorySyncStatus = {
  state: {
    lastSuccessfulSyncAt: string | null;
    lastSyncedDate: string | null;
    firstSyncAt: string | null;
    /** min(earliestSalesDate, earliestSnapshotDate) — dipertahankan untuk kompatibilitas (skrip backfill gap). */
    earliestAvailableDate: string | null;
    /** Tanggal transaksi penjualan paling awal yang tersimpan (olsera_inventory_movements). */
    earliestSalesDate: string | null;
    /** Tanggal snapshot stok paling awal yang tersimpan (olsera_inventory_snapshots). */
    earliestSnapshotDate: string | null;
    historyCoverage: "snapshot-only";
  };
  run: {
    id: string;
    status: OlseraInventorySyncRunDocument["status"];
    phase: OlseraInventorySyncRunDocument["phase"];
    startDate: string;
    endDate: string;
    currentDate: string | null;
    processedDays: number;
    totalDays: number;
    totalProducts: number;
    totalMovements: number;
    createdRecords: number;
    updatedRecords: number;
    failedDates: string[];
    errorMessage: string | null;
    startedAt: string;
    completedAt: string | null;
  } | null;
  productCount: number;
  movementCount: number;
};

function serializeRun(run: OlseraInventorySyncRunDocument): NonNullable<InventorySyncStatus["run"]> {
  return {
    id: run._id,
    status: run.status,
    phase: run.phase,
    startDate: run.startDate,
    endDate: run.endDate,
    currentDate: run.currentDate,
    processedDays: run.processedDays,
    totalDays: run.totalDays,
    totalProducts: run.totalProducts,
    totalMovements: run.totalMovements,
    createdRecords: run.createdRecords,
    updatedRecords: run.updatedRecords,
    failedDates: run.failedDates,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
  };
}

export async function getInventorySyncStatus(): Promise<InventorySyncStatus> {
  return withMongo(async () => {
    const {
      olseraInventoryState,
      olseraInventorySyncRuns,
      olseraInventoryProducts,
      olseraInventoryMovements,
      olseraInventorySnapshots,
    } = await collections();
    const [state, run, productCount, movementCount, earliestMovement, earliestSnapshot] = await Promise.all([
      olseraInventoryState.findOne({ _id: "olsera-inventory" }),
      olseraInventorySyncRuns.find().sort({ startedAt: -1 }).limit(1).next(),
      olseraInventoryProducts.countDocuments(),
      olseraInventoryMovements.countDocuments(),
      // Baca langsung dari koleksi (bukan hanya field tersimpan) — status yang
      // ditampilkan selalu mencerminkan data aktual, tidak pernah hardcode.
      olseraInventoryMovements.find().sort({ date: 1 }).limit(1).next(),
      olseraInventorySnapshots.find().sort({ date: 1 }).limit(1).next(),
    ]);
    return {
      state: {
        lastSuccessfulSyncAt: state?.lastSuccessfulSyncAt?.toISOString() ?? null,
        lastSyncedDate: state?.lastSyncedDate ?? null,
        firstSyncAt: state?.firstSyncAt?.toISOString() ?? null,
        earliestAvailableDate: state?.earliestAvailableDate ?? null,
        earliestSalesDate: earliestMovement?.date ?? null,
        earliestSnapshotDate: earliestSnapshot?.date ?? null,
        historyCoverage: "snapshot-only",
      },
      run: run ? serializeRun(run) : null,
      productCount,
      movementCount,
    };
  });
}

/**
 * Mulai run sync baru (atau kembalikan run running yang belum selesai supaya
 * klik berikutnya melanjutkan, bukan menduplikasi). Sync pertama: baseline
 * (lib/olsera-baseline.ts) s/d hari ini; incremental: lastSyncedDate - 1 hari
 * (overlap) s/d hari ini.
 */
export async function startInventorySync(): Promise<NonNullable<InventorySyncStatus["run"]>> {
  return withMongo(async () => {
    const { olseraInventoryState, olseraInventorySyncRuns } = await collections();

    const existing = await olseraInventorySyncRuns.find({ status: "running" }).sort({ startedAt: -1 }).limit(1).next();
    if (existing) return serializeRun(existing);

    const today = todayJakarta();
    const state = await olseraInventoryState.findOne({ _id: "olsera-inventory" });
    const startDate = state?.lastSyncedDate
      ? (() => {
          const overlap = addDays(state.lastSyncedDate, -1);
          return overlap < INVENTORY_BASELINE_DATE ? INVENTORY_BASELINE_DATE : overlap > today ? today : overlap;
        })()
      : INVENTORY_BASELINE_DATE;

    const lastRun = await olseraInventorySyncRuns.find().sort({ startedAt: -1 }).limit(1).next();
    const previousFailed = lastRun?.status === "partial" || lastRun?.status === "failed" ? lastRun.failedDates : [];
    const pendingDates = buildPendingDates(previousFailed, startDate, today);

    const startedAt = new Date();
    const run: OlseraInventorySyncRunDocument = {
      _id: `run-${startedAt.toISOString()}`,
      status: "running",
      phase: "products",
      baselineDate: INVENTORY_BASELINE_DATE,
      startDate,
      endDate: today,
      pendingDates,
      currentDate: null,
      processedDays: 0,
      totalDays: pendingDates.length,
      totalProducts: 0,
      totalMovements: 0,
      createdRecords: 0,
      updatedRecords: 0,
      failedDates: [],
      errorMessage: null,
      startedAt,
      completedAt: null,
      updatedAt: startedAt,
    };
    await olseraInventorySyncRuns.insertOne(run);
    return serializeRun(run);
  });
}

/** Fase products: tarik katalog, upsert master produk, tulis snapshot stok hari ini. */
async function runProductsPhase(run: OlseraInventorySyncRunDocument) {
  const auth = await getAccessToken();
  if ("error" in auth) throw new Error(auth.error);
  const products = await fetchInventoryProducts(auth.token);
  if (!products.length) throw new Error("Katalog produk Olsera kosong/tidak terbaca — fase produk dibatalkan.");

  const today = todayJakarta();
  const { created, updated } = await withMongo(async () => {
    const { olseraInventoryProducts, olseraInventorySnapshots } = await collections();
    const syncedAt = new Date();
    const result = await olseraInventoryProducts.bulkWrite(
      products.map((product) => ({
        updateOne: {
          filter: { _id: product._id },
          update: { $set: { ...product, syncedAt } },
          upsert: true,
        },
      })),
    );
    await olseraInventorySnapshots.bulkWrite(
      products
        .filter((product) => product.trackInventory)
        .map((product) => ({
          updateOne: {
            filter: { _id: `${product._id}:${today}` },
            update: {
              $set: {
                date: today,
                productId: product.productId,
                variantId: product.variantId,
                sku: product.sku,
                name: product.variantName ? `${product.name} - ${product.variantName}` : product.name,
                storeId: product.storeId,
                stockQty: product.stockQty,
                holdQty: product.holdQty,
                buyPrice: product.buyPrice,
                syncedAt,
              },
            },
            upsert: true,
          },
        })),
    );
    return { created: result.upsertedCount, updated: result.modifiedCount };
  });
  return { totalProducts: products.length, created, updated };
}

/**
 * Fase movements: satu tanggal — mutasi "penjualan" dari olsera_order_items.
 * Diekspor agar skrip backfill lokal (mis. mengisi mutasi tanggal sebelum
 * checkpoint lama saat baseline dimundurkan) bisa memakai fungsi yang SAMA
 * tanpa duplikasi logika.
 */
export async function runMovementDate(date: string) {
  return withMongo(async () => {
    const { olseraOrderItems, olseraInventoryProducts, olseraInventoryMovements } = await collections();
    const [items, productDocs] = await Promise.all([
      olseraOrderItems.find({ date }).toArray(),
      olseraInventoryProducts.find().toArray(),
    ]);
    if (!items.length) return { movements: 0, created: 0, updated: 0 };

    const nameIndex = buildNameIndex(productDocs as InventoryProductInput[]);
    const syncedAt = new Date();
    const docs: OlseraInventoryMovementDocument[] = items.map((item) => {
      const match = nameIndex.get(normalizeItemName(item.itemName)) as OlseraInventoryProductDocument | undefined;
      return {
        _id: `sale:${item._id}`,
        source: "sale",
        type: "penjualan",
        date,
        movementAt: item.orderDate,
        productId: match?.productId ?? null,
        variantId: match?.variantId ?? null,
        sku: match?.sku ?? null,
        productName: item.itemName,
        qtyBefore: null,
        qtyChange: -item.qty,
        qtyAfter: null,
        costPrice: item.qty > 0 ? item.costAmount / item.qty : null,
        value: item.amount,
        storeId: match?.storeId ?? null,
        reference: item.orderNo,
        note: match ? null : "Produk tidak ditemukan di katalog (nama tidak cocok)",
        syncedAt,
      };
    });
    const result = await olseraInventoryMovements.bulkWrite(
      docs.map((doc) => ({
        updateOne: { filter: { _id: doc._id }, update: { $set: doc }, upsert: true },
      })),
    );
    return { movements: docs.length, created: result.upsertedCount, updated: result.modifiedCount };
  });
}

export type InventoryStepResult = {
  done: boolean;
  run: NonNullable<InventorySyncStatus["run"]>;
};

/** Proses satu langkah run yang sedang berjalan. Dipanggil frontend berulang. */
export async function stepInventorySync(): Promise<InventoryStepResult | { error: string }> {
  const run = await withMongo(async () => {
    const { olseraInventorySyncRuns } = await collections();
    return olseraInventorySyncRuns.find({ status: "running" }).sort({ startedAt: -1 }).limit(1).next();
  });
  if (!run) return { error: "Tidak ada sync inventori yang sedang berjalan. Panggil start terlebih dahulu." };

  const updates: Partial<OlseraInventorySyncRunDocument> = { updatedAt: new Date() };

  if (run.phase === "products") {
    try {
      const phase = await runProductsPhase(run);
      updates.phase = "movements";
      updates.totalProducts = phase.totalProducts;
      updates.createdRecords = run.createdRecords + phase.created;
      updates.updatedRecords = run.updatedRecords + phase.updated;
    } catch (error) {
      // Fase produk gagal total → run failed (tanpa katalog, mutasi tak bisa dipetakan).
      updates.status = "failed";
      updates.phase = "done";
      updates.completedAt = new Date();
      updates.errorMessage = error instanceof Error ? error.message : "Fase produk gagal.";
    }
  } else if (run.phase === "movements") {
    const nextDate = run.pendingDates[0];
    if (nextDate) {
      updates.currentDate = nextDate;
      try {
        const dayResult = await runMovementDate(nextDate);
        updates.totalMovements = run.totalMovements + dayResult.movements;
        updates.createdRecords = run.createdRecords + dayResult.created;
        updates.updatedRecords = run.updatedRecords + dayResult.updated;
      } catch (error) {
        updates.failedDates = [...run.failedDates, nextDate];
        console.error(`Inventori Olsera: tanggal ${nextDate} gagal`, error);
      }
      updates.pendingDates = run.pendingDates.slice(1);
      updates.processedDays = run.processedDays + 1;
    }
    const remaining = updates.pendingDates ?? run.pendingDates;
    if (!remaining.length) {
      const failedDates = updates.failedDates ?? run.failedDates;
      updates.phase = "done";
      updates.status = failedDates.length ? "partial" : "success";
      updates.completedAt = new Date();
      updates.currentDate = null;
      if (failedDates.length) updates.errorMessage = `Tanggal gagal: ${failedDates.join(", ")}`;
    }
  }

  const merged = { ...run, ...updates } as OlseraInventorySyncRunDocument;
  await withMongo(async () => {
    const { olseraInventorySyncRuns } = await collections();
    await olseraInventorySyncRuns.updateOne({ _id: run._id }, { $set: updates });

    if (merged.status === "success" || merged.status === "partial") {
      await refreshInventoryEarliestAvailableDate({
        // last_successful_sync_at & checkpoint tanggal HANYA maju saat sukses penuh —
        // run partial membiarkan checkpoint lama agar tanggal gagal ditarik ulang.
        advanceCheckpointTo: merged.status === "success" ? merged.endDate : null,
      });
    }
  });
  return { done: merged.phase === "done", run: serializeRun(merged) };
}

/**
 * Hitung ulang & simpan `earliestAvailableDate` (tanggal mutasi/snapshot paling
 * awal yang benar-benar tersimpan) — dipanggil setelah step sync normal maupun
 * setelah backfill mutasi historis (mis. skrip lokal yang mengisi tanggal
 * sebelum checkpoint lama saat baseline dimundurkan). TIDAK pernah menyentuh
 * stockQty/buyPrice/nilai persediaan — hanya field metadata cakupan histori.
 */
export async function refreshInventoryEarliestAvailableDate(options: { advanceCheckpointTo: string | null }) {
  await withMongo(async () => {
    const { olseraInventoryState, olseraInventoryMovements, olseraInventorySnapshots } = await collections();
    const now = new Date();
    const [earliestMovement, earliestSnapshot, state] = await Promise.all([
      olseraInventoryMovements.find().sort({ date: 1 }).limit(1).next(),
      olseraInventorySnapshots.find().sort({ date: 1 }).limit(1).next(),
      olseraInventoryState.findOne({ _id: "olsera-inventory" }),
    ]);
    const earliestAvailableDate =
      [earliestMovement?.date, earliestSnapshot?.date].filter((d): d is string => Boolean(d)).sort()[0] ?? null;
    await olseraInventoryState.updateOne(
      { _id: "olsera-inventory" },
      {
        $set: {
          earliestAvailableDate,
          historyCoverage: "snapshot-only" as const,
          updatedAt: now,
          ...(state?.firstSyncAt ? {} : { firstSyncAt: now }),
          // field yang belum pernah ditulis dibaca sebagai null oleh pemakai state.
          ...(options.advanceCheckpointTo ? { lastSuccessfulSyncAt: now, lastSyncedDate: options.advanceCheckpointTo } : {}),
        },
      },
      { upsert: true },
    );
  });
}

// ---- Query untuk halaman ----

export async function getInventorySummary() {
  return withMongo(async () => {
    const { olseraInventoryProducts } = await collections();
    const products = (await olseraInventoryProducts.find().toArray()) as InventoryProductInput[];
    return summarizeInventory(products);
  });
}

export async function getInventoryConsistency(): Promise<{
  rows: ConsistencyRow[];
  note: string;
}> {
  return withMongo(async () => {
    const { olseraInventoryProducts, olseraInventorySnapshots, olseraInventoryMovements } = await collections();
    const [products, snapshots, movements] = await Promise.all([
      olseraInventoryProducts.find({ trackInventory: true }).toArray(),
      olseraInventorySnapshots.find().toArray(),
      olseraInventoryMovements.find({ productId: { $ne: null } }).toArray(),
    ]);
    const snapshotsByKey = new Map<string, { date: string; stockQty: number }[]>();
    for (const snapshot of snapshots) {
      const key = `${snapshot.storeId ?? 0}:${snapshot.productId}:${snapshot.variantId ?? 0}`;
      const list = snapshotsByKey.get(key) ?? [];
      list.push({ date: snapshot.date, stockQty: snapshot.stockQty });
      snapshotsByKey.set(key, list);
    }
    const movementsByKey = new Map<string, { date: string; qtyChange: number }[]>();
    for (const movement of movements) {
      const key = `${movement.storeId ?? 0}:${movement.productId}:${movement.variantId ?? 0}`;
      const list = movementsByKey.get(key) ?? [];
      list.push({ date: movement.date, qtyChange: movement.qtyChange });
      movementsByKey.set(key, list);
    }
    const rows = products.map((product) =>
      computeConsistency({
        key: product._id,
        sku: product.sku,
        name: product.variantName ? `${product.name} - ${product.variantName}` : product.name,
        category: product.category,
        trackInventory: product.trackInventory,
        snapshots: snapshotsByKey.get(product._id) ?? [],
        movements: movementsByKey.get(product._id) ?? [],
      }),
    );
    // "Perlu Stock Opname" (butuh perhatian) ditampilkan lebih dulu, lalu
    // diurutkan berdasarkan besar perubahan snapshot — bukan klaim kebenaran.
    const statusPriority: Record<ConsistencyStatus, number> = {
      "Perlu Stock Opname": 0,
      "Snapshot Tersedia": 1,
      "Histori Tidak Lengkap": 2,
      "Belum Ada Snapshot": 3,
    };
    rows.sort((a, b) => {
      const byStatus = statusPriority[a.status] - statusPriority[b.status];
      if (byStatus !== 0) return byStatus;
      return Math.abs(b.snapshotChange ?? 0) - Math.abs(a.snapshotChange ?? 0);
    });
    return {
      rows,
      note:
        "Konsistensi hanya menggunakan snapshot stok aplikasi dan transaksi penjualan yang tersedia. " +
        "Kecocokan stok fisik memerlukan stock opname.",
    };
  });
}
