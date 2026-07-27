import { NextResponse } from "next/server";
import { requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/reconciliation-store";
import { ManualResolutionError, revokeManualResolution } from "@/lib/reconciliation-manual-resolution";
import { assertReconciliationWriteEnabled, ReconciliationWriteSafetyError } from "@/lib/reconciliation-operational-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ findingId: string }> }) {
  try {
    const user = await requireSupervisor();
    assertReconciliationWriteEnabled();
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ManualResolutionError("Content-Type harus application/json.");
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 4 * 1024) throw new ManualResolutionError("Body request terlalu besar.");
    const payload: unknown = JSON.parse(raw);
    if (!payload || Array.isArray(payload) || typeof payload !== "object" || Object.keys(payload).some((key) => key !== "note") || typeof (payload as { note?: unknown }).note !== "string") throw new ManualResolutionError("Body revoke harus berisi note saja.");
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) throw new ManualResolutionError("Idempotency-Key wajib diisi.");
    const { findingId } = await params;
    const result = await revokeManualResolution({ findingId, storeId: currentStoreId(), actor: user.id, idempotencyKey, note: (payload as { note: string }).note, requestId: request.headers.get("x-request-id") });
    return NextResponse.json({ data: result.resolution, effectiveStatus: result.effectiveStatus, idempotent: result.idempotent }, { status: result.idempotent ? 200 : 201, headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ReconciliationWriteSafetyError) return NextResponse.json({ error: error.message }, { status: 403, headers: NO_CACHE_HEADERS });
    if (error instanceof ManualResolutionError) return NextResponse.json({ error: error.message }, { status: error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : error.code === "INVALID_TRANSITION" ? 422 : 400, headers: NO_CACHE_HEADERS });
    console.error("[reconciliation:resolution:revoke]", error);
    return NextResponse.json({ error: "Gagal membatalkan manual resolution." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
