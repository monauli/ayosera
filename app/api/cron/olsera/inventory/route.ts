import { NextResponse } from "next/server";
import { runOlseraInventoryCron } from "@/lib/cron-olsera-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Endpoint cron server-side untuk auto-sync Inventori Olsera, dijadwalkan
 * lewat cron-job.org (setiap 60 menit). Satu invocation memanggil step
 * berulang (lib/cron-olsera-inventory.ts) sampai run selesai atau mendekati
 * maxDuration di bawah — checkpoint tersimpan di MongoDB (lib/olsera-inventory.ts)
 * sehingga proses yang BENAR-BENAR belum selesai (mis. backlog sangat besar)
 * tetap aman dilanjutkan oleh invocation cron berikutnya. Dilindungi
 * distributed lock yang sama dengan cron Penjualan/Keuangan dan tombol sync
 * manual.
 */
export async function POST(request: Request) {
  const { status, body } = await runOlseraInventoryCron(request.headers.get("authorization"));
  return NextResponse.json(body, { status });
}
