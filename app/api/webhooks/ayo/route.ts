import { NextResponse } from "next/server";
import {
  extractBookingItems,
  logSyncFailure,
  syncBookingItems,
  writeMongoSyncLog,
} from "@/lib/booking-sync";
import { collections, withMongo, type WebhookLogDocument } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

// Endpoint webhook selalu realtime: nonaktifkan cache Next.js/Vercel.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Batasi ukuran potongan payload yang disimpan agar dokumen tetap ringan.
const BODY_PREVIEW_LIMIT = 6000;

const ROUTE_PATH = "/api/webhooks/ayo";

// Header yang berguna untuk debugging webhook. Nilai secret sengaja TIDAK dilog.
const IMPORTANT_HEADERS = [
  "content-type",
  "user-agent",
  "x-ayo-event",
  "x-ayo-signature",
  "x-forwarded-for",
] as const;

// ID yang menarik untuk ditelusuri jika payload membawanya.
const ID_KEYS = ["booking_id", "reservation_id", "order_id", "order_detail_id"] as const;

/**
 * Health check dari browser.
 * GET https://ayosera.vercel.app/api/webhooks/ayo
 */
export async function GET() {
  return NextResponse.json(
    { ok: true, route: ROUTE_PATH, status: "ready" },
    { headers: NO_CACHE_HEADERS },
  );
}

/**
 * Receiver webhook AYO (tahap 1: receiver/log listener).
 *
 * Prinsip: selalu balas cepat dan tidak pernah menggagalkan pengiriman webhook
 * hanya karena bentuk payload belum dipetakan. Semua kerja berat (sync ke DB)
 * dibungkus try/catch agar error hanya tercatat, bukan meng-crash respons.
 */
export async function POST(request: Request) {
  const startedAt = new Date();
  const rawBody = await request.text().catch(() => "");
  const payload = parseJsonBody(rawBody);

  // Log utama supaya mudah dicari di console/Vercel logs.
  console.log("AYO WEBHOOK RECEIVED", {
    method: request.method,
    timestamp: startedAt.toISOString(),
    headers: pickHeaders(request.headers),
    body: payload.ok ? payload.value : rawBody,
  });

  if (!payload.ok) {
    console.error("AYO WEBHOOK: body bukan JSON valid", payload.error);
    await logSyncFailure({ type: "webhook", startedAt, error: new Error("Invalid JSON payload") });
    await saveWebhookLog({
      receivedAt: startedAt,
      method: request.method,
      ok: false,
      status: "invalid",
      ids: {},
      itemCount: 0,
      message: "Body bukan JSON valid",
      bodyPreview: rawBody.slice(0, BODY_PREVIEW_LIMIT),
    });
    // Balas JSON error yang rapi, tetap HTTP 200 agar AYO tidak menganggap gagal kirim.
    return NextResponse.json(
      { ok: false, received: false, error: "Invalid JSON payload" },
      { headers: NO_CACHE_HEADERS },
    );
  }

  const ids = collectIds(payload.value);
  if (Object.values(ids).some((list) => list.length)) {
    console.log("AYO WEBHOOK IDs", ids);
  }

  // Reuse pipeline sync yang sudah ada, tapi aman: kegagalan tidak menggagalkan webhook.
  const items = extractBookingItems(payload.value);
  let logStatus: WebhookLogDocument["status"] = "received";
  let logMessage = items.length ? `Diterima ${items.length} item booking` : "Diterima (tanpa item booking)";
  try {
    if (items.length) {
      const result = await syncBookingItems(items, {
        type: "webhook",
        message: "AYO webhook received",
        startedAt,
      });
      console.log("AYO WEBHOOK SYNC OK", result);
    } else {
      // Tidak ada item booking yang bisa dipetakan; cukup catat event-nya.
      await writeMongoSyncLog({
        type: "webhook",
        status: "success",
        message: "AYO webhook received (tanpa item booking)",
        recordsProcessed: 0,
        startedAt,
      });
    }
  } catch (error) {
    console.error("AYO WEBHOOK SYNC FAILED", error);
    logStatus = "error";
    logMessage = error instanceof Error ? error.message : "Sync gagal";
    await logSyncFailure({ type: "webhook", startedAt, error });
  }

  await saveWebhookLog({
    receivedAt: startedAt,
    method: request.method,
    ok: logStatus !== "error",
    status: logStatus,
    ids,
    itemCount: items.length,
    message: logMessage,
    bodyPreview: rawBody.slice(0, BODY_PREVIEW_LIMIT),
  });

  return NextResponse.json({ ok: true, received: true }, { headers: NO_CACHE_HEADERS });
}

/** Simpan log webhook untuk monitoring. Aman: kegagalan simpan tidak meng-crash webhook. */
async function saveWebhookLog(doc: WebhookLogDocument) {
  try {
    await withMongo(async () => {
      const { webhookLogs } = await collections();
      await webhookLogs.insertOne(doc);
    });
  } catch (error) {
    console.error("AYO WEBHOOK: gagal menyimpan log webhook", error);
  }
}

type ParsedBody = { ok: true; value: unknown } | { ok: false; error: string };

function parseJsonBody(rawBody: string): ParsedBody {
  if (!rawBody.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(rawBody) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown parse error" };
  }
}

function pickHeaders(headers: Headers) {
  const picked: Record<string, string> = {};
  for (const key of IMPORTANT_HEADERS) {
    const value = headers.get(key);
    if (value) picked[key] = value;
  }
  return picked;
}

/** Telusuri payload (termasuk nested/array) untuk mengumpulkan ID yang dikenal. */
function collectIds(payload: unknown) {
  const found: Record<string, Set<string>> = Object.fromEntries(ID_KEYS.map((key) => [key, new Set<string>()]));
  const seen = new Set<object>();

  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value as object)) return;
    seen.add(value as object);

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey in found && (typeof nested === "string" || typeof nested === "number")) {
        found[normalizedKey].add(String(nested));
      }
      if (nested && typeof nested === "object") walk(nested);
    }
  };

  walk(payload);
  return Object.fromEntries(Object.entries(found).map(([key, set]) => [key, [...set]]));
}
