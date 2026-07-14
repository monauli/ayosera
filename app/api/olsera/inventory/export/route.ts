import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import {
  buildInventoryConsistencyWorkbook,
  buildInventoryMovementWorkbook,
  buildInventoryStockWorkbook,
} from "@/lib/olsera-inventory-export";
import { todayJakarta } from "@/lib/olsera-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  type: z.enum(["stock", "movements", "consistency"]),
  start_date: dateString.optional(),
  end_date: dateString.optional(),
  movement_type: z.string().trim().max(60).optional(),
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(120).optional(),
});

export async function GET(request: Request) {
  try {
    await requireModule("olsera");
    const url = new URL(request.url);
    const params = querySchema.parse(Object.fromEntries(url.searchParams));
    const today = todayJakarta();

    let workbook;
    let filename;
    if (params.type === "stock") {
      workbook = await buildInventoryStockWorkbook({ q: params.q, category: params.category });
      filename = `Stok Inventori-${today}.xlsx`;
    } else if (params.type === "movements") {
      const start = params.start_date ?? today;
      const end = params.end_date ?? today;
      if (start > end) {
        return NextResponse.json({ error: "start_date tidak boleh lebih besar dari end_date." }, { status: 400 });
      }
      workbook = await buildInventoryMovementWorkbook({
        startDate: start,
        endDate: end,
        type: params.movement_type,
        q: params.q,
      });
      filename = `Mutasi Inventori-${start}__${end}.xlsx`;
    } else {
      workbook = await buildInventoryConsistencyWorkbook();
      const start = params.start_date ?? today;
      filename = `Konsistensi Inventori-${start}__${today}.xlsx`;
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Parameter export tidak valid" }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Gagal membuat export inventori Olsera." }, { status: 500 });
  }
}
