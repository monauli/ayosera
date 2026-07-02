import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

// Status sesi selalu realtime: nonaktifkan cache Next.js/Vercel.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ user: null }, { status: 401, headers: NO_CACHE_HEADERS });
  return NextResponse.json({ user }, { headers: NO_CACHE_HEADERS });
}
