import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { collections, withMongo } from "@/lib/mongodb";
import {
  buildOlseraCategoryWorkbook,
  categoryForItem,
  getCategoryByNameMap,
} from "@/lib/olsera-category-export";

export const runtime = "nodejs";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    await requireModule("olsera");

    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start_date") || "";
    const end = searchParams.get("end_date") || "";

    if (!DATE_PATTERN.test(start) || !DATE_PATTERN.test(end)) {
      return NextResponse.json(
        { error: "start_date & end_date wajib diisi dengan format YYYY-MM-DD." },
        { status: 400 },
      );
    }
    if (start > end) {
      return NextResponse.json({ error: "start_date tidak boleh lebih besar dari end_date." }, { status: 400 });
    }

    const items = await withMongo(async () => {
      const { olseraOrderItems } = await collections();
      return olseraOrderItems
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
        })
        .toArray();
    });

    if (!items.length) {
      return NextResponse.json(
        { error: "Tidak ada transaksi Olsera pada periode tersebut. Jalankan sync terlebih dahulu." },
        { status: 404 },
      );
    }

    // Kategori di-resolve dari katalog produk Olsera (nama → klasifikasi) —
    // identik hasilnya dengan agregat olsera_sales_by_category di dashboard.
    const nameMap = await getCategoryByNameMap();
    const rows = items.map((item) => ({ ...item, category: categoryForItem(item.itemName, nameMap) }));

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
