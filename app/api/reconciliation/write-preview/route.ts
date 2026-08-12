import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/reconciliation-store";
import { computeReconciliationRequestFingerprint, resolvePreWriteContext, validateReconciliationWrite } from "@/lib/reconciliation-operational-readiness";

export const runtime = "nodejs"; export const dynamic = "force-dynamic";
const FIELDS = ["target", "period", "findingId", "runId", "dryRun", "explicitConfirmation", "idempotencyKey"] as const;
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return NextResponse.json({ error: "Content-Type harus application/json." }, { status: 400, headers: NO_CACHE_HEADERS });
    const raw = await request.text(); if (new TextEncoder().encode(raw).byteLength > 8 * 1024) return NextResponse.json({ error: "Body request terlalu besar." }, { status: 400, headers: NO_CACHE_HEADERS });
    const body: unknown = JSON.parse(raw); if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some((key) => !(FIELDS as readonly string[]).includes(key))) return NextResponse.json({ error: "Body preview tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    const value = body as Record<string, unknown>; const target = value.target === "RUNNER" || value.target === "MANUAL_RESOLUTION" ? value.target : null;
    if (!target || typeof value.period !== "string" || typeof value.idempotencyKey !== "string" || typeof value.dryRun !== "boolean" || typeof value.explicitConfirmation !== "boolean") return NextResponse.json({ error: "Field preview wajib tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    const storeId = currentStoreId(); const fingerprint = computeReconciliationRequestFingerprint({ target, storeId, period: value.period, findingId: typeof value.findingId === "string" ? value.findingId : undefined, runId: typeof value.runId === "string" ? value.runId : undefined, idempotencyKey: value.idempotencyKey });
    const validation = await validateReconciliationWrite({ target, actor: { id: user.id, role: user.role }, storeId, expectedStoreId: storeId, period: value.period, dryRun: value.dryRun, explicitConfirmation: value.explicitConfirmation, requestFingerprint: fingerprint, idempotencyKey: value.idempotencyKey, findingId: typeof value.findingId === "string" ? value.findingId : undefined, runId: typeof value.runId === "string" ? value.runId : undefined }, await resolvePreWriteContext());
    const affectedCollection = target === "RUNNER" ? ["reconciliation_runs", "reconciliation_findings"] : ["reconciliation_manual_resolutions", "reconciliation_audit_log"];
    return NextResponse.json({ preview: true, target: { findingId: value.findingId ?? null, runId: value.runId ?? null, storeId, period: value.period }, affectedCollections: affectedCollection, affectedDocumentCount: target === "RUNNER" ? "unknown-until-dry-run" : validation.finding ? 2 : 0, expectedAction: target === "RUNNER" ? "Idempotent upsert run/finding; tidak pernah delete finding." : "Append resolution dan audit; finding asal tidak dimutasi.", validation }, { headers: NO_CACHE_HEADERS });
  } catch (error) { if (error instanceof Response) return error; console.error("[reconciliation:write-preview]", error); return NextResponse.json({ error: "Gagal membuat write preview." }, { status: 500, headers: NO_CACHE_HEADERS }); }
}
