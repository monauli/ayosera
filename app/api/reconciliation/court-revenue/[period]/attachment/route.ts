import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/olsera-store-id";
import { uploadOmzetAttachment } from "@/lib/blob-storage";
import { MAX_ATTACHMENT_BYTES, PERIOD_PATTERN } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Ekstensi dan content-type divalidasi sebagai PASANGAN yang konsisten
// (bukan independen) — mencegah file .pdf yang diklaim "image/png" (atau
// sebaliknya) lolos hanya karena masing-masing nilai kebetulan ada di
// daftar yang sama.
const EXTENSION_TO_CONTENT_TYPES: Record<string, readonly string[]> = {
  pdf: ["application/pdf"],
  jpg: ["image/jpeg", "image/jpg"],
  jpeg: ["image/jpeg", "image/jpg"],
  png: ["image/png"],
};

/**
 * POST /api/reconciliation/court-revenue/:period/attachment — upload lampiran
 * Berita Acara (PDF/gambar bukti jurnal) ke Vercel Blob (lib/blob-storage.ts).
 * HANYA upload file — TIDAK menulis apa pun ke MongoDB (bandingkan dengan
 * lib/reconciliation-omzet-note-store.ts submitOmzetExplanation, yang butuh
 * attachmentUrl/attachmentFileName sebagai INPUT, bukan endpoint ini yang
 * memanggilnya). UI (Phase 4, belum dikerjakan) yang bertanggung jawab
 * menyertakan attachmentUrl/attachmentFileName hasil endpoint ini ke payload
 * POST .../explanation sebagai request TERPISAH — upload dan submit
 * penjelasan SENGAJA dua langkah berbeda, supaya upload gagal tidak pernah
 * meninggalkan note dengan attachmentUrl yang salah/setengah jadi.
 */
export async function POST(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    await requireSupervisor();
    const { period } = await context.params;
    if (!PERIOD_PATTERN.test(period)) {
      return NextResponse.json({ error: "Format periode tidak valid (harus YYYY-MM)." }, { status: 400, headers: NO_CACHE_HEADERS });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "File wajib diunggah (field 'file')." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "File kosong." }, { status: 400, headers: NO_CACHE_HEADERS });
    }

    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const allowedContentTypesForExtension = EXTENSION_TO_CONTENT_TYPES[extension];
    if (!allowedContentTypesForExtension || !allowedContentTypesForExtension.includes(file.type)) {
      return NextResponse.json(
        { error: "Tipe file tidak didukung — hanya PDF (.pdf) atau gambar (.jpg/.jpeg/.png) yang diterima." },
        { status: 400, headers: NO_CACHE_HEADERS },
      );
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        { error: `Ukuran file terlalu besar (maksimal ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB).` },
        { status: 413, headers: NO_CACHE_HEADERS },
      );
    }

    const storeId = currentStoreId();
    let result;
    try {
      result = await uploadOmzetAttachment({ storeId, period, file });
    } catch (error) {
      console.error("[reconciliation:court-revenue:attachment:blob]", error);
      return NextResponse.json(
        { error: "Gagal mengunggah lampiran ke penyimpanan file. Pastikan BLOB_READ_WRITE_TOKEN sudah dikonfigurasi." },
        { status: 502, headers: NO_CACHE_HEADERS },
      );
    }

    return NextResponse.json(
      { data: { attachmentUrl: result.url, attachmentFileName: file.name } },
      { status: 201, headers: NO_CACHE_HEADERS },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue:attachment:post]", error);
    return NextResponse.json({ error: "Gagal mengunggah lampiran." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
