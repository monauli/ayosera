import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { generateTwoSheetInventoryExport } from "@/lib/olsera-inventory-two-sheet-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const paramsSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

/**
 * Export Inventori canonical — SATU tombol, SATU file, DUA sheet ("[Bulan]
 * Terjual"/"[Bulan] Keseluruhan"). Pengguna hanya memilih bulan+tahun; bila
 * snapshot bulanan bulan itu belum ada, `ensureMonthlySnapshotChain` (dipanggil
 * di dalam `generateTwoSheetInventoryExport`) membangunnya on-demand dari Open
 * API Olsera terlebih dahulu — idempotent (upsert by _id, aman dijalankan
 * ulang, tidak menyentuh bulan lain), TIDAK PERNAH menulis data ganda. Ini
 * menggantikan endpoint "Laporan Stock Opname Bulanan" lama (format satu
 * sheet + kolom harian) — lihat tmp/ai-handoff.md untuk audit sumber data.
 */
export async function GET(request: Request) {
  try {
    await requireModule("olsera");

    const { searchParams } = new URL(request.url);
    const params = paramsSchema.safeParse({ year: searchParams.get("year"), month: searchParams.get("month") });
    if (!params.success) {
      return NextResponse.json({ error: "Parameter year/month tidak valid." }, { status: 400 });
    }

    const result = await generateTwoSheetInventoryExport({ year: params.data.year, month: params.data.month });
    if (!result.ok) {
      return NextResponse.json({ error: "Gagal membuat export inventori.", details: result.errors }, { status: 400 });
    }

    const buffer = await result.workbook.xlsx.writeBuffer();
    const filename = `Inventori-${params.data.year}-${String(params.data.month).padStart(2, "0")}.xlsx`;
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal membuat export inventori." }, { status: 500 });
  }
}
