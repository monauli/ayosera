import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import {
  addDays,
  getOlseraSyncStatus,
  syncOlseraSalesByCategory,
  todayJakarta,
} from "@/lib/olsera-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sync per hari memanggil detail tiap order (2 worker × jeda 200ms + retry 429) — beri waktu lega.
export const maxDuration = 300;

const syncSchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  force: z.boolean().optional(),
});

export async function GET() {
  try {
    await requireModule("olsera");
    const status = await getOlseraSyncStatus();
    return NextResponse.json(status, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json({ error: "Gagal memuat status sync Olsera." }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}

export async function POST(request: Request) {
  try {
    // Sync Olsera boleh dipakai semua user yang punya modul "olsera" (tidak lagi wajib supervisor).
    await requireModule("olsera");

    const body = syncSchema.parse(await request.json().catch(() => ({})));

    let startDate = body.start_date;
    if (!startDate) {
      const status = await getOlseraSyncStatus();
      if (!status.lastFullySyncedDate) {
        return NextResponse.json(
          { error: "Sync pertama kali: start_date wajib dikirim eksplisit (belum ada lastFullySyncedDate)." },
          { status: 400 },
        );
      }
      startDate = addDays(status.lastFullySyncedDate, 1);
    }
    const today = todayJakarta();
    const endDate = body.end_date ?? today;

    if (endDate > today) {
      return NextResponse.json(
        { error: `end_date (${endDate}) tidak boleh melewati hari ini (${today}).` },
        { status: 400 },
      );
    }
    if (startDate > endDate) {
      return NextResponse.json(
        { error: `start_date (${startDate}) lebih besar dari end_date (${endDate}). Data sudah up to date?` },
        { status: 400 },
      );
    }

    const result = await syncOlseraSalesByCategory(startDate, endDate, { force: body.force });
    return NextResponse.json(result, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Payload sync Olsera tidak valid" }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Sync Olsera gagal" }, { status: 500 });
  }
}
