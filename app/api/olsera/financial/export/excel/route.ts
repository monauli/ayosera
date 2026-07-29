import { generateFinancialExcelExport, generateFinancialLedgerAccountExcelExport } from "@/lib/olsera-financial-export";
import { exportFailureResponse } from "@/lib/olsera-financial-export-core";
import { guard, json, isDatabaseTimeoutError } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Export Excel gabungan (5 sheet) Laporan Keuangan — HANYA dari snapshot MongoDB
 * (lib/olsera-financial-export.ts), tidak pernah membaca Olsera live. Auth sama
 * dengan route snapshot (guard: requireModule "olsera" saja, tanpa syarat
 * supervisor). Timeout database
 * dipetakan ke HTTP 504 terstruktur; kegagalan lain ke pesan aman tanpa
 * BSON/stack/payload mentah.
 *
 * accountCode (opsional) → "Download Akun Ini": workbook satu sheet berisi
 * HANYA Buku Besar Detail akun tersebut, bukan 5-sheet gabungan. Tanpa
 * accountCode, perilaku penuh (5 sheet) tidak berubah.
 */
export async function GET(req: Request) {
  try {
    await guard();
    const url = new URL(req.url);
    const period = url.searchParams.get("period") ?? "";
    const accountCode = url.searchParams.get("accountCode");
    const result = accountCode
      ? await generateFinancialLedgerAccountExcelExport(period, accountCode)
      : await generateFinancialExcelExport(period);
    if (!result.ok) {
      const { httpStatus, body } = exportFailureResponse(result.reason);
      return json(body, { status: httpStatus });
    }
    return new Response(result.body as unknown as BodyInit, {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (isDatabaseTimeoutError(error)) {
      return json({ status: "timeout", message: "Snapshot laporan keuangan belum merespons dalam batas waktu aman." }, { status: 504 });
    }
    return json({ status: "generation-failed", message: "Gagal membuat berkas Excel laporan keuangan. Coba lagi." }, { status: 500 });
  }
}
