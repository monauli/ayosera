import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getSalesItemsPerGroup } from "@/lib/olsera";
import { NO_CACHE_HEADERS } from "@/lib/no-cache";

// Data diambil live dari API Olsera setiap request: jangan di-cache.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function todayJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function GET(request: Request) {
  try {
    await requireUser();

    const { searchParams } = new URL(request.url);
    const today = todayJakarta();
    const defaultFrom = `${today.slice(0, 7)}-01`; // tanggal 1 bulan berjalan (WIB)

    const fromParam = searchParams.get("from") ?? "";
    const toParam = searchParams.get("to") ?? "";
    const from = DATE_PATTERN.test(fromParam) ? fromParam : defaultFrom;
    const to = DATE_PATTERN.test(toParam) ? toParam : today;

    if (from > to) {
      return NextResponse.json(
        { error: "Rentang tanggal tidak valid: from lebih besar dari to." },
        { status: 400, headers: NO_CACHE_HEADERS },
      );
    }

    const result = await getSalesItemsPerGroup(from, to);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, from, to }, { status: 502, headers: NO_CACHE_HEADERS });
    }

    return NextResponse.json({ data: result.data, from, to }, { headers: NO_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(error);
    return NextResponse.json(
      { error: "Gagal memuat data penjualan Olsera." },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }
}
