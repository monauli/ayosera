import { NextResponse } from "next/server";
import crypto from "crypto";
import { createAyoSignature } from "@/lib/ayo";
import { extractBookingItems, logSyncFailure, syncBookingItems } from "@/lib/booking-sync";

export async function POST(request: Request) {
  const startedAt = new Date();
  try {
    const rawBody = await request.text();
    const payload = parseJsonBody(rawBody);
    const authError = validateWebhookRequest(request.headers, payload);

    if (authError) {
      await logSyncFailure({ type: "webhook", startedAt, error: new Error(authError) });
      return NextResponse.json(
        { error: true, status_code: 401, message: authError },
        { status: 401 },
      );
    }

    const items = extractBookingItems(payload);
    const result = await syncBookingItems(items, {
      type: "webhook",
      message: "AYO webhook accepted",
      startedAt,
    });

    return NextResponse.json({
      error: false,
      status_code: 200,
      message: "Success",
      ...result,
    });
  } catch (error) {
    await logSyncFailure({ type: "webhook", startedAt, error });
    console.error(error);
    return NextResponse.json(
      { error: true, status_code: 500, message: "Webhook ingest failed" },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    error: false,
    status_code: 200,
    message: "AYO webhook endpoint is ready",
  });
}

function parseJsonBody(rawBody: string) {
  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new Error("Invalid webhook JSON payload");
  }
}

function validateWebhookRequest(headers: Headers, payload: unknown) {
  const expectedSecret = process.env.AYO_WEBHOOK_SECRET;
  if (expectedSecret) {
    const suppliedSecret =
      headers.get("x-ayo-webhook-secret") ||
      headers.get("x-webhook-secret") ||
      headers.get("authorization")?.replace(/^Bearer\s+/i, "");

    if (!suppliedSecret || !safeCompare(suppliedSecret, expectedSecret)) {
      return "Invalid webhook secret";
    }
  }

  const suppliedSignature = getWebhookSignature(headers, payload);
  if (suppliedSignature && process.env.AYO_PRIVATE_KEY && isRecord(payload)) {
    const expectedSignature = createAyoSignature(payload, process.env.AYO_PRIVATE_KEY);
    if (!safeCompare(suppliedSignature, expectedSignature)) {
      return "Invalid webhook signature";
    }
  }

  return null;
}

function getWebhookSignature(headers: Headers, payload: unknown) {
  const headerSignature = headers.get("x-ayo-signature") || headers.get("x-signature");
  if (headerSignature) return headerSignature;

  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const signature = (payload as Record<string, unknown>).signature;
    if (typeof signature === "string") return signature;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeCompare(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
