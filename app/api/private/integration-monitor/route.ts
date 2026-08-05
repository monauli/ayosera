import { NextResponse } from "next/server";
import { z } from "zod";
import { collections } from "@/lib/mongodb";
import { integrationTokenHealth, requirePrivateToolsUser } from "@/lib/private-integration-monitor";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ source: z.enum(["olsera", "ayo-booking", "ayo-payment-events"]), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), action: z.enum(["check", "repair"]) });

export async function GET() {
  try { await requirePrivateToolsUser(); return NextResponse.json({ enabled: true, tokenHealth: integrationTokenHealth() }, { headers: NO_CACHE_HEADERS }); }
  catch (error) { if (error instanceof Response) return error; return NextResponse.json({ error: "Gagal memuat monitoring integritas." }, { status: 500, headers: NO_CACHE_HEADERS }); }
}

export async function POST(request: Request) {
  try {
    const user = await requirePrivateToolsUser(); const body = schema.parse(await request.json());
    if (body.startDate > body.endDate) return NextResponse.json({ error: "Rentang tanggal tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS });
    const c = await collections();
    const localCount = body.source === "ayo-booking" ? await c.bookings.countDocuments({ date: { $gte: body.startDate, $lte: body.endDate } }) : body.source === "ayo-payment-events" ? await c.ayoPaymentEvents.countDocuments({ date: { $gte: body.startDate, $lte: body.endDate } }) : await c.olseraOrderItems.countDocuments({ date: { $gte: body.startDate, $lte: body.endDate } });
    // A repair is intentionally refused until a source-complete audit has produced a deterministic identity set.
    // This endpoint never performs broad syncs or writes source data.
    return NextResponse.json({ source: body.source, status: "MANUAL_REVIEW_REQUIRED", checkedAt: new Date().toISOString(), range: { startDate: body.startDate, endDate: body.endDate }, sourceCount: null, localCount, gapsFound: 0, repaired: 0, unchanged: localCount, updated: 0, duplicateIdentity: 0, conflict: 0, failed: 0, startedBy: user.id, message: body.action === "repair" ? "Repair ditolak: audit sumber lengkap belum tersedia." : "Audit lokal selesai; pemeriksaan sumber perlu dijalankan saat integrasi sumber dikonfirmasi." }, { headers: NO_CACHE_HEADERS });
  } catch (error) { if (error instanceof Response) return error; if (error instanceof z.ZodError) return NextResponse.json({ error: "Payload audit tidak valid." }, { status: 400, headers: NO_CACHE_HEADERS }); return NextResponse.json({ error: "Gagal menjalankan audit integritas." }, { status: 500, headers: NO_CACHE_HEADERS }); }
}
