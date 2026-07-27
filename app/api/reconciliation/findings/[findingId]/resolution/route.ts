import { NextResponse } from "next/server";
import { requireModule, requireSupervisor } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/reconciliation-store";
import { createManualResolution, getManualResolutionDetail, ManualResolutionError, recordUnauthorizedResolutionAttempt } from "@/lib/reconciliation-manual-resolution";
import { collections } from "@/lib/mongodb";
import { assertReconciliationWriteEnabled, ReconciliationWriteSafetyError } from "@/lib/reconciliation-operational-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 16 * 1024;
const FIELDS = ["runId", "domain", "entityKey", "decision", "reasonCode", "note", "evidence"] as const;

function responseError(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof ReconciliationWriteSafetyError) return NextResponse.json({ error: error.message }, { status: 403, headers: NO_CACHE_HEADERS });
  if (error instanceof ManualResolutionError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : error.code === "INVALID_TRANSITION" ? 422 : 400;
    return NextResponse.json({ error: error.message }, { status, headers: NO_CACHE_HEADERS });
  }
  console.error("[reconciliation:resolution]", error);
  return NextResponse.json({ error: "Gagal memproses manual resolution." }, { status: 500, headers: NO_CACHE_HEADERS });
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ManualResolutionError("Content-Type harus application/json.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new ManualResolutionError("Body request terlalu besar.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ManualResolutionError("JSON body tidak valid."); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new ManualResolutionError("JSON body harus object.");
  for (const key of Object.keys(parsed)) if (!(FIELDS as readonly string[]).includes(key)) throw new ManualResolutionError(`Field tidak didukung: ${key}`);
  for (const field of ["runId", "domain", "entityKey", "decision", "reasonCode"] as const) if (!(field in parsed)) throw new ManualResolutionError(`${field} wajib diisi.`);
  return parsed as Record<string, unknown>;
}

export async function GET(request: Request, { params }: { params: Promise<{ findingId: string }> }) {
  try {
    await requireModule("rekonsiliasi");
    const { findingId } = await params;
    const storeId = currentStoreId();
    const detail = await getManualResolutionDetail({ findingId, storeId });
    const { reconciliationAuditLog } = await collections();
    const audit = await reconciliationAuditLog.find({ findingId, storeId }).sort({ createdAt: -1 }).limit(100).toArray();
    return NextResponse.json({ ...detail, historyCount: detail.history.length, audit }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) { const { findingId } = await params; await recordUnauthorizedResolutionAttempt({ findingId, storeId: currentStoreId(), requestId: request.headers.get("x-request-id") }); }
    return responseError(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ findingId: string }> }) {
  try {
    const user = await requireSupervisor();
    assertReconciliationWriteEnabled();
    const payload = await body(request);
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) throw new ManualResolutionError("Idempotency-Key wajib diisi.");
    const { findingId } = await params;
    const result = await createManualResolution({ findingId, storeId: currentStoreId(), runId: payload.runId as string, domain: payload.domain as never, entityKey: payload.entityKey as string, decision: payload.decision as never, reasonCode: payload.reasonCode as never, note: payload.note as string | null | undefined, evidence: payload.evidence as string[] | undefined, actor: user.id, idempotencyKey, requestId: request.headers.get("x-request-id") }, undefined);
    return NextResponse.json({ data: result.resolution, effectiveStatus: result.effectiveStatus, idempotent: result.idempotent }, { status: result.idempotent ? 200 : 201, headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) { const { findingId } = await params; await recordUnauthorizedResolutionAttempt({ findingId, storeId: currentStoreId(), requestId: request.headers.get("x-request-id") }); }
    return responseError(error);
  }
}
