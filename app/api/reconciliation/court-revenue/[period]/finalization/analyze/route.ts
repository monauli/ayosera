// Baca otomatis Berita Acara yang baru diunggah (Langkah 2-4 spesifikasi
// OCR): ambil attachment tersimpan di lock (lib/reconciliation-omzet-period-lock.ts),
// unduh dari Vercel Blob, ekstrak teks (lib/reconciliation-berita-acara-ocr.ts),
// lalu deteksi nominal/arah/alasan (lib/reconciliation-berita-acara-parser.ts)
// dan cocokkan terhadap selisih sistem berjalan (lib/reconciliation-omzet-ledger.ts).
// TIDAK menyimpan apa pun ke Mongo — murni pembacaan+analisis, hasil dipakai
// UI untuk auto-fill "Nominal final disepakati"/"Alasan penyesuaian" saat COCOK.
import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/olsera-store-id";
import { loadOmzetLedgerMonthDetail } from "@/lib/reconciliation-omzet-ledger";
import { getOmzetPeriodLock } from "@/lib/reconciliation-omzet-period-lock";
import { extractBeritaAcaraText } from "@/lib/reconciliation-berita-acara-ocr";
import { parseBeritaAcaraText, matchBeritaAcaraToSystemDifference } from "@/lib/reconciliation-berita-acara-parser";
import { isTrustedBlobAttachmentUrl } from "@/lib/attachment-url-safety";

const PERIOD = /^\d{4}-\d{2}$/;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    await requireSupervisor();
    const { period } = await context.params;
    if (!PERIOD.test(period)) return NextResponse.json({ error: "Format periode tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    const storeId = currentStoreId();
    const [lock, original] = await Promise.all([getOmzetPeriodLock(storeId, period), loadOmzetLedgerMonthDetail(period)]);
    if (!lock?.attachment) return NextResponse.json({ error: "Berita acara belum diunggah." }, { status: 404, headers: NO_CACHE_HEADERS });
    // Cegah SSRF — TOLAK fetch() ke URL sembarang, bukan biarkan jalan.
    // attachment.url HARUS berasal dari Vercel Blob (satu-satunya jalur
    // tulis saat ini — lihat finalization/upload/route.ts), tapi titik baca
    // ini tidak boleh diam-diam mengandalkan itu tanpa verifikasi ulang;
    // https-only saja tidak cukup (https://127.0.0.1/, https://169.254.169.254/
    // dkk tetap lolos) — lihat lib/attachment-url-safety.ts.
    if (!isTrustedBlobAttachmentUrl(lock.attachment.url)) {
      console.error("[reconciliation:period-finalization:analyze] attachment.url bukan origin Vercel Blob yang dipercaya, fetch ditolak", { period, url: lock.attachment.url });
      return NextResponse.json({ error: "Lampiran berita acara tidak valid — hubungi admin." }, { status: 502, headers: NO_CACHE_HEADERS });
    }

    const systemDifference = original.differenceRevenue;
    let ocr;
    try {
      const fileResponse = await fetch(lock.attachment.url);
      if (!fileResponse.ok) throw new Error(`Gagal mengunduh berita acara (status ${fileResponse.status}).`);
      const buffer = new Uint8Array(await fileResponse.arrayBuffer());
      ocr = await extractBeritaAcaraText({ buffer, mimeType: lock.attachment.mimeType });
    } catch (error) {
      console.error("[reconciliation:period-finalization:analyze:extract]", error);
      // Kegagalan pembacaan file BUKAN kegagalan upload — attachment tetap
      // tersimpan; UI harus jatuh ke PERLU_REVIEW dan tetap izinkan alur
      // manual, bukan blokir total (Langkah 8).
      return NextResponse.json({
        data: {
          systemDifference,
          nominal: null,
          direction: null,
          reason: null,
          parseStatus: "PERLU_REVIEW",
          matchStatus: "PERLU_REVIEW",
          ocrSource: "pdf-scanned-unsupported",
          rawTextExcerpt: "",
        },
      }, { headers: NO_CACHE_HEADERS });
    }

    const parsed = parseBeritaAcaraText(ocr.text, ocr.confidence);
    const matchStatus = parsed.status === "OK" ? matchBeritaAcaraToSystemDifference(systemDifference, parsed, period) : "PERLU_REVIEW";

    return NextResponse.json({
      data: {
        systemDifference,
        nominal: parsed.nominal,
        direction: parsed.direction,
        period: parsed.period,
        reason: parsed.reason,
        parseStatus: parsed.status,
        matchStatus,
        ocrSource: ocr.source,
        rawTextExcerpt: parsed.rawText.slice(0, 500),
      },
    }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:period-finalization:analyze]", error);
    return NextResponse.json({ error: "Gagal membaca berita acara secara otomatis." }, { status: 502, headers: NO_CACHE_HEADERS });
  }
}
