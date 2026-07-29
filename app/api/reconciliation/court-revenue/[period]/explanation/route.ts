import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { loadOmzetLedgerMonthDetail, OMZET_EVIDENCE_TYPES } from "@/lib/reconciliation-omzet-ledger";
import { deleteOmzetExplanation, getOmzetExplanation, isOmzetEvidenceType, saveOmzetExplanation } from "@/lib/reconciliation-omzet-explanation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * GET/POST/DELETE bukti jurnal nyata ("Selisih Terjelaskan") untuk SATU periode
 * Rekonsiliasi Omzet AYOSERA — lihat lib/reconciliation-omzet-explanation-store.ts.
 * Menulis WAJIB supervisor (konsisten dengan manual resolution rekonsiliasi
 * lainnya, lihat app/api/reconciliation/findings/[findingId]/resolution/route.ts).
 * `explainedAmount` divalidasi HARUS sama persis dengan selisih yang dihitung
 * engine SAAT INI — mencegah penjelasan basi/salah nominal dipakai menyembunyikan
 * selisih yang sebenarnya berbeda (tidak ada toleransi otomatis).
 */
export async function GET(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    await requireSupervisor();
    const { period } = await context.params;
    if (!PERIOD_PATTERN.test(period)) return NextResponse.json({ error: "Format periode tidak valid (harus YYYY-MM)." }, { status: 400, headers: NO_CACHE_HEADERS });
    const explanation = await getOmzetExplanation(period);
    return NextResponse.json({ data: explanation }, { headers: NO_CACHE_HEADERS });
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
    const { evidenceType, description, explainedAmount } = parsed as Record<string, unknown>;
    if (!isOmzetEvidenceType(evidenceType)) {
      return NextResponse.json({ error: `evidenceType harus salah satu dari: ${OMZET_EVIDENCE_TYPES.join(", ")}.` }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    if (typeof description !== "string" || description.trim().length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: "description wajib diisi (bukti jurnal nyata), maksimal 2000 karakter." }, { status: 400, headers: NO_CACHE_HEADERS });
    }
    if (typeof explainedAmount !== "number" || !Number.isFinite(explainedAmount) || !Number.isInteger(explainedAmount)) {
      return NextResponse.json({ error: "explainedAmount wajib angka bulat (Rupiah)." }, { status: 400, headers: NO_CACHE_HEADERS });
    }

    const current = await loadOmzetLedgerMonthDetail(period);
    if (current.differenceRevenue === 0) {
      return NextResponse.json({ error: "Periode ini sudah Cocok (selisih 0) — tidak perlu penjelasan." }, { status: 409, headers: NO_CACHE_HEADERS });
    }
    if (explainedAmount !== current.differenceRevenue) {
      return NextResponse.json(
        { error: `explainedAmount (${explainedAmount}) tidak sama persis dengan selisih yang dihitung saat ini (${current.differenceRevenue}). Tidak ada toleransi otomatis — perbarui bukti sesuai nominal yang benar.` },
        { status: 422, headers: NO_CACHE_HEADERS },
      );
    }

    const saved = await saveOmzetExplanation({ period, evidenceType, description: description.trim(), explainedAmount, userId: user.id });
    return NextResponse.json({ data: saved }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue:explanation:post]", error);
    return NextResponse.json({ error: "Gagal menyimpan penjelasan selisih." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ period: string }> }) {
  try {
    await requireSupervisor();
    const { period } = await context.params;
    if (!PERIOD_PATTERN.test(period)) return NextResponse.json({ error: "Format periode tidak valid (harus YYYY-MM)." }, { status: 400, headers: NO_CACHE_HEADERS });
    await deleteOmzetExplanation(period);
    return NextResponse.json({ ok: true }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reconciliation:court-revenue:explanation:delete]", error);
    return NextResponse.json({ error: "Gagal menghapus penjelasan selisih." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
