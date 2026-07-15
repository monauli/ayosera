import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { collections, withMongo } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  start_date: dateString.optional(),
  end_date: dateString.optional(),
  type: z.string().trim().max(60).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: Request) {
  try {
    await requireModule("olsera");
    const url = new URL(request.url);
    const params = querySchema.parse(Object.fromEntries(url.searchParams));

    const { rows, total, types } = await withMongo(async () => {
      const { olseraInventoryMovements } = await collections();
      const filter: Record<string, unknown> = {};
      if (params.start_date || params.end_date) {
        filter.date = {
          ...(params.start_date ? { $gte: params.start_date } : {}),
          ...(params.end_date ? { $lte: params.end_date } : {}),
        };
      }
      if (params.type) filter.type = params.type;
      if (params.q) {
        const rx = new RegExp(params.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ productName: rx }, { sku: rx }, { reference: rx }];
      }
      const [total, docs, types] = await Promise.all([
        olseraInventoryMovements.countDocuments(filter),
        olseraInventoryMovements
          .find(filter)
          .sort({ movementAt: -1, _id: 1 })
          .skip((params.page - 1) * params.limit)
          .limit(params.limit)
          .toArray(),
        olseraInventoryMovements.distinct("type"),
      ]);
      return { rows: docs, total, types: types.sort() };
    });

    return NextResponse.json(
      {
        data: rows.map((doc) => ({
          id: doc._id,
          date: doc.date,
          movementAt: doc.movementAt,
          sku: doc.sku,
          productName: doc.productName,
          type: doc.type,
          // Qty sebelum/sesudah TIDAK ditampilkan — API Olsera tidak menyediakan
          // saldo sebelum/sesudah (lihat lib/mongodb.ts: field selalu null).
          qtyChange: doc.qtyChange,
          costPrice: doc.costPrice,
          value: doc.value,
          reference: doc.reference,
          note: doc.note,
        })),
        total,
        page: params.page,
        totalPages: Math.max(1, Math.ceil(total / params.limit)),
        types,
      },
      { headers: NO_CACHE_HEADERS },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Parameter tidak valid" }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Gagal memuat mutasi inventori." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
