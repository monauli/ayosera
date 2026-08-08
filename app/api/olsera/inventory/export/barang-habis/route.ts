import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { generateBarangHabisExport } from "@/lib/olsera-inventory-two-sheet-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const paramsSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

/**
 * Export Barang Habis — SATU sheet ("[Bulan] Barang Habis"), laporan
 * historis produk yang closing stoknya 0 pada bulan yang dipilih (dan
 * terbukti punya aktivitas, bukan zero-activity row — lihat
 * filterBarangHabisRows di lib/olsera-inventory-two-sheet-export.ts). Sama
 * seperti export/monthly-auto: snapshot bulanan dibangun on-demand via
 * ensureMonthlySnapshotChain bila belum ada, idempotent, tidak menyentuh
 * bulan lain.
 */
export async function GET(request: Request) {
  try {
    await requireModule("olsera");

    const { searchParams } = new URL(request.url);
    const params = paramsSchema.safeParse({ year: searchParams.get("year"), month: searchParams.get("month") });
    if (!params.success) {
      return NextResponse.json({ error: "Parameter year/month tidak valid." }, { status: 400 });
    }

    const result = await generateBarangHabisExport({ year: params.data.year, month: params.data.month });
    if (!result.ok) {
      return NextResponse.json({ error: "Gagal membuat export Barang Habis.", details: result.errors }, { status: 400 });
    }

    const buffer = await result.workbook.xlsx.writeBuffer();
    const filename = `Barang-Habis-${params.data.year}-${String(params.data.month).padStart(2, "0")}.xlsx`;
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal membuat export Barang Habis." }, { status: 500 });
  }
}
