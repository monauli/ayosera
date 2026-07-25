import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule } from "@/lib/auth";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";
import {
  addDays,
  auditAndSyncOlseraDay,
  getOlseraSyncStatus,
  logOlseraMonthSync,
  syncOlseraSalesByCategory,
  todayJakarta,
} from "@/lib/olsera-sync";
import { withOlseraSyncLock } from "@/lib/olsera-cron-lock";

const MANUAL_SALES_LEASE_MS = 5 * 60 * 1000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sync per hari memanggil detail tiap order (2 worker × jeda 200ms + retry 429) — beri waktu lega.
export const maxDuration = 300;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const syncSchema = z.object({
  // Mode audit bertahap (dipakai tombol Sync Olsera): satu tanggal per request.
  date: dateString.optional(),
  // Mode finalize: tulis satu log ringkasan setelah seluruh tanggal diperiksa.
  finalize: z
    .object({
      start_date: dateString,
      end_date: dateString,
      checked: z.number().int().min(0),
      matched: z.number().int().min(0),
      updated: z.number().int().min(0),
      expected_orders: z.number().int().min(0),
      processed_orders: z.number().int().min(0),
      failed_dates: z.array(dateString),
      started_at: z.string(),
    })
    .optional(),
  // Mode lama (rentang tanggal) dipertahankan untuk skrip/pemakaian manual.
  start_date: dateString.optional(),
  end_date: dateString.optional(),
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
    const today = todayJakarta();

    // Mode audit bertahap: periksa satu tanggal terhadap API Olsera, tarik ulang
    // bila belum lengkap. Frontend memanggil tanggal demi tanggal (aman di Vercel).
    if (body.date) {
      if (body.date > today) {
        return NextResponse.json(
          { error: `Tanggal (${body.date}) tidak boleh melewati hari ini (${today}).` },
          { status: 400 },
        );
      }
      const outcome = await withOlseraSyncLock("sales", "manual", MANUAL_SALES_LEASE_MS, () =>
        auditAndSyncOlseraDay(body.date as string),
      );
      if (outcome.locked) {
        return NextResponse.json(
          { status: "sync-in-progress", activeModule: outcome.activeModule, runId: outcome.runId },
          { status: 409, headers: NO_CACHE_HEADERS },
        );
      }
      return NextResponse.json(outcome.result, { headers: NO_CACHE_HEADERS });
    }

    // Mode finalize: catat ringkasan run bulan berjalan sebagai log status terakhir.
    if (body.finalize) {
      const summary = body.finalize;
      const { status } = await logOlseraMonthSync({
        startDate: summary.start_date,
        endDate: summary.end_date,
        checkedDates: summary.checked,
        matchedDates: summary.matched,
        updatedDates: summary.updated,
        expectedOrderCount: summary.expected_orders,
        processedOrderCount: summary.processed_orders,
        failedDates: summary.failed_dates,
        startedAt: summary.started_at,
      });
      return NextResponse.json({ status }, { headers: NO_CACHE_HEADERS });
    }

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

    const outcome = await withOlseraSyncLock("sales", "manual", MANUAL_SALES_LEASE_MS, () =>
      syncOlseraSalesByCategory(startDate as string, endDate, { force: body.force }),
    );
    if (outcome.locked) {
      return NextResponse.json(
        { status: "sync-in-progress", activeModule: outcome.activeModule, runId: outcome.runId },
        { status: 409, headers: NO_CACHE_HEADERS },
      );
    }
    return NextResponse.json(outcome.result, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Payload sync Olsera tidak valid" }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Sync Olsera gagal" }, { status: 500 });
  }
}
