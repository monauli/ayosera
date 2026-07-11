import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { collections, withMongo } from "@/lib/mongodb";
import { buildOlseraOmsetWorkbook } from "@/lib/olsera-export";

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

    const rows = await withMongo(async () => {
      const { olseraSalesByCategory } = await collections();
      return olseraSalesByCategory
        .find({ date: { $gte: start, $lte: end } })
        .project<{ date: string; category: string; totalAmount: number; costAmount: number }>({
          _id: 0,
          date: 1,
          category: 1,
          totalAmount: 1,
          costAmount: 1,
        })
        .toArray();
    });

    const buffer = await buildOlseraOmsetWorkbook({ start, end, rows });

    const filename = start === end ? `Omset Olsera ${start}.xlsx` : `Omset Olsera ${start} sd ${end}.xlsx`;
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
    return NextResponse.json({ error: "Gagal membuat export omset Olsera." }, { status: 500 });
  }
}
