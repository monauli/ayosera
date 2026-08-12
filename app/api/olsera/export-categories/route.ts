import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { collections, withMongo } from "@/lib/mongodb";
import { buildOlseraCategoryWorkbook } from "@/lib/olsera-category-export";
import { loadResolverContext, resolveStoredItemCategory } from "@/lib/olsera-resolver-context";
import { validateDateRangeQuery } from "@/lib/date-range-validation";

export const runtime = "nodejs";

const MAX_RANGE_DAYS = 366;

export async function GET(request: Request) {
  try {
    await requireModule("olsera");

    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start_date") || "";
    const end = searchParams.get("end_date") || "";

    const validation = validateDateRangeQuery(start, end, MAX_RANGE_DAYS);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const items = await withMongo(async () => {
      const { olseraOrderItems, olseraSalesCorrections } = await collections();
      const [orderItems, corrections] = await Promise.all([
        olseraOrderItems
        .find({ date: { $gte: start, $lte: end } })
        .sort({ orderDate: 1, orderNo: 1 })
        .project<{
          date: string;
          orderNo: string;
          orderDate: string;
          customerName: string | null;
          tableNo: string | null;
          salesByName: string | null;
          itemName: string;
          qty: number;
          amount: number;
          costAmount: number;
          discount: number;
          addonPrice?: number;
          productId?: number | null;
          variantId?: number | null;
          sku?: string | null;
          barcode?: string | null;
          originalCategoryId?: string | null;
          originalCategoryName?: string | null;
          resolvedCategoryName?: string | null;
          categoryResolutionStatus?: "resolved" | "unresolved";
        }>({
          _id: 0,
          date: 1,
          orderNo: 1,
          orderDate: 1,
          customerName: 1,
          tableNo: 1,
          salesByName: 1,
          itemName: 1,
          qty: 1,
          amount: 1,
          costAmount: 1,
          discount: 1,
          addonPrice: 1,
          productId: 1,
          variantId: 1,
          sku: 1,
          barcode: 1,
          originalCategoryId: 1,
          originalCategoryName: 1,
          resolvedCategoryName: 1,
          categoryResolutionStatus: 1,
        })
        .toArray(),
        olseraSalesCorrections.find({ date: { $gte: start, $lte: end } }).toArray(),
      ]);
      return [
        ...orderItems,
        ...corrections.map((correction) => ({
          date: correction.date,
          orderNo: correction.orderNo,
          orderDate: `${correction.date} 00:00:00`,
          customerName: null,
          tableNo: null,
          salesByName: "Historical correction",
          itemName: correction.itemName,
          qty: correction.qty,
          amount: correction.amount,
          costAmount: 0,
          discount: 0,
          addonPrice: 0,
          originalCategoryName: correction.category,
          resolvedCategoryName: correction.category,
          categoryResolutionStatus: "resolved" as const,
        })),
      ];
    });

    if (!items.length) {
      return NextResponse.json(
        { error: "Tidak ada transaksi Olsera pada periode tersebut. Jalankan sync terlebih dahulu." },
        { status: 404 },
      );
    }

    // Kategori via canonical resolver (identitas tersimpan → katalog → alias →
    // SKU/nama exact) — identik dengan agregat olsera_sales_by_category di dashboard.
    const { ctx } = await loadResolverContext();
    const rows = items.map((item) => ({ ...item, category: resolveStoredItemCategory(item, ctx) }));

    const buffer = await buildOlseraCategoryWorkbook({ start, end, rows });

    const filename = `Kategori Penjualan-${start}__${end}.xlsx`;
    // cast: TS 5.7 menganggap Uint8Array<ArrayBufferLike> tak cocok BodyInit (false positive)
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal membuat export kategori penjualan Olsera." }, { status: 500 });
  }
}
