import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { uploadMappingSource } from "@/lib/blob-storage";
import { currentStoreId } from "@/lib/reconciliation-store";
import { readFinancialWorkbook } from "@/lib/mapping-excel-parser";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXCEL_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];
// Laporan scan bertanda tangan di fixture berukuran 4,5 MB — batas 4 MB milik
// alur BA terlalu ketat untuk berkas kelas ini.
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Unggah berkas sumber Modul Mapping ke Vercel Blob.
 *
 * Workbook Excel SEKALIAN diparse di sini, PDF tidak. Alasannya bukan
 * selera:
 *
 *  - Excel butuh exceljs (~1 MB). Memparsenya di browser berarti menyeret
 *    pustaka itu ke bundle klien, padahal repo ini sudah memakainya di sisi
 *    server. Yang dikembalikan adalah model barisnya (label + tebal + nilai
 *    per kolom), BUKAN hasil parse satu bulan — supaya sekali unggah pengguna
 *    bisa berpindah bulan tanpa unggah ulang, dan parsing per bulan
 *    (parseFinancialSheet, fungsi murni tanpa dependensi) jalan di browser.
 *
 *  - PDF hasil scan WAJIB diparse di browser: rasterisasi halaman butuh
 *    Canvas API, yang di serverless Vercel butuh binary native. Ini pola yang
 *    sama dengan alur Berita Acara inventori — lihat
 *    lib/reconciliation-berita-acara-client-ocr.ts.
 */
export async function POST(request: Request) {
  try {
    await requireModule("mapping");
    const form = await request.formData();
    const file = form.get("file");
    const kind = form.get("kind");
    if (kind !== "excel" && kind !== "pdf") {
      return NextResponse.json({ error: "Jenis berkas tidak dikenal." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    if (!(file instanceof File) || !file.size) {
      return NextResponse.json({ error: "Berkas wajib diisi." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: `Berkas maksimal ${MAX_BYTES / 1024 / 1024} MB.` }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    const allowed = kind === "excel" ? EXCEL_MIME_TYPES : ["application/pdf"];
    if (!allowed.includes(file.type)) {
      return NextResponse.json(
        { error: kind === "excel" ? "Berkas harus .xlsx." : "Berkas harus PDF." },
        { status: 400, headers: NO_CACHE_HEADERS },
      );
    }

    // Workbook diparse SEBELUM diunggah supaya berkas yang tidak bisa dibaca
    // tidak pernah menyisakan blob yatim.
    let sheets: Awaited<ReturnType<typeof readFinancialWorkbook>> | undefined;
    if (kind === "excel") {
      try {
        sheets = await readFinancialWorkbook(await file.arrayBuffer());
      } catch {
        return NextResponse.json({ error: "Berkas .xlsx tidak bisa dibaca." }, { status: 400, headers: NO_CACHE_HEADERS });
      }
      if (sheets.length === 0) {
        return NextResponse.json(
          { error: "Tidak ada sheet laporan yang dikenali. Nama sheet harus memuat 'Laba Rugi'/'Profit', 'Neraca'/'Balance', atau 'Arus Kas'/'Cashflow'." },
          { status: 400, headers: NO_CACHE_HEADERS },
        );
      }
    }

    const uploaded = await uploadMappingSource({ storeId: currentStoreId(), kind, file });
    return NextResponse.json(
      { data: { url: uploaded.url, fileName: file.name, mimeType: file.type, size: file.size, uploadedAt: new Date().toISOString(), sheets } },
      { status: 201, headers: NO_CACHE_HEADERS },
    );
  } catch (error) {
    // Alasannya ikut dikirim: "Gagal mengunggah berkas." tanpa keterangan
    // tidak bisa dibedakan dari penolakan platform (413 body >4,5 MB) yang
    // bahkan tidak pernah sampai ke sini, dan itu persis yang membuat
    // kegagalan unggah PDF dulu tidak bisa didiagnosis dari layar.
    const reason = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Gagal mengunggah berkas: ${reason}` }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
