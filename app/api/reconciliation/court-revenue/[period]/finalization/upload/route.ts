import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/olsera-store-id";
import { uploadOmzetPeriodLockAttachment as uploadBlob } from "@/lib/blob-storage";
import { uploadOmzetPeriodLockAttachment, validateOmzetPeriodLockAttachment, OmzetPeriodLockError } from "@/lib/reconciliation-omzet-period-lock";

const PERIOD = /^\d{4}-\d{2}$/;
export const runtime = "nodejs"; export const dynamic = "force-dynamic"; export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    const user = await requireSupervisor(); const { period } = await context.params;
    if (!PERIOD.test(period)) return NextResponse.json({ error: "Format periode tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    const form = await request.formData(); const file = form.get("file"); const version = form.get("version");
    if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "File berita acara wajib diunggah." }, { status: 400, headers: NO_CACHE_HEADERS });
    validateOmzetPeriodLockAttachment(file);
    const storeId = currentStoreId();
    let uploaded;
    try {
      uploaded = await uploadBlob({ storeId, period, file });
    } catch (error) {
      console.error("[reconciliation:period-finalization:upload:blob]", error);
      return NextResponse.json({ error: "Gagal mengunggah berita acara ke penyimpanan file. Pastikan BLOB_READ_WRITE_TOKEN sudah dikonfigurasi." }, { status: 502, headers: NO_CACHE_HEADERS });
    }
    const lock = await uploadOmzetPeriodLockAttachment({ storeId, period, actor: user.id, expectedVersion: version ? Number(version) : null, attachment: { fileName: file.name, mimeType: file.type, size: file.size, url: uploaded.url, uploadedAt: new Date(), uploadedBy: user.id } });
    return NextResponse.json({ data: lock }, { status: 201, headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof OmzetPeriodLockError) return NextResponse.json({ error: error.message }, { status: error.code === "CONFLICT" ? 409 : error.code === "LOCKED" ? 423 : 400, headers: NO_CACHE_HEADERS });
    console.error("[reconciliation:period-finalization:upload]", error);
    return NextResponse.json({ error: "Gagal menyimpan berita acara. Coba lagi." }, { status: 502, headers: NO_CACHE_HEADERS });
  }
}
