import { generateFinancialPdfExport } from "@/lib/olsera-financial-export";
import { exportFailureResponse } from "@/lib/olsera-financial-export-core";
import { guard, json, isDatabaseTimeoutError } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Export PDF satu jenis laporan (report=neraca|laba-rugi|arus-kas|
 * ringkasan-buku-besar|buku-besar-detail) — HANYA dari snapshot MongoDB, tidak
 * pernah membaca Olsera live. Buku Besar Detail boleh banyak halaman (seluruh
 * ledger periode dari MongoDB, bukan halaman pertama API). Timeout database →
 * HTTP 504 terstruktur; kegagalan lain → pesan aman tanpa BSON/stack/payload.
 */
export async function GET(req: Request) {
  try {
    await guard();
    const url = new URL(req.url);
    const period = url.searchParams.get("period") ?? "";
    const report = url.searchParams.get("report") ?? "";
    const result = await generateFinancialPdfExport(period, report);
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
    return json({ status: "generation-failed", message: "Gagal membuat berkas PDF laporan keuangan. Coba lagi." }, { status: 500 });
  }
}
