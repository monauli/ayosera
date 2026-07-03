import { NextResponse } from "next/server";
import { collections, withMongo, type WebhookLogDocument } from "@/lib/mongodb";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

// Endpoint webhook selalu realtime: nonaktifkan cache Next.js/Vercel.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Batasi ukuran potongan payload yang disimpan agar dokumen tetap ringan.
const BODY_PREVIEW_LIMIT = 6000;

const ROUTE_PATH = "/api/webhooks/ayo-sandbox";

// Header yang berguna untuk debugging webhook.
// Di sandbox nilai signature BOLEH dilog: kita justru butuh mempelajari formatnya.
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
 * GET https://ayosera.vercel.app/api/webhooks/ayo-sandbox
 */
export async function GET() {
  return NextResponse.json(
    { ok: true, route: ROUTE_PATH, status: "ready", mode: "sandbox" },
    { headers: NO_CACHE_HEADERS },
  );
}

/**
 * Receiver webhook AYO versi SANDBOX (khusus testing tim AYO).
 *
 * Sama seperti receiver produksi TAPI TANPA sync ke koleksi bookings: payload test
 * hanya diterima, dicatat ke webhook_logs (source: "sandbox"), lalu dibalas cepat.
 * Tidak ada tulisan apa pun ke data produksi (bookings).
 */
export async function POST(request: Request) {
  const startedAt = new Date();
  const rawBody = await request.text().catch(() => "");
  const payload = parseJsonBody(rawBody);

  // Log utama supaya mudah dicari di console/Vercel logs.
  console.log("AYO SANDBOX WEBHOOK RECEIVED", {
    method: request.method,
    timestamp: startedAt.toISOString(),
    headers: pickHeaders(request.headers),
    body: payload.ok ? payload.value : rawBody,
  });

  if (!payload.ok) {
    console.error("AYO SANDBOX WEBHOOK: body bukan JSON valid", payload.error);
    await saveWebhookLog({
      receivedAt: startedAt,
      method: request.method,
      ok: false,
      status: "invalid",
      ids: {},
      itemCount: 0,
      message: "Body bukan JSON valid",
      bodyPreview: rawBody.slice(0, BODY_PREVIEW_LIMIT),
      source: "sandbox",
    });
    // Balas JSON error yang rapi, tetap HTTP 200 agar AYO tidak menganggap gagal kirim.
    return NextResponse.json(
      { ok: false, received: false, mode: "sandbox", error: "Invalid JSON payload" },
      { headers: NO_CACHE_HEADERS },
    );
  }

  const ids = collectIds(payload.value);
  if (Object.values(ids).some((list) => list.length)) {
    console.log("AYO SANDBOX WEBHOOK IDs", ids);
  }

  // Sengaja TIDAK memanggil pipeline booking-sync: sandbox tidak boleh menulis ke bookings.
  await saveWebhookLog({
    receivedAt: startedAt,
    method: request.method,
    ok: true,
    status: "received",
    ids,
    itemCount: 0,
    message: "Diterima (sandbox, tanpa sync bookings)",
    bodyPreview: rawBody.slice(0, BODY_PREVIEW_LIMIT),
    source: "sandbox",
  });

  return NextResponse.json({ ok: true, received: true, mode: "sandbox" }, { headers: NO_CACHE_HEADERS });
}

/** Simpan log webhook untuk monitoring. Aman: kegagalan simpan tidak meng-crash webhook. */
async function saveWebhookLog(doc: WebhookLogDocument) {
  try {
    await withMongo(async () => {
      const { webhookLogs } = await collections();
      await webhookLogs.insertOne(doc);
    });
  } catch (error) {
    console.error("AYO SANDBOX WEBHOOK: gagal menyimpan log webhook", error);
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
