import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { collections, withMongo, type OlseraInventoryMonthlySnapshotDocument } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { DEFAULT_LOW_STOCK_THRESHOLD } from "@/lib/olsera-inventory-core";
import { isHiddenInventoryCategory } from "@/lib/olsera-inventory-ui";
import { stripDuplicateSuffix } from "@/lib/olsera-inventory-monthly-snapshot-core";
import { monthlyPeriodStatus, monthlyStockStatus, summarizeMonthlyInventory, type MonthlyInventoryUiRow } from "@/lib/olsera-inventory-monthly-ui";
import { getInventorySyncStatus } from "@/lib/olsera-inventory";

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
    const [status, raw] = await Promise.all([
      getInventorySyncStatus(),
      withMongo(async () => {
        const { olseraInventoryMonthlySnapshots, olseraInventoryProducts } = await collections();
        const [snapshots, products] = await Promise.all([
          olseraInventoryMonthlySnapshots.find({ year, month }).sort({ productName: 1, _id: 1 }).toArray(),
          olseraInventoryProducts.find().toArray(),
        ]);
        return { snapshots, products };
      }),
    ]);

    const productByKey = new Map(raw.products.map((product) => [rowKey(product.storeId ?? 0, product.productId, product.variantId), product]));
    const rows = raw.snapshots.map((snapshot: OlseraInventoryMonthlySnapshotDocument) => {
      const product = productByKey.get(rowKey(snapshot.storeId, snapshot.productId, snapshot.variantId));
      const category = product?.category ?? snapshot.groupName;
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
        // Sufiks "duplicate" dari katalog Olsera (produk lama yang dibuat
        // ulang dengan productId baru) dibersihkan untuk tampilan — generik,
        // sama seperti export dua-sheet (lib/olsera-inventory-two-sheet-export.ts).
        name: stripDuplicateSuffix(product?.name ?? snapshot.productName),
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
      };
    });

    const summary = summarizeMonthlyInventory(rows);
    const filtered = rows.filter((row) => {
      if (params.q) {
        const query = params.q.toLocaleLowerCase();
        if (![row.name, row.variantName, row.sku, row.category].some((value) => value?.toLocaleLowerCase().includes(query))) return false;
      }
      if (params.category && row.category !== params.category) return false;
      if (params.status && ({ aman: "Aman", hampir: "Hampir Habis", habis: "Habis", manual: "Butuh Adjust Manual" } as Record<string, string>)[params.status] !== row.status) return false;
      return true;
    });
    const direction = params.dir === "asc" ? 1 : -1;
    filtered.sort((a, b) => (params.sort === "stock" ? ((a.closingQty ?? 0) - (b.closingQty ?? 0)) : params.sort === "value" ? ((a.value ?? 0) - (b.value ?? 0)) : a.name.localeCompare(b.name, "id")) * direction);
    const categories = [...new Set(rows.map((row) => row.category))].sort((a, b) => a.localeCompare(b, "id"));
    const start = (params.page - 1) * params.limit;
    const currentPeriod = jakartaPeriod();
    return NextResponse.json({
      period: params.period,
      hasData: rows.length > 0,
      status: monthlyPeriodStatus(params.period, currentPeriod, rows),
      temporaryUntil: params.period === currentPeriod ? status.state.lastSuccessfulSyncAt : null,
      priceSource: "current-master",
      priceNote: "Snapshot bulanan belum menyimpan unit cost historis; harga modal memakai master inventori saat ini.",
      summary,
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
