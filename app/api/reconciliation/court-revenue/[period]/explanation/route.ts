import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/olsera-store-id";
import { loadOmzetLedgerMonthDetail } from "@/lib/reconciliation-omzet-ledger";
import { getCurrentOmzetNote, OmzetNoteError, submitOmzetExplanation } from "@/lib/reconciliation-omzet-note-store";
import { isOmzetEvidenceTypeValue, omzetNoteErrorResponse, PERIOD_PATTERN, resolveIdempotencyKey, toOmzetNoteResponse, validateAttachmentFields } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * GET/POST bukti jurnal nyata ("Selisih Terjelaskan") untuk SATU periode
 * Rekonsiliasi Omzet AYOSERA — skema BARU append-only
 * (lib/reconciliation-omzet-note-store.ts, lihat "Desain Skema Lock+Berita
 * Acara" & "Implementasi Skema Lock+Berita Acara (Langkah 3)" di
 * tmp/ai-handoff.md; MENGGANTIKAN lib/reconciliation-omzet-explanation-store.ts
 * skema lama, yang SENGAJA dibiarkan ada tapi tidak lagi dipanggil route ini).
 * Menulis WAJIB supervisor (konsisten dengan manual resolution rekonsiliasi
 * lainnya, lihat app/api/reconciliation/findings/[findingId]/resolution/route.ts).
 * `explainedAmount` divalidasi HARUS sama persis dengan selisih yang dihitung
 * engine SAAT INI — mencegah penjelasan basi/salah nominal dipakai menyembunyikan
 * selisih yang sebenarnya berbeda (tidak ada toleransi otomatis).
 *
 * DELETE DINONAKTIFKAN (410 Gone) — lihat handler di bawah.
 */
export async function GET(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    await requireSupervisor();
    const { period } = await context.params;
    if (!PERIOD_PATTERN.test(period)) return NextResponse.json({ error: "Format periode tidak valid (harus YYYY-MM)." }, { status: 400, headers: NO_CACHE_HEADERS });
    const note = await getCurrentOmzetNote(currentStoreId(), period);
    return NextResponse.json({ data: note ? toOmzetNoteResponse(note) : null }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue:explanation:get]", error);
    return NextResponse.json({ error: "Gagal memuat penjelasan selisih." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}

export async function POST(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    const user = await requireSupervisor();
    const { period } = await context.params;
    if (!PERIOD_PATTERN.test(period)) return NextResponse.json({ error: "Format periode tidak valid (harus YYYY-MM)." }, { status: 400, headers: NO_CACHE_HEADERS });

    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return NextResponse.json({ error: "Content-Type harus application/json." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Body request terlalu besar." }, { status: 413, headers: NO_CACHE_HEADERS });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "JSON body tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "JSON body harus object." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    const { evidenceType, description, explainedAmount, attachmentUrl: rawAttachmentUrl, attachmentFileName: rawAttachmentFileName } = parsed as Record<string, unknown>;
    if (!isOmzetEvidenceTypeValue(evidenceType)) {
      return NextResponse.json({ error: "evidenceType tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    if (typeof description !== "string" || description.trim().length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: "description wajib diisi (bukti jurnal nyata), maksimal 2000 karakter." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    if (typeof explainedAmount !== "number" || !Number.isFinite(explainedAmount) || !Number.isInteger(explainedAmount)) {
      return NextResponse.json({ error: "explainedAmount wajib angka bulat (Rupiah)." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    // Lampiran (hasil POST .../attachment) OPSIONAL — attachmentUrl dan
    // attachmentFileName harus sama-sama diisi atau sama-sama kosong,
    // mencegah data setengah-jadi tersimpan ke note.
    const attachmentFields = validateAttachmentFields(rawAttachmentUrl, rawAttachmentFileName);
    if (!attachmentFields.ok) {
      return NextResponse.json({ error: attachmentFields.error }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    const { attachmentUrl, attachmentFileName } = attachmentFields;

    const storeId = currentStoreId();
    const current = await loadOmzetLedgerMonthDetail(period);
    if (current.differenceRevenue === 0) {
      return NextResponse.json({ error: "Periode ini sudah Cocok (selisih 0) — tidak perlu penjelasan." }, { status: 409, headers: NO_CACHE_HEADERS });
    }

    const trimmedDescription = description.trim();
    const idempotencyKey = resolveIdempotencyKey(request.headers.get("idempotency-key"), {
      storeId,
      period,
      actor: user.id,
      evidenceType,
      description: trimmedDescription,
      explainedAmount,
      attachmentUrl,
    });

    try {
      const result = await submitOmzetExplanation({
        storeId,
        period,
        evidenceType,
        description: trimmedDescription,
        explainedAmount,
        currentDifferenceRevenue: current.differenceRevenue,
        actor: user.id,
        idempotencyKey,
        // Dibaca+divalidasi dari body lewat validateAttachmentFields di atas
        // (hasil POST .../attachment yang sudah diselesaikan UI SEBELUM
        // submit ini) — null bila memang tidak ada lampiran, BUKAN hardcode.
        attachmentUrl,
        attachmentFileName,
      });
      return NextResponse.json(
        { data: toOmzetNoteResponse(result.note), idempotent: result.idempotent },
        { status: result.idempotent ? 200 : 201, headers: NO_CACHE_HEADERS },
      );
    } catch (error) {
      if (error instanceof OmzetNoteError) return omzetNoteErrorResponse(error);
      throw error;
    }
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue:explanation:post]", error);
    return NextResponse.json({ error: "Gagal menyimpan penjelasan selisih." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}

/**
 * DINONAKTIFKAN — skema baru (OlseraOmzetReconciliationNoteV2Document)
 * bersifat APPEND-ONLY dan permanen, tidak ada operasi hapus. Kirim
 * penjelasan baru (POST) untuk menggantikan yang lama — otomatis
 * men-supersede versi sebelumnya, riwayat penuh tetap tersimpan (bukan
 * diam-diam dialihkan ke fungsi lain). Lihat "Desain Skema Lock+Berita
 * Acara" di tmp/ai-handoff.md.
 */
export async function DELETE(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    await requireSupervisor();
    const { period } = await context.params;
    if (!PERIOD_PATTERN.test(period)) return NextResponse.json({ error: "Format periode tidak valid (harus YYYY-MM)." }, { status: 400, headers: NO_CACHE_HEADERS });
    return NextResponse.json(
      { error: "Fitur hapus penjelasan tidak lagi didukung — skema baru bersifat append-only dan permanen. Kirim penjelasan baru untuk menggantikan yang lama." },
      { status: 410, headers: NO_CACHE_HEADERS },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue:explanation:delete]", error);
    return NextResponse.json({ error: "Gagal memproses permintaan." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
