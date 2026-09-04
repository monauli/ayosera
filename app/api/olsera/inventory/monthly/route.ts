import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { collections, withMongo, type OlseraInventoryMonthlySnapshotDocument } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { DEFAULT_LOW_STOCK_THRESHOLD } from "@/lib/olsera-inventory-core";
import { isHiddenInventoryCategory } from "@/lib/olsera-inventory-ui";
import { computeMonthlyTabRowSets, monthlyPeriodStatus, monthlyStockStatus, summarizeMonthlyInventory, type MonthlyInventoryUiRow } from "@/lib/olsera-inventory-monthly-ui";
import { getInventorySyncStatus } from "@/lib/olsera-inventory";
import { getInventoryMonthlyPeriodLock } from "@/lib/inventory-monthly-period-lock";
import { currentStoreId } from "@/lib/olsera-store-id";
import { ensureMonthlySnapshotChain } from "@/lib/olsera-inventory-monthly-snapshot-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(120).optional(),
  status: z.enum(["aman", "hampir", "habis", "manual"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.enum(["stock", "value", "name"]).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  tab: z.enum(["sold", "unsold", "overall", "stagnant", "grandTotal"]).default("overall"),
});

function jakartaPeriod() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" }).format(new Date());
}

function rowKey(storeId: number, productId: number, variantId: number | null) {
  return `${storeId}:${productId}:${variantId ?? 0}`;
}

