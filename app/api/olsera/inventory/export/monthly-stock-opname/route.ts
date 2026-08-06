import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { generateMonthlyInventoryExportAuto } from "@/lib/olsera-inventory-monthly-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const paramsSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

/**
 * Laporan Stock Opname Bulanan — format lama (satu sheet, kolom
 * tanggal/per hari), dikembalikan dari commit f5bf8f0 (lihat
 * tmp/ai-handoff.md). Berdampingan dengan Export Inventori 2 Sheet
 * (/api/olsera/inventory/export/monthly-auto) di dropdown "Export
 * Inventori" yang sama — bukan pengganti. TIDAK ada upload file; pengguna
 * hanya memilih bulan+tahun, snapshot bulanan disiapkan on-demand lewat
 * `ensureMonthlySnapshotChain` yang sama dipakai jalur canonical.
 */
export async function GET(request: Request) {
  try {
    await requireModule("olsera");

    const { searchParams } = new URL(request.url);
    const params = paramsSchema.safeParse({ year: searchParams.get("year"), month: searchParams.get("month") });
    if (!params.success) {
      return NextResponse.json({ error: "Parameter year/month tidak valid." }, { status: 400 });
    }

    const result = await generateMonthlyInventoryExportAuto({ year: params.data.year, month: params.data.month });
    if (!result.ok) {
      return NextResponse.json({ error: "Gagal membuat Laporan Stock Opname Bulanan.", details: result.errors }, { status: 400 });
    }

    const buffer = await result.workbook.xlsx.writeBuffer();
    const filename = `Laporan Stock Opname Bulanan-${params.data.year}-${String(params.data.month).padStart(2, "0")}.xlsx`;
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal membuat Laporan Stock Opname Bulanan." }, { status: 500 });
  }
}
