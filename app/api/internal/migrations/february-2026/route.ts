import { NextResponse } from "next/server";
import { runFebruaryHistoricalMigration } from "@/lib/february-historical-migration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (process.env.VERCEL_ENV !== "production") return NextResponse.json({ error: "production-only" }, { status: 404 });
  const length = request.headers.get("content-length");
  if (length && length !== "0") return NextResponse.json({ error: "body-not-allowed" }, { status: 400 });
  try {
    const result = await runFebruaryHistoricalMigration();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "fixed migration failed";
    return NextResponse.json({ ok: false, error: message.replace(/mongodb(?:\\+srv)?:\\/\\/[^\\s]+/gi, "mongodb://[redacted]") }, { status: 500 });
  }
}
