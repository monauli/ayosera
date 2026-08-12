import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { uploadOmzetPeriodLockAttachment } from "@/lib/blob-storage";
import { currentStoreId } from "@/lib/reconciliation-store";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user = await requireModule("rekonsiliasi");
    const form = await request.formData();
    const file = form.get("file");
    const year = Number(form.get("year"));
    const month = Number(form.get("month"));
    if (!(file instanceof File) || !file.size) return NextResponse.json({ error: "File BA wajib diisi." }, { status: 400, headers: NO_CACHE_HEADERS });
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return NextResponse.json({ error: "Periode tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    if (file.size > 4 * 1024 * 1024 || !["application/pdf", "image/jpeg", "image/png"].includes(file.type)) return NextResponse.json({ error: "File harus PDF/JPG/PNG maksimal 4MB." }, { status: 400, headers: NO_CACHE_HEADERS });
    const uploaded = await uploadOmzetPeriodLockAttachment({ storeId: currentStoreId(), period: `${year}-${String(month).padStart(2, "0")}`, file });
    return NextResponse.json({ data: { url: uploaded.url, fileName: file.name, mimeType: file.type, size: file.size, uploadedBy: user.email } }, { status: 201, headers: NO_CACHE_HEADERS });
  } catch {
    return NextResponse.json({ error: "Gagal mengunggah bukti BA." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