export async function GET(request: Request) {
  try {
    await requireModule("olsera");
    const params = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const year = Number(params.period.slice(0, 4));
    const month = Number(params.period.slice(5));
    const ensured = await ensureMonthlySnapshotChain({ year, month });
    if (!ensured.ok) return NextResponse.json({ error: ensured.error }, { status: 409, headers: NO_CACHE_HEADERS });
    const [status, raw] = await Promise.all([
      getInventorySyncStatus(),
      withMongo(async () => {
        const { olseraInventoryMonthlySnapshots, olseraInventoryProducts } = await collections();
        const [lock, products] = await Promise.all([
          getInventoryMonthlyPeriodLock(currentStoreId(), year, month),
          olseraInventoryProducts.find().toArray(),
        ]);
        const snapshots = lock?.status === "locked" ? lock.snapshots : await olseraInventoryMonthlySnapshots.find({ year, month }).sort({ productName: 1, _id: 1 }).toArray();
        return { snapshots, products, lock };
      }),
    ]);

    const productByKey = new Map(raw.products.map((product) => [rowKey(product.storeId ?? 0, product.productId, product.variantId), product]));
    const allRows = raw.snapshots.map((snapshot: OlseraInventoryMonthlySnapshotDocument) => {
      const product = productByKey.get(rowKey(snapshot.storeId, snapshot.productId, snapshot.variantId));
      const category = snapshot.groupName ?? "";
      const minimumStock = product?.lowStockAlert ?? DEFAULT_LOW_STOCK_THRESHOLD;
      const unitCost = product?.buyPrice ?? null;
      const base: MonthlyInventoryUiRow = {
        closingQty: snapshot.closingQty,
        unitCost,
        minimumStock,
        trackInventory: product?.trackInventory ?? true,
        hidden: isHiddenInventoryCategory(category),
        snapshotStatus: snapshot.status,
      };
      return {
        ...base,
        id: snapshot._id,
        sku: snapshot.productSku ?? product?.sku ?? null,
        name: product?.name ?? snapshot.productName,
        variantName: product?.variantName ?? null,
        category,
        storeName: product?.storeName ?? null,
        openingQty: snapshot.openingQty,
        incomingQty: snapshot.incomingQty,
        returnQty: snapshot.returnQty,
        salesQty: snapshot.salesQty,
        outgoingQty: snapshot.outgoingQty,
        status: monthlyStockStatus(base),
        stockQty: snapshot.closingQty ?? 0,
        lowStockAlert: product?.lowStockAlert ?? null,
        uom: product?.uom ?? null,
        active: product?.active ?? true,
        modifiedTime: product?.modifiedTime ?? null,
        buyPrice: unitCost,
        value: snapshot.closingQty !== null && unitCost !== null ? snapshot.closingQty * unitCost : null,
        usesDefaultThreshold: product?.lowStockAlert == null,
        trackInventory: base.trackInventory,
        diagnostics: snapshot.diagnostics,
        source: snapshot.source === "catalog" ? "CATALOG" : "STOCK_MOVEMENT",
        identityResolved: snapshot.status !== "incomplete",
      };
    });
    // "moved" (dulu "rows") dikecualikan dari produk active:false tak
    // bergerak; "stagnant" adalah selisihnya; "grandTotal" filter TUNGGAL
    // hasInventoryActivity sama persis dengan export "Laporan Stock Opname
    // Bulanan" — satu sumber, tiga tab, lihat computeMonthlyTabRowSets.
    const { moved: rows, stagnant: stagnantRows, grandTotal: grandTotalRows } = computeMonthlyTabRowSets(allRows);

    const summary = summarizeMonthlyInventory(rows);
    const tabCounts = {
      sold: rows.filter((row) => (row.salesQty ?? 0) > 0).length,
      unsold: rows.filter((row) => (row.salesQty ?? 0) <= 0).length,
      overall: rows.length,
      stagnant: stagnantRows.length,
      grandTotal: grandTotalRows.length,
    };
    // Baris yang benar-benar dirender HARUS diambil dari himpunan yang sama
    // dengan badge count di atas untuk tab yang sama — supaya tidak berulang
    // masalah badge-vs-baris (lihat komit 7828bd9).
    const baseRowsByTab: Record<typeof params.tab, typeof rows> = {
      sold: rows,
      unsold: rows,
      overall: rows,
      stagnant: stagnantRows,
      grandTotal: grandTotalRows,
    };
    const filtered = baseRowsByTab[params.tab].filter((row) => {
      if (params.tab === "sold" && (row.salesQty ?? 0) <= 0) return false;
      if (params.tab === "unsold" && (row.salesQty ?? 0) > 0) return false;
      if (params.q) {
        const query = params.q.toLocaleLowerCase();
        if (![row.name, row.variantName, row.sku, row.category].some((value) => value?.toLocaleLowerCase().includes(query))) return false;
      }
      if (params.category && row.category !== params.category) return false;
      if (params.status && ({ aman: "Aman", hampir: "Hampir Habis", habis: "Habis", manual: "Butuh Adjust Manual" } as Record<string, string>)[params.status] !== row.status) return false;
      return true;
    });
    const direction = params.dir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      if (params.sort === "stock") return ((a.closingQty ?? 0) - (b.closingQty ?? 0)) * direction;
      if (params.sort === "value") return ((a.value ?? 0) - (b.value ?? 0)) * direction;
      return (a.category.localeCompare(b.category, "id") || a.name.localeCompare(b.name, "id")) * direction;
    });
    // Superset grandTotalRows (bukan rows/moved saja) — supaya filter
    // kategori tetap bisa dipakai di tab "Tidak Ada Pergerakan"/"Total
    // Keseluruhan" yang berisi kategori di luar himpunan "moved".
    const categories = [...new Set(grandTotalRows.map((row) => row.category))].sort((a, b) => a.localeCompare(b, "id"));
    const start = (params.page - 1) * params.limit;
    const currentPeriod = jakartaPeriod();
    return NextResponse.json({
      period: params.period,
      hasData: rows.length > 0,
      status: raw.lock?.status === "locked" ? "LOCKED" : monthlyPeriodStatus(params.period, currentPeriod, rows),
      periodLock: raw.lock ? { status: raw.lock.status, lockedAt: raw.lock.lockedAt, lockedBy: raw.lock.lockedBy, unlockedAt: raw.lock.unlockedAt, unlockedBy: raw.lock.unlockedBy, history: raw.lock.history } : null,
      temporaryUntil: params.period === currentPeriod ? status.state.lastSuccessfulSyncAt : null,
      priceSource: "current-master",
      priceNote: "Snapshot bulanan belum menyimpan unit cost historis; harga modal memakai master inventori saat ini.",
      summary,
      tabCounts,
      data: filtered.slice(start, start + params.limit),
      total: filtered.length,
      page: params.page,
      totalPages: Math.max(1, Math.ceil(filtered.length / params.limit)),
      categories,
      defaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
      syncStatus: status,
    }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Parameter periode inventori tidak valid." }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: "Gagal memuat snapshot inventori bulanan." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
