import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { requireModule } from "@/lib/auth";
import { cellValue } from "@/lib/xlsx-cell";
import { parseRacketAddonRows } from "@/lib/ayo-racket-addon-import";
import { saveRacketAddonImport } from "@/lib/ayo-racket-addon-store";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const user = await requireModule("transaksi");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) {
      return NextResponse.json({ error: "Berkas Excel add-on wajib diisi." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    if (file.size > MAX_BYTES || !file.name.toLowerCase().endsWith(".xlsx")) {
      return NextResponse.json({ error: "Berkas harus .xlsx dan maksimal 10 MB." }, { status: 400, headers: NO_CACHE_HEADERS });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const worksheet = workbook.worksheets[0];
    if (!worksheet) return NextResponse.json({ error: "Sheet Excel tidak ditemukan." }, { status: 400, headers: NO_CACHE_HEADERS });
    const rows: unknown[][] = [];
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      rows.push(Array.from({ length: worksheet.columnCount }, (_, index) => cellValue(row.getCell(index + 1))));
    });

    const parsed = parseRacketAddonRows(rows);
    if (!parsed.headerFound) {
      return NextResponse.json({ error: "Kolom Booking ID dan Sewa Raket Add On tidak ditemukan." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    if (parsed.rows.length === 0) {
      return NextResponse.json({ error: "Tidak ada baris booking yang bisa diimpor." }, { status: 400, headers: NO_CACHE_HEADERS });
    }

    await saveRacketAddonImport({ rows: parsed.rows, sourceFileName: file.name, importedBy: user.email });
    return NextResponse.json({
      data: {
        fileName: file.name,
        rowsImported: parsed.rows.length,
        addonCount: parsed.addonCount,
        totalAmount: parsed.totalAmount,
        periods: parsed.periods,
      },
    }, { status: 201, headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    const reason = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Import add-on gagal: ${reason}` }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
