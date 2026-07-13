import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { buildOmsetKategoriWorkbook, loadOmsetKategoriRows } from "@/lib/omset-kategori-export";

export const runtime = "nodejs";

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

export async function GET(request: Request) {
  try {
    await requireModule("olsera");

    const { searchParams } = new URL(request.url);
    const month = searchParams.get("month") || "";

    if (!MONTH_PATTERN.test(month)) {
      return NextResponse.json({ error: "month wajib diisi dengan format YYYY-MM." }, { status: 400 });
    }
    const monthNumber = Number(month.slice(5, 7));
    if (monthNumber < 1 || monthNumber > 12) {
      return NextResponse.json({ error: "month tidak valid (bulan harus 01-12)." }, { status: 400 });
    }

    const input = await loadOmsetKategoriRows(month);
    if (input.empty) {
      return NextResponse.json(
        { error: `Tidak ada transaksi pada bulan ${month}. Jalankan sync terlebih dahulu.` },
        { status: 404 },
      );
    }

    const buffer = await buildOmsetKategoriWorkbook(input);

    const filename = `Omset Kategori-${month}.xlsx`;
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
    return NextResponse.json({ error: "Gagal membuat export Omset Kategori." }, { status: 500 });
  }
}
