import { NextResponse } from "next/server";
import { runOlseraFinancialCron } from "@/lib/cron-olsera-financial";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Endpoint cron server-side untuk auto-sync Laporan Keuangan Olsera,
 * dijadwalkan lewat cron-job.org. Memakai mekanisme start/step bertahap yang
 * sama dengan tombol manual (lib/olsera-financial-sync.ts) — satu panggilan
 * cron = satu step, checkpoint tersimpan per periode sehingga proses yang
 * belum selesai dilanjutkan otomatis oleh panggilan berikutnya. Body opsional
 * `{year, month}` (JSON) untuk override periode; default bulan berjalan (WIB).
 */
export async function POST(request: Request) {
  const input = await request.json().catch(() => undefined);
  const { status, body } = await runOlseraFinancialCron(request.headers.get("authorization"), { ...input, scope: "current" });
  return NextResponse.json(body, { status });
}
