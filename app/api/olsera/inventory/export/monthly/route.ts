import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { generateMonthlyInventoryExport } from "@/lib/olsera-inventory-monthly-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const paramsSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

/**
 * Export Inventori Bulanan ("Laporan Stock Opname") — menerima upload file
 * summary Pergerakan Stok resmi Olsera (Backoffice, bukan Open API — endpoint
 * ini tidak tersedia di Open API, lihat audit) sebagai sumber Stok Awal/
 * Barang Masuk/Keluar/Stock Akhir, digabung dengan penjualan harian dari
 * data Olsera yang sudah tersinkron (olsera_inventory_movements existing)
 * dan katalog produk (olsera_inventory_products existing). Tidak menulis
 * apa pun ke MongoDB.
 */
export async function POST(request: Request) {
  try {
    await requireModule("olsera");

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "File summary Pergerakan Stok Olsera (.xlsx) wajib diunggah." }, { status: 400 });
    }

    const params = paramsSchema.safeParse({ year: formData.get("year"), month: formData.get("month") });
    if (!params.success) {
      return NextResponse.json({ error: "Parameter year/month tidak valid." }, { status: 400 });
    }

    const fileBuffer = await file.arrayBuffer();
    const result = await generateMonthlyInventoryExport({
      fileBuffer,
      year: params.data.year,
      month: params.data.month,
    });

    if (!result.ok) {
      return NextResponse.json({ error: "File summary tidak valid.", details: result.errors }, { status: 400 });
    }

    const buffer = await result.workbook.xlsx.writeBuffer();
    const filename = `Laporan Stock Opname-${params.data.year}-${String(params.data.month).padStart(2, "0")}.xlsx`;
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal membuat Export Inventori Bulanan." }, { status: 500 });
  }
}
