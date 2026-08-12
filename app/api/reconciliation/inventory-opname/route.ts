import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import {
  InventoryStockOpnameError,
  loadInventoryOpnameMonth,
  saveInventoryOpnameBatch,
  finalizeInventoryStockOpname,
  unlockInventoryStockOpname,
} from "@/lib/inventory-stock-opname-store";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/reconciliation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;

function errorResponse(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof InventoryStockOpnameError) {
    const status = error.code === "FORBIDDEN" ? 403 : 400;
    return NextResponse.json({ error: error.message }, { status, headers: NO_CACHE_HEADERS });
  }
  console.error("[reconciliation:inventory-opname]", error);
  return NextResponse.json({ error: "Gagal memproses rekonsiliasi inventori." }, { status: 500, headers: NO_CACHE_HEADERS });
}

/** GET /api/reconciliation/inventory-opname?year=&month= — gabungan snapshot bulanan (READ-ONLY) + berita acara tersimpan. */
export async function GET(request: Request) {
  try {
    await requireModule("rekonsiliasi");
    const params = new URL(request.url).searchParams;
    const result = await loadInventoryOpnameMonth({
      storeId: currentStoreId(),
      year: Number(params.get("year")),
      month: Number(params.get("month")),
    });
    return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/reconciliation/inventory-opname — simpan berita acara satu bulan sekaligus (supervisor only, idempotent). */
export async function POST(request: Request) {
  try {
    const user = await requireModule("rekonsiliasi");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new InventoryStockOpnameError("Content-Type harus application/json.");
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new InventoryStockOpnameError("Body request terlalu besar.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new InventoryStockOpnameError("JSON body tidak valid.");
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new InventoryStockOpnameError("JSON body harus object.");
    const body = parsed as Record<string, unknown>;

    if (body.action === "unlock") {
      const result = await unlockInventoryStockOpname({ storeId: currentStoreId(), year: Number(body.year), month: Number(body.month), actor: user.email, reason: String(body.reason ?? "") });
      return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
    }
    if (body.action === "finalize") {
      const attachment = body.attachment && typeof body.attachment === "object" ? body.attachment as Record<string, unknown> : null;
      if (!attachment || typeof attachment.url !== "string" || typeof attachment.fileName !== "string") throw new InventoryStockOpnameError("Bukti BA wajib diunggah sebelum finalisasi.");
      const result = await finalizeInventoryStockOpname({ storeId: currentStoreId(), year: Number(body.year), month: Number(body.month), actor: user.email, cutoff: String(body.cutoff ?? ""), baOnlyDifferencesConfirmed: body.baOnlyDifferencesConfirmed === true, attachment: { fileName: attachment.fileName, mimeType: String(attachment.mimeType ?? "application/octet-stream"), size: Number(attachment.size ?? 0), url: attachment.url, uploadedAt: new Date(), uploadedBy: user.email } });
      return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
    }

    const result = await saveInventoryOpnameBatch({
      storeId: currentStoreId(),
      year: Number(body.year),
      month: Number(body.month),
      actor: { role: user.role, email: user.email },
      entries: (body.entries ?? []) as never,
      baOnlyDifferencesConfirmed: body.baOnlyDifferencesConfirmed === true ? true : undefined,
      cutoff: typeof body.cutoff === "string" ? body.cutoff : undefined,
    });
    return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}
