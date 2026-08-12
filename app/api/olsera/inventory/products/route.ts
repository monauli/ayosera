import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { collections, withMongo, type OlseraInventoryProductDocument } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import {
  inventoryValueFor,
  stockStatusFor,
  DEFAULT_LOW_STOCK_THRESHOLD,
} from "@/lib/olsera-inventory-core";
import { stripDuplicateSuffix } from "@/lib/olsera-inventory-monthly-snapshot-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(120).optional(),
  status: z.enum(["aman", "hampir", "habis", "nolengkap"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.enum(["stock", "value", "name"]).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

const STATUS_LABEL: Record<string, string> = {
  aman: "Aman",
  hampir: "Hampir Habis",
  habis: "Habis",
  nolengkap: "Data Tidak Lengkap",
};

export async function GET(request: Request) {
  try {
    await requireModule("olsera");
    const url = new URL(request.url);
    const params = querySchema.parse(Object.fromEntries(url.searchParams));

    const { rows, total, categories } = await withMongo(async () => {
      const { olseraInventoryProducts } = await collections();
      const filter: Record<string, unknown> = {};
      if (params.q) {
        const rx = new RegExp(params.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ name: rx }, { sku: rx }, { variantName: rx }, { barcode: rx }];
      }
      if (params.category) filter.category = params.category;

      const [docs, categories] = await Promise.all([
        olseraInventoryProducts.find(filter).toArray(),
        olseraInventoryProducts.distinct("category"),
      ]);

      // Status stok dihitung dari data (bukan disimpan) — filter status di memori;
      // katalog < ~1000 baris sehingga aman.
      let list = docs;
      if (params.status) {
        list = docs.filter((doc) => stockStatusFor(doc) === STATUS_LABEL[params.status!]);
      }

      const direction = params.dir === "asc" ? 1 : -1;
      list.sort((a, b) => {
        if (params.sort === "stock") return (a.stockQty - b.stockQty) * direction;
        if (params.sort === "value") return (inventoryValueFor(a) - inventoryValueFor(b)) * direction;
        return a.name.localeCompare(b.name) * direction;
      });

      const total = list.length;
      const start = (params.page - 1) * params.limit;
      return { rows: list.slice(start, start + params.limit), total, categories: categories.sort() };
    });

    return NextResponse.json(
      {
        data: rows.map((doc: OlseraInventoryProductDocument) => ({
          id: doc._id,
          sku: doc.sku,
          // Katalog Olsera kadang menyimpan produk lama sebagai entri baru
          // dengan sufiks "duplicate" (lihat lib/olsera-inventory-monthly-snapshot-core.ts,
          // kasus "YONEX SHORTS MEN # SM-J035-2906-RW1-S") — dibersihkan di
          // sini juga (bukan hanya di export Buku Besar Inventori) supaya
          // pencarian/tampilan Daftar Produk tidak membuat produk terlihat
          // seperti duplikat/hilang. Generik untuk produk mana pun, bukan
          // hardcode nama tertentu.
          name: stripDuplicateSuffix(doc.name),
          variantName: doc.variantName,
          category: doc.category,
          uom: doc.uom,
          storeName: doc.storeName,
          stockQty: doc.stockQty,
          lowStockAlert: doc.lowStockAlert,
          usesDefaultThreshold: doc.trackInventory && doc.lowStockAlert === null,
          status: stockStatusFor(doc),
          buyPrice: doc.buyPrice,
          value: inventoryValueFor(doc),
          active: doc.active,
          trackInventory: doc.trackInventory,
          modifiedTime: doc.modifiedTime,
        })),
        total,
        page: params.page,
        totalPages: Math.max(1, Math.ceil(total / params.limit)),
        categories,
        defaultThreshold: DEFAULT_LOW_STOCK_THRESHOLD,
      },
      { headers: NO_CACHE_HEADERS },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Parameter tidak valid" }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Gagal memuat produk inventori." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
