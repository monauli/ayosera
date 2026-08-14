import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth";
import { computeCategoryValidation, computeInventoryValidation, computeFinancialValidation, failedSection, periodEnd, type ValidationStatus } from "@/lib/olsera-validation-sections";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Kategori (via computeCategoryValidation) butuh sampai CATEGORY_TIMEOUT_MS
// untuk fetch sebulan penuh order dari Olsera live — route ini SEBELUMNYA
// tidak punya maxDuration sama sekali (default platform, bisa hanya 10-15s),
// jauh di bawah waktu nyata yang dibutuhkan, sehingga category SELALU gagal
// timeout ("Gagal Dicek") untuk periode dengan volume order wajar. Root cause
// exact Phase 1 — bukan bug logic pembanding. Disamakan dengan cron sync
// bulanan sejenis (app/api/cron/olsera/sales/route.ts, maxDuration 300s).
export const maxDuration = 300;
type Status = ValidationStatus;
const iso = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(request: Request) {
  try {
    await requireModule("audit");
    const period = new URL(request.url).searchParams.get("period") ?? "";
    const section = new URL(request.url).searchParams.get("section");
    if (!iso.test(period)) return NextResponse.json({ error: "period harus YYYY-MM." }, { status: 400 });
    const [year, month] = period.split("-").map(Number);
    const start = `${period}-01`, end = periodEnd(period);
    const current = period === new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" }).format(new Date());
    const result: Record<string, unknown> = { period, checkedAt: new Date().toISOString() };

    const sections = await Promise.allSettled([
      (async () => {
        if (section && section !== "category") return { status: "Data Belum Lengkap" as Status };
        return computeCategoryValidation(start, end, current);
      })(),
      (async () => {
        if (section && section !== "inventory") return { status: "Data Belum Lengkap" as Status };
        return computeInventoryValidation(year, month, start, end);
      })(),
      (async () => {
        if (section && section !== "financial") return { status: "Data Belum Lengkap" as Status };
        return computeFinancialValidation(period);
      })(),
    ]);
    // Saat `section` diisi, IIFE section lain sengaja short-circuit ke stub
    // `{status}` di atas — TIDAK diikutsertakan di sini, supaya response
    // tidak membawa key stub yang, lewat Object.assign berurutan di
    // OlseraValidationPanel.validate(), akan menimpa hasil section lain yang
    // sudah lengkap dari fetch sebelumnya (root cause NaN/"-"/0-0 di production).
    if (!section || section === "category") result.category = sections[0].status === "fulfilled" ? sections[0].value : failedSection("category", sections[0].reason);
    if (!section || section === "inventory") result.inventory = sections[1].status === "fulfilled" ? sections[1].value : failedSection("inventory", sections[1].reason);
    if (!section || section === "financial") result.financial = sections[2].status === "fulfilled" ? sections[2].value : failedSection("financial", sections[2].reason);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { if (error instanceof Response) return error; return NextResponse.json({ error: "Validasi Olsera gagal dijalankan." }, { status: 500 }); }
}
