import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import {
  InventoryStockOpnameError,
  loadInventoryOpnameCutoff,
  loadInventoryOpnameMonth,
  saveInventoryOpnameBatch,
  finalizeInventoryStockOpname,
  unlockInventoryStockOpname,
} from "@/lib/inventory-stock-opname-store";
import { isValidIsoDate } from "@/lib/inventory-stock-opname";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import { currentStoreId } from "@/lib/reconciliation-store";
import { getInventoryMonthlyPeriodLock, InventoryMonthlyPeriodLockError, lockInventoryMonthlyPeriod, unlockInventoryMonthlyPeriod } from "@/lib/inventory-monthly-period-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;

function errorResponse(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof InventoryMonthlyPeriodLockError) return NextResponse.json({ error: error.message }, { status: 400, headers: NO_CACHE_HEADERS });
  if (error instanceof InventoryStockOpnameError) {
    const status = error.code === "FORBIDDEN" ? 403 : 400;
    return NextResponse.json({ error: error.message }, { status, headers: NO_CACHE_HEADERS });
  }
  console.error("[reconciliation:inventory-opname]", error);
  return NextResponse.json({ error: "Gagal memproses rekonsiliasi inventori." }, { status: 500, headers: NO_CACHE_HEADERS });
}

/**
 * GET /api/reconciliation/inventory-opname?year=&month=[&cutoffDate=YYYY-MM-DD]
 * — year/month TETAP dipakai sebagai kunci berita acara tersimpan (dan
 * sebagai filter UI), tapi BILA `cutoffDate` diisi, Stok Akhir Sistem
 * dihitung PERSIS pada tanggal itu (GET .../inventory/stockmovement
 * end_date=cutoffDate — lihat lib/inventory-stock-opname-store.ts:loadInventoryOpnameCutoff),
 * BUKAN akhir bulan kalender. Tanpa `cutoffDate`, perilaku LAMA (snapshot
 * bulanan) dipertahankan penuh — backward compatible.
 */
export async function GET(request: Request) {
  try {
    await requireModule("rekonsiliasi");
    const params = new URL(request.url).searchParams;
    const year = Number(params.get("year"));
    const month = Number(params.get("month"));
    const cutoffDateParam = params.get("cutoffDate");
    if (cutoffDateParam) {
      if (!isValidIsoDate(cutoffDateParam)) throw new InventoryStockOpnameError("cutoffDate tidak valid — format wajib YYYY-MM-DD.");
      const result = await loadInventoryOpnameCutoff({ storeId: currentStoreId(), year, month, cutoffDate: cutoffDateParam });
      return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
    }
    const [result, monthlyLock] = await Promise.all([loadInventoryOpnameMonth({ storeId: currentStoreId(), year, month }), getInventoryMonthlyPeriodLock(currentStoreId(), year, month)]);
    return NextResponse.json({ ...result, monthlyLock }, { headers: NO_CACHE_HEADERS });
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

    if (body.action === "lock-period" || body.action === "unlock-period") {
      const year = Number(body.year); const month = Number(body.month);
      const result = body.action === "lock-period"
        ? await lockInventoryMonthlyPeriod({ storeId: currentStoreId(), year, month, actor: user.email })
        : await unlockInventoryMonthlyPeriod({ storeId: currentStoreId(), year, month, actor: user.email, reason: String(body.reason ?? "") });
      return NextResponse.json({ data: result }, { headers: NO_CACHE_HEADERS });
    }

    if (body.action === "unlock") {
      const result = await unlockInventoryStockOpname({ storeId: currentStoreId(), year: Number(body.year), month: Number(body.month), actor: user.email, reason: String(body.reason ?? "") });
      return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
    }
    if (body.action === "finalize") {
      const attachment = body.attachment && typeof body.attachment === "object" ? body.attachment as Record<string, unknown> : null;
      if (!attachment || typeof attachment.url !== "string" || typeof attachment.fileName !== "string") throw new InventoryStockOpnameError("Bukti BA wajib diunggah sebelum finalisasi.");
      const result = await finalizeInventoryStockOpname({
        storeId: currentStoreId(),
        year: Number(body.year),
        month: Number(body.month),
        actor: user.email,
        cutoff: String(body.cutoff ?? ""),
        cutoffDate: typeof body.cutoffDate === "string" ? body.cutoffDate : null,
        cutoffConfirmed: body.cutoffConfirmed === true,
        baOnlyDifferencesConfirmed: body.baOnlyDifferencesConfirmed === true,
        attachment: { fileName: attachment.fileName, mimeType: String(attachment.mimeType ?? "application/octet-stream"), size: Number(attachment.size ?? 0), url: attachment.url, uploadedAt: new Date(), uploadedBy: user.email },
      });
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
