// Wrapper Vercel Blob — SATU-SATUNYA titik panggilan @vercel/blob `put()` di
// project ini (dipakai app/api/reconciliation/court-revenue/[period]/attachment/route.ts
// untuk lampiran Berita Acara Rekonsiliasi Omzet). Diekstrak ke file
// terpisah (pola sama lib/olsera-financial-client.ts untuk API eksternal
// lain) supaya mudah di-mock lewat mock.module (lihat
// app/api/reconciliation/court-revenue/[period]/attachment/route.test.ts) —
// TIDAK PERNAH menyentuh jaringan Vercel Blob sungguhan saat test.
import "server-only";
import { put } from "@vercel/blob";

function sanitizePathnameSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
}

export type UploadOmzetAttachmentInput = { storeId: number; period: string; file: File };
export type UploadOmzetAttachmentResult = { url: string };

/**
 * Upload lampiran Berita Acara ke Vercel Blob. Validasi tipe/ukuran file
 * SUDAH dilakukan caller (route) sebelum memanggil ini — fungsi ini murni
 * I/O upload.
 */
export async function uploadOmzetAttachment(input: UploadOmzetAttachmentInput): Promise<UploadOmzetAttachmentResult> {
  // Predictable (storeId+period+timestamp) TAPI tidak collision:
  // addRandomSuffix:true menjamin unik walau dua upload jatuh di milidetik
  // yang sama.
  const pathname = `reconciliation/omzet-explanation/${input.storeId}/${input.period}/${Date.now()}-${sanitizePathnameSegment(input.file.name)}`;
  const result = await put(pathname, input.file, { access: "public", addRandomSuffix: true, contentType: input.file.type });
  return { url: result.url };
}

/** Persistent Vercel Blob upload for the separate, auditable period-finalization flow. */
export async function uploadOmzetPeriodLockAttachment(input: UploadOmzetAttachmentInput): Promise<UploadOmzetAttachmentResult> {
  const pathname = `reconciliation/omzet-period-lock/${input.storeId}/${input.period}/${Date.now()}-${sanitizePathnameSegment(input.file.name)}`;
  const result = await put(pathname, input.file, { access: "public", addRandomSuffix: true, contentType: input.file.type });
  return { url: result.url };
}
